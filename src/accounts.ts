import type { Account, AccountStore } from '@adcp/sdk/server';

export interface GovernanceAccountMeta {
  scope: 'governance';
}

const SINGLETON_ID = 'governance_default';

function buildAccount(
  overrides: Partial<Account<GovernanceAccountMeta>> = {},
): Account<GovernanceAccountMeta> {
  return {
    id: SINGLETON_ID,
    name: 'Abzu Governance — default account',
    status: 'active',
    ctx_metadata: { scope: 'governance' },
    mode: 'sandbox',
    ...overrides,
  } as Account<GovernanceAccountMeta>;
}

// In-memory notification_configs store. Keyed by account_id; values are the
// persisted subscriber set after replace-by-subscriber_id semantics. Lives for
// the lifetime of the process — restart wipes it (governance MVP is in-memory
// throughout; switch to durable storage when persistence becomes a hard
// requirement).
interface PersistedNotificationConfig {
  subscriber_id: string;
  url: string;
  event_types: readonly string[];
  active: boolean;
}
const configsByAccount = new Map<string, PersistedNotificationConfig[]>();

// AdCP 3.1 notification-type.json splits into two anchor surfaces:
//   account-level: creative.*, product.*, signal.*, wholesale_feed.bulk_change
//   media-buy-level: scheduled, final, delayed, adjusted, impairment
// JSON Schema permits the full enum on every notification_configs[]; rejection
// of media-buy-anchored event_types on account-level configs is semantic.
const MEDIA_BUY_ANCHORED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'scheduled',
  'final',
  'delayed',
  'adjusted',
  'impairment',
]);

export const accountStore: AccountStore<GovernanceAccountMeta> = {
  // Explicit resolution: callers reference accounts via {account_id}.
  // Required by AAO notification_config_lifecycle storyboards which read back
  // a previously-synced account by id. Single-tenant deployment: the resolver
  // returns the singleton account for any inline ref (account_id or brand/operator
  // pair); list_accounts surfaces the same singleton with its persisted configs.
  resolution: 'explicit',
  resolve: async () => buildAccount(),
  list: async () => {
    const primary = buildAccount();
    const configs = configsByAccount.get(primary.id);
    const enriched =
      configs !== undefined
        ? ({ ...primary, notification_configs: configs } as unknown as Account<GovernanceAccountMeta>)
        : primary;
    return { items: [enriched] };
  },
  upsert: async (refs, ctx) => {
    const principal = (ctx as { authInfo?: { clientId?: string } } | undefined)?.authInfo?.clientId;
    const isPassthroughOnly = principal === 'compliance-runner-passthrough';

    type WireEntry = {
      brand?: { domain?: string };
      operator?: string;
      account?: { account_id?: string };
      billing?: string;
      payment_terms?: string;
      notification_configs?: ReadonlyArray<{
        subscriber_id?: string;
        url?: string;
        event_types?: ReadonlyArray<string>;
        active?: boolean;
      }>;
    };
    const wireBody = ((ctx as unknown as { input?: { accounts?: WireEntry[] } } | undefined)?.input)
      ?.accounts;

    return refs.map((ref, i) => {
      const wire = wireBody?.[i];
      const refAny = ref as { brand?: { domain?: string }; operator?: string; account_id?: string };
      const wireAccountId = wire?.account?.account_id;
      const accountId = wireAccountId ?? refAny.account_id ?? SINGLETON_ID;
      const isSettingsUpdate = wireAccountId !== undefined || refAny.account_id !== undefined;

      const brand = wire?.brand ?? refAny.brand ?? { domain: 'governance.example' };
      const operator = wire?.operator ?? refAny.operator ?? 'governance.example';

      // billing_gate_dispatch/per_agent_gate_reject (AAO error_handling, 3.1).
      // supportedBillings advertises ['operator', 'agent'] — the capability
      // wire-level gate accepts both. The per-buyer-agent commercial-relationship
      // gate (row-level) rejects 'agent' for every caller because we have no
      // direct payments relationship with any buyer agent; all callers are
      // operationally passthrough-only. The clamped error.details shape
      // (additionalProperties: false) carries ONLY rejected_billing +
      // suggested_billing — no commercial-state oracle leakage.
      void isPassthroughOnly;
      if (wire?.billing === 'agent') {
        return {
          account_id: accountId,
          brand: brand as never,
          operator: operator,
          action: 'failed' as const,
          status: 'rejected' as const,
          errors: [
            {
              code: 'BILLING_NOT_PERMITTED_FOR_AGENT' as const,
              message:
                'No direct billing relationship with this buyer agent. Retry with the suggested_billing value under a fresh idempotency_key.',
              field: 'accounts[].billing',
              recovery: 'correctable' as const,
              details: {
                rejected_billing: 'agent',
                suggested_billing: 'operator',
              },
            },
          ],
        } as never;
      }

      // notification_configs validation: duplicate subscriber_id + media-buy-anchored
      // event_types are both rejected per scope (account-level here).
      const configs = wire?.notification_configs;
      if (Array.isArray(configs)) {
        const seen = new Set<string>();
        for (let j = 0; j < configs.length; j++) {
          const cfg = configs[j];
          if (cfg?.subscriber_id !== undefined) {
            if (seen.has(cfg.subscriber_id)) {
              return {
                account_id: accountId,
                brand: brand as never,
                operator: operator,
                action: 'failed' as const,
                status: 'rejected' as const,
                errors: [
                  {
                    code: 'INVALID_REQUEST' as const,
                    message: `Duplicate subscriber_id "${cfg.subscriber_id}" in notification_configs[]`,
                    field: `notification_configs[${j}].subscriber_id`,
                    recovery: 'correctable' as const,
                  },
                ],
              } as never;
            }
            seen.add(cfg.subscriber_id);
          }
          if (Array.isArray(cfg?.event_types)) {
            for (let k = 0; k < cfg.event_types.length; k++) {
              const et = cfg.event_types[k];
              if (et !== undefined && MEDIA_BUY_ANCHORED_EVENT_TYPES.has(et)) {
                return {
                  account_id: accountId,
                  brand: brand as never,
                  operator: operator,
                  action: 'failed' as const,
                  status: 'rejected' as const,
                  errors: [
                    {
                      code: 'INVALID_REQUEST' as const,
                      message: `Event type "${et}" is media-buy-anchored and not permitted on account-level notification_configs[]; use push_notification_config on the buy instead.`,
                      field: `notification_configs[${j}].event_types[${k}]`,
                      recovery: 'correctable' as const,
                    },
                  ],
                } as never;
              }
            }
          }
        }
      }

      // Persist with replace-by-subscriber_id semantics. Empty array clears.
      // Omitting the field is a no-op (preserves prior state).
      if (Array.isArray(configs)) {
        configsByAccount.set(
          accountId,
          configs
            .filter(
              (
                c,
              ): c is { subscriber_id: string; url: string; event_types: readonly string[]; active: boolean } =>
                typeof c?.subscriber_id === 'string' &&
                typeof c.url === 'string' &&
                Array.isArray(c.event_types) &&
                typeof c.active === 'boolean',
            )
            .map((c) => ({
              subscriber_id: c.subscriber_id,
              url: c.url,
              event_types: c.event_types,
              active: c.active,
            })),
        );
      }
      const persisted = configsByAccount.get(accountId);
      const action: 'created' | 'updated' = isSettingsUpdate ? 'updated' : 'created';

      // Always echo billing on success rows — per_agent_gate_recover (and the
      // sync-accounts-response examples) require accounts[].billing to be
      // populated so buyers can confirm the seller honoured the requested
      // model. Default to 'operator' (our supportedBillings primary) when
      // the caller omits it.
      const billing = (wire?.billing ?? 'operator') as never;
      return {
        account_id: accountId,
        brand: brand as never,
        operator: operator,
        name: buildAccount().name,
        action,
        status: 'active' as const,
        billing,
        ...(wire?.payment_terms ? { payment_terms: wire.payment_terms as never } : {}),
        ...(persisted !== undefined ? { notification_configs: persisted as never } : {}),
      };
    }) as never;
  },
};
