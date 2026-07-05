/**
 * daemon-stop-watchers-disabled.test.ts
 *
 * Regression: DaemonServer.stop() used to call
 * watcherRegistry.stopWatcher('daemon-heartbeat') UNCONDITIONALLY, but start()
 * only ever registers that watcher behind `watchers.enabled`, and stopWatcher()
 * calls requireFeatureGate('watcher-framework') — which THROWS when the gate is
 * off (its default state). So a daemon that ran with watchers disabled (the
 * common case) threw from stop(), and only cli.ts / boot.ts's best-effort
 * `.catch()` wrappers hid it. This test calls the RAW server.stop() (bypassing
 * boot.ts's catch) and asserts a clean shutdown.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';

let home: string;
let work: string;
let daemon: BootedDaemon;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'stop-home-'));
  work = mkdtempSync(join(tmpdir(), 'stop-work-'));
  daemon = await bootDaemon({
    homeDirectory: home,
    workingDir: work,
    daemonHomeDir: join(home, 'daemon'),
    port: 0,
    host: '127.0.0.1',
    token: 'stop-token',
  });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('DaemonServer.stop() with the watcher framework disabled', () => {
  test('raw server.stop() resolves cleanly instead of throwing on the heartbeat teardown', async () => {
    // The default feature-flag set leaves `watcher-framework` disabled, so the
    // heartbeat watcher was never registered. Before the fix this rejected with
    // a feature-gate error; after the fix the guarded teardown is a no-op.
    await expect(daemon.server.stop()).resolves.toBeUndefined();
  });

  test('stop() is idempotent — a second call is a clean no-op', async () => {
    await expect(daemon.server.stop()).resolves.toBeUndefined();
  });
});
