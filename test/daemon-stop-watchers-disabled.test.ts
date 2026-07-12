/**
 * daemon-stop-watchers-disabled.test.ts
 *
 * Regression: DaemonServer.stop() used to call
 * watcherRegistry.stopWatcher('daemon-heartbeat') UNCONDITIONALLY, but start()
 * only ever registers that watcher behind `watchers.enabled`, and stopWatcher()
 * calls requireFeatureGate('watcher-framework') — which THROWS when the gate is
 * off. A daemon that ran with watchers disabled threw from stop(), and only
 * cli.ts / boot.ts's best-effort `.catch()` wrappers hid it. Watchers now
 * default ON, so this boots with `watchers.enabled` explicitly false to keep
 * covering the disabled-teardown path, calling the RAW server.stop()
 * (bypassing boot.ts's catch) and asserting a clean shutdown.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';

let home: string;
let work: string;
let daemon: BootedDaemon;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'stop-home-'));
  work = mkdtempSync(join(tmpdir(), 'stop-work-'));
  // Watchers default ON now — recreate the disabled case this regression guards.
  // bootDaemon's ConfigManager resolves <home>/.goodvibes/goodvibes/settings.json.
  const configDir = join(home, '.goodvibes', 'goodvibes');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ watchers: { enabled: false } }));
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
    // watchers.enabled is explicitly false for this daemon, so the heartbeat
    // watcher was never registered. Before the fix this rejected with a
    // feature-gate error; after the fix the guarded teardown is a no-op.
    await expect(daemon.server.stop()).resolves.toBeUndefined();
  });

  test('stop() is idempotent — a second call is a clean no-op', async () => {
    await expect(daemon.server.stop()).resolves.toBeUndefined();
  });
});
