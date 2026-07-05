/**
 * daemon-version-compat.test.ts
 *
 * The adopt-or-start version band policy: a surface may only adopt a daemon on
 * the configured port when the daemon's reported version is in the same wire
 * band. These are pure-function tests of the policy, independent of the live
 * build VERSION (fixed version literals, no comparison against the SDK version).
 */

import { describe, expect, test } from 'bun:test';
import {
  isDaemonVersionCompatible,
  describeVersionIncompatibility,
} from '../packages/sdk/src/platform/runtime/daemon-version-compat.ts';

describe('isDaemonVersionCompatible — 0.y band (minor is the breaking axis)', () => {
  test('same 0.y minor is compatible regardless of patch', () => {
    expect(isDaemonVersionCompatible('0.38.0', '0.38.9')).toBe(true);
    expect(isDaemonVersionCompatible('0.38.9', '0.38.0')).toBe(true);
  });

  test('different 0.y minor is incompatible', () => {
    expect(isDaemonVersionCompatible('0.38.0', '0.37.30')).toBe(false);
    expect(isDaemonVersionCompatible('0.38.0', '0.35.0')).toBe(false);
    expect(isDaemonVersionCompatible('0.33.30', '0.38.0')).toBe(false);
  });
});

describe('isDaemonVersionCompatible — >=1 band (major is the breaking axis)', () => {
  test('same major, any minor/patch is compatible', () => {
    expect(isDaemonVersionCompatible('1.0.0', '1.9.9')).toBe(true);
    expect(isDaemonVersionCompatible('1.4.2', '1.0.0')).toBe(true);
  });

  test('different major is incompatible', () => {
    expect(isDaemonVersionCompatible('1.0.0', '2.0.0')).toBe(false);
    expect(isDaemonVersionCompatible('2.0.0', '1.9.9')).toBe(false);
    expect(isDaemonVersionCompatible('0.38.0', '1.0.0')).toBe(false);
  });
});

describe('isDaemonVersionCompatible — parsing and edge cases', () => {
  test('prerelease and build metadata are ignored for banding', () => {
    expect(isDaemonVersionCompatible('0.38.0', '0.38.1-rc.2')).toBe(true);
    expect(isDaemonVersionCompatible('1.2.0+build.5', '1.9.0')).toBe(true);
    expect(isDaemonVersionCompatible('v0.38.0', '0.38.0')).toBe(true);
  });

  test('unparseable or absent versions are never compatible (conservative default)', () => {
    expect(isDaemonVersionCompatible('0.38.0', undefined)).toBe(false);
    expect(isDaemonVersionCompatible('0.38.0', '')).toBe(false);
    expect(isDaemonVersionCompatible('0.38.0', 'not-a-version')).toBe(false);
    expect(isDaemonVersionCompatible(undefined, '0.38.0')).toBe(false);
    expect(isDaemonVersionCompatible('0', '0.38.0')).toBe(false);
  });
});

describe('describeVersionIncompatibility', () => {
  test('names the endpoint, the found version, and this surface version', () => {
    const reason = describeVersionIncompatibility('127.0.0.1', 3421, '0.38.0', '0.35.0');
    expect(reason).toContain('127.0.0.1:3421');
    expect(reason).toContain('0.35.0');
    expect(reason).toContain('0.38.0');
    expect(reason.toLowerCase()).toContain('incompatible');
  });

  test('degrades to "unknown" when a version is missing rather than printing undefined', () => {
    const reason = describeVersionIncompatibility('127.0.0.1', 3421, '0.38.0', undefined);
    expect(reason).toContain('unknown');
    expect(reason).not.toContain('undefined');
  });
});
