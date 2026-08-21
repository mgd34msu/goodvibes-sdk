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
  test('a one-field sdkPin section parses: requiredness lives in resolveSdkPinConfig, not the schema', () => {
    const raw = JSON.stringify({
      packageName: '@pellux/goodvibes-tui',
      sdkPin: { pinSource: 'devDependencies' },
    });
    const config = parseToolchainConfig(raw);
    expect(Object.keys(config.sdkPin ?? {})).toEqual(['pinSource']);
    expect(config.sdkPin?.pinSource).toBe('devDependencies');
    const resolved = resolveSdkPinConfig(config.sdkPin);
    expect(resolved.pinSource).toBe('devDependencies');
    expect(resolved.sdkPackage).toBe(DEFAULT_SDK_PACKAGE);
  });
  test('a perJobGreen section with only owner/repo parses: the rest defaults via resolvePerJobGreenConfig', () => {
    const raw = JSON.stringify({
      packageName: '@pellux/goodvibes-tui',
      perJobGreen: { owner: 'mgd34msu', repo: 'goodvibes-sdk' },
    });
    const config = parseToolchainConfig(raw);
    expect(Object.keys(config.perJobGreen ?? {}).sort()).toEqual(['owner', 'repo']);
    expect(config.perJobGreen?.owner).toBe('mgd34msu');
    expect(config.perJobGreen?.repo).toBe('goodvibes-sdk');
    const resolved = resolvePerJobGreenConfig(config.perJobGreen as { owner: string; repo: string });
    expect(resolved.workflow).toBe('ci.yml');
    expect(resolved.retryAttempts).toBe(8);
  });
  test('rejects a present-but-wrongly-typed optional sdkPin field, naming it', () => {
    const raw = JSON.stringify({
      packageName: '@pellux/goodvibes-tui',
      sdkPin: { sourceRoots: 'src' },
    });
    expect(() => parseToolchainConfig(raw)).toThrow(/sdkPin\.sourceRoots/);
  });
  test('rejects a malformed nested section with a clear message naming the bad field', () => {
    const raw = JSON.stringify({
      packageName: '@pellux/goodvibes-tui',
      coverage: { funcsFloor: 80, linesFloor: '90', command: ['bun', 'test', '--coverage', 'src'] },
    });
    expect(() => parseToolchainConfig(raw)).toThrow(/coverage\.linesFloor/);
  });
  test('rejects a malformed enum field with a clear message naming the bad field', () => {
    const raw = JSON.stringify({
      packageName: '@pellux/goodvibes-tui',
      releaseCut: {
        branch: 'main',
        versionFiles: [],
        syncCommands: [],
        commitPaths: [],
        changelogHeading: 'invalid',
        changelogInsertMarker: 'top',
      },
    });
    expect(() => parseToolchainConfig(raw)).toThrow(/releaseCut\.changelogHeading/);
  });
  test('valid config parses to a deep-equal object, matching the old cast-through parser', () => {
    const full = {
      packageName: '@pellux/goodvibes-tui',
      sdkPin: {
        sdkPackage: '@pellux/goodvibes-sdk',
        pinSource: 'dependencies',
        lockfile: 'bun.lock',
        overlayMarker: 'node_modules/@pellux/goodvibes-sdk/.local-sdk-overlay.json',
        sourceRoots: ['src'],
        enforceExportsMap: false,
      },
      coverage: {
        funcsFloor: 80,
        linesFloor: 90,
        command: ['bun', 'test', '--coverage', 'src'],
      },
      // Unknown extra key: the old cast-through parser preserved whatever the
      // raw JSON contained, so a valid config must still round-trip it. This
      // is checked with `toEqual` (deep equality of values), not identity;
      // `.catchall(z.unknown())` does not guarantee the parsed object's key
      // order matches the input's, and nothing here re-serializes the config,
      // so that reordering has no observable effect.
      extra: { nested: true },
    };
    const raw = JSON.stringify(full);
    const config = parseToolchainConfig(raw);
    expect(config).toEqual(JSON.parse(raw));
  });
});
