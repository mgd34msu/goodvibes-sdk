/**
 * session-union-cache-daemon-integration.test.ts
 *
 * W3-S4 acceptance evidence: drives the SDK SessionUnionCache against a REAL
 * bootDaemon over a real HttpTransport (no mocked wire). Proves the adopted-mode
 * union genuinely includes a session that exists ONLY on the daemon (registered by
 * a different surface), which the local reader alone would miss — and that losing
 * the daemon degrades the served rows to local-only honestly.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';
import { createHttpTransport } from '../packages/sdk/src/platform/runtime/transport.ts';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import type { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.ts';
import type { SharedSessionRecord } from '../packages/sdk/src/platform/control-plane/index.ts';
import {
  SessionUnionCache,
  SessionSpineClient,
  TUI_SPINE_PARTICIPANT,
  type LocalSessionReader,
  type SpineTransport,
} from '../packages/sdk/src/platform/runtime/session-spine/index.ts';

const TOKEN = 'union-integration-token';

const noopScheduler = {
  setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
  clearInterval: () => {},
};
const silent = { debug: () => {} };

interface Harness {
  readonly daemon: BootedDaemon;
  readonly homeDirectory: string;
  readonly workingDir: string;
  readonly wireList: (limit?: number) => Promise<readonly SharedSessionRecord[]>;
  readonly registerWireSession: (id: string) => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-union-home-'));
  const workingDir = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-union-project-'));
  const daemon = await bootDaemon({ homeDirectory, workingDir, port: 0, token: TOKEN });
  const transport = createHttpTransport({ baseUrl: daemon.url, authToken: TOKEN });
  return {
    daemon,
    homeDirectory,
    workingDir,
    wireList: (limit) => transport.operator.sessions.list(limit),
    registerWireSession: async (id) => {
      await transport.operator.sessions.register({
        sessionId: id,
        project: workingDir,
        title: id,
        participant: { surfaceKind: 'companion', surfaceId: 'surface:companion', displayName: 'Companion', lastSeenAt: Date.now() },
      });
    },
  };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.daemon.stop();
  rmSync(harness.homeDirectory, { recursive: true, force: true });
  rmSync(harness.workingDir, { recursive: true, force: true });
}

describe('SDK SessionUnionCache against a real bootDaemon (adopted-mode union)', () => {
  let harness: Harness | null = null;
  afterEach(async () => { if (harness) await stopHarness(harness); harness = null; });

  test('adopted union includes a daemon-hosted session the local reader never saw', async () => {
    harness = await startHarness();
    await harness.registerWireSession('companion-session-1');

    const local: LocalSessionReader = {
      listSessions: () => [{ id: 'tui-local-1', kind: 'tui', project: harness!.workingDir, title: 'tui-local-1', status: 'active', createdAt: 1, updatedAt: 1, participants: [] } as SharedSessionRecord],
      getSession: (id) => (id === 'tui-local-1' ? ({ id: 'tui-local-1' } as SharedSessionRecord) : null),
    };
    const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
    cache.activate({ list: (limit) => harness!.wireList(limit) });
    await cache.refresh();

    const ids = cache.listSessions().map((r) => r.id).sort();
    expect(ids).toContain('tui-local-1');
    expect(ids).toContain('companion-session-1');
    expect(cache.getSession('companion-session-1')?.id).toBe('companion-session-1');
    expect(cache.crossSurfaceView).toMatchObject({ mode: 'adopted', online: true, offlineNote: null });
    cache.dispose();
  });

  test('losing the daemon degrades the union to local-only rows + honest offline note', async () => {
    harness = await startHarness();
    await harness.registerWireSession('companion-session-2');

    const local: LocalSessionReader = {
      listSessions: () => [{ id: 'tui-local-2', kind: 'tui', project: harness!.workingDir, title: 'tui-local-2', status: 'active', createdAt: 1, updatedAt: 1, participants: [] } as SharedSessionRecord],
      getSession: (id) => (id === 'tui-local-2' ? ({ id: 'tui-local-2' } as SharedSessionRecord) : null),
    };
    const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
    cache.activate({ list: (limit) => harness!.wireList(limit) });
    await cache.refresh();
    expect(cache.listSessions().map((r) => r.id)).toContain('companion-session-2');

    await harness.daemon.stop();
    await cache.refresh();
    expect(cache.listSessions().map((r) => r.id)).toEqual(['tui-local-2']);
    expect(cache.crossSurfaceView.offlineNote).toBe('cross-surface view offline');
    expect(cache.crossSurfaceView.stale).toBe(true);
    cache.dispose();
  });
});

// ---------------------------------------------------------------------------
// D-TUI-1 (Wave-3 replay): SessionUnionCache.listSessions() was counting the
// adopting surface's OWN session twice — once from the local broker's record,
// once from its wire-mirrored copy — because the merge deduped on raw
// `record.id` equality, which silently assumed the local reader's own id and
// whatever id was actually registered to the wire were the same string. They
// need not be: SessionSpineClient.register()/reopen() send exactly the
// `sessionId` a caller passes in, independent of whatever id the caller's own
// local store separately assigned the same conceptual session. The fix
// (union-cache.ts) filters the wire side of the merge by
// `SessionSpineClient.mirroredSessionIds` — the CANONICAL "which wire rows are
// mine" set — before overlaying `local`, so the local view is authoritative
// for the surface's own sessions regardless of what id the wire mirror
// carries for them.
// ---------------------------------------------------------------------------
function makeNoopRouteBindings(): RouteBindingManager {
  return {
    start: async () => {},
    stop: async () => {},
    list: () => [],
    find: () => null,
    resolve: () => undefined,
    bind: async () => ({}),
    unbind: async () => {},
    patch: async () => null,
    patchBinding: async () => null,
    getBinding: () => null,
  } as unknown as RouteBindingManager;
}

describe('D-TUI-1: adopting surface self-mirror identity against a real bootDaemon', () => {
  let harness: Harness | null = null;
  afterEach(async () => { if (harness) await stopHarness(harness); harness = null; });

  async function registerOthers(harness: Harness, n: number): Promise<void> {
    for (let i = 0; i < n; i++) await harness.registerWireSession(`other-${i}`);
  }

  test('exact replay scenario: adopting surface registers itself, daemon has N others -> union lists exactly N+1 with no duplicate of self', async () => {
    harness = await startHarness();
    const N = 4;
    await registerOthers(harness, N);

    // The adopting surface's own local broker — a SEPARATE store from the
    // daemon's, exactly as the TUI's in-process SharedSessionBroker is.
    const localBroker = new SharedSessionBroker({
      storePath: join(harness.homeDirectory, 'local-sessions.json'),
      routeBindings: makeNoopRouteBindings(),
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => true },
    } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);

    const selfId = 'tui-self-session';
    await localBroker.createSession({ id: selfId, kind: 'tui', project: harness.workingDir, title: 'Terminal UI session' });

    const transport = createHttpTransport({ baseUrl: harness.daemon.url, authToken: TOKEN });
    const spineTransport: SpineTransport = {
      register: async (input) => {
        try { await transport.operator.sessions.register(input); return { outcome: 'ok' }; }
        catch (e) { return { outcome: 'offline', error: String(e) }; }
      },
      close: async (id) => {
        try { await transport.operator.sessions.close(id); return { outcome: 'ok' }; }
        catch (e) { return { outcome: 'offline', error: String(e) }; }
      },
    };
    const spineClient = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    spineClient.activate(spineTransport);
    // Mirrors the SAME id the local broker used — the ordinary, well-behaved
    // case. Even here, the fix must not regress: N others + 1 self = N+1.
    spineClient.register({ sessionId: selfId, project: harness.workingDir, title: 'Terminal UI session' });

    // Wait for the register to actually land on the daemon.
    for (let i = 0; i < 100; i++) {
      const rows = await transport.operator.sessions.list(200);
      if (rows.some((r) => r.id === selfId)) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const cache = new SessionUnionCache({
      local: localBroker,
      selfSessionIds: () => spineClient.mirroredSessionIds,
    });
    cache.activate({ list: (limit) => harness!.wireList(limit) });
    await cache.refresh();

    const union = cache.listSessions();
    expect(union).toHaveLength(N + 1);
    const ids = union.map((r) => r.id).sort();
    expect(ids).toEqual(['other-0', 'other-1', 'other-2', 'other-3', selfId].sort());
    // No duplicate of self under any id.
    expect(ids.filter((id) => id === selfId)).toHaveLength(1);

    cache.dispose();
    spineClient.dispose();
  });

  test('identity mismatch: local id and the wire-mirrored id genuinely DIFFER for the same self session -> still N+1, not N+2', async () => {
    harness = await startHarness();
    const N = 3;
    await registerOthers(harness, N);

    const localBroker = new SharedSessionBroker({
      storePath: join(harness.homeDirectory, 'local-sessions-mismatch.json'),
      routeBindings: makeNoopRouteBindings(),
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => true },
    } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);

    // Deliberately DIFFERENT ids for "the same" conceptual session — the
    // realistic failure mode the raw id-equality dedup could never catch.
    const localId = 'local-own-id-scheme';
    const wireId = 'wire-mirrored-id-scheme';
    await localBroker.createSession({ id: localId, kind: 'tui', project: harness.workingDir, title: 'Terminal UI session' });

    const transport = createHttpTransport({ baseUrl: harness.daemon.url, authToken: TOKEN });
    const spineTransport: SpineTransport = {
      register: async (input) => {
        try { await transport.operator.sessions.register(input); return { outcome: 'ok' }; }
        catch (e) { return { outcome: 'offline', error: String(e) }; }
      },
      close: async (id) => {
        try { await transport.operator.sessions.close(id); return { outcome: 'ok' }; }
        catch (e) { return { outcome: 'offline', error: String(e) }; }
      },
    };
    const spineClient = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    spineClient.activate(spineTransport);
    spineClient.register({ sessionId: wireId, project: harness.workingDir, title: 'Terminal UI session' });

    for (let i = 0; i < 100; i++) {
      const rows = await transport.operator.sessions.list(200);
      if (rows.some((r) => r.id === wireId)) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const cache = new SessionUnionCache({
      local: localBroker,
      selfSessionIds: () => spineClient.mirroredSessionIds,
    });
    cache.activate({ list: (limit) => harness!.wireList(limit) });
    await cache.refresh();

    const union = cache.listSessions();
    expect(union).toHaveLength(N + 1); // NOT N+2
    const ids = union.map((r) => r.id).sort();
    expect(ids).toContain(localId); // local's own view survives
    expect(ids).not.toContain(wireId); // the wire mirror is recognized as "mine" and dropped

    cache.dispose();
    spineClient.dispose();
  });
});
