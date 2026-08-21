/**
 * channel-inbox-list-verb.test.ts
 *
 * `channels.inbox.list`, the eighth and last of the channels route-reconcile
 * debt, and the only one whose answer this SDK cannot produce on its own.
 *
 * The other seven were served here (routes/channel-sync.ts). This one is served
 * by the HOST that holds the provider credentials: it attaches a handler over
 * the catalog descriptor and answers from its synced provider mirror. So what
 * this file pins is the SEAM, at the level the SDK owns it:
 *
 *   1. The descriptor no longer claims to be uncallable, and its advertised
 *      path is in the gateway REST table.
 *   2. A host-attached handler is reachable over BOTH transports a client has,
 *      the methodId invoke (what the WebSocket `call` frame and the generic
 *      `/api/control/gateway-methods/:id/invoke` endpoint both run) and the
 *      plain REST path `GET /api/channels/inbox`, and both reach the SAME
 *      handler with the same params, rather than two implementations of one
 *      idea. The fixture stands in for the daemon's real Slack/Discord/IMAP
 *      mirror, which is not reachable from this package.
 *   3. The declared `read:channels` scope is enforced on that path.
 *   4. A build that attaches NO handler, every SDK-only process, which has no
 *      mailbox, answers 501 NOT_INVOKABLE naming the missing composition step,
 *      not the bare 404 a caller used to get. That is the honest answer, and it
 *      is why removing `invokable: false` did not just move the lie.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import {
  DaemonControlPlaneHelper,
  type DaemonControlPlaneContext,
} from '../packages/sdk/src/platform/daemon/control-plane.ts';
import {
  GATEWAY_REST_ROUTES,
  dispatchDaemonApiRoutes,
} from '../packages/daemon-sdk/src/index.ts';
import type {
  DaemonApiRouteHandlers,
  GatewayRestVerbInvocation,
} from '../packages/daemon-sdk/src/context.ts';
import type { GatewayMethodInvocation } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.ts';

const METHOD_ID = 'channels.inbox.list';

/**
 * A stand-in for a host's synced provider mirror: two Slack items, one email
 * item, and an IMAP account whose last sync failed. Deliberately shaped like
 * the real thing, the failing provider contributes no items AND says why, and
 * `partial` is true because those items exist and are not in the answer.
 */
const MIRROR = [
  { id: 'slack:1', provider: 'slack', kind: 'dm', from: 'a1b2c3d4e5f60718', bodyPreview: 'ping', receivedAt: 3_000, unread: true },
  { id: 'slack:2', provider: 'slack', kind: 'mention', from: 'a1b2c3d4e5f60718', bodyPreview: 'over here', receivedAt: 2_000, unread: false },
  { id: 'email:9', provider: 'email', kind: 'thread', from: '99887766554433aa', subject: 'Invoice', bodyPreview: 'attached', receivedAt: 1_000, unread: true },
] as const;

interface InboxAnswer {
  items: readonly { id: string; provider: string }[];
  total: number;
  truncated: boolean;
  hasMore: boolean;
  cursor?: string;
  nextCursor?: string;
  providers: readonly { provider: string; state: string; itemCount: number; storedCount: number; error?: string }[];
  partial: boolean;
}

/** Records every invocation the fixture handler saw, so "one handler" is checkable. */
interface FixtureHost {
  readonly catalog: GatewayMethodCatalog;
  readonly seen: GatewayMethodInvocation[];
}

function readNumber(invocation: GatewayMethodInvocation, field: string): number | undefined {
  const fromQuery = invocation.query?.[field];
  const fromBody = (invocation.body as Record<string, unknown> | undefined)?.[field];
  const raw = fromQuery ?? fromBody;
  if (raw === undefined || raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function readString(invocation: GatewayMethodInvocation, field: string): string | undefined {
  const fromQuery = invocation.query?.[field];
  const fromBody = (invocation.body as Record<string, unknown> | undefined)?.[field];
  const raw = fromQuery ?? fromBody;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Attach a fixture inbox handler the way a host does: look the SDK's descriptor
 * up and re-register it WITH a handler. No descriptor or schema is authored
 * here, that is the whole point of the seam.
 */
function fixtureHost(): FixtureHost {
  const catalog = new GatewayMethodCatalog();
  const seen: GatewayMethodInvocation[] = [];
  const descriptor = catalog.get(METHOD_ID);
  if (!descriptor) throw new Error(`${METHOD_ID} is not in the catalog`);
  catalog.register(descriptor, (invocation) => {
    seen.push(invocation);
    const provider = readString(invocation, 'provider');
    const limit = readNumber(invocation, 'limit') ?? 50;
    const matching = MIRROR.filter((item) => provider === undefined || item.provider === provider);
    const page = matching.slice(0, limit);
    const hasMore = matching.length > page.length;
    const answer: InboxAnswer = {
      items: page,
      total: matching.length,
      truncated: hasMore,
      hasMore,
      cursor: String(Math.max(0, ...matching.map((item) => item.receivedAt))),
      ...(hasMore ? { nextCursor: `after:${page[page.length - 1]!.id}` } : {}),
      providers: [
        { provider: 'slack', state: 'ready', itemCount: page.filter((i) => i.provider === 'slack').length, storedCount: 2 },
        { provider: 'email', state: 'ready', itemCount: page.filter((i) => i.provider === 'email').length, storedCount: 1 },
        { provider: 'imap-archive', state: 'error', itemCount: 0, storedCount: 0, error: 'IMAP LOGIN refused' },
      ],
      partial: true,
    };
    return Promise.resolve(answer);
  }, { replace: true });
  return { catalog, seen };
}

function helperFor(catalog: GatewayMethodCatalog): DaemonControlPlaneHelper {
  // Only `context.gatewayMethods` is touched on the invoke/scope path, so a
  // minimal stub is sufficient and honest, the same shape
  // runtime-metrics-gateway-verb.test.ts uses for the identical path.
  return new DaemonControlPlaneHelper({ gatewayMethods: catalog } as unknown as DaemonControlPlaneContext);
}

/**
 * Wire the plain-REST leg to the SAME helper the methodId invoke uses, exactly
 * as a daemon does: the route table hands over a methodId and the raw request,
 * and the query string becomes the invocation's params.
 */
function restHandlers(helper: DaemonControlPlaneHelper, scopes: readonly string[]): DaemonApiRouteHandlers {
  return {
    invokeGatewayRestVerb: async ({ methodId, req, params }: GatewayRestVerbInvocation) => {
      const url = new URL(req.url);
      const query: Record<string, unknown> = { ...params };
      for (const [key, value] of url.searchParams) query[key] = value;
      const result = await helper.invokeGatewayMethodCall({
        authToken: 'fixture-token',
        methodId,
        query,
        context: { scopes, admin: false },
      });
      return Response.json(result.body, { status: result.status });
    },
  } as unknown as DaemonApiRouteHandlers;
}

// ── the descriptor's own claims ─────────────────────────────────────────────

describe('the catalog entry', () => {
  test('is no longer marked uncallable, and advertises the path the REST table serves', () => {
    const descriptor = new GatewayMethodCatalog().get(METHOD_ID);
    expect(descriptor).not.toBeNull();
    expect(descriptor?.invokable).not.toBe(false);
    expect(descriptor?.http).toEqual({ method: 'GET', path: '/api/channels/inbox' });
    expect(descriptor?.scopes).toEqual(['read:channels']);
    const entry = GATEWAY_REST_ROUTES.find((route) => route.methodId === METHOD_ID);
    expect(entry, `${METHOD_ID} is missing from GATEWAY_REST_ROUTES`).toBeDefined();
    expect(entry!.method).toBe('GET');
    expect(entry!.regex.test('/api/channels/inbox')).toBe(true);
  });

  test('the output schema names every field the answer carries, including the per-provider states', () => {
    const descriptor = new GatewayMethodCatalog().get(METHOD_ID)!;
    const output = descriptor.outputSchema as {
      properties?: Record<string, unknown>;
      required?: readonly string[];
    };
    expect(Object.keys(output.properties ?? {}).sort()).toEqual(
      ['cursor', 'hasMore', 'items', 'nextCursor', 'partial', 'providers', 'total', 'truncated'],
    );
    // A client can rely on these being present in every answer, which is what
    // makes "zero items" readable rather than ambiguous.
    expect([...(output.required ?? [])].sort()).toEqual(
      ['hasMore', 'items', 'partial', 'providers', 'total', 'truncated'],
    );
    const input = descriptor.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(input.properties ?? {}).sort()).toEqual(['cursor', 'limit', 'provider', 'since']);
  });
});

// ── both transports, one handler ────────────────────────────────────────────

describe('a host-attached handler is reachable over both transports', () => {
  test('the methodId invoke returns the mirror, with per-provider state and the failing provider named', async () => {
    const host = fixtureHost();
    const result = await helperFor(host.catalog).invokeGatewayMethodCall({
      authToken: 'fixture-token',
      methodId: METHOD_ID,
      context: { scopes: ['read:channels'], admin: false },
    });

    expect(result.status).toBe(200);
    const body = result.body as InboxAnswer;
    expect(body.items.map((item) => item.id)).toEqual(['slack:1', 'slack:2', 'email:9']);
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(false);
    expect(body.truncated).toBe(body.hasMore);
    // The provider that failed contributes nothing AND is reported, which is the
    // difference between a partial answer and a silent hole.
    const failing = body.providers.find((entry) => entry.state === 'error');
    expect(failing?.provider).toBe('imap-archive');
    expect(failing?.error).toBe('IMAP LOGIN refused');
    expect(body.items.some((item) => item.provider === 'imap-archive')).toBe(false);
    expect(body.partial).toBe(true);
  });

  test('the advertised REST path reaches the same handler, and carries the query params to it', async () => {
    const host = fixtureHost();
    const helper = helperFor(host.catalog);
    const response = await dispatchDaemonApiRoutes(
      new Request('http://daemon.invalid/api/channels/inbox?provider=slack&limit=1', { method: 'GET' }),
      restHandlers(helper, ['read:channels']),
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = await response!.json() as InboxAnswer;
    // The filter and the page size both took effect, so the params really
    // reached the handler rather than being dropped by the REST leg.
    expect(body.items.map((item) => item.id)).toEqual(['slack:1']);
    expect(body.total).toBe(2);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe('after:slack:1');
    expect(host.seen).toHaveLength(1);
    expect(host.seen[0]!.query).toMatchObject({ provider: 'slack', limit: '1' });
  });

  test('the two transports answer identically for identical params — one handler, not two', async () => {
    const host = fixtureHost();
    const helper = helperFor(host.catalog);

    const viaMethodId = await helper.invokeGatewayMethodCall({
      authToken: 'fixture-token',
      methodId: METHOD_ID,
      query: { provider: 'email' },
      context: { scopes: ['read:channels'], admin: false },
    });
    const viaRest = await dispatchDaemonApiRoutes(
      new Request('http://daemon.invalid/api/channels/inbox?provider=email', { method: 'GET' }),
      restHandlers(helper, ['read:channels']),
    );

    expect(viaRest!.status).toBe(viaMethodId.status);
    expect(await viaRest!.json()).toEqual(viaMethodId.body);
    expect(host.seen).toHaveLength(2);
  });
});

// ── the declared scope is a real gate ───────────────────────────────────────

describe('read:channels is enforced on the way in', () => {
  test('a caller without the scope is refused before the handler runs', async () => {
    const host = fixtureHost();
    const result = await helperFor(host.catalog).invokeGatewayMethodCall({
      authToken: 'fixture-token',
      methodId: METHOD_ID,
      context: { scopes: ['read:sessions'], admin: false },
    });
    expect(result.status).toBe(403);
    expect((result.body as { missingScopes?: readonly string[] }).missingScopes).toEqual(['read:channels']);
    expect(host.seen).toHaveLength(0);
  });

  test('the same refusal happens on the REST leg, because it is the same gate', async () => {
    const host = fixtureHost();
    const response = await dispatchDaemonApiRoutes(
      new Request('http://daemon.invalid/api/channels/inbox', { method: 'GET' }),
      restHandlers(helperFor(host.catalog), ['read:sessions']),
    );
    expect(response!.status).toBe(403);
    expect(host.seen).toHaveLength(0);
  });
});

// ── a build with no mailbox says so ─────────────────────────────────────────

describe('an SDK-only build, with no inbox composition', () => {
  test('answers 501 naming the missing composition step rather than a bare 404', async () => {
    const catalog = new GatewayMethodCatalog();
    expect(catalog.hasHandler(METHOD_ID)).toBe(false);

    const result = await helperFor(catalog).invokeGatewayMethodCall({
      authToken: 'fixture-token',
      methodId: METHOD_ID,
      context: { scopes: ['read:channels'], admin: false },
    });

    // Not 404 (the id IS cataloged) and not 200 (nothing can answer). The path
    // routes back to this same methodId, so there is no other implementation to
    // reach and the answer is terminal, self-dispatch guard, not a retry.
    expect(result.status).toBe(501);
    const body = result.body as { code?: string; error?: string };
    expect(body.code).toBe('NOT_INVOKABLE');
    expect(body.error).toContain(METHOD_ID);
    expect(body.error).toContain('no handler is attached');
  });
});
