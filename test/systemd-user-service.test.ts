import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import {
  renderGoodvibesDaemonUnit,
  buildDaemonExecStart,
  goodvibesDaemonUnitPath,
  installGoodvibesDaemonUserService,
  uninstallGoodvibesDaemonUserService,
  goodvibesDaemonUserServiceStatus,
  GOODVIBES_DAEMON_UNIT_NAME,
  SERVICE_UNSUPPORTED_EXIT_CODE,
  type SystemctlRunner,
  type SystemctlResult,
} from '../packages/sdk/src/platform/daemon/systemd-user-service.ts';

const UNIT_OPTIONS = {
  binaryPath: '/usr/local/bin/goodvibes-daemon',
  homeDir: '/home/tester',
  host: '127.0.0.1',
  port: 3421,
} as const;

describe('renderGoodvibesDaemonUnit (pure, golden)', () => {
  test('produces the exact systemd USER unit content', () => {
    const unit = renderGoodvibesDaemonUnit(UNIT_OPTIONS);
    expect(unit).toBe(
      [
        '[Unit]',
        'Description=GoodVibes daemon (shared session broker + companion host)',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart=/usr/local/bin/goodvibes-daemon --daemon-home /home/tester --hostname 127.0.0.1 --port 3421',
        'Restart=on-failure',
        'RestartSec=3',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    );
  });

  test('encodes the required directives: Restart=on-failure, WantedBy=default.target, After=network.target', () => {
    const unit = renderGoodvibesDaemonUnit({ ...UNIT_OPTIONS, port: 4555, homeDir: '/var/lib/gv' });
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('After=network.target');
    // Resolved home/port land in ExecStart.
    expect(unit).toContain('--daemon-home /var/lib/gv');
    expect(unit).toContain('--port 4555');
  });

  test('respects a custom RestartSec and Description', () => {
    const unit = renderGoodvibesDaemonUnit({ ...UNIT_OPTIONS, restartSec: 10, description: 'Custom desc' });
    expect(unit).toContain('RestartSec=10');
    expect(unit).toContain('Description=Custom desc');
  });

  test('buildDaemonExecStart is exactly the binary plus resolved flags', () => {
    expect(buildDaemonExecStart(UNIT_OPTIONS)).toBe(
      '/usr/local/bin/goodvibes-daemon --daemon-home /home/tester --hostname 127.0.0.1 --port 3421',
    );
  });

  test('unit install path is <configHome>/.config/systemd/user/goodvibes-daemon.service', () => {
    expect(goodvibesDaemonUnitPath('/home/tester')).toBe(
      '/home/tester/.config/systemd/user/goodvibes-daemon.service',
    );
  });
});

describe('install/uninstall orchestration (stubbed systemctl — no root, no real systemd)', () => {
  function recordingRunner(): { runner: SystemctlRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: SystemctlRunner = (args) => {
      calls.push([...args]);
      return { status: 0 } satisfies SystemctlResult;
    };
    return { runner, calls };
  }

  test('install writes the unit and runs daemon-reload + enable --now with the exact arg vectors', () => {
    const { runner, calls } = recordingRunner();
    const writes: Array<{ path: string; contents: string }> = [];
    const result = installGoodvibesDaemonUserService(UNIT_OPTIONS, {
      platform: 'linux',
      runSystemctl: runner,
      writeUnitFile: (path, contents) => { writes.push({ path, contents }); },
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.unitPath).toBe('/home/tester/.config/systemd/user/goodvibes-daemon.service');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.contents).toContain('ExecStart=/usr/local/bin/goodvibes-daemon --daemon-home /home/tester');
    expect(calls).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', '--now', GOODVIBES_DAEMON_UNIT_NAME],
    ]);
    expect(result.lines.some((l) => l.includes('systemctl --user disable --now goodvibes-daemon.service'))).toBe(true);
  });

  test('install reports failure honestly when enable exits non-zero', () => {
    const runner: SystemctlRunner = (args) =>
      args.includes('enable') ? { status: 1, stderr: 'unit masked' } : { status: 0 };
    const result = installGoodvibesDaemonUserService(UNIT_OPTIONS, {
      platform: 'linux',
      runSystemctl: runner,
      writeUnitFile: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.lines.some((l) => l.includes('FAILED') && l.includes('unit masked'))).toBe(true);
  });

  test('uninstall runs disable --now + daemon-reload and removes the unit', () => {
    const { runner, calls } = recordingRunner();
    let removed: string | null = null;
    const result = uninstallGoodvibesDaemonUserService({ homeDir: '/home/tester' }, {
      platform: 'linux',
      runSystemctl: runner,
      removeUnitFile: (path) => { removed = path; },
      fileExists: () => true,
    });
    expect(result.ok).toBe(true);
    expect(removed).toBe('/home/tester/.config/systemd/user/goodvibes-daemon.service');
    expect(calls).toEqual([
      ['--user', 'disable', '--now', GOODVIBES_DAEMON_UNIT_NAME],
      ['--user', 'daemon-reload'],
    ]);
  });

  test('the real systemctl runner is NEVER invoked in these tests (stub captured every call)', () => {
    // Guard assertion: if the default runner had leaked through, calls would be empty
    // and the unit would have been written to the real home. We inject writeUnitFile
    // + runSystemctl everywhere, so nothing touches the host.
    const { runner, calls } = recordingRunner();
    installGoodvibesDaemonUserService(UNIT_OPTIONS, { platform: 'linux', runSystemctl: runner, writeUnitFile: () => {} });
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('non-Linux platforms report honest unsupported (clean non-zero exit, no crash)', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    test(`${platform}: install returns supported:false with exit code ${SERVICE_UNSUPPORTED_EXIT_CODE}`, () => {
      let systemctlInvoked = false;
      const result = installGoodvibesDaemonUserService(UNIT_OPTIONS, {
        platform,
        runSystemctl: () => { systemctlInvoked = true; return { status: 0 }; },
        writeUnitFile: () => { systemctlInvoked = true; },
      });
      expect(result.supported).toBe(false);
      expect(result.exitCode).toBe(SERVICE_UNSUPPORTED_EXIT_CODE);
      expect(result.ok).toBe(false);
      expect(systemctlInvoked).toBe(false); // guarded: nothing runs on unsupported platforms
      expect(result.lines[0]).toContain('not supported yet');
    });
  }

  test('darwin names the launchd follow-up track', () => {
    const result = installGoodvibesDaemonUserService(UNIT_OPTIONS, { platform: 'darwin' });
    expect(result.lines[0]).toContain('macOS launchd follow-up');
  });
});

// --- Real user-systemd detection: honest round-trip when a user bus exists, ---
// --- else a NAMED skip. Host-safety: we exercise only READ-ONLY systemctl    ---
// --- (is-enabled/is-active/daemon-reload is not run here); we never install,  ---
// --- enable, or start the real goodvibes daemon on this host.                 ---
function detectUserSystemd(): { available: boolean; reason: string } {
  const probe = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf-8' });
  if (probe.error) return { available: false, reason: `systemctl binary not available: ${probe.error.message}` };
  const combined = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  if (/Failed to connect to( the)? bus|No medium|Access denied|not been booted with systemd/i.test(combined)) {
    return { available: false, reason: 'no reachable user systemd bus in this environment' };
  }
  return { available: true, reason: `user systemd bus reachable (state: ${(probe.stdout ?? '').trim() || 'unknown'})` };
}

const userSystemd = detectUserSystemd();

describe('real user-systemd status probe (read-only)', () => {
  test.skipIf(!userSystemd.available)(
    `status() against the real user bus returns a supported result [${userSystemd.reason}]`,
    () => {
      const result = goodvibesDaemonUserServiceStatus({ homeDir: os.homedir() });
      expect(result.supported).toBe(true);
      expect(result.action).toBe('status');
      expect(result.unitPath).toContain('/.config/systemd/user/goodvibes-daemon.service');
      // installed/enabled/active are read-only reads; whatever the truth is, the
      // lines are populated honestly.
      expect(result.lines.some((l) => l.startsWith('installed:'))).toBe(true);
    },
  );

  test.skipIf(userSystemd.available)(
    `SKIP real-bus round-trip: ${userSystemd.reason}`,
    () => {
      // Named skip guard: when no user bus is reachable we do not fabricate a pass.
      expect(userSystemd.available).toBe(false);
    },
  );
});
