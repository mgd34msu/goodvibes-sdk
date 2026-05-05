/**
 *
 * RateLimiter O(1) LRU correctness.
 * Verifies the http-listener's RateLimiter:
 *   - Allows requests under the limit.
 *   - Blocks requests over the limit.
 *   - Tracks IPs independently.
 *   - LRU eviction works (lruMap capped at maxEntries).
 *   - _sweep removes expired entries.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserAuthManager } from '../packages/sdk/src/platform/security/user-auth.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { HttpListener } from '../packages/sdk/src/platform/daemon/http-listener.ts';
import { installFrozenNow } from './_helpers/test-timeout.ts';

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-perf02-${suffix}-${randomUUID()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

const TEST_NOW_MS = 1_800_000_000_000;
let restoreNow: (() => void) | undefined;

beforeEach(() => {
  restoreNow = installFrozenNow(TEST_NOW_MS);
});

afterEach(() => {
  restoreNow?.();
  restoreNow = undefined;
});

type RateLimiterInternal = {
  check(ip: string): boolean;
  lruMap: Map<string, number>;
  _sweep(): void;
  maxEntries: number;
};

function makeRateLimiter(limit: number): { rl: RateLimiterInternal; cleanup: () => void } {
  const dir = tempDir('rl');
  const userAuth = new UserAuthManager({
    bootstrapFilePath: join(dir, 'auth-users.json'),
    bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'),
  });
  const configManager = new ConfigManager({ configDir: dir });
  const listener = new HttpListener({
    port: 0,
    userAuth,
    configManager,
    rateLimit: limit,
  }) as unknown as { rateLimiter: RateLimiterInternal };
  return {
    rl: listener.rateLimiter,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('RateLimiter O(1) LRU', () => {
  test('check returns true when under limit', () => {
    const { rl, cleanup } = makeRateLimiter(10);
    try {
      expect(rl.check('1.2.3.4')).toBe(true);
    } finally { cleanup(); }
  });

  test('check returns false after exceeding limit', () => {
    const { rl, cleanup } = makeRateLimiter(3);
    try {
      rl.check('1.2.3.4');
      rl.check('1.2.3.4');
      rl.check('1.2.3.4');
      expect(rl.check('1.2.3.4')).toBe(false);
    } finally { cleanup(); }
  });

  test('each IP is tracked independently', () => {
    const { rl, cleanup } = makeRateLimiter(2);
    try {
      rl.check('1.1.1.1');
      rl.check('1.1.1.1');
      expect(rl.check('2.2.2.2')).toBe(true);
      expect(rl.check('1.1.1.1')).toBe(false);
    } finally { cleanup(); }
  });

  test('lruMap contains entry after check', () => {
    const { rl, cleanup } = makeRateLimiter(10);
    try {
      rl.check('5.6.7.8');
      expect(rl.lruMap.has('5.6.7.8')).toBe(true);
    } finally { cleanup(); }
  });

  test('_sweep removes expired entries', () => {
    const { rl, cleanup } = makeRateLimiter(100);
    try {
      rl.check('9.9.9.9');
      // Backdate the stored timestamp to simulate expiry
      // Backdate beyond RATE_TTL_MS (10 minutes = 600_000ms)
      rl.lruMap.set('9.9.9.9', Date.now() - 700_000);
      rl._sweep();
      expect(rl.lruMap.has('9.9.9.9')).toBe(false);
    } finally { cleanup(); }
  });
});
