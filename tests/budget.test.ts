import { describe, expect, test } from 'bun:test';
import { evaluateBudget, verdictFromFindings } from '../src/policies/budget.ts';
import type { PlanRecord } from '../src/store.ts';

function plan(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    plan_id: 'plan_1',
    brand: { domain: 'acme.example.com' },
    objectives: 'awareness',
    budget: {
      total: 10000,
      currency: 'USD',
      reallocation_threshold: 5000,
    },
    flight: { start: '2026-07-01', end: '2026-07-31' },
    ...overrides,
  } as PlanRecord;
}

describe('evaluateBudget', () => {
  test('approves when payload has no budget (info finding only)', () => {
    const findings = evaluateBudget(plan(), {
      plan_id: 'plan_1',
      caller: 'abzu',
      payload: {},
    });
    expect(verdictFromFindings(findings)).toBe('approved');
    expect(findings[0]!.severity).toBe('info');
  });

  test('approves when payload spend is within plan total and threshold', () => {
    const findings = evaluateBudget(plan(), {
      plan_id: 'plan_1',
      caller: 'abzu',
      payload: { total_budget: 3000, currency: 'USD' },
    });
    expect(findings).toEqual([]);
    expect(verdictFromFindings(findings)).toBe('approved');
  });

  test('emits conditions when spend exceeds reallocation threshold', () => {
    const findings = evaluateBudget(plan(), {
      plan_id: 'plan_1',
      caller: 'abzu',
      payload: { total_budget: 6000, currency: 'USD' },
    });
    expect(findings.some((f) => f.policy_id === 'budget.reallocation_threshold')).toBe(true);
    expect(verdictFromFindings(findings)).toBe('conditions');
  });

  test('denies when spend exceeds plan total', () => {
    const findings = evaluateBudget(plan(), {
      plan_id: 'plan_1',
      caller: 'abzu',
      payload: { total_budget: 15000, currency: 'USD' },
    });
    expect(findings.some((f) => f.policy_id === 'budget.plan_total_cap')).toBe(true);
    expect(verdictFromFindings(findings)).toBe('denied');
  });

  test('denies on currency mismatch (critical)', () => {
    const findings = evaluateBudget(plan(), {
      plan_id: 'plan_1',
      caller: 'abzu',
      payload: { total_budget: 1000, currency: 'EUR' },
    });
    expect(findings.some((f) => f.policy_id === 'budget.currency_match')).toBe(true);
    expect(verdictFromFindings(findings)).toBe('denied');
  });

  test('emits soft-cap warning at 80%+ of plan total', () => {
    const findings = evaluateBudget(plan(), {
      plan_id: 'plan_1',
      caller: 'abzu',
      payload: { total: 8500 },
    });
    expect(findings.some((f) => f.policy_id === 'budget.plan_total_soft_cap')).toBe(true);
    expect(verdictFromFindings(findings)).toBe('conditions');
  });
});
