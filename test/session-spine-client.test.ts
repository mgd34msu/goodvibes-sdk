/**
 * session-spine-client.test.ts
 *
 * Unit evidence for the extracted SDK session-spine core (W3-S4). Proves the ONE
 * core drives identically through BOTH real transport shapes:
 *  - a TYPED adapter (TUI-style: wraps a typed sessions client, resolve->ok /
 *    throw->offline), and
 *  - a REST adapter (agent-style: wraps a version-tolerant REST mirror that folds
 *    ok / connected_host_unavailable / auth_required into ok/offline/rejected).
 *
 * Coverage: parameterized queue/heartbeat/keepalive parity across both adapters;
 * dormant-until-activate vs live-immediately construction; the 128-drop-oldest
 * offline ring; the 45s-cadence keepalive; reopen/legacy-fold semantics; and
 * result-kind folding (a durable reject does NOT enqueue+retry-forever; a transient
 * offline DOES queue).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RegisterSharedSessionInput,
  SharedSessionRecord,
  SharedSessionRegisterResult,
} from '../packages/sdk/src/platform/control-plane/index.ts';
import {
  AGENT_SPINE_PARTICIPANT,
  foldLegacySpineStore,
  SessionSpineClient,
  TUI_SPINE_PARTICIPANT,
  type SpineResult,
  type SpineTransport,
} from '../packages/sdk/src/platform/runtime/session-spine/index.ts';

const silent = { debug: () => {}, info: () => {} };

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

interface CapturedCall {
  readonly kind: 'register' | 'close';
  readonly sessionId: string;
  readonly input?: RegisterSharedSessionInput;
}

function fakeRecord(id: string, over: Partial<SharedSessionRecord> = {}): SharedSessionRecord {
  return {
    id,
    kind: 'tui',
    project: '/p',
    title: '',
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    messageCount: 0,
    pendingInputCount: 0,
    routeIds: [],
    surfaceKinds: [],
    participants: [],
    metadata: {},
    ...over,
  } as SharedSessionRecord;
}

/**
 * An adapter fixture: a SpineTransport that captures calls and can be flipped
 * between succeed/fail. Both the typed and REST adapters implement this shape so a
 * single parameterized suite proves identical core behavior.
 */
interface AdapterFixture {
  readonly name: string;
  readonly transport: SpineTransport;
  readonly calls: CapturedCall[];
  mode: 'succeed' | 'fail';
  readonly participant: typeof TUI_SPINE_PARTICIPANT;
}

/** TUI-style: wraps a typed sessions client; resolve -> 'ok', throw -> 'offline' (binary). */
function typedAdapter(): AdapterFixture {
  const calls: CapturedCall[] = [];
  const state = { mode: 'succeed' as 'succeed' | 'fail' };
  const client = {
    register: (input: RegisterSharedSessionInput): Promise<SharedSessionRegisterResult> => {
      calls.push({ kind: 'register', sessionId: input.sessionId, input });
      if (state.mode === 'fail') return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve({ record: fakeRecord(input.sessionId), reopened: input.reopen === true });
    },
    close: (sessionId: string): Promise<SharedSessionRecord | null> => {
      calls.push({ kind: 'close', sessionId });
      if (state.mode === 'fail') return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(fakeRecord(sessionId, { status: 'closed' }));
    },
  };
  const transport: SpineTransport = {
    register: async (input) => {
      try { await client.register(input); return { outcome: 'ok' }; }
      catch (e) { return { outcome: 'offline', error: String(e) }; }
    },
    close: async (id) => {
      try { await client.close(id); return { outcome: 'ok' }; }
      catch (e) { return { outcome: 'offline', error: String(e) }; }
    },
  };
  return {
    name: 'typed',
    transport,
    calls,
    participant: TUI_SPINE_PARTICIPANT,
    get mode() { return state.mode; },
    set mode(v) { state.mode = v; },
  };
}

type RestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'connected_host_unavailable' | 'auth_required' | 'connected_host_route_unavailable' | 'connected_host_error' };

function foldRest(r: RestResult): SpineResult {
  if (r.ok) return { outcome: 'ok' };
  if (r.kind === 'connected_host_unavailable') return { outcome: 'offline', error: r.kind };
  return { outcome: 'rejected', error: r.kind };
}

/** Agent-style: wraps a version-tolerant REST mirror; folds result kinds via foldRest. */
function restAdapter(): AdapterFixture {
  const calls: CapturedCall[] = [];
  const state = { mode: 'succeed' as 'succeed' | 'fail' };
  const rest = {
    register: (input: RegisterSharedSessionInput): Promise<RestResult> => {
      calls.push({ kind: 'register', sessionId: input.sessionId, input });
      return Promise.resolve(state.mode === 'fail' ? { ok: false, kind: 'connected_host_unavailable' } : { ok: true });
    },
    close: (sessionId: string): Promise<RestResult> => {
      calls.push({ kind: 'close', sessionId });
      return Promise.resolve(state.mode === 'fail' ? { ok: false, kind: 'connected_host_unavailable' } : { ok: true });
    },
  };
  const transport: SpineTransport = {
    register: async (input) => foldRest(await rest.register(input)),
    close: async (id) => foldRest(await rest.close(id)),
  };
  return {
    name: 'rest',
    transport,
    calls,
    participant: AGENT_SPINE_PARTICIPANT,
    get mode() { return state.mode; },
    set mode(v) { state.mode = v; },
  };
}

const adapters: Array<() => AdapterFixture> = [typedAdapter, restAdapter];

for (const makeAdapter of adapters) {
  const sample = makeAdapter();
  describe(`SessionSpineClient parity — ${sample.name} adapter`, () => {
    test('activate() flushes everything queued while dormant, exactly once each', async () => {
      const fix = makeAdapter();
      const client = new SessionSpineClient({ participant: fix.participant, log: silent });
      client.register({ sessionId: 's1', project: '/p', title: 'T' });
      client.close('s1');
      expect(client.pendingOps).toBe(2);
      expect(client.active).toBe(false);

      client.activate(fix.transport);
      await settle();
      expect(client.active).toBe(true);
      expect(client.pendingOps).toBe(0);
      expect(client.status()).toBe('online');
      expect(fix.calls.filter((c) => c.kind === 'register')).toHaveLength(1);
      expect(fix.calls.filter((c) => c.kind === 'close')).toHaveLength(1);
      client.dispose();
    });

    test('register/heartbeat/reopen/close return synchronously (no interactive stall)', () => {
      const fix = makeAdapter();
      const client = new SessionSpineClient({ participant: fix.participant, transport: fix.transport, log: silent });
      const start = Date.now();
      client.register({ sessionId: 's1', project: '/p', title: 'T' });
      client.heartbeat('s1');
      client.reopen({ sessionId: 's2', project: '/p' });
      client.close('s3');
      expect(Date.now() - start).toBeLessThan(20);
      expect(client.status()).toBe('unknown'); // network has not settled — no premature online
      client.dispose();
    });

    test('offline register queues; recovering the backend flushes it once (idempotent replay)', async () => {
      const fix = makeAdapter();
      fix.mode = 'fail';
      const client = new SessionSpineClient({ participant: fix.participant, transport: fix.transport, log: silent });
      client.register({ sessionId: 's1', project: '/p', title: 'T' });
      await settle();
      expect(client.status()).toBe('offline');
      expect(client.pendingOps).toBe(1);

      fix.mode = 'succeed';
      client.heartbeat('s1'); // any op triggers a flush attempt
      await settle();
      expect(client.status()).toBe('online');
      expect(client.pendingOps).toBe(0);
      client.dispose();
    });

    test('bounded ring drops the oldest op past the 128 cap (default) / small cap', () => {
      const fix = makeAdapter();
      const client = new SessionSpineClient({ participant: fix.participant, queueLimit: 2, log: silent });
      for (const id of ['a', 'b', 'c']) client.register({ sessionId: id, project: '/p' });
      expect(client.pendingOps).toBe(2); // 'a' dropped
      client.dispose();
    });

    test('default queue cap is 128 (drop-oldest past it)', () => {
      const fix = makeAdapter();
      const client = new SessionSpineClient({ participant: fix.participant, log: silent });
      for (let i = 0; i < 200; i += 1) client.register({ sessionId: `s${i}`, project: '/p' });
      expect(client.pendingOps).toBe(128);
      client.dispose();
    });

    test('heartbeat debounce coalesces bursty activity to one leading wire call per window; beats omit title', async () => {
      let clock = 100_000;
      const fix = makeAdapter();
      const client = new SessionSpineClient({ participant: fix.participant, transport: fix.transport, now: () => clock, heartbeatMinIntervalMs: 1_000, log: silent });
      client.register({ sessionId: 's1', project: '/p', title: 'T' });
      await settle();
      const afterCreate = fix.calls.filter((c) => c.kind === 'register').length;

      client.heartbeat('s1');
      await settle();
      expect(fix.calls.filter((c) => c.kind === 'register').length - afterCreate).toBe(1);

      clock = 100_200; client.heartbeat('s1');
      clock = 100_400; client.heartbeat('s1'); // coalesced
      await settle();
      expect(fix.calls.filter((c) => c.kind === 'register').length - afterCreate).toBe(1);

      clock = 101_500; client.heartbeat('s1'); // new window
      await settle();
      expect(fix.calls.filter((c) => c.kind === 'register').length - afterCreate).toBe(2);

      const beats = fix.calls.filter((c) => c.kind === 'register').slice(afterCreate);
      for (const beat of beats) expect(beat.input && 'title' in beat.input).toBe(false);
      client.dispose();
    });

    test('45s keepalive re-heartbeats on its own cadence with NO activity, and dispose() stops it', async () => {
      const fix = makeAdapter();
      const client = new SessionSpineClient({ participant: fix.participant, transport: fix.transport, heartbeatMinIntervalMs: 15, log: silent });
      client.register({ sessionId: 'keepalive-1', project: '/p', title: 'T' });
      await settle();
      expect(client.keepaliveSessionId).toBe('keepalive-1');
      const afterRegister = fix.calls.filter((c) => c.kind === 'register').length;

      await new Promise((r) => setTimeout(r, 70));
      await settle();
      const afterIdle = fix.calls.filter((c) => c.kind === 'register').length;
      expect(afterIdle).toBeGreaterThan(afterRegister);
      expect(fix.calls.every((c) => c.sessionId === 'keepalive-1')).toBe(true);

      client.dispose();
      const afterDispose = fix.calls.length;
      await new Promise((r) => setTimeout(r, 70));
      expect(fix.calls.length).toBe(afterDispose);
    });

    test('reopen sends reopen:true and omits title; create includes title', async () => {
      const fix = makeAdapter();
      const client = new SessionSpineClient({ participant: fix.participant, transport: fix.transport, log: silent });
      client.register({ sessionId: 's1', project: '/p', title: 'Created' });
      client.reopen({ sessionId: 's2', project: '/p', title: 'Should not be sent' });
      await settle();
      const create = fix.calls.find((c) => c.sessionId === 's1');
      const reopen = fix.calls.find((c) => c.sessionId === 's2');
      expect(create?.input?.title).toBe('Created');
      expect(create?.input?.reopen).toBeUndefined();
      expect(reopen?.input?.reopen).toBe(true);
      expect(reopen?.input && 'title' in reopen.input).toBe(false);
      client.dispose();
    });

    test('legacy fold registers each record and closes locally-closed records', async () => {
      const fix = makeAdapter();
      const client = new SessionSpineClient({ participant: fix.participant, transport: fix.transport, log: silent });
      client.foldLegacyRecords(
        [
          { sessionId: 'open-1', project: '/p', title: 'Open one' },
          { sessionId: 'closed-1', project: '/p', title: 'Closed one' },
        ],
        new Set(['closed-1']),
      );
      await settle();
      expect(fix.calls.filter((c) => c.kind === 'register')).toHaveLength(2);
      const closes = fix.calls.filter((c) => c.kind === 'close');
      expect(closes).toHaveLength(1);
      expect(closes[0]?.sessionId).toBe('closed-1');
      client.dispose();
    });
  });
}

describe('SessionSpineClient — recordKind stamping (divergence: TUI stamps kind, agent omits)', () => {
  test('recordKind:"tui" stamps kind on every input; unset omits it entirely', async () => {
    const typed = typedAdapter();
    const withKind = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, transport: typed.transport, recordKind: 'tui', log: silent });
    withKind.register({ sessionId: 't1', project: '/p', title: 'T' });
    await settle();
    expect(typed.calls[0]?.input?.kind).toBe('tui');
    withKind.dispose();

    const rest = restAdapter();
    const noKind = new SessionSpineClient({ participant: AGENT_SPINE_PARTICIPANT, transport: rest.transport, log: silent });
    noKind.register({ sessionId: 'a1', project: '/p', title: 'A' });
    await settle();
    expect(rest.calls[0]?.input && 'kind' in rest.calls[0].input).toBe(false);
    noKind.dispose();
  });

  test('participant const carries the right surface identity per surface', async () => {
    const rest = restAdapter();
    const client = new SessionSpineClient({ participant: AGENT_SPINE_PARTICIPANT, transport: rest.transport, log: silent });
    client.register({ sessionId: 'a1', project: '/p', title: 'A' });
    await settle();
    expect(rest.calls[0]?.input?.participant.surfaceKind).toBe('service');
    expect(rest.calls[0]?.input?.participant.surfaceId).toBe('surface:goodvibes-agent');
    client.dispose();
  });
});

describe('SessionSpineClient — result-kind folding (REST adapter)', () => {
  test('a durable reject (auth_required) does NOT enqueue+retry-forever; a transient offline DOES queue', async () => {
    const calls: CapturedCall[] = [];
    const state = { kind: 'auth_required' as 'auth_required' | 'connected_host_unavailable' };
    const transport: SpineTransport = {
      register: async (input) => {
        calls.push({ kind: 'register', sessionId: input.sessionId, input });
        return foldRest({ ok: false, kind: state.kind });
      },
      close: async (id) => { calls.push({ kind: 'close', sessionId: id }); return foldRest({ ok: false, kind: state.kind }); },
    };
    const client = new SessionSpineClient({ participant: AGENT_SPINE_PARTICIPANT, transport, log: silent });

    // Durable reject: logged, NOT queued, reachability unchanged (stays 'unknown').
    client.register({ sessionId: 'auth-1', project: '/p', title: 'T' });
    await settle();
    expect(client.pendingOps).toBe(0);
    expect(client.status()).toBe('unknown');

    // Transient offline: queued for replay, reachability offline.
    state.kind = 'connected_host_unavailable';
    client.register({ sessionId: 'net-1', project: '/p', title: 'T' });
    await settle();
    expect(client.pendingOps).toBe(1);
    expect(client.status()).toBe('offline');
    client.dispose();
  });
});

describe('SessionSpineClient — activation modes', () => {
  test('dormant-until-activate: nothing hits the wire before activate()', async () => {
    const typed = typedAdapter();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, log: silent });
    expect(client.active).toBe(false);
    client.register({ sessionId: 's1', project: '/p', title: 'T' });
    await settle();
    expect(typed.calls).toHaveLength(0); // never attempted over a transport that does not exist
    expect(client.pendingOps).toBeGreaterThan(0);

    client.activate(typed.transport);
    await settle();
    expect(typed.calls.length).toBeGreaterThan(0);
    client.dispose();
  });

  test('live-immediately: registers on construct (agent — live for the whole process)', async () => {
    const rest = restAdapter();
    const client = new SessionSpineClient({ participant: AGENT_SPINE_PARTICIPANT, transport: rest.transport, log: silent });
    expect(client.active).toBe(true);
    client.register({ sessionId: 'a1', project: '/p', title: 'T' });
    await settle();
    expect(rest.calls.filter((c) => c.kind === 'register')).toHaveLength(1);
    expect(client.status()).toBe('online');
    client.dispose();
  });

  test('deactivate() stops attempting the wire but keeps queuing (bounded)', async () => {
    const typed = typedAdapter();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, transport: typed.transport, log: silent });
    client.register({ sessionId: 's1', project: '/p' });
    await settle();
    expect(typed.calls).toHaveLength(1);
    client.deactivate('daemon mode changed');
    expect(client.active).toBe(false);
    expect(client.status()).toBe('unknown');
    client.register({ sessionId: 's2', project: '/p' });
    await settle();
    expect(typed.calls).toHaveLength(1); // no new wire attempt while dormant
    expect(client.pendingOps).toBe(1);
    client.dispose();
  });

  test('probeReachability(): offline when the injected probe reports the host unreachable; no-op without a probe', async () => {
    const rest = restAdapter();
    const client = new SessionSpineClient({ participant: AGENT_SPINE_PARTICIPANT, transport: rest.transport, probe: async () => false, log: silent });
    expect(client.status()).toBe('unknown');
    expect(await client.probeReachability()).toBe('offline');
    expect(client.status()).toBe('offline');
    client.dispose();

    const noProbe = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, transport: typedAdapter().transport, log: silent });
    expect(await noProbe.probeReachability()).toBe('unknown'); // honest no-op
    noProbe.dispose();
  });
});

describe('foldLegacySpineStore', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-spine-fold-')); });
  afterEach(() => { /* best-effort */ });

  test('reads the store, folds records, and writes a migration marker', () => {
    const storePath = join(root, 'sessions.json');
    const markerPath = join(root, 'sessions.json.spine-migrated');
    writeFileSync(storePath, JSON.stringify({
      sessions: {
        'sess-1': { id: 'sess-1', kind: 'tui', title: 'One', status: 'active' },
        'sess-2': { id: 'sess-2', kind: 'tui', title: 'Two', status: 'closed' },
      },
    }));
    const folded: Array<{ ids: string[]; closed: string[] }> = [];
    const stub = {
      foldLegacyRecords: (records: readonly { sessionId: string }[], closedIds: ReadonlySet<string>) => {
        folded.push({ ids: records.map((r) => r.sessionId), closed: [...closedIds] });
      },
    };
    const result = foldLegacySpineStore(stub, { storePath, markerPath, project: '/p', now: () => 42, log: silent });
    expect(result).toEqual({ folded: 2, skipped: false });
    expect(folded[0]?.ids.sort()).toEqual(['sess-1', 'sess-2']);
    expect(folded[0]?.closed).toEqual(['sess-2']);
    expect(existsSync(markerPath)).toBe(true);
    expect((JSON.parse(readFileSync(markerPath, 'utf-8')) as { count: number }).count).toBe(2);
  });

  test('skips when the marker already exists (idempotent)', () => {
    const storePath = join(root, 'sessions.json');
    const markerPath = join(root, 'sessions.json.spine-migrated');
    writeFileSync(storePath, JSON.stringify({ sessions: { 'sess-1': { id: 'sess-1', status: 'active' } } }));
    writeFileSync(markerPath, JSON.stringify({ migratedAt: 1, count: 1 }));
    let called = 0;
    const result = foldLegacySpineStore({ foldLegacyRecords: () => { called += 1; } }, { storePath, markerPath, project: '/p', log: silent });
    expect(result.skipped).toBe(true);
    expect(called).toBe(0);
  });

  test('a missing store folds nothing and writes no marker', () => {
    const markerPath = join(root, 'sessions.json.spine-migrated');
    let called = 0;
    const result = foldLegacySpineStore({ foldLegacyRecords: () => { called += 1; } }, { storePath: join(root, 'nope.json'), markerPath, project: '/p', log: silent });
    expect(result).toEqual({ folded: 0, skipped: false });
    expect(called).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
  });
});
