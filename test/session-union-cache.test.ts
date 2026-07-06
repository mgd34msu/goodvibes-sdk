/**
 * session-union-cache.test.ts
 *
 * Unit evidence for the cross-surface read facade moved into the SDK (W3-S4). Drives
 * the facade with a fake sync local reader + a fake async wire reader (no real
 * daemon here — the daemon-integration test covers the real wire) to prove the
 * honesty contract: embedded/local passthrough; adopted-online union (deduped, local
 * wins); adopted-offline degrades to local-only + honest note with a stale flag; the
 * probe-timeout bound; and the generation guard (a superseded activate's in-flight
 * refresh does not clobber newer state).
 */
import { describe, expect, test } from 'bun:test';
import type { SharedSessionRecord } from '../packages/sdk/src/platform/control-plane/index.ts';
import {
  deriveSpineFooterStatus,
  SessionUnionCache,
  type LocalSessionReader,
  type SessionReadFacade,
  type WireSessionReader,
} from '../packages/sdk/src/platform/runtime/session-spine/index.ts';

describe('deriveSpineFooterStatus (offline within one union-probe interval)', () => {
  test('not adopted: falls back to the spine client status', () => {
    expect(deriveSpineFooterStatus('online', { mode: 'local', online: false, lastSyncAt: null })).toBe('online');
    expect(deriveSpineFooterStatus('unknown', { mode: 'embedded', online: false, lastSyncAt: null })).toBe('unknown');
  });
  test('adopted, never synced yet: falls back to the spine client status', () => {
    expect(deriveSpineFooterStatus('online', { mode: 'adopted', online: false, lastSyncAt: null })).toBe('online');
  });
  test('adopted + confirmed once + probe now failing: reads offline even if the spine client still says online', () => {
    expect(deriveSpineFooterStatus('online', { mode: 'adopted', online: false, lastSyncAt: 1_000 })).toBe('offline');
  });
  test('adopted + probe succeeding: reads online (and recovers from a prior offline)', () => {
    expect(deriveSpineFooterStatus('offline', { mode: 'adopted', online: true, lastSyncAt: 2_000 })).toBe('online');
  });
});

function record(id: string, over: Partial<SharedSessionRecord> = {}): SharedSessionRecord {
  return {
    id,
    kind: 'tui',
    project: '/proj',
    title: id,
    status: 'active',
    createdAt: 1_000,
    updatedAt: 1_000,
    participants: [],
    ...over,
  } as SharedSessionRecord;
}

function localReader(rows: SharedSessionRecord[]): LocalSessionReader {
  return {
    listSessions: (limit?: number) => (typeof limit === 'number' ? rows.slice(0, limit) : rows),
    getSession: (id: string) => rows.find((r) => r.id === id) ?? null,
  };
}

function wireReader(behavior: { rows?: readonly SharedSessionRecord[]; reject?: boolean }): {
  reader: WireSessionReader;
  set: (next: { rows?: readonly SharedSessionRecord[]; reject?: boolean }) => void;
} {
  let state = behavior;
  return {
    reader: {
      list: async () => {
        if (state.reject) throw new Error('daemon unreachable');
        return state.rows ?? [];
      },
    },
    set: (next) => { state = next; },
  };
}

const noopScheduler = {
  setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
  clearInterval: () => {},
};

const silent = { debug: () => {} };

describe('SessionUnionCache — honest cross-surface read facade', () => {
  test('local/dormant mode: pure passthrough, no cross-surface claim', () => {
    const cache = new SessionUnionCache({ local: localReader([record('local-1')]), scheduler: noopScheduler, log: silent });
    expect(cache.getMode()).toBe('local');
    expect(cache.listSessions().map((r) => r.id)).toEqual(['local-1']);
    expect(cache.crossSurfaceView).toEqual({ mode: 'local', online: false, stale: false, lastSyncAt: null, offlineNote: null });
  });

  test('embedded mode: passthrough to the local broker (it IS the truth), no offline note', () => {
    const cache = new SessionUnionCache({ local: localReader([record('local-1'), record('local-2')]), scheduler: noopScheduler, log: silent });
    cache.markEmbedded();
    expect(cache.getMode()).toBe('embedded');
    expect(cache.listSessions().map((r) => r.id).sort()).toEqual(['local-1', 'local-2']);
    expect(cache.crossSurfaceView.offlineNote).toBeNull();
    expect(cache.crossSurfaceView.online).toBe(false);
    expect(cache.crossSurfaceView.stale).toBe(false);
  });

  test('adopted-online: serves the deduped union, local wins for its own id', async () => {
    const local = localReader([record('shared-1', { title: 'local-title' }), record('local-only')]);
    const wire = wireReader({ rows: [record('shared-1', { title: 'wire-title' }), record('wire-only')] });
    let clock = 5_000;
    const cache = new SessionUnionCache({ local, now: () => clock, scheduler: noopScheduler, log: silent });
    cache.activate(wire.reader);
    await cache.refresh();

    const union = cache.listSessions();
    expect(union.map((r) => r.id).sort()).toEqual(['local-only', 'shared-1', 'wire-only']);
    expect(union.find((r) => r.id === 'shared-1')?.title).toBe('local-title');
    expect(cache.getSession('wire-only')?.id).toBe('wire-only');
    expect(cache.getSession('local-only')?.id).toBe('local-only');
    expect(cache.crossSurfaceView).toMatchObject({ mode: 'adopted', online: true, stale: false, lastSyncAt: 5_000, offlineNote: null });
  });

  test('adopted-offline (daemon down): local-only rows + honest note, NO phantom wire rows, stale flag set', async () => {
    const local = localReader([record('local-1')]);
    const wire = wireReader({ rows: [record('wire-1')] });
    const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
    cache.activate(wire.reader);
    await cache.refresh();
    expect(cache.listSessions().map((r) => r.id).sort()).toEqual(['local-1', 'wire-1']);

    wire.set({ reject: true });
    await cache.refresh();
    expect(cache.listSessions().map((r) => r.id)).toEqual(['local-1']);
    expect(cache.getSession('wire-1')).toBeNull();
    const view = cache.crossSurfaceView;
    expect(view.online).toBe(false);
    expect(view.stale).toBe(true);
    expect(view.offlineNote).toBe('cross-surface view offline');
  });

  test('adopted-but-never-synced: honest until first success (local-only + note, stale)', () => {
    const local = localReader([record('local-1')]);
    const wire = wireReader({ rows: [record('wire-1')] });
    const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
    cache.activate(wire.reader);
    expect(cache.listSessions().map((r) => r.id)).toEqual(['local-1']);
    expect(cache.crossSurfaceView.offlineNote).toBe('cross-surface view offline');
    expect(cache.crossSurfaceView.stale).toBe(true);
  });

  test('staleness by age: online but past the freshness window reads stale', async () => {
    const wire = wireReader({ rows: [record('wire-1')] });
    let clock = 0;
    const cache = new SessionUnionCache({ local: localReader([]), now: () => clock, staleAfterMs: 1_000, scheduler: noopScheduler, log: silent });
    cache.activate(wire.reader);
    clock = 10_000;
    await cache.refresh();
    expect(cache.crossSurfaceView.stale).toBe(false);
    clock = 12_000;
    expect(cache.crossSurfaceView.stale).toBe(true);
    expect(cache.crossSurfaceView.online).toBe(true);
  });

  test('deactivate/markEmbedded drop the wire union and return to passthrough honesty', async () => {
    const wire = wireReader({ rows: [record('wire-1')] });
    const cache = new SessionUnionCache({ local: localReader([record('local-1')]), scheduler: noopScheduler, log: silent });
    cache.activate(wire.reader);
    await cache.refresh();
    expect(cache.listSessions().length).toBe(2);
    cache.deactivate('daemon mode changed');
    expect(cache.getMode()).toBe('local');
    expect(cache.listSessions().map((r) => r.id)).toEqual(['local-1']);
    expect(cache.crossSurfaceView.offlineNote).toBeNull();
  });

  test('onTransition: fires exactly on a genuine online/offline flip, never on a repeat of the same state', async () => {
    const wire = wireReader({ rows: [record('wire-1')] });
    const cache = new SessionUnionCache({ local: localReader([]), scheduler: noopScheduler, log: silent });
    const transitions: boolean[] = [];
    cache.setOnTransition((online) => transitions.push(online));
    cache.activate(wire.reader);
    await cache.refresh();
    expect(transitions).toEqual([true]);
    await cache.refresh();
    expect(transitions).toEqual([true]);
    wire.set({ reject: true });
    await cache.refresh();
    expect(transitions).toEqual([true, false]);
    await cache.refresh();
    expect(transitions).toEqual([true, false]);
    wire.set({ rows: [record('wire-1')] });
    await cache.refresh();
    expect(transitions).toEqual([true, false, true]);
  });

  test('refresh() in-flight guard: overlapping calls collapse into the same pending probe (no double-fire)', async () => {
    let listCalls = 0;
    let releaseFirst: (() => void) | null = null;
    const held: WireSessionReader = {
      list: () => new Promise<readonly SharedSessionRecord[]>((resolve) => {
        listCalls += 1;
        releaseFirst = () => resolve([record('wire-1')]);
      }),
    };
    const cache = new SessionUnionCache({ local: localReader([]), scheduler: noopScheduler, log: silent });
    const transitions: boolean[] = [];
    cache.setOnTransition((online) => transitions.push(online));
    cache.activate(held);
    const overlap = cache.refresh();
    expect(listCalls).toBe(1);
    releaseFirst!();
    await overlap;
    expect(transitions).toEqual([true]);
  });

  test('probeTimeoutMs: a hung wire call bounds refresh() to ~1 probe interval instead of an indefinite wait', async () => {
    let capturedTimeoutFn: (() => void) | null = null;
    const scheduler = {
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
      setTimeout: (fn: () => void) => { capturedTimeoutFn = fn; return 0 as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout: () => {},
    };
    let hang = false;
    const wire: WireSessionReader = {
      list: () => (hang ? new Promise<readonly SharedSessionRecord[]>(() => {}) : Promise.resolve([record('wire-1')])),
    };
    const cache = new SessionUnionCache({ local: localReader([record('local-1')]), scheduler, log: silent });
    const transitions: boolean[] = [];
    cache.setOnTransition((online) => transitions.push(online));
    cache.activate(wire);
    await cache.refresh();
    expect(cache.crossSurfaceView.online).toBe(true);
    expect(transitions).toEqual([true]);

    hang = true;
    const pending = cache.refresh();
    expect(capturedTimeoutFn).not.toBeNull();
    capturedTimeoutFn!();
    await pending;
    expect(cache.crossSurfaceView.online).toBe(false);
    expect(cache.crossSurfaceView.offlineNote).toBe('cross-surface view offline');
    expect(transitions).toEqual([true, false]);
  });

  describe('generation guard: a superseded reader can never write back after activate()/deactivate() moves on', () => {
    function flushMicrotasks(): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, 0));
    }
    function heldReader(): { reader: WireSessionReader; release: (result: { rows?: readonly SharedSessionRecord[]; reject?: boolean }) => void } {
      let settle: ((result: { rows?: readonly SharedSessionRecord[]; reject?: boolean }) => void) | null = null;
      return {
        reader: {
          list: () => new Promise<readonly SharedSessionRecord[]>((resolve, reject) => {
            settle = (result) => (result.reject ? reject(new Error('daemon unreachable')) : resolve(result.rows ?? []));
          }),
        },
        release: (result) => settle!(result),
      };
    }

    test('late timeout from a pre-activate() probe writes nothing and fires no transition, even though readerB already went online', async () => {
      const readerA = heldReader();
      const readerB = wireReader({ rows: [record('b-1')] });
      const cache = new SessionUnionCache({ local: localReader([]), scheduler: noopScheduler, log: silent });
      const transitions: boolean[] = [];
      cache.setOnTransition((online) => transitions.push(online));
      cache.activate(readerA.reader);
      cache.activate(readerB.reader);
      await cache.refresh();
      expect(cache.crossSurfaceView.online).toBe(true);
      expect(cache.crossSurfaceView.lastSyncAt).not.toBeNull();
      expect(transitions).toEqual([true]);
      readerA.release({ reject: true });
      await flushMicrotasks();
      expect(cache.crossSurfaceView.online).toBe(true);
      expect(cache.listSessions().map((r) => r.id)).toEqual(['b-1']);
      expect(transitions).toEqual([true]);
    });

    test('late success with stale rows from a pre-activate() probe does not overwrite readerB\'s fresh cache', async () => {
      const readerA = heldReader();
      const readerB = wireReader({ rows: [record('b-1')] });
      const cache = new SessionUnionCache({ local: localReader([]), scheduler: noopScheduler, log: silent });
      const transitions: boolean[] = [];
      cache.setOnTransition((online) => transitions.push(online));
      cache.activate(readerA.reader);
      cache.activate(readerB.reader);
      await cache.refresh();
      expect(cache.listSessions().map((r) => r.id)).toEqual(['b-1']);
      expect(transitions).toEqual([true]);
      readerA.release({ rows: [record('a-1', { title: 'stale' })] });
      await flushMicrotasks();
      expect(cache.listSessions().map((r) => r.id)).toEqual(['b-1']);
      expect(transitions).toEqual([true]);
    });

    test('deactivate() mid-probe invalidates the write-back: a late-resolving probe from before deactivation writes nothing', async () => {
      const readerA = heldReader();
      const cache = new SessionUnionCache({ local: localReader([record('local-1')]), scheduler: noopScheduler, log: silent });
      const transitions: boolean[] = [];
      cache.setOnTransition((online) => transitions.push(online));
      cache.activate(readerA.reader);
      cache.deactivate('daemon mode changed');
      expect(cache.getMode()).toBe('local');
      readerA.release({ rows: [record('wire-1')] });
      await flushMicrotasks();
      expect(cache.getMode()).toBe('local');
      expect(cache.listSessions().map((r) => r.id)).toEqual(['local-1']);
      expect(cache.crossSurfaceView).toEqual({ mode: 'local', online: false, stale: false, lastSyncAt: null, offlineNote: null });
      expect(transitions).toEqual([]);
    });

    test('normal single-adoption refresh is unaffected by the generation guard', async () => {
      const local = localReader([record('local-1')]);
      const wire = wireReader({ rows: [record('wire-1')] });
      let clock = 1_000;
      const cache = new SessionUnionCache({ local, now: () => clock, scheduler: noopScheduler, log: silent });
      const transitions: boolean[] = [];
      cache.setOnTransition((online) => transitions.push(online));
      cache.activate(wire.reader);
      await cache.refresh();
      expect(cache.crossSurfaceView).toMatchObject({ mode: 'adopted', online: true, stale: false, lastSyncAt: 1_000 });
      expect(cache.listSessions().map((r) => r.id).sort()).toEqual(['local-1', 'wire-1']);
      expect(transitions).toEqual([true]);
      clock = 2_000;
      wire.set({ reject: true });
      await cache.refresh();
      expect(cache.crossSurfaceView.online).toBe(false);
      expect(transitions).toEqual([true, false]);
    });
  });

  describe('self-mirror identity (D-TUI-1): dedup on the TRUE shared identity, not raw id equality', () => {
    test('local record + its wire mirror under the SAME id still dedup to exactly one row (no regression)', async () => {
      const local = localReader([record('self-1', { title: 'local-title' })]);
      const wire = wireReader({ rows: [record('other-1'), record('self-1', { title: 'wire-title' })] });
      const cache = new SessionUnionCache({
        local,
        scheduler: noopScheduler,
        log: silent,
        selfSessionIds: () => new Set(['self-1']),
      });
      cache.activate(wire.reader);
      await cache.refresh();
      const union = cache.listSessions();
      expect(union.map((r) => r.id).sort()).toEqual(['other-1', 'self-1']);
      // local wins for its own row even though it was also excluded from the wire side.
      expect(union.find((r) => r.id === 'self-1')?.title).toBe('local-title');
    });

    test('local id and its wire-mirrored id DIFFER for the same session: still exactly one row for it, via mirroredSessionIds', async () => {
      // The realistic failure mode: a local record created under one id
      // (e.g. auto-assigned by a local store) gets mirrored to the wire under
      // a DIFFERENT id the caller separately chose for SessionSpineClient.
      // Raw id-equality dedup cannot catch this; selfSessionIds can, because
      // it is keyed on what was ACTUALLY sent to the wire, independent of the
      // local reader's own id for the same conceptual session.
      const local = localReader([record('local-own-id')]);
      const wire = wireReader({ rows: [record('other-1'), record('wire-mirrored-id')] });
      const cache = new SessionUnionCache({
        local,
        scheduler: noopScheduler,
        log: silent,
        selfSessionIds: () => new Set(['wire-mirrored-id']),
      });
      cache.activate(wire.reader);
      await cache.refresh();
      const union = cache.listSessions();
      // Exactly N (other-1) + 1 (local-own-id) = 2 rows, NOT 3 — the
      // wire-mirrored-id row is recognized as "mine" and dropped, while
      // local's own view (under its own id) is kept.
      expect(union.map((r) => r.id).sort()).toEqual(['local-own-id', 'other-1']);
      expect(union).toHaveLength(2);
    });

    test('N wire sessions + 1 self session (mismatched id) -> N+1 total, never N+2', async () => {
      const others = ['other-0', 'other-1', 'other-2', 'other-3'].map((id) => record(id));
      const local = localReader([record('tui-self')]);
      const wire = wireReader({ rows: [...others, record('daemon-self-mirror')] });
      const cache = new SessionUnionCache({
        local,
        scheduler: noopScheduler,
        log: silent,
        selfSessionIds: () => new Set(['daemon-self-mirror']),
      });
      cache.activate(wire.reader);
      await cache.refresh();
      const union = cache.listSessions();
      expect(union).toHaveLength(5); // N=4 others + 1 self, not 6
      expect(union.map((r) => r.id).sort()).toEqual(['other-0', 'other-1', 'other-2', 'other-3', 'tui-self']);
    });

    test('multiple self sessions (2 mismatched ids) still resolve to exactly N + 2, no special-casing "subtract one"', async () => {
      const others = ['other-0', 'other-1', 'other-2'].map((id) => record(id));
      const local = localReader([record('self-local-a'), record('self-local-b')]);
      const wire = wireReader({ rows: [...others, record('self-wire-a'), record('self-wire-b')] });
      const cache = new SessionUnionCache({
        local,
        scheduler: noopScheduler,
        log: silent,
        selfSessionIds: () => new Set(['self-wire-a', 'self-wire-b']),
      });
      cache.activate(wire.reader);
      await cache.refresh();
      const union = cache.listSessions();
      expect(union).toHaveLength(5); // N=3 others + 2 self
      expect(union.map((r) => r.id).sort()).toEqual(['other-0', 'other-1', 'other-2', 'self-local-a', 'self-local-b']);
    });

    test('getSession() is consistent with listSessions(): a self-mirrored wire id not present locally resolves to null, not a phantom cross-surface hit', async () => {
      const local = localReader([record('local-own-id')]);
      const wire = wireReader({ rows: [record('wire-mirrored-id')] });
      const cache = new SessionUnionCache({
        local,
        scheduler: noopScheduler,
        log: silent,
        selfSessionIds: () => new Set(['wire-mirrored-id']),
      });
      cache.activate(wire.reader);
      await cache.refresh();
      expect(cache.getSession('wire-mirrored-id')).toBeNull();
      expect(cache.getSession('local-own-id')?.id).toBe('local-own-id');
    });

    test('no selfSessionIds accessor supplied: behavior is byte-identical to before (pure id-equality dedup)', async () => {
      const local = localReader([record('shared-1', { title: 'local-title' })]);
      const wire = wireReader({ rows: [record('shared-1', { title: 'wire-title' }), record('wire-only')] });
      const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
      cache.activate(wire.reader);
      await cache.refresh();
      const union = cache.listSessions();
      expect(union.map((r) => r.id).sort()).toEqual(['shared-1', 'wire-only']);
      expect(union.find((r) => r.id === 'shared-1')?.title).toBe('local-title');
    });
  });

  test('panel-consumer stand-in: renders union rows online, and local rows + offline note when down', async () => {
    function renderPanel(facade: SessionReadFacade): { ids: string[]; note: string | null } {
      return { ids: facade.listSessions().map((r) => r.id).sort(), note: facade.crossSurfaceView.offlineNote };
    }
    const local = localReader([record('local-1')]);
    const wire = wireReader({ rows: [record('wire-1')] });
    const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
    cache.activate(wire.reader);
    await cache.refresh();
    expect(renderPanel(cache)).toEqual({ ids: ['local-1', 'wire-1'], note: null });
    wire.set({ reject: true });
    await cache.refresh();
    expect(renderPanel(cache)).toEqual({ ids: ['local-1'], note: 'cross-surface view offline' });
  });
});
