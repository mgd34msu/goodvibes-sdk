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
import type { SharedSessionRecord } from '../packages/sdk/src/platform/control-plane/index.ts';
import { SessionUnionCache, type LocalSessionReader } from '../packages/sdk/src/platform/runtime/session-spine/index.ts';

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
