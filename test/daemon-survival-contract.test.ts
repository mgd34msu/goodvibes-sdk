/**
 * The daemon survival contract: the generated systemd unit never tombstones
 * (StartLimitIntervalSec=0 + escalating restart delays where systemd
 * supports them), the install path verifies lingering honestly, and the
 * clean-shutdown marker yields exactly one crash receipt after an unclean
 * exit.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import {
  parseSystemdMajorVersion,
  PlatformServiceManager,
  renderSystemdUnit,
  systemdSupportsRestartSteps,
  type ManagedServiceActionResult,
  type ManagedServiceDefinition,
} from '../packages/sdk/src/platform/daemon/service-manager.js';
import {
  recordDaemonCleanShutdown,
  recordDaemonStart,
  type LifecycleMarkerIo,
} from '../packages/sdk/src/platform/daemon/lifecycle-marker.js';
import { DaemonReceiptStore, formatReceiptTime } from '../packages/sdk/src/platform/daemon/receipts.js';

const definition: ManagedServiceDefinition = {
  name: 'goodvibes',
  description: 'goodvibes omnichannel daemon host',
  workingDirectory: '/home/user/project',
  command: '/opt/gv/goodvibes-daemon',
  args: [],
  env: {},
  restartOnFailure: true,
};

describe('renderSystemdUnit survival contract', () => {
  test('the unit disables the start-rate limiter and retries forever', () => {
    const unit = renderSystemdUnit(definition, 255);
    const lines = unit.split('\n');
    // StartLimitIntervalSec belongs in [Unit]; a crashing daemon must keep
    // retrying instead of tombstoning in the start-limit-hit state.
    expect(lines.indexOf('StartLimitIntervalSec=0')).toBeGreaterThan(lines.indexOf('[Unit]'));
    expect(lines.indexOf('StartLimitIntervalSec=0')).toBeLessThan(lines.indexOf('[Service]'));
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=2');
  });

  test('systemd 254+ gets escalating restart delays; older systemd degrades to the flat retry', () => {
    const modern = renderSystemdUnit(definition, 254);
    expect(modern).toContain('RestartSteps=8');
    expect(modern).toContain('RestartMaxDelaySec=300');

    for (const version of [253, null] as const) {
      const older = renderSystemdUnit(definition, version);
      expect(older).not.toContain('RestartSteps');
      expect(older).not.toContain('RestartMaxDelaySec');
      expect(older).toContain('StartLimitIntervalSec=0');
      expect(older).toContain('RestartSec=2');
    }
  });

  test('a restartOnFailure=false unit keeps the plain shape', () => {
    const unit = renderSystemdUnit({ ...definition, restartOnFailure: false }, 255);
    expect(unit).toContain('Restart=no');
    expect(unit).not.toContain('StartLimitIntervalSec');
    expect(unit).not.toContain('RestartSteps');
  });

  test('systemd version parsing reads the first line of systemctl --version', () => {
    expect(parseSystemdMajorVersion('systemd 254 (254.10-arch)\n+PAM +AUDIT')).toBe(254);
    expect(parseSystemdMajorVersion('systemd 249 (v249.11)')).toBe(249);
    expect(parseSystemdMajorVersion('unexpected output')).toBeNull();
    expect(parseSystemdMajorVersion(undefined)).toBeNull();
    expect(systemdSupportsRestartSteps(254)).toBe(true);
    expect(systemdSupportsRestartSteps(253)).toBe(false);
    expect(systemdSupportsRestartSteps(null)).toBe(false);
  });
});

describe('systemd install path: detected version gates the unit; lingering is verified honestly', () => {
  function systemdManager(dir: string, options: {
    systemdVersion: string;
    lingerAnswers: readonly string[];
  }): { manager: PlatformServiceManager; commands: string[] } {
    const configManager = new ConfigManager({ configDir: join(dir, 'config') });
    configManager.set('service.platform', 'systemd');
    configManager.set('service.serviceName', 'goodvibes-survival-test');
    const commands: string[] = [];
    let lingerCall = 0;
    const actionRunner = (command: string, args: readonly string[]): ManagedServiceActionResult => {
      commands.push([command, ...args].join(' '));
      if (command === 'systemctl' && args[0] === '--version') {
        return { status: 0, stdout: options.systemdVersion };
      }
      if (command === 'loginctl' && args[0] === 'show-user') {
        const answer = options.lingerAnswers[Math.min(lingerCall, options.lingerAnswers.length - 1)] ?? '';
        lingerCall += 1;
        return { status: 0, stdout: `${answer}\n` };
      }
      return { status: 0, stdout: '' };
    };
    const manager = new PlatformServiceManager(configManager, {
      workingDirectory: dir,
      homeDirectory: dir,
      actionRunner,
      featureFlags: { isEnabled: (id: string) => id === 'service-management' },
      definitionOverride: { ...definition, workingDirectory: dir },
    });
    return { manager, commands };
  }

  test('install() renders the survival contract using the host systemd version and verifies lingering', () => {
    const dir = mkdtempSync(join(tmpdir(), 'survival-install-'));
    try {
      const { manager, commands } = systemdManager(dir, {
        systemdVersion: 'systemd 254 (254.10-arch)',
        lingerAnswers: ['Linger=no', 'Linger=yes'],
      });
      const status = manager.install();
      const unit = readFileSync(join(dir, '.config', 'systemd', 'user', 'goodvibes-survival-test.service'), 'utf-8');
      expect(unit).toContain('StartLimitIntervalSec=0');
      expect(unit).toContain('RestartSec=2');
      expect(unit).toContain('RestartSteps=8');
      expect(unit).toContain('RestartMaxDelaySec=300');
      expect(commands).toContain('systemctl --version');
      expect(commands.some((c) => c.startsWith('loginctl enable-linger '))).toBe(true);
      expect(status.lingerNote).toMatch(/lingering: enabled for .+ — the daemon starts at boot\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('older systemd omits the escalation directives; failed lingering yields the one honest fallback line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'survival-install-old-'));
    try {
      const { manager } = systemdManager(dir, {
        systemdVersion: 'systemd 249 (249.11-ubuntu)',
        lingerAnswers: ['Linger=no', 'Linger=no'],
      });
      const status = manager.install();
      const unit = readFileSync(join(dir, '.config', 'systemd', 'user', 'goodvibes-survival-test.service'), 'utf-8');
      expect(unit).toContain('StartLimitIntervalSec=0');
      expect(unit).toContain('RestartSec=2');
      expect(unit).not.toContain('RestartSteps');
      expect(status.lingerNote).toContain('could not be enabled');
      expect(status.lingerNote).toContain('loginctl enable-linger');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('clean-shutdown marker + crash receipt', () => {
  function markerIo(): { io: LifecycleMarkerIo; files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
      files,
      io: {
        read: (path) => files.get(path) ?? null,
        write: (path, contents) => void files.set(path, contents),
      },
    };
  }

  test('a first boot is not a crash', () => {
    const { io } = markerIo();
    const result = recordDaemonStart('/state/daemon-lifecycle.json', { io, now: () => 1000 });
    expect(result.crashed).toBe(false);
    expect(result.previous).toBeNull();
  });

  test('start after an orderly shutdown is not a crash; start after a running marker is', () => {
    const { io } = markerIo();
    recordDaemonStart('/state/daemon-lifecycle.json', { io, now: () => 1000, pid: 42 });
    recordDaemonCleanShutdown('/state/daemon-lifecycle.json', { io, now: () => 2000 });
    const cleanRestart = recordDaemonStart('/state/daemon-lifecycle.json', { io, now: () => 3000 });
    expect(cleanRestart.crashed).toBe(false);
    expect(cleanRestart.previous?.state).toBe('clean-shutdown');

    // This run "dies" here: no clean-shutdown stamp. The next start sees it.
    const afterCrash = recordDaemonStart('/state/daemon-lifecycle.json', { io, now: () => 4000 });
    expect(afterCrash.crashed).toBe(true);
    expect(afterCrash.previous?.state).toBe('running');
  });

  test('an unreadable marker never fabricates a crash', () => {
    const { io, files } = markerIo();
    files.set('/state/daemon-lifecycle.json', 'not json at all');
    const result = recordDaemonStart('/state/daemon-lifecycle.json', { io, now: () => 1000 });
    expect(result.crashed).toBe(false);
  });
});

describe('daemon receipts surfaced on next surface connect', () => {
  test('a crash receipt is delivered to the first /status reader exactly once and survives reloads', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'daemon-receipts-'));
    try {
      const path = join(scratch, 'daemon-receipts.json');
      const at = new Date(2026, 6, 12, 9, 05).getTime();
      const store = new DaemonReceiptStore(path, { now: () => at });
      store.record(`restarted after a crash at ${formatReceiptTime(at)}`);

      // A fresh store instance (daemon restart) still has the receipt pending.
      const reloaded = new DaemonReceiptStore(path);
      const delivered = reloaded.consumeUndelivered();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.text).toBe('restarted after a crash at 09:05');

      // Second surface connect: nothing left to surface.
      expect(reloaded.consumeUndelivered()).toEqual([]);
      const again = new DaemonReceiptStore(path);
      expect(again.consumeUndelivered()).toEqual([]);
      expect(again.list()).toHaveLength(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
