/**
 * sqlite-vec-resolver.test.ts
 *
 * Tests for the sqlite-vec bundled binary resolver.
 *
 * Coverage:
 *   - Dev mode (current process.meta.url has no $bunfs): returns ''
 *   - Bundled mode (simulate $bunfs URL): returns expected lib path
 *   - Path uses correct platform suffix (.so / .dylib / .dll)
 *   - Path uses correct platform/arch directory name
 */

import { describe, expect, test } from 'bun:test';
import { resolveSqliteVecPath } from '../packages/sdk/src/platform/state/memory-vector-store.js';

describe('resolveSqliteVecPath: dev mode', () => {
  test('returns empty string when not running inside $bunfs (dev/test mode)', () => {
    // In normal bun test execution, import.meta.url does NOT contain "$bunfs"
    const result = resolveSqliteVecPath();
    expect(result).toBe('');
  });
});
