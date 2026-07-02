import type { CheckGovernanceRequest } from '@adcp/sdk';
import type { GovernanceDecision, PlanRecord } from '../store.ts';

export type Severity = 'info' | 'warning' | 'critical';

export type Finding = {
  category_id: string;
  policy_id?: string;
  severity: Severity;
  explanation: string;
  details?: Record<string, unknown>;
};

type PayloadBudget = {
  total?: number;
  total_budget?: number;
  amount?: number;
  budget?: { total?: number; amount?: number; currency?: string };
  packages?: Array<{ budget?: number }>;
  total_budget_obj?: { amount?: number };
};

function extractRequestedSpend(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as PayloadBudget & { total_budget?: number | { amount?: number } };
  if (typeof p.total === 'number') return p.total;
  if (typeof p.total_budget === 'number') return p.total_budget;
  if (
    p.total_budget &&
    typeof p.total_budget === 'object' &&
    typeof (p.total_budget as { amount?: number }).amount === 'number'
  ) {
    return (p.total_budget as { amount: number }).amount;
  }
  if (typeof p.amount === 'number') return p.amount;
  if (p.budget) {
    if (typeof p.budget.total === 'number') return p.budget.total;
    if (typeof p.budget.amount === 'number') return p.budget.amount;
  }
  // create_media_buy payload shape: packages[].budget summed across line items.
  if (Array.isArray(p.packages) && p.packages.length > 0) {
    const total = p.packages.reduce(
      (sum, pkg) => sum + (typeof pkg.budget === 'number' ? pkg.budget : 0),
      0,
    );
    if (total > 0) return total;
  }
  return undefined;
}

function extractRequestedCurrency(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as { currency?: string; budget?: { currency?: string } };
  return p.currency ?? p.budget?.currency;
}

export function evaluateBudget(plan: PlanRecord, request: CheckGovernanceRequest): Finding[] {
  const findings: Finding[] = [];
  const requested = extractRequestedSpend(request.payload);
  const planTotal = plan.budget.total;
  const planCurrency = plan.budget.currency;

  if (requested === undefined) {
    findings.push({
      category_id: 'budget_compliance',
      policy_id: 'budget.spend_declared',
      severity: 'info',
      explanation: 'Tool payload did not declare a budget amount; per-spend check skipped.',
    });
    return findings;
  }

  const requestedCurrency = extractRequestedCurrency(request.payload);
  if (requestedCurrency && requestedCurrency !== planCurrency) {
    findings.push({
      category_id: 'budget_compliance',
      policy_id: 'budget.currency_match',
      severity: 'critical',
      explanation: `Payload currency ${requestedCurrency} does not match plan currency ${planCurrency}.`,
      details: { plan_currency: planCurrency, payload_currency: requestedCurrency },
    });
  }

  if (requested > planTotal) {
    findings.push({
      category_id: 'budget_compliance',
      policy_id: 'budget.plan_total_cap',
      severity: 'critical',
      explanation: `Requested spend ${requested} ${planCurrency} exceeds plan total ${planTotal} ${planCurrency}.`,
      details: { requested, plan_total: planTotal },
    });
  } else if (requested > planTotal * 0.8) {
    findings.push({
      category_id: 'budget_compliance',
      policy_id: 'budget.plan_total_soft_cap',
      severity: 'warning',
      explanation: `Requested spend ${requested} ${planCurrency} is above 80% of plan total ${planTotal} ${planCurrency}.`,
      details: { requested, plan_total: planTotal, fraction: requested / planTotal },
    });
  }

  const reallocationCapped =
    'reallocation_threshold' in plan.budget
      ? plan.budget.reallocation_threshold
      : undefined;
  if (reallocationCapped !== undefined && requested > reallocationCapped) {
    findings.push({
      category_id: 'budget_compliance',
      policy_id: 'budget.reallocation_threshold',
      severity: 'warning',
      explanation: `Requested spend ${requested} ${planCurrency} exceeds reallocation threshold ${reallocationCapped} ${planCurrency}; human escalation required by plan policy.`,
      details: { requested, threshold: reallocationCapped },
    });
  }

  return findings;
}

export function verdictFromFindings(findings: Finding[]): GovernanceDecision {
  if (findings.some((f) => f.severity === 'critical')) return 'denied';
  if (findings.some((f) => f.severity === 'warning')) return 'conditions';
  return 'approved';
}
