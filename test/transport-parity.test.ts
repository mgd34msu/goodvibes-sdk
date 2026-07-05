/**
 * transport-parity.test.ts  (One-Platform Wave 1, S2b)
 *
 * THE PARITY GATE. HTTP + WebSocket parity is automatic (the operator-sdk client is
 * contract-driven), but DirectTransport (the TUI's in-process path) is HAND-WIRED in
 * runtime/operator-client.ts — a method can be HTTP-reachable while being invisible
 * in-process, and nothing caught that today. This gate makes the asymmetry fail loudly so
 * Wave-3 `fleet.*` (which the TUI renders locally) cannot silently ship HTTP-only.
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
  'sessions.steer': 'steerMessage',
  'sessions.followUp': 'followUpMessage',
  'sessions.messages.list': 'messages',
  'sessions.messages.create': 'submitMessage',
  'sessions.inputs.list': 'inputs',
  'sessions.inputs.cancel': 'cancelInput',
  'sessions.integration.snapshot': 'current',
};

interface ParityViolation { readonly id: string; readonly reason: string }

/** Contract-internal transport-declaration honesty. */
function findTransportHonestyViolations(
  methods: readonly { id: string; transport?: readonly string[]; http?: unknown }[],
): ParityViolation[] {
  const violations: ParityViolation[] = [];
  for (const m of methods) {
    const declaresHttp = (m.transport ?? []).includes('http');
    const hasBinding = m.http != null;
    if (declaresHttp && !hasBinding) {
      violations.push({ id: m.id, reason: 'declares http transport but has no http binding (unreachable)' });
    }
    if (hasBinding && !declaresHttp) {
      violations.push({ id: m.id, reason: 'has an http binding but does not declare http transport' });
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
      { id: 'phantom.method', transport: ['http', 'ws'], http: undefined },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.id).toBe('phantom.method');
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
    // Simulate Wave-3 adding fleet.list HTTP-only without a DirectTransport decision.
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
