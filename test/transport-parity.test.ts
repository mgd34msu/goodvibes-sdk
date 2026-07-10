/**
 * transport-parity.test.ts  (One-Platform parity gate, S2b)
 *
 * THE PARITY GATE. HTTP + WebSocket parity is automatic (the operator-sdk client is
 * contract-driven), but DirectTransport (the TUI's in-process path) is HAND-WIRED in
 * runtime/operator-client.ts — a method can be HTTP-reachable while being invisible
 * in-process, and nothing caught that today. This gate makes the asymmetry fail loudly so
 * a later `fleet.*` addition (which the TUI renders locally) cannot silently ship HTTP-only.
 *
 * It enforces three properties:
 *   1. Transport-declaration honesty: a method that advertises `http` transport MUST carry
 *      an http binding, and vice-versa (present-in-one-transport-but-not-the-other fails).
 *   2. DirectTransport coverage: every in-process namespace method (`sessions.*`, and
 *      `fleet.*` once it lands) MUST be declared in the coverage manifest as either mapped
 *      to a real operator-client method or explicitly `http-only`. Adding a method without
 *      a decision fails.
 *   3. Cataloged-but-not-invokable is an honest 501 (via the contract-driven client),
 *      never a silent 200.
 *
 * See docs/contract-regeneration-recipe.md for the full add-a-namespace procedure this gate
 * backstops.
 */
import { describe, expect, test } from 'bun:test';
import { buildOperatorContract } from '../packages/sdk/src/platform/control-plane/operator-contract.js';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.js';
import { createOperatorClient } from '../packages/sdk/src/platform/runtime/operator-client.js';
import type { OperatorClientServices } from '../packages/sdk/src/platform/runtime/foundation-services.js';
import { createOperatorRemoteClient } from '../packages/operator-sdk/src/client-core.js';
import { createHttpTransport } from '../packages/transport-http/dist/index.js';
import { getOperatorContract } from '../packages/contracts/dist/index.js';
import { GoodVibesSdkError } from '../packages/errors/dist/index.js';

/** Namespaces whose methods are consumed IN-PROCESS by a product (the TUI) via DirectTransport. */
const DIRECT_TRANSPORT_NAMESPACES = ['sessions', 'fleet'] as const;

/**
 * The DirectTransport coverage manifest. Every `sessions.*` / `fleet.*` contract method id
 * MUST appear here, mapped to either:
 *   - the name of the method on createOperatorClient(...).sessions (or .fleet) that serves
 *     it in-process, OR
 *   - the sentinel 'http-only' if the method is intentionally NOT exposed in-process
 *     (webui-only) — a documented, deliberate skip.
 *
 * A new namespace method with no entry here FAILS the gate — that is the forcing function.
 */
const DIRECT_TRANSPORT_COVERAGE: Record<string, string> = {
  // sessions.* → operator-client `sessions` surface (runtime/operator-client.ts)
  'sessions.list': 'list',
  'sessions.get': 'get',
  'sessions.create': 'ensureSession',
  'sessions.register': 'register',
  'sessions.close': 'close',
  'sessions.reopen': 'reopen',
  'sessions.detach': 'detach',
  'sessions.delete': 'delete',
  'sessions.steer': 'steerMessage',
  'sessions.followUp': 'followUpMessage',
  'sessions.messages.list': 'messages',
  'sessions.messages.create': 'submitMessage',
  'sessions.inputs.list': 'inputs',
  'sessions.inputs.cancel': 'cancelInput',
  'sessions.inputs.deliver': 'deliverInput',
  'sessions.integration.snapshot': 'current',
  // sessions.search: a NEW, wire-only query (cursor pagination over
  // the home-scoped store) with no existing in-process consumer — every
  // other sessions.* verb here mirrors whole-session access the TUI already
  // gets in-process via services.sessionBroker directly (through this same
  // operator-client), which sessions.search does not add anything over.
  // 'http-only' documents the deliberate skip; add a DirectTransport wrapper
  // if/when a concrete in-process consumer (e.g. T2's union surface) needs
  // cursor pagination without going through the wire.
  'sessions.search': 'http-only',
  // sessions.permissionMode.get/set + sessions.contextUsage.get: session-scoped
  // permission mode and context-usage RPCs that exist for REMOTE surfaces
  // (webui) which cannot read the in-process per-session runtime state the TUI
  // sees directly. The TUI reads its own runtime's permission mode + context
  // usage in-process (config + the session read model), so no DirectTransport
  // wrapper is needed — 'http-only' documents that deliberate skip.
  'sessions.permissionMode.get': 'http-only',
  'sessions.permissionMode.set': 'http-only',
  'sessions.contextUsage.get': 'http-only',
  // sessions.changes.get: aggregate workspace file changes for a session,
  // joined over its stamped WorkspaceCheckpoints. A wire-only read for REMOTE
  // surfaces that cannot reach the in-process workspaceCheckpointManager the
  // TUI holds directly — 'http-only' documents the deliberate skip, exactly as
  // sessions.search / checkpoints.* do.
  'sessions.changes.get': 'http-only',
  // fleet.*: the TUI's fleet panel (src/panels/fleet-read-model.ts)
  // already holds a direct reference to the SDK's ProcessRegistry and calls
  // `registry.query()` in-process — it does NOT go through operator-client
  // at all, so no DirectTransport wrapper is needed here. fleet.snapshot/
  // fleet.list exist for REMOTE consumers (webui, a detached session view)
  // that don't share the daemon's process and can only reach the registry
  // over the wire.
  'fleet.snapshot': 'http-only',
  'fleet.list': 'http-only',
  // fleet archive verbs: same in-process story as fleet.snapshot/fleet.list —
  // the TUI drives the archive through its direct ArchivableProcessRegistry
  // reference (withFleetArchive, runtime/fleet/archive.ts); the wire verbs
  // exist for remote consumers (webui archive view).
  'fleet.archive': 'http-only',
  'fleet.unarchive': 'http-only',
  'fleet.archiveFinished': 'http-only',
  'fleet.archived.list': 'http-only',
  // fleet.attempts.* (best-of-N held-merge): same in-process story as the other
  // fleet.* verbs — the TUI drives best-of-N through its direct orchestration
  // engine reference (listHeldMergeGroups / pickAttemptWinner / proposeAttemptWinner),
  // not through operator-client; the wire verbs exist for remote consumers
  // (a webui diff-review cockpit).
  'fleet.attempts.list': 'http-only',
  'fleet.attempts.pick': 'http-only',
  'fleet.attempts.judge': 'http-only',
};

interface ParityViolation { readonly id: string; readonly reason: string }

/** Contract-internal transport-declaration honesty (http AND ws legs). */
function findTransportHonestyViolations(
  methods: readonly { id: string; transport?: readonly string[]; http?: unknown; invokable?: boolean }[],
): ParityViolation[] {
  const violations: ParityViolation[] = [];
  for (const m of methods) {
    const transport = m.transport ?? [];
    const declaresHttp = transport.includes('http');
    const declaresWs = transport.includes('ws');
    const hasBinding = m.http != null;
    if (declaresHttp && !hasBinding) {
      violations.push({ id: m.id, reason: 'declares http transport but has no http binding (unreachable)' });
    }
    if (hasBinding && !declaresHttp) {
      violations.push({ id: m.id, reason: 'has an http binding but does not declare http transport' });
    }
    // WS parity leg: the gateway WS `call` frame dispatches a method by id through
    // its internal handler or, failing that, its http binding (control-plane.ts).
    // So a ws-declared method must be dispatchable = has an http binding OR is an
    // invokable gateway method. A ws advert with neither is an unreachable phantom.
    if (declaresWs) {
      const wsDispatchable = hasBinding || m.invokable !== false;
      if (!wsDispatchable) {
        violations.push({ id: m.id, reason: 'declares ws transport but is not dispatchable (no http binding and not an invokable gateway method)' });
      }
    }
  }
  return violations;
}

/** DirectTransport coverage: in-process methods must be mapped or explicitly http-only. */
function findDirectTransportGaps(
  methodIds: readonly string[],
  manifest: Record<string, string>,
  exposedByNamespace: Record<string, ReadonlySet<string>>,
): ParityViolation[] {
  const violations: ParityViolation[] = [];
  for (const id of methodIds) {
    const namespace = id.split('.')[0]!;
    if (!DIRECT_TRANSPORT_NAMESPACES.includes(namespace as (typeof DIRECT_TRANSPORT_NAMESPACES)[number])) continue;
    const mapped = manifest[id];
    if (!mapped) {
      violations.push({ id, reason: `no DirectTransport disposition — add to DIRECT_TRANSPORT_COVERAGE (map to a client method or 'http-only')` });
      continue;
    }
    if (mapped === 'http-only') continue;
    const exposed = exposedByNamespace[namespace] ?? new Set<string>();
    if (!exposed.has(mapped)) {
      violations.push({ id, reason: `mapped to operator-client method '${mapped}' which does not exist on the ${namespace} surface` });
    }
  }
  return violations;
}

function sessionsClientMethodNames(): ReadonlySet<string> {
  // createOperatorClient wires closures lazily; construction never touches services.
  const client = createOperatorClient({} as unknown as OperatorClientServices);
  return new Set(Object.keys(client.sessions));
}

// ---------------------------------------------------------------------------
// 1. Transport-declaration honesty
// ---------------------------------------------------------------------------

describe('S2b parity gate — transport-declaration honesty', () => {
  test('no contract method advertises a transport it is not reachable on', () => {
    const contract = buildOperatorContract(new GatewayMethodCatalog());
    const violations = findTransportHonestyViolations(contract.operator.methods);
    expect(violations).toEqual([]);
  });

  test('the honesty check CATCHES an http-transport method with no binding', () => {
    const violations = findTransportHonestyViolations([
      { id: 'phantom.method', transport: ['http'], http: undefined },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.id).toBe('phantom.method');
  });

  test('the WS parity leg CATCHES a ws-declared method that is not dispatchable', () => {
    // ws-declared, no http binding, and explicitly not invokable → unreachable phantom.
    const violations = findTransportHonestyViolations([
      { id: 'phantom.ws', transport: ['ws'], http: undefined, invokable: false },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toContain('ws transport');
  });

  test('the WS parity leg PASSES a ws-declared method dispatchable via its http binding', () => {
    const violations = findTransportHonestyViolations([
      { id: 'ok.ws', transport: ['http', 'ws'], http: { method: 'GET', path: '/api/ok' } },
    ]);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. DirectTransport coverage (the real hole)
// ---------------------------------------------------------------------------

describe('S2b parity gate — DirectTransport coverage', () => {
  test('every in-process namespace method is mapped or explicitly http-only', () => {
    const contract = buildOperatorContract(new GatewayMethodCatalog());
    const ids = contract.operator.methods.map((m) => m.id);
    const gaps = findDirectTransportGaps(ids, DIRECT_TRANSPORT_COVERAGE, {
      sessions: sessionsClientMethodNames(),
      fleet: new Set(),
    });
    expect(gaps).toEqual([]);
  });

  test('every mapped operator-client method actually exists (no phantom mapping)', () => {
    const exposed = sessionsClientMethodNames();
    for (const [id, method] of Object.entries(DIRECT_TRANSPORT_COVERAGE)) {
      if (method === 'http-only' || !id.startsWith('sessions.')) continue;
      expect(exposed.has(method)).toBe(true);
    }
  });

  test('the coverage gate FAILS for a new namespace method with no disposition (forcing function)', () => {
    // Simulate a later addition of fleet.list HTTP-only without a DirectTransport decision.
    const gaps = findDirectTransportGaps(
      ['sessions.list', 'fleet.list'],
      { 'sessions.list': 'list' }, // fleet.list intentionally absent
      { sessions: sessionsClientMethodNames(), fleet: new Set() },
    );
    expect(gaps.map((g) => g.id)).toContain('fleet.list');
  });

  test('the coverage gate CATCHES a mapping to a non-existent client method', () => {
    const gaps = findDirectTransportGaps(
      ['sessions.list'],
      { 'sessions.list': 'thisMethodDoesNotExist' },
      { sessions: sessionsClientMethodNames(), fleet: new Set() },
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.reason).toContain('does not exist');
  });
});

// ---------------------------------------------------------------------------
// 2b. DirectTransport ROUTING: a mapped name must fire the RIGHT broker method
//     (name-existence alone cannot catch a mis-wire like list→getSession).
// ---------------------------------------------------------------------------

describe('S2b parity gate — DirectTransport routing (effect-based)', () => {
  // wire id → { the args to call the mapped client method with, the underlying
  // services effect it MUST produce }. Covers all non-http-only manifest mappings.
  const ROUTING: Record<string, { args: readonly unknown[]; effect: string }> = {
    'sessions.list': { args: [10], effect: 'sessionBroker.listSessions' },
    'sessions.get': { args: ['s'], effect: 'sessionBroker.getSession' },
    'sessions.create': { args: [{}], effect: 'sessionBroker.ensureSession' },
    'sessions.register': { args: [{ sessionId: 's', participant: { surfaceKind: 'tui', surfaceId: 'x', lastSeenAt: 0 } }], effect: 'sessionBroker.register' },
    'sessions.close': { args: ['s'], effect: 'sessionBroker.closeSession' },
    'sessions.reopen': { args: ['s'], effect: 'sessionBroker.reopenSession' },
    'sessions.detach': { args: ['s', 'surface-1'], effect: 'sessionBroker.detachParticipant' },
    'sessions.delete': { args: ['s'], effect: 'sessionBroker.deleteSession' },
    'sessions.steer': { args: [{}], effect: 'sessionBroker.steerMessage' },
    'sessions.followUp': { args: [{}], effect: 'sessionBroker.followUpMessage' },
    'sessions.messages.list': { args: ['s'], effect: 'sessionBroker.getMessages' },
    'sessions.messages.create': { args: [{}], effect: 'sessionBroker.submitMessage' },
    'sessions.inputs.list': { args: ['s'], effect: 'sessionBroker.getInputs' },
    'sessions.inputs.cancel': { args: ['s', 'i'], effect: 'sessionBroker.cancelInput' },
    'sessions.inputs.deliver': { args: ['s', 'i'], effect: 'sessionBroker.markInputDelivered' },
    'sessions.integration.snapshot': { args: [], effect: 'readModels.session.getSnapshot' },
  };

  function makeSpyClient(): { client: ReturnType<typeof createOperatorClient>; calls: string[] } {
    const calls: string[] = [];
    const brokerSpy = (label: string, ret: unknown) => (..._a: unknown[]) => { calls.push(`sessionBroker.${label}`); return ret; };
    const services = {
      sessionBroker: {
        listSessions: brokerSpy('listSessions', []),
        getSession: brokerSpy('getSession', null),
        getMessages: brokerSpy('getMessages', []),
        getInputs: brokerSpy('getInputs', []),
        ensureSession: brokerSpy('ensureSession', Promise.resolve({})),
        register: brokerSpy('register', Promise.resolve({ record: {}, reopened: false })),
        closeSession: brokerSpy('closeSession', Promise.resolve(null)),
        reopenSession: brokerSpy('reopenSession', Promise.resolve(null)),
        detachParticipant: brokerSpy('detachParticipant', Promise.resolve(null)),
        deleteSession: brokerSpy('deleteSession', Promise.resolve('deleted')),
        bindAgent: brokerSpy('bindAgent', Promise.resolve(null)),
        submitMessage: brokerSpy('submitMessage', Promise.resolve({})),
        steerMessage: brokerSpy('steerMessage', Promise.resolve({})),
        followUpMessage: brokerSpy('followUpMessage', Promise.resolve({})),
        cancelInput: brokerSpy('cancelInput', Promise.resolve(null)),
        getInputsSince: brokerSpy('getInputsSince', []),
        markInputDelivered: brokerSpy('markInputDelivered', Promise.resolve(null)),
      },
      readModels: {
        session: { getSnapshot: () => { calls.push('readModels.session.getSnapshot'); return {}; } },
        tasks: { getSnapshot: () => ({ tasks: [] }) },
      },
      approvalBroker: {},
    } as unknown as OperatorClientServices;
    return { client: createOperatorClient(services), calls };
  }

  test('every manifest mapping routes to the correct broker/read-model effect', () => {
    for (const [wireId, mappedMethod] of Object.entries(DIRECT_TRANSPORT_COVERAGE)) {
      if (mappedMethod === 'http-only') continue;
      const routing = ROUTING[wireId];
      expect(routing, `ROUTING is missing an entry for ${wireId}`).toBeDefined();
      const { client, calls } = makeSpyClient();
      const fn = (client.sessions as unknown as Record<string, (...a: unknown[]) => unknown>)[mappedMethod];
      expect(typeof fn, `${wireId} → sessions.${mappedMethod} must exist`).toBe('function');
      void fn(...routing!.args);
      // The RIGHT underlying method fired — a mis-wire (e.g. list→getSession) fails here.
      expect(calls, `${wireId} → sessions.${mappedMethod} must fire ${routing!.effect}`).toContain(routing!.effect);
    }
  });

  test('integration.snapshot maps to current → readModels.session.getSnapshot (not a broker call)', () => {
    const { client, calls } = makeSpyClient();
    client.sessions.current();
    expect(calls).toEqual(['readModels.session.getSnapshot']);
  });
});

// ---------------------------------------------------------------------------
// 3. Cataloged-but-not-invokable is an honest failure, never a silent 200
// ---------------------------------------------------------------------------

describe('S2b parity gate — cataloged-but-not-invokable is honest', () => {
  test('a method with no http binding is not HTTP-invokable via the contract-driven client', () => {
    const transport = createHttpTransport({ baseUrl: 'http://127.0.0.1:3210', fetch: async () => new Response('{}') });
    const contract = {
      operator: { methods: [{ id: 'internal.only', description: 'internal', http: null }] },
    } as unknown as ReturnType<typeof getOperatorContract>;
    const client = createOperatorRemoteClient(transport, contract);
    expect(() => client.invoke('internal.only' as never)).toThrow(GoodVibesSdkError);
  });

  test('HTTP parity is automatic: listOperations enumerates every contract method', () => {
    const transport = createHttpTransport({ baseUrl: 'http://127.0.0.1:3210', fetch: async () => new Response('{}') });
    const contract = getOperatorContract();
    const client = createOperatorRemoteClient(transport, contract);
    expect(client.listOperations()).toHaveLength(contract.operator.methods.length);
  });
});
