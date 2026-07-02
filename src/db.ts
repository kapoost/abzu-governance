import postgres from 'postgres';
import type { CheckGovernanceRequest, ReportPlanOutcomeRequest } from '@adcp/sdk';
import type {
  AuditEvent,
  CheckEvent,
  FindingSnapshot,
  GovernanceDecision,
  OutcomeEvent,
  PlanRecord,
} from './store.ts';

export type PlanStoreAdapter = {
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
};

const CREATE_PLANS_SQL = `
  CREATE TABLE IF NOT EXISTS governance_plans (
    plan_id TEXT PRIMARY KEY,
    record JSONB NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const CREATE_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS governance_audit_events (
    id BIGSERIAL PRIMARY KEY,
    plan_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL
  )
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_governance_events_plan_ts
    ON governance_audit_events (plan_id, ts)
`;

export async function createPostgresPlanStore(
  databaseUrl: string,
): Promise<PlanStoreAdapter> {
  const sql = postgres(databaseUrl, { onnotice: () => {} });
  await sql.unsafe(CREATE_PLANS_SQL);
  await sql.unsafe(CREATE_EVENTS_SQL);
  await sql.unsafe(CREATE_INDEX_SQL);

  return {
    async upsertPlan(plan) {
      const result = await sql`
        INSERT INTO governance_plans (plan_id, record, synced_at)
        VALUES (${plan.plan_id}, ${sql.json(plan as never)}, NOW())
        ON CONFLICT (plan_id) DO UPDATE
          SET record = EXCLUDED.record, synced_at = EXCLUDED.synced_at
        RETURNING (xmax = 0) AS inserted
      `;
      return { action: result[0]?.inserted ? 'created' : 'updated' };
    },
    async getPlan(planId) {
      const rows = await sql<Array<{ record: PlanRecord }>>`
        SELECT record FROM governance_plans WHERE plan_id = ${planId}
      `;
      return rows[0]?.record;
    },
    async recordCheck(planId, checkId, request, verdict, findings) {
      const event: CheckEvent = {
        kind: 'check',
        ts: new Date().toISOString(),
        check_id: checkId,
        caller: request.caller,
        ...(request.tool !== undefined ? { tool: request.tool } : {}),
        ...(request.phase !== undefined ? { phase: request.phase } : {}),
        verdict,
        findings,
      };
      await sql`
        INSERT INTO governance_audit_events (plan_id, kind, ts, payload)
        VALUES (${planId}, 'check', ${event.ts}, ${sql.json(event as never)})
      `;
      return event;
    },
    async recordOutcome(planId, request) {
      const event: OutcomeEvent = {
        kind: 'outcome',
        ts: new Date().toISOString(),
        outcome: request.outcome,
        ...(request.check_id !== undefined ? { check_id: request.check_id } : {}),
      };
      await sql`
        INSERT INTO governance_audit_events (plan_id, kind, ts, payload)
        VALUES (${planId}, 'outcome', ${event.ts}, ${sql.json(event as never)})
      `;
      return event;
    },
    async getAudit(planId) {
      const rows = await sql<Array<{ payload: AuditEvent }>>`
        SELECT payload FROM governance_audit_events
        WHERE plan_id = ${planId}
        ORDER BY ts ASC, id ASC
      `;
      return rows.map((r) => r.payload);
    },
  };
}
