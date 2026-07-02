import {
  createAdcpServerFromPlatform,
  createIdempotencyStore,
  createInMemoryTaskRegistry,
  InMemoryStateStore,
  memoryBackend,
  serve,
  verifyApiKey,
} from '@adcp/sdk/server';
import { loadEnv } from './env.ts';
import { log } from './observability/logger.ts';
import { buildPlatform } from './platform.ts';
import { createPostgresPlanStore } from './db.ts';
import { InMemoryPlanStore, type PlanStoreAdapter } from './store.ts';
import { startHealthzProxy } from './healthz-proxy.ts';

// SDK 9.0.0 auto-registers framework tools with name + inputSchema + annotations,
// but no `description` — AAO dashboard renders "No description available" for each.
// We poke the wrapper's private SDK-server reference (Symbol.for('@adcp/client.sdkServer'))
// and stamp descriptions on `_registeredTools[toolName]` so tools/list emits them.
// Symbol matches the one wrapMcpServer assigns; mirrored from
// node_modules/@adcp/sdk/dist/lib/server/adcp-server.js:71.
const ADCP_SDK_SERVER = Symbol.for('@adcp/client.sdkServer');

const TOOL_DESCRIPTIONS: Record<string, string> = {
  sync_plans:
    'Register or update governance plans (budget, currency, flight, reallocation_threshold) so subsequent check_governance calls have authority to evaluate against. Idempotent on (seller, idempotency_key).',
  check_governance:
    'Evaluate a proposed buyer action against the registered plan. Returns verdict (approved / conditions / denied) with structured findings, mode (audit/advisory/enforce), and a signed governance_context the buyer must attach to the seller call. Denial fires before any seller dispatch — hard stop.',
  report_plan_outcome:
    'Buyer reports the actual outcome of a governance-approved action (outcome=completed/failed/delivery). Commits committed_budget against the plan, appends to the audit ledger, and accepts mid-flight delivery snapshots for drift detection.',
  get_plan_audit_logs:
    'Read the chronological governance ledger for one or more plans. Returns budget state (authorized/committed/utilization), summary counts, and (when include_entries=true) the full check + outcome timeline with verdicts, findings, and timestamps.',
  list_accounts:
    'List accounts visible to the authenticated principal. For this governance agent each principal resolves to one singleton account; notification_configs[] from sync_accounts are echoed when present.',
  sync_accounts:
    'Provision or update accounts and their account-level notification_configs[] subscribers. Validates billing posture (operator-only) and notification_config event scope (rejects media-buy-anchored types). Replace-by-subscriber_id semantics; empty array clears.',
  get_task_status:
    'Poll the lifecycle of an async task (submitted → working → completed / failed / input-required). Used by buyers waiting on long-running governance checks or out-of-band escalations.',
  list_tasks:
    'List active and recently completed async tasks under the authenticated principal.',
  tasks_get:
    'A2A-compatible alias for get_task_status — retrieve the current state of a task by id.',
  get_adcp_capabilities:
    'Protocol-level capability discovery. Returns supported AdCP versions, declared specialisms (governance-spend-authority), supported protocols, account model, idempotency posture, and per-domain feature flags. Buyers query this before issuing any tool call.',
};

function stampToolDescriptions(adcpServer: unknown): void {
  const candidate = adcpServer as Record<symbol, unknown> | null;
  if (!candidate) return;
  const inner = candidate[ADCP_SDK_SERVER] as
    | { _registeredTools?: Record<string, { description?: string }> }
    | undefined;
  const registry = inner?._registeredTools;
  if (!registry) {
    log.warn('tool description stamper: no _registeredTools surface found');
    return;
  }
  let stamped = 0;
  for (const [name, description] of Object.entries(TOOL_DESCRIPTIONS)) {
    const entry = registry[name];
    if (entry) {
      entry.description = description;
      stamped++;
    }
  }
  log.info('tool descriptions stamped', { count: stamped, registered: Object.keys(registry).length });
}

const env = loadEnv();

const store: PlanStoreAdapter = env.DATABASE_URL
  ? await createPostgresPlanStore(env.DATABASE_URL)
  : new InMemoryPlanStore();
log.info('plan store', { backend: env.DATABASE_URL ? 'postgres' : 'in-memory' });

const platform = buildPlatform({
  store,
  defaultMode: env.DEFAULT_MODE,
  agentName: env.AGENT_NAME,
  now: () => new Date().toISOString(),
});

const taskRegistry = createInMemoryTaskRegistry();
const stateStore = new InMemoryStateStore();
const idempotencyStore = createIdempotencyStore({ backend: memoryBackend() });

// SDK serve() handles /mcp + RFC 9728 PRM only; everything else returns 404
// at the SDK layer. Run the SDK on an internal loopback port and front it
// with healthz-proxy on env.PORT so /.well-known/healthz is reachable
// without bearer auth — AAO's crawler probes this for liveness.
const sdkPort = env.PORT + 100;

serve(
  ({ taskStore }) => {
    const adcpServer = createAdcpServerFromPlatform(platform, {
      name: env.AGENT_NAME,
      version: env.VERSION,
      adcpVersion: '3.1',
      taskStore,
      taskRegistry,
      stateStore,
      idempotency: idempotencyStore,
      // SDK 9.x's regular dispatch injects adcp_version via injectVersionIntoResponse,
      // but the auto-registered get_adcp_capabilities handler bypasses that wrapper.
      // Mirror seller's pattern: stamp adcp_version on structuredContent and on the
      // JSON-text content[0] envelope so AAO's version_negotiation/capabilities_advertise_and_echo
      // sees the echoed release on the discovery surface.
      responseEnhancer: (response) => {
        const sc = (response as { structuredContent?: Record<string, unknown> }).structuredContent;
        if (sc && typeof sc === 'object' && !('adcp_version' in sc)) {
          sc.adcp_version = '3.1';
        }
        const content = (response as { content?: Array<{ type: string; text?: string }> }).content;
        if (Array.isArray(content)) {
          const first = content[0];
          if (first?.type === 'text' && typeof first.text === 'string') {
            try {
              const parsed = JSON.parse(first.text) as Record<string, unknown>;
              if (parsed && typeof parsed === 'object' && !('adcp_version' in parsed)) {
                parsed.adcp_version = '3.1';
                first.text = JSON.stringify(parsed);
              }
            } catch {
              // Text isn't JSON — leave it alone.
            }
          }
        }
      },
    });
    stampToolDescriptions(adcpServer);
    return adcpServer;
  },
  {
    port: sdkPort,
    onListening: () => {
      startHealthzProxy({ publicPort: env.PORT, sdkPort });
    },
    authenticate: verifyApiKey({
      keys: {
        [env.ADCP_AUTH_TOKEN]: { principal: 'abzu-governance-dev' },
      },
      // AAO test-kit convention: accept demo-* bearers whose suffix encodes the
      // compliance runner principal so the storyboards can target specific principals
      // (e.g. per-agent billing gate) without bespoke token provisioning.
      verify: (token) => {
        if (/^demo-acme-outdoor-live-v\d+$/.test(token)) {
          return { principal: 'compliance-runner-live' };
        }
        if (/^demo-acme-outdoor-v\d+$/.test(token)) {
          return { principal: 'compliance-runner' };
        }
        if (/^demo-billing-passthrough-v\d+$/.test(token)) {
          return { principal: 'compliance-runner-passthrough' };
        }
        // Abzu orchestrator caller — versioned token pattern so secret rotation
        // is a fly-secrets-set away (no code change). Principal surfaces in
        // audit log entries when abzu sync_plans / check_governance.
        if (/^abzu-orchestrator-v\d+$/.test(token)) {
          return { principal: 'abzu-orchestrator' };
        }
        return null;
      },
    }),
  },
);

log.info('startup', {
  agent: env.AGENT_NAME,
  version: env.VERSION,
  listening_on: `http://${env.HOST}:${env.PORT}/mcp`,
  specialisms: ['governance-spend-authority'],
  default_mode: env.DEFAULT_MODE,
  node_env: env.NODE_ENV,
});
