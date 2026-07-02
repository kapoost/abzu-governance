import { definePlatform } from '@adcp/sdk/server';
import { accountStore, type GovernanceAccountMeta } from './accounts.ts';
import { buildHandlers, type HandlerOptions } from './handlers.ts';

export function buildPlatform(options: HandlerOptions) {
  const handlers = buildHandlers(options);
  return definePlatform<null, GovernanceAccountMeta>({
    capabilities: {
      specialisms: ['governance-spend-authority'] as const,
      supported_versions: ['3.0', '3.1'] as const,
      // Declare both 'operator' and 'agent' to keep the per-account billing
      // gate semantic (AAO billing_gate_dispatch/per_agent_gate_reject expects
      // a row-level rejection from a passthrough-only buyer, not a capability
      // declaration rebuff). Per-principal gating in accounts.ts.upsert.
      supportedBillings: ['operator', 'agent'] as const,
      requireOperatorAuth: false,
      config: null,
    },
    accounts: accountStore,
    campaignGovernance: {
      syncPlans: handlers.syncPlans,
      checkGovernance: handlers.checkGovernance,
      reportPlanOutcome: handlers.reportPlanOutcome,
      getPlanAuditLogs: handlers.getPlanAuditLogs,
    },
  });
}
