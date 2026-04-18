/**
 * hostmode-restart.test.ts
 *
 * Tests for hostMode auto-restart behavior introduced in 0.18.44.
 *
 * Coverage:
 *
 * CM1: ConfigManager.subscribe() — keyed listener map, fires on set(), returns unsubscribe
 * CM2: ConfigManager.subscribe() fires with correct (newValue, oldValue) arguments
 * CM3: Unsubscribe stops receiving further notifications
 * CM4: Unrelated key change does not trigger a listener for a different key
 *
 * HL1: HttpListener restarts when httpListener.port changes while running
 * HL2: HttpListener does NOT restart when stopped (watcher not attached)
 * HL3: HttpListener does NOT restart for unrelated config key change
 * HL4: stop() unsubscribes — subsequent config changes do not trigger another start
 * HL5: Re-entrancy guard prevents overlapping restart cycles
 * HL6: hostMode change triggers rebind (local -> custom with explicit host)
 */

import { describe, expect, test, mock } from 'bun:test';
import { createHostModeRestartWatcher } from '../packages/sdk/src/_internal/platform/daemon/host-mode-watcher.js';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '../packages/sdk/src/_internal/platform/config/manager.js';
import { HttpListener } from '../packages/sdk/src/_internal/platform/daemon/http-listener.js';
import { UserAuthManager } from '../packages/sdk/src/_internal/platform/security/user-auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'gv-test-'));
}

/** Return a high port that is very unlikely to be in use during tests. */
let _portCounter = 54000;
function nextTestPort(): number {
  return ++_portCounter;
}

function makeConfigManager(overrides?: { port?: number; host?: string; hostMode?: string }): ConfigManager {
  const configDir = makeTempConfigDir();
  const cm = new ConfigManager({ configDir });
  // Default to a high test port to avoid conflicts with the running daemon
  cm.set('httpListener.port', overrides?.port ?? nextTestPort());
  if (overrides?.host !== undefined) cm.set('httpListener.host', overrides.host);
  if (overrides?.hostMode !== undefined) cm.set('httpListener.hostMode', overrides.hostMode as 'local' | 'network' | 'custom');
  return cm;
}

function makeUserAuth(): UserAuthManager {
  // Pass explicit empty users list to bypass filesystem bootstrap logic
  const dir = makeTempConfigDir();
  return new UserAuthManager({
    users: [],
    bootstrapFilePath: join(dir, 'users.json'),
    bootstrapCredentialPath: join(dir, 'bootstrap-credential'),
  });
}

/** A minimal Bun.serve mock that records calls. */
function makeServeMock() {
  const calls: Array<{ port: number; hostname: string }> = [];
  const factory = (options: Record<string, unknown>) => {
    calls.push({ port: options.port, hostname: options.hostname });
    return {
      stop: (_force?: boolean) => {},
      port: options.port,
      hostname: options.hostname,
    } as unknown as ReturnType<typeof Bun.serve>;
  };
  return { calls, factory };
}

function makeHttpListener(cm: ConfigManager, serveMock: ReturnType<typeof makeServeMock>) {
  return new HttpListener({
    configManager: cm,
    userAuth: makeUserAuth(),
    serveFactory: serveMock.factory,
  } as unknown as Parameters<InstanceType<typeof import('../packages/sdk/src/_internal/platform/daemon/http-listener.js').HttpListener>['start']>[0] extends never ? never : ConstructorParameters<typeof import('../packages/sdk/src/_internal/platform/daemon/http-listener.js').HttpListener>[0]);
}

async function startListener(listener: HttpListener) {
  listener.enable({ httpListener: true });
  await listener.start();
}

// ---------------------------------------------------------------------------
// CM: ConfigManager.subscribe() unit tests
// ---------------------------------------------------------------------------

describe('CM1: ConfigManager.subscribe — basic notification', () => {
  test('listener fires when subscribed key is set', () => {
    const cm = makeConfigManager();
    const received: number[] = [];
    cm.subscribe('httpListener.port', (newVal) => received.push(newVal));
    cm.set('httpListener.port', 4000);
    expect(received).toEqual([4000]);
  });

  test('multiple subscribers on same key all fire', () => {
    const cm = makeConfigManager();
    const a: number[] = [];
    const b: number[] = [];
    cm.subscribe('httpListener.port', (v) => a.push(v));
    cm.subscribe('httpListener.port', (v) => b.push(v));
    cm.set('httpListener.port', 5555);
    expect(a).toEqual([5555]);
    expect(b).toEqual([5555]);
  });
});

describe('CM2: ConfigManager.subscribe — correct argument shape', () => {
  test('callback receives (newValue, oldValue)', () => {
    const cm = makeConfigManager({ port: 3422 });
    let captured: [number, number] | null = null;
    cm.subscribe('httpListener.port', (newVal, oldVal) => { captured = [newVal, oldVal]; });
    cm.set('httpListener.port', 7777);
    expect(captured).toEqual([7777, 3422]);
  });
});

describe('CM3: ConfigManager.subscribe — unsubscribe stops notifications', () => {
  test('unsub() prevents further callbacks', () => {
    const cm = makeConfigManager();
    const received: number[] = [];
    const unsub = cm.subscribe('httpListener.port', (v) => received.push(v));
    cm.set('httpListener.port', 4000);
    unsub();
    cm.set('httpListener.port', 5000);
    expect(received).toEqual([4000]); // 5000 not received after unsubscribe
  });

  test('unsub() is idempotent (calling twice does not throw)', () => {
    const cm = makeConfigManager();
    const unsub = cm.subscribe('httpListener.port', () => {});
    expect(() => { unsub(); unsub(); }).not.toThrow();
  });
});

describe('CM4: ConfigManager.subscribe — key isolation', () => {
  test('changing an unrelated key does not trigger listener', () => {
    const cm = makeConfigManager();
    const received: unknown[] = [];
    cm.subscribe('httpListener.port', (v) => received.push(v));
    // Change a completely different key
    cm.set('controlPlane.port', 9000);
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HL: HttpListener restart tests
// ---------------------------------------------------------------------------

describe('HL1: HttpListener restarts when httpListener.port changes while running', () => {
  test('port change while running triggers stop + restart with new port', async () => {
    const port1 = nextTestPort();
    const port2 = nextTestPort();
    const cm = makeConfigManager({ port: port1 });
    const mock = makeServeMock();
    const listener = makeHttpListener(cm, mock);

    await startListener(listener);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.port).toBe(port1);

    // Change port — should trigger async restart
    cm.set('httpListener.port', port2);
    await listener.waitForRestart();

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]!.port).toBe(port2);
    expect(listener.isRunning).toBe(true);

    await listener.stop();
  });
});

describe('HL2: HttpListener does NOT restart when stopped before start', () => {
  test('config change on a never-started listener does nothing', async () => {
    const cm = makeConfigManager();
    const mock = makeServeMock();
    const listener = makeHttpListener(cm, mock);
    // Do NOT start the listener
    cm.set('httpListener.port', nextTestPort());
    // Give a tick
    await new Promise<void>((r) => setImmediate(r));
    expect(mock.calls).toHaveLength(0);
  });
});

describe('HL3: HttpListener ignores unrelated config key changes', () => {
  test('controlPlane.port change does not restart HttpListener', async () => {
    const cm = makeConfigManager();
    // Ensure controlPlane keys are also set
    cm.set('controlPlane.port', nextTestPort());
    const mock = makeServeMock();
    const listener = makeHttpListener(cm, mock);

    await startListener(listener);
    expect(mock.calls).toHaveLength(1);

    cm.set('controlPlane.port', 9999);
    await new Promise<void>((r) => setImmediate(r));

    expect(mock.calls).toHaveLength(1); // no restart
    await listener.stop();
  });
});

describe('HL4: stop() unsubscribes — no restart after explicit stop', () => {
  test('config change after stop() does not restart the listener', async () => {
    const cm = makeConfigManager();
    const mock = makeServeMock();
    const listener = makeHttpListener(cm, mock);

    await startListener(listener);
    await listener.stop();

    // Now change config — should be silent
    cm.set('httpListener.port', nextTestPort());
    await new Promise<void>((r) => setImmediate(r));

    expect(mock.calls).toHaveLength(1); // only the original start
    expect(listener.isRunning).toBe(false);
  });
});

describe('HL5: Re-entrancy guard — dirty-flag ensures both changes are applied', () => {
  test('simultaneous port + host change fires two restart cycles, not zero or one', async () => {
    const cm = makeConfigManager();
    const serveMock = makeServeMock();
    const listener = makeHttpListener(cm, serveMock);

    await startListener(listener);
    expect(serveMock.calls).toHaveLength(1);

    // Fire two changes back-to-back synchronously — the re-entrancy guard absorbs
    // the second trigger into _restartDirty=true, then the finally block loops back
    // and triggers a second restart so both changes are applied.
    cm.set('httpListener.port', nextTestPort());
    cm.set('httpListener.host', '127.0.0.2');
    await listener.waitForRestart();
    // First restart: guard kicks off restart #1, dirty flag set for host change.
    // Second restart: dirty-flag loop-back picks up host change.
    // Total: initial start (1) + restart #1 (1) + restart #2 (1) = 3.
    expect(serveMock.calls).toHaveLength(3);
    await listener.stop();
  });
});

describe('HL6: hostMode change triggers rebind', () => {
  test('local -> custom with explicit host rebinds to custom host', async () => {
    const cm = makeConfigManager();
    const serveMock = makeServeMock();
    const listener = makeHttpListener(cm, serveMock);

    await startListener(listener);
    expect(serveMock.calls[0]!.hostname).toBe('127.0.0.1'); // local mode default

    // Switch to custom mode with an explicit host
    cm.set('httpListener.host', '0.0.0.0');
    cm.set('httpListener.hostMode', 'custom');
    await listener.waitForRestart();

    // After restart the server should bind to 0.0.0.0
    const lastCall = serveMock.calls[serveMock.calls.length - 1]!;
    expect(lastCall.hostname).toBe('0.0.0.0');
    await listener.stop();
  });
});

// ---------------------------------------------------------------------------
// HW: createHostModeRestartWatcher unit tests
// ---------------------------------------------------------------------------

describe('HW1: createHostModeRestartWatcher — fires onRestart when key changes and running', () => {
  test('calls onRestart when a watched key is set and isRunning=true', () => {
    const cm = makeConfigManager();
    const onRestart = mock(() => {});
    let running = true;

    const handle = createHostModeRestartWatcher({
      configManager: cm,
      keys: ['httpListener.port'],
      onRestart,
      getIsRunning: () => running,
    });

    cm.set('httpListener.port', nextTestPort());
    expect(onRestart).toHaveBeenCalledTimes(1);
    handle.unsubscribe();
  });
});

describe('HW2: createHostModeRestartWatcher — does NOT fire when isRunning=false', () => {
  test('skips onRestart when getIsRunning returns false', () => {
    const cm = makeConfigManager();
    const onRestart = mock(() => {});

    const handle = createHostModeRestartWatcher({
      configManager: cm,
      keys: ['httpListener.port'],
      onRestart,
      getIsRunning: () => false,
    });

    cm.set('httpListener.port', nextTestPort());
    expect(onRestart).toHaveBeenCalledTimes(0);
    handle.unsubscribe();
  });
});

describe('HW3: createHostModeRestartWatcher — unsubscribe prevents further callbacks', () => {
  test('onRestart is not called after unsubscribe()', () => {
    const cm = makeConfigManager();
    const onRestart = mock(() => {});

    const handle = createHostModeRestartWatcher({
      configManager: cm,
      keys: ['httpListener.port'],
      onRestart,
      getIsRunning: () => true,
    });

    handle.unsubscribe();
    cm.set('httpListener.port', nextTestPort());
    expect(onRestart).toHaveBeenCalledTimes(0);
  });
});

describe('HW4: createHostModeRestartWatcher — unsubscribe is idempotent', () => {
  test('calling unsubscribe() twice does not throw', () => {
    const cm = makeConfigManager();
    const handle = createHostModeRestartWatcher({
      configManager: cm,
      keys: ['httpListener.port'],
      onRestart: () => {},
      getIsRunning: () => true,
    });
    expect(() => { handle.unsubscribe(); handle.unsubscribe(); }).not.toThrow();
  });
});

describe('HW5: createHostModeRestartWatcher — getIsRunning gate and multi-key subscription', () => {
  test('fires onRestart for each watched key independently', () => {
    const cm = makeConfigManager();
    const restartCalls: string[] = [];
    let running = true;

    const handle = createHostModeRestartWatcher({
      configManager: cm,
      keys: ['httpListener.hostMode', 'httpListener.host', 'httpListener.port'],
      onRestart: () => restartCalls.push('restart'),
      getIsRunning: () => running,
    });

    // Each key change should trigger onRestart independently
    cm.set('httpListener.port', nextTestPort());
    cm.set('httpListener.host', '192.168.1.1');
    cm.set('httpListener.hostMode', 'custom');
    expect(restartCalls).toHaveLength(3);

    handle.unsubscribe();
  });

  test('getIsRunning=false gates ALL keys — none trigger onRestart', () => {
    const cm = makeConfigManager();
    const onRestart = mock(() => {});
    let running = false;

    const handle = createHostModeRestartWatcher({
      configManager: cm,
      keys: ['httpListener.hostMode', 'httpListener.host', 'httpListener.port'],
      onRestart,
      getIsRunning: () => running,
    });

    cm.set('httpListener.port', nextTestPort());
    cm.set('httpListener.host', '10.0.0.1');
    cm.set('httpListener.hostMode', 'network');
    expect(onRestart).toHaveBeenCalledTimes(0);

    // Now flip running=true — subsequent changes should fire
    running = true;
    cm.set('httpListener.port', nextTestPort());
    expect(onRestart).toHaveBeenCalledTimes(1);

    handle.unsubscribe();
  });

  test('unsubscribe stops all key subscriptions', () => {
    const cm = makeConfigManager();
    const onRestart = mock(() => {});

    const handle = createHostModeRestartWatcher({
      configManager: cm,
      keys: ['httpListener.hostMode', 'httpListener.host', 'httpListener.port'],
      onRestart,
      getIsRunning: () => true,
    });

    handle.unsubscribe();

    // After unsubscribe, no key should trigger onRestart
    cm.set('httpListener.port', nextTestPort());
    cm.set('httpListener.host', '10.0.0.2');
    cm.set('httpListener.hostMode', 'local');
    expect(onRestart).toHaveBeenCalledTimes(0);
  });
});
