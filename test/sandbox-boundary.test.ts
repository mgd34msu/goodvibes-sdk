/**
 * Coverage-gap smoke test — platform/runtime/sandbox
 * Verifies sandbox boundary functions return correct observable shapes
 * when called with realistic inputs.
 * Closes coverage gap: sandbox boundary / platform/runtime/sandbox
 */

import { describe, expect, test } from 'bun:test';
import {
  getSandboxConfigSnapshot,
  detectSandboxHostStatus,
  listSandboxProfiles,
  listSandboxPresets,
  getSandboxPreset,
  isRunningInWsl,
} from '../packages/sdk/src/platform/runtime/sandbox/manager.js';
import {
  buildSandboxLaunchPlan,
  probeSandboxBackends,
} from '../packages/sdk/src/platform/runtime/sandbox/backend.js';

const sandboxConfig = {
  'sandbox.replIsolation': 'shared-vm',
  'sandbox.mcpIsolation': 'hybrid',
  'sandbox.windowsMode': 'require-wsl',
  'sandbox.vmBackend': 'qemu',
  'sandbox.qemuBinary': 'qemu-system-x86_64',
  'sandbox.qemuImagePath': '/tmp/goodvibes-sandbox.img',
  'sandbox.qemuExecWrapper': '/tmp/goodvibes-qemu-wrapper',
  'sandbox.qemuGuestHost': '127.0.0.1',
  'sandbox.qemuGuestPort': 2222,
  'sandbox.qemuGuestUser': 'goodvibes',
  'sandbox.qemuWorkspacePath': '/workspace',
  'sandbox.qemuSessionMode': 'attach',
} as const;

function makeConfigManager() {
  return {
    get: (key: string) => sandboxConfig[key as keyof typeof sandboxConfig],
  };
}

function makeConfigManagerWith(
  overrides: Partial<Record<keyof typeof sandboxConfig, string | number>>,
) {
  return {
    get: (key: string) => ({
      ...sandboxConfig,
      ...overrides,
    })[key as keyof typeof sandboxConfig],
  };
}

describe('platform/runtime/sandbox — behavior smoke', () => {
  test('isRunningInWsl returns a boolean', () => {
    expect(typeof isRunningInWsl()).toBe('boolean');
  });

  test('getSandboxConfigSnapshot returns a frozen snapshot from config values', () => {
    const config = getSandboxConfigSnapshot(makeConfigManager());
    expect(Object.isFrozen(config)).toBe(true);
    expect(config).toEqual({
      replIsolation: 'shared-vm',
      mcpIsolation: 'hybrid',
      windowsMode: 'require-wsl',
      vmBackend: 'qemu',
      qemuBinary: 'qemu-system-x86_64',
      qemuImagePath: '/tmp/goodvibes-sandbox.img',
      qemuExecWrapper: '/tmp/goodvibes-qemu-wrapper',
      qemuGuestHost: '127.0.0.1',
      qemuGuestPort: 2222,
      qemuGuestUser: 'goodvibes',
      qemuWorkspacePath: '/workspace',
      qemuSessionMode: 'attach',
    });
  });

  test('detectSandboxHostStatus returns frozen host readiness details', () => {
    const status = detectSandboxHostStatus(makeConfigManager());
    expect(Object.isFrozen(status)).toBe(true);
    expect(status.platform).toBe(process.platform);
    expect(status.windows).toBe(process.platform === 'win32');
    expect(status.runningInWsl).toBe(isRunningInWsl());
    expect(status.recommendedBackend).toBe('qemu');
    expect(Array.isArray(status.warnings)).toBe(true);
  });

  test('listSandboxProfiles returns a non-empty array, each profile has id/label/kind/isolation', () => {
    const profiles = listSandboxProfiles(makeConfigManager());
    expect(profiles).toBeInstanceOf(Array);
    expect(profiles.length).toBeGreaterThan(0);
    const first = profiles[0] as Record<string, unknown>;
    expect(typeof first.id).toBe('string');
    expect(typeof first.label).toBe('string');
    expect(typeof first.kind).toBe('string');
    expect(typeof first.isolation).toBe('string');
  });

  test('listSandboxPresets returns an array containing secure-balanced', () => {
    const presets = listSandboxPresets();
    expect(presets).toBeInstanceOf(Array);
    const ids = (presets as Array<Record<string, unknown>>).map((p) => p.id);
    expect(ids).toContain('secure-balanced');
  });

  test('getSandboxPreset returns the preset for secure-balanced with id and label', () => {
    const preset = getSandboxPreset('secure-balanced');
    expect(preset).not.toBeNull();
    const p = preset as Record<string, unknown>;
    expect(p.id).toBe('secure-balanced');
    expect(typeof p.label).toBe('string');
  });

  test('getSandboxPreset returns null for an unknown preset id', () => {
    const preset = getSandboxPreset('non-existent-preset-xyz');
    // Returns null, not undefined
    expect(preset).toBeNull();
  });

  test('probe does not resolve explicit qemu to local when qemu is unavailable', () => {
    const manager = makeConfigManagerWith({
      'sandbox.vmBackend': 'qemu',
      'sandbox.qemuBinary': '__goodvibes_missing_qemu_binary__',
    });
    const probe = probeSandboxBackends(manager);

    expect(probe.requestedBackend).toBe('qemu');
    expect(probe.resolvedBackend).toBe('qemu');
    expect(probe.backends.find((backend) => backend.id === 'qemu')?.available).toBe(false);
    expect(probe.warnings.join('\n')).toContain('local process isolation will not be used');
  });

  test('launch planning refuses to downgrade explicit qemu to local isolation', () => {
    const manager = makeConfigManagerWith({
      'sandbox.vmBackend': 'qemu',
      'sandbox.qemuBinary': '__goodvibes_missing_qemu_binary__',
    });
    const profile = listSandboxProfiles(manager)[0]!;

    expect(() => buildSandboxLaunchPlan(profile, 'No downgrade', manager, process.cwd()))
      .toThrow(/refusing to downgrade to local process isolation/);
  });
});
