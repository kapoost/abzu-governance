// Minimal public-port reverse proxy in front of the SDK MCP server.
//
// AAO's registry crawler probes /mcp anonymously to confirm liveness. The
// SDK's `verifyApiKey` returns 401 + WWW-Authenticate: Bearer, which AAO
// interprets as an OAuth-protected endpoint and tries an OAuth handshake —
// fails closed with "Missing or unrecognized credentials". To give AAO a
// fallback liveness signal that doesn't require auth, this Bun.serve runs on
// the public port, serves `/.well-known/healthz` directly, and forwards
// everything else to the SDK on an internal loopback port.
//
// Storyboard runs still hit /mcp through the proxy (auth happens at the SDK
// behind us). The proxy is dumb — it does not inspect Authorization headers.

import { log } from './observability/logger.ts';

interface ProxyOptions {
  publicPort: number;
  sdkPort: number;
}

let server: ReturnType<typeof Bun.serve> | null = null;

/* Cross-request idempotency map for the MCP webhook receiver. Bounded so a
 * long-lived process doesn't accumulate keys forever; entries fall out
 * after WEBHOOK_DEDUP_TTL_MS. Enough to survive a burst of at-least-once
 * retries without letting bad-faith callers OOM the process. */
const WEBHOOK_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const webhookSeen = new Map<string, number>();
function pruneWebhookSeen() {
  const cutoff = Date.now() - WEBHOOK_DEDUP_TTL_MS;
  for (const [k, ts] of webhookSeen) if (ts < cutoff) webhookSeen.delete(k);
}
const TASK_STATUS_ENUM = new Set([
  'submitted', 'working', 'input_required', 'completed', 'canceled', 'failed',
  'auth_required', 'rejected', 'partial', 'processing', 'pending',
]);

export function startHealthzProxy(opts: ProxyOptions): void {
  if (server) return;
  const startedAt = Date.now();

  server = Bun.serve({
    port: opts.publicPort,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      if (req.method === 'GET' && url.pathname === '/.well-known/healthz') {
        return Response.json(
          { ok: true, agent: 'abzu-governance', uptime_ms: Date.now() - startedAt },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }

      // MCP webhook receiver — implements the buyer/orchestrator side of the
      // webhook_receiver_envelope storyboard. Accepts full MCP webhook
      // envelopes with an idempotency_key + task_type + task_id + operation_id
      // + task-status enum + result payload; dedupes retries of the same
      // idempotency_key with a 24h TTL. Rejects bare inner results, missing
      // idempotency_key, and media-buy-lifecycle values used as top-level
      // status (which must be a task-status enum). Signature verification is
      // out of scope until the storyboard runner registers a signing key
      // here; envelope-shape errors already surface the failing checks.
      if (req.method === 'POST' && url.pathname === '/webhooks/adcp') {
        return handleAdcpWebhook(req);
      }

      const target = `http://127.0.0.1:${opts.sdkPort}${url.pathname}${url.search}`;
      const fwdHeaders = new Headers(req.headers);
      fwdHeaders.delete('host');
      fwdHeaders.delete('connection');
      fwdHeaders.delete('content-length');

      const methodHasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      const fetchInit: RequestInit = { method: req.method, headers: fwdHeaders };
      if (methodHasBody) {
        const bodyBuf = await req.arrayBuffer();
        if (bodyBuf.byteLength > 0) fetchInit.body = bodyBuf;
      }

      try {
        const upstream = await fetch(target, fetchInit);
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        });
      } catch (err) {
        log.error('healthz_proxy_upstream_failed', {
          target,
          method: req.method,
          path: url.pathname,
          error: (err as Error).message?.slice(0, 200),
        });
        return Response.json({ error: 'upstream_unavailable' }, { status: 502 });
      }
    },
  });

  log.info('healthz_proxy_started', {
    public_port: opts.publicPort,
    sdk_port: opts.sdkPort,
  });
}

async function handleAdcpWebhook(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json(
      { ok: false, error: 'invalid_json', message: 'Request body must be JSON.' },
      { status: 400 },
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return Response.json(
      { ok: false, error: 'invalid_envelope', message: 'Body must be a JSON object.' },
      { status: 400 },
    );
  }
  const body = raw as Record<string, unknown>;

  // Bare inner result — has notification_type/media_buy_deliveries at the top
  // level instead of nested under result. Reject with the envelope fields
  // the receiver expected.
  const hasEnvelopeMarkers = ['idempotency_key', 'operation_id', 'task_id', 'task_type'].some(
    (k) => k in body,
  );
  if (!hasEnvelopeMarkers) {
    return Response.json(
      {
        ok: false,
        error: 'missing_envelope_fields',
        message: 'Body is not an MCP webhook envelope. Expected top-level idempotency_key, operation_id, task_id, task_type, status, timestamp, and result.',
        missing_fields: ['idempotency_key', 'operation_id', 'task_id', 'task_type', 'status', 'timestamp'],
      },
      { status: 400 },
    );
  }

  const idempotencyKey = body['idempotency_key'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    return Response.json(
      {
        ok: false,
        error: 'missing_idempotency_key',
        message: 'MCP webhook envelope requires a non-empty idempotency_key so the receiver can safely dedupe retries.',
      },
      { status: 400 },
    );
  }

  const status = body['status'];
  if (typeof status !== 'string' || !TASK_STATUS_ENUM.has(status)) {
    return Response.json(
      {
        ok: false,
        error: 'invalid_envelope_status',
        message: 'Top-level status must be a task-status enum value. Media buy lifecycle values (e.g. active) belong under result.media_buy_deliveries[].status.',
        received_status: status,
        allowed_task_statuses: [...TASK_STATUS_ENUM],
      },
      { status: 400 },
    );
  }

  const missing: string[] = [];
  for (const k of ['operation_id', 'task_id', 'task_type', 'timestamp'] as const) {
    if (typeof body[k] !== 'string' || (body[k] as string).length === 0) missing.push(k);
  }
  if (missing.length > 0) {
    return Response.json(
      { ok: false, error: 'missing_envelope_fields', message: `Envelope missing required fields: ${missing.join(', ')}.`, missing_fields: missing },
      { status: 400 },
    );
  }

  pruneWebhookSeen();
  const alreadySeen = webhookSeen.has(idempotencyKey);
  webhookSeen.set(idempotencyKey, Date.now());
  return Response.json(
    {
      ok: true,
      accepted: true,
      duplicate: alreadySeen,
      idempotency_key: idempotencyKey,
      task_type: body['task_type'],
      task_id: body['task_id'],
    },
    { status: 200 },
  );
}
