import type {
  CheckGovernanceRequest,
  ReportPlanOutcomeRequest,
  SyncPlansRequest,
} from '@adcp/sdk';

export type GovernanceDecision = 'approved' | 'denied' | 'conditions';
export type GovernanceMode = 'audit' | 'advisory' | 'enforce';

export type PlanRecord = SyncPlansRequest['plans'][number];

export type FindingSnapshot = {
  category_id: string;
  policy_id?: string;
  severity: 'info' | 'warning' | 'critical';
  explanation: string;
};

export type CheckEvent = {
  kind: 'check';
  ts: string;
  check_id: string;
  caller: string;
  tool?: string;
  phase?: string;
  verdict: GovernanceDecision;
  findings: FindingSnapshot[];
};

export type OutcomeEvent = {
  kind: 'outcome';
  ts: string;
  outcome: string;
  check_id?: string;
  detail?: Record<string, unknown>;
};

export type AuditEvent = CheckEvent | OutcomeEvent;

export interface PlanStoreAdapter {
  upsertPlan(plan: PlanRecord): Promise<{ action: 'created' | 'updated' }>;
  getPlan(planId: string): Promise<PlanRecord | undefined>;
  recordCheck(
    planId: string,
    checkId: string,
    request: CheckGovernanceRequest,
    verdict: GovernanceDecision,
    findings: FindingSnapshot[],
  ): Promise<CheckEvent>;
  recordOutcome(planId: string, request: ReportPlanOutcomeRequest): Promise<OutcomeEvent>;
  getAudit(planId: string): Promise<AuditEvent[]>;
}

export class InMemoryPlanStore implements PlanStoreAdapter {
  private plans = new Map<string, PlanRecord>();
  private audit = new Map<string, AuditEvent[]>();
  private now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  async upsertPlan(plan: PlanRecord): Promise<{ action: 'created' | 'updated' }> {
    const existed = this.plans.has(plan.plan_id);
    this.plans.set(plan.plan_id, plan);
    return { action: existed ? 'updated' : 'created' };
  }

  async getPlan(planId: string): Promise<PlanRecord | undefined> {
    return this.plans.get(planId);
  }

  async recordCheck(
    planId: string,
    checkId: string,
    request: CheckGovernanceRequest,
    verdict: GovernanceDecision,
    findings: FindingSnapshot[],
  ): Promise<CheckEvent> {
    const event: CheckEvent = {
      kind: 'check',
      ts: this.now(),
      check_id: checkId,
      caller: request.caller,
      ...(request.tool !== undefined ? { tool: request.tool } : {}),
      ...(request.phase !== undefined ? { phase: request.phase } : {}),
      verdict,
      findings,
    };
    this.append(planId, event);
    return event;
  }

  async recordOutcome(planId: string, request: ReportPlanOutcomeRequest): Promise<OutcomeEvent> {
    const event: OutcomeEvent = {
      kind: 'outcome',
      ts: this.now(),
      outcome: request.outcome,
      ...(request.check_id !== undefined ? { check_id: request.check_id } : {}),
    };
    this.append(planId, event);
    return event;
  }

  async getAudit(planId: string): Promise<AuditEvent[]> {
    return [...(this.audit.get(planId) ?? [])];
  }

  private append(planId: string, event: AuditEvent): void {
    const arr = this.audit.get(planId) ?? [];
    arr.push(event);
    this.audit.set(planId, arr);
  }
}

// Back-compat alias for tests that constructed `new GovernanceStore()`.
export { InMemoryPlanStore as GovernanceStore };
