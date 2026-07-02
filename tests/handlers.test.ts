import { describe, expect, test } from 'bun:test';
import { applyMode, buildHandlers, mintGovernanceContext } from '../src/handlers.ts';
import { GovernanceStore, type PlanRecord } from '../src/store.ts';

function makePlan(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    plan_id: 'plan_demo',
    brand: { domain: 'acme.example.com' },
    objectives: 'awareness for cats',
    budget: {
      total: 10000,
      currency: 'USD',
      reallocation_threshold: 5000,
    },
    flight: { start: '2026-07-01', end: '2026-07-31' },
    ...overrides,
  } as PlanRecord;
}

function ts(i: number): string {
  return new Date(1_700_000_000_000 + i * 1000).toISOString();
}

function setup(mode: 'audit' | 'advisory' | 'enforce' = 'enforce') {
  let i = 0;
  const store = new GovernanceStore(() => ts(i++));
  const handlers = buildHandlers({
    store,
    defaultMode: mode,
    agentName: 'abzu-governance-test',
    now: () => ts(i++),
  });
  return { store, handlers };
}

describe('applyMode', () => {
  test('audit forces approved regardless of policy verdict', () => {
    expect(applyMode('audit', 'denied')).toBe('approved');
    expect(applyMode('audit', 'conditions')).toBe('approved');
    expect(applyMode('audit', 'approved')).toBe('approved');
  });

  test('advisory + enforce pass through policy verdict', () => {
    expect(applyMode('advisory', 'denied')).toBe('denied');
    expect(applyMode('enforce', 'denied')).toBe('denied');
  });
});

describe('mintGovernanceContext', () => {
  test('produces ASCII-safe printable token', () => {
    const tok = mintGovernanceContext('plan_1', 'chk_abc', '2026-01-01T00:00:00.000Z');
    expect(tok).toMatch(/^gov\.v0\.[A-Za-z0-9_-]+$/);
  });
});

describe('handlers: syncPlans + checkGovernance + reportPlanOutcome', () => {
  test('happy path approves within-budget action and records audit', async () => {
    const { store, handlers } = setup('enforce');
    await handlers.syncPlans({
      idempotency_key: 'idempo_test_one_two_three',
      plans: [makePlan()],
    });
    const check = await handlers.checkGovernance({
      plan_id: 'plan_demo',
      caller: 'https://abzu.test',
      tool: 'create_media_buy',
      payload: { total_budget: 3000, currency: 'USD' },
    });
    expect(check.verdict).toBe('approved');
    expect(check.governance_context).toMatch(/^gov\.v0\./);
    const audit = await store.getAudit('plan_demo');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.kind).toBe('check');
  });

  test('enforce denies over-budget request', async () => {
    const { handlers } = setup('enforce');
    await handlers.syncPlans({
      idempotency_key: 'idempo_over_budget_one_two',
      plans: [makePlan()],
    });
    const check = await handlers.checkGovernance({
      plan_id: 'plan_demo',
      caller: 'https://abzu.test',
      tool: 'create_media_buy',
      payload: { total_budget: 25000, currency: 'USD' },
    });
    expect(check.verdict).toBe('denied');
    expect(check.findings!.some((f) => f.policy_id === 'budget.plan_total_cap')).toBe(true);
  });

  test('audit mode approves even when policy would deny', async () => {
    const { handlers } = setup('audit');
    await handlers.syncPlans({
      idempotency_key: 'idempo_audit_modeone_two',
      plans: [makePlan()],
    });
    const check = await handlers.checkGovernance({
      plan_id: 'plan_demo',
      caller: 'https://abzu.test',
      tool: 'create_media_buy',
      payload: { total_budget: 25000, currency: 'USD' },
    });
    expect(check.verdict).toBe('approved');
    expect(check.mode).toBe('audit');
    expect(check.findings!.length).toBeGreaterThan(0);
  });

  test('check on unregistered plan returns critical finding', async () => {
    const { handlers } = setup('enforce');
    const check = await handlers.checkGovernance({
      plan_id: 'never_seen',
      caller: 'https://abzu.test',
      tool: 'create_media_buy',
      payload: { total_budget: 1000, currency: 'USD' },
    });
    expect(check.verdict).toBe('denied');
    expect(check.findings![0]!.policy_id).toBe('plan.exists');
  });

  test('report_plan_outcome accepts after a check', async () => {
    const { store, handlers } = setup();
    await handlers.syncPlans({
      idempotency_key: 'idempo_outcome_flow_one_two',
      plans: [makePlan()],
    });
    const check = await handlers.checkGovernance({
      plan_id: 'plan_demo',
      caller: 'https://abzu.test',
      tool: 'create_media_buy',
      payload: { total_budget: 3000, currency: 'USD' },
    });
    const outcome = await handlers.reportPlanOutcome({
      plan_id: 'plan_demo',
      check_id: check.check_id,
      idempotency_key: 'idempo_outcome_one_two_three',
      outcome: 'completed',
      governance_context: check.governance_context!,
      seller_response: { committed_budget: 3000 },
    });
    expect(outcome.outcome_state).toBe('accepted');
    expect(outcome.committed_budget).toBe(3000);
    const audit = await store.getAudit('plan_demo');
    expect(audit).toHaveLength(2);
    expect(audit[1]!.kind).toBe('outcome');
  });

  test('get_plan_audit_logs aggregates plan + summary', async () => {
    const { handlers } = setup();
    await handlers.syncPlans({
      idempotency_key: 'idempo_audit_view_one_two_three',
      plans: [makePlan()],
    });
    await handlers.checkGovernance({
      plan_id: 'plan_demo',
      caller: 'https://abzu.test',
      tool: 'create_media_buy',
      payload: { total_budget: 3000, currency: 'USD' },
    });
    const audit = await handlers.getPlanAuditLogs({ plan_ids: ['plan_demo'] });
    expect(audit.plans).toHaveLength(1);
    expect(audit.plans[0]!.summary.checks_performed).toBe(1);
    expect(audit.plans[0]!.budget.authorized).toBe(10000);
  });
});
