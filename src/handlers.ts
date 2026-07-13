import { randomUUID } from 'node:crypto';
import type {
  CheckGovernanceRequest,
  CheckGovernanceResponse,
  GetPlanAuditLogsRequest,
  GetPlanAuditLogsResponse,
  ReportPlanOutcomeRequest,
  ReportPlanOutcomeResponse,
  SyncPlansRequest,
  SyncPlansResponse,
} from '@adcp/sdk';
import { evaluateBudget, evaluateCustomPolicies, verdictFromFindings, type Finding } from './policies/budget.ts';
import type { GovernanceMode, PlanStoreAdapter } from './store.ts';

export type HandlerOptions = {
  store: PlanStoreAdapter;
  defaultMode: GovernanceMode;
  agentName: string;
  now: () => string;
};

export function mintGovernanceContext(planId: string, checkId: string, ts: string): string {
  const body = JSON.stringify({ plan_id: planId, check_id: checkId, ts, kind: 'abzu-gov-v0' });
  return `gov.v0.${Buffer.from(body, 'utf8').toString('base64url')}`;
}

export function applyMode(
  mode: GovernanceMode,
  policyVerdict: 'approved' | 'denied' | 'conditions',
): 'approved' | 'denied' | 'conditions' {
  return mode === 'audit' ? 'approved' : policyVerdict;
}

function findingsToResponse(findings: Finding[]): CheckGovernanceResponse['findings'] {
  return findings.map((f) => ({
    category_id: f.category_id,
    ...(f.policy_id !== undefined ? { policy_id: f.policy_id } : {}),
    severity: f.severity,
    explanation: f.explanation,
    ...(f.details !== undefined ? { details: f.details } : {}),
  }));
}

export function buildHandlers(options: HandlerOptions) {
  const { store, defaultMode, now } = options;

  async function syncPlans(params: SyncPlansRequest): Promise<SyncPlansResponse> {
    const plans: Array<{ plan_id: string; status: 'active'; version: number }> = [];
    for (const p of params.plans) {
      await store.upsertPlan(p);
      plans.push({ plan_id: p.plan_id, status: 'active', version: 1 });
    }
    return {
      status: 'completed',
      timestamp: now(),
      plans,
      ...(params.context !== undefined ? { context: params.context } : {}),
    };
  }

  async function checkGovernance(params: CheckGovernanceRequest): Promise<CheckGovernanceResponse> {
    const plan = await store.getPlan(params.plan_id);
    const checkId = `chk_${randomUUID()}`;
    const ts = now();

    const expiresAt = new Date(Date.parse(ts) + 60 * 60 * 1000).toISOString();

    if (!plan) {
      const findings: Finding[] = [
        {
          category_id: 'plan_registration',
          policy_id: 'plan.exists',
          severity: 'critical',
          explanation: `Plan ${params.plan_id} is not registered. Call sync_plans first.`,
        },
      ];
      const verdict = applyMode(defaultMode, verdictFromFindings(findings));
      await store.recordCheck(params.plan_id, checkId, params, verdict, findings.map((f) => ({
      category_id: f.category_id,
      ...(f.policy_id !== undefined ? { policy_id: f.policy_id } : {}),
      severity: f.severity,
      explanation: f.explanation,
    })));
      return {
        check_id: checkId,
        plan_id: params.plan_id,
        verdict,
        explanation: `Plan ${params.plan_id} is not registered.`,
        findings: findingsToResponse(findings),
        mode: defaultMode,
        governance_context: mintGovernanceContext(params.plan_id, checkId, ts),
        categories_evaluated: ['plan_registration'],
        policies_evaluated: ['plan.exists'],
        ...(params.context !== undefined ? { context: params.context } : {}),
      };
    }

    const findings = [
      ...evaluateBudget(plan, params),
      ...evaluateCustomPolicies(plan, params),
    ];
    const policyVerdict = verdictFromFindings(findings);
    const verdict = applyMode(defaultMode, policyVerdict);
    await store.recordCheck(params.plan_id, checkId, params, verdict, findings.map((f) => ({
      category_id: f.category_id,
      ...(f.policy_id !== undefined ? { policy_id: f.policy_id } : {}),
      severity: f.severity,
      explanation: f.explanation,
    })));

    const conditions =
      verdict === 'conditions'
        ? findings
            .filter((f) => f.severity === 'warning')
            .map((f) => ({
              field: f.policy_id ?? 'unknown',
              reason: f.explanation,
            }))
        : undefined;

    return {
      check_id: checkId,
      plan_id: params.plan_id,
      verdict,
      explanation: explanationFor(verdict, defaultMode, findings),
      findings: findingsToResponse(findings),
      mode: defaultMode,
      governance_context: mintGovernanceContext(params.plan_id, checkId, ts),
      categories_evaluated: Array.from(new Set(findings.map((f) => f.category_id))).length > 0
        ? Array.from(new Set(findings.map((f) => f.category_id)))
        : ['budget_compliance'],
      policies_evaluated: findings.map((f) => f.policy_id ?? 'unknown').filter(Boolean),
      ...(verdict !== 'denied' ? { expires_at: expiresAt } : {}),
      ...(conditions ? { conditions } : {}),
      ...(params.context !== undefined ? { context: params.context } : {}),
    };
  }

  async function reportPlanOutcome(
    params: ReportPlanOutcomeRequest,
  ): Promise<ReportPlanOutcomeResponse> {
    const plan = await store.getPlan(params.plan_id);
    const outcomeId = `out_${randomUUID()}`;
    if (!plan) {
      return {
        outcome_id: outcomeId,
        outcome_state: 'findings',
        findings: [
          {
            category_id: 'plan_registration',
            severity: 'critical',
            explanation: `Plan ${params.plan_id} is not registered. Outcome rejected.`,
          },
        ],
        ...(params.context !== undefined ? { context: params.context } : {}),
      };
    }
    await store.recordOutcome(params.plan_id, params);
    const committed = params.seller_response?.committed_budget;
    return {
      outcome_id: outcomeId,
      outcome_state: 'accepted',
      ...(committed !== undefined ? { committed_budget: committed } : {}),
      ...(params.context !== undefined ? { context: params.context } : {}),
    };
  }

  async function getPlanAuditLogs(
    params: GetPlanAuditLogsRequest,
  ): Promise<GetPlanAuditLogsResponse> {
    const ids = [...(params.plan_ids ?? [])];
    const plans = await Promise.all(ids.map(async (id) => {
      const plan = await store.getPlan(id);
      const events = await store.getAudit(id);
      const checks = events.filter((e) => e.kind === 'check').length;
      const outcomes = events.filter((e) => e.kind === 'outcome').length;
      return {
        plan_id: id,
        plan_version: 1,
        status: (plan ? 'active' : 'completed') as 'active' | 'suspended' | 'completed',
        budget: {
          authorized: plan?.budget.total,
          committed: 0,
        },
        summary: {
          checks_performed: checks,
          outcomes_reported: outcomes,
        },
        governed_actions: [] as never[],
        ...(params.include_entries
          ? {
              entries: events.map((e, idx) => ({
                id: e.kind === 'check' ? e.check_id : `out_${id}_${idx}`,
                type: e.kind,
                timestamp: e.ts,
                ...(e.kind === 'check'
                  ? {
                      verdict: e.verdict,
                      caller: e.caller,
                      ...(e.tool !== undefined ? { tool: e.tool } : {}),
                      ...(e.findings.length > 0 ? { findings: e.findings } : {}),
                    }
                  : { outcome: e.outcome }),
              })),
            }
          : {}),
      };
    }));
    return {
      status: 'completed',
      timestamp: now(),
      plans: plans as GetPlanAuditLogsResponse['plans'],
      ...(params.context !== undefined ? { context: params.context } : {}),
    };
  }

  return { syncPlans, checkGovernance, reportPlanOutcome, getPlanAuditLogs };
}

function explanationFor(
  verdict: 'approved' | 'denied' | 'conditions',
  mode: GovernanceMode,
  findings: Finding[],
): string {
  if (mode === 'audit') {
    return findings.length === 0
      ? 'Audit mode: approved, no findings.'
      : `Audit mode: approved, ${findings.length} finding(s) recorded.`;
  }
  if (verdict === 'approved') return 'Approved: no policy violations detected.';
  if (verdict === 'denied') {
    return `Denied: ${findings.filter((f) => f.severity === 'critical').length} critical finding(s).`;
  }
  return `Conditions: ${findings.filter((f) => f.severity === 'warning').length} warning(s).`;
}
