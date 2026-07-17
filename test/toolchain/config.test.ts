import { describe, expect, test } from 'bun:test';
import { parseToolchainConfig, resolveSdkPinConfig, resolvePerJobGreenConfig, DEFAULT_SDK_PACKAGE } from '@pellux/goodvibes-toolchain';

describe('toolchain config', () => {
  test('parses a minimal config', () => {
    const config = parseToolchainConfig('{"packageName":"@pellux/goodvibes-tui"}');
    expect(config.packageName).toBe('@pellux/goodvibes-tui');
  });
  test('rejects a config without packageName', () => {
    expect(() => parseToolchainConfig('{}')).toThrow(/packageName/);
  });
  test('rejects a non-object config', () => {
    expect(() => parseToolchainConfig('[]')).toThrow();
  });
  test('resolveSdkPinConfig fills conventional defaults', () => {
    const resolved = resolveSdkPinConfig(undefined);
    expect(resolved.sdkPackage).toBe(DEFAULT_SDK_PACKAGE);
    expect(resolved.pinSource).toBe('dependencies');
    expect(resolved.lockfile).toBe('bun.lock');
    expect(resolved.overlayMarker).toContain('.local-sdk-overlay.json');
  });
  test('resolvePerJobGreenConfig requires owner/repo and defaults the rest', () => {
    const resolved = resolvePerJobGreenConfig({ owner: 'a', repo: 'b' });
    expect(resolved.workflow).toBe('ci.yml');
    expect(resolved.event).toBe('push');
    expect(resolved.pollIntervalMs).toBeGreaterThan(0);
  });
  test('per-job-green default retry posture: ~8 attempts with sleeps in the 5-10s band', () => {
    const resolved = resolvePerJobGreenConfig({ owner: 'a', repo: 'b' });
    expect(resolved.retryAttempts).toBe(8);
    expect(resolved.retryDelayMs).toBeGreaterThanOrEqual(5000);
    expect(resolved.retryDelayMs).toBeLessThanOrEqual(10000);
    // And it stays configurable.
    const custom = resolvePerJobGreenConfig({ owner: 'a', repo: 'b', retryAttempts: 3, retryDelayMs: 100 });
    expect(custom.retryAttempts).toBe(3);
    expect(custom.retryDelayMs).toBe(100);
  });
});
