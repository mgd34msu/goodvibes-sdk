/**
 * Coverage-gap smoke test — platform/runtime/sandbox (sec-10)
 * Verifies sandbox boundary functions return correct observable shapes
 * when called with realistic inputs.
 * Closes coverage gap: sec-10 sandbox boundary / platform/runtime/sandbox (eighth-review)
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

/** Minimal ConfigManagerLike that returns undefined for all keys (default config). */
function makeConfigManager() {
  return { get: (_key: string) => undefined };
}

describe('platform/runtime/sandbox — behavior smoke', () => {
  test('isRunningInWsl returns a boolean', () => {
    expect(typeof isRunningInWsl()).toBe('boolean');
  });

  test('getSandboxConfigSnapshot returns a frozen object with expected keys', () => {
    const config = getSandboxConfigSnapshot(makeConfigManager());
    expect(config).toBeDefined();
    expect(typeof config).toBe('object');
    // Must be frozen (Object.isFrozen)
    expect(Object.isFrozen(config)).toBe(true);
    // Must include replIsolation key
    expect('replIsolation' in config).toBe(true);
  });

  test('detectSandboxHostStatus returns a frozen object with platform key', () => {
    const status = detectSandboxHostStatus(makeConfigManager());
    expect(status).toBeDefined();
    expect(Object.isFrozen(status)).toBe(true);
    expect('platform' in status).toBe(true);
    expect(typeof (status as Record<string, unknown>).platform).toBe('string');
  });

  test('listSandboxProfiles returns a non-empty array, each profile has id/label/kind/isolation', () => {
    const profiles = listSandboxProfiles(makeConfigManager());
    expect(Array.isArray(profiles)).toBe(true);
    expect(profiles.length).toBeGreaterThan(0);
    const first = profiles[0] as Record<string, unknown>;
    expect(typeof first.id).toBe('string');
    expect(typeof first.label).toBe('string');
    expect(typeof first.kind).toBe('string');
    expect(typeof first.isolation).toBe('string');
  });

  test('listSandboxPresets returns an array containing secure-balanced', () => {
    const presets = listSandboxPresets();
    expect(Array.isArray(presets)).toBe(true);
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
});
