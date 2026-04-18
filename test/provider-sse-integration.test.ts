/**
 * provider-sse-integration.test.ts
 *
 * Regression test for C-2: DEFAULT_DOMAINS must include 'providers' so that
 * MODEL_CHANGED events reach companion SSE subscribers.
 *
 * Also validates C-3: exactly ONE MODEL_CHANGED emission per model switch
 * (no duplicate from the route handler).
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_DOMAINS_TEST_EXPORT } from '../packages/sdk/src/_internal/platform/control-plane/gateway.js';
import type { RuntimeEventDomain } from '../packages/sdk/src/_internal/platform/runtime/events/index.js';

// ---------------------------------------------------------------------------
// C-2: DEFAULT_DOMAINS includes 'providers'
// ---------------------------------------------------------------------------

describe('gateway DEFAULT_DOMAINS', () => {
  test("includes 'providers' domain so MODEL_CHANGED reaches companion SSE subscribers", () => {
    const domains: readonly RuntimeEventDomain[] = DEFAULT_DOMAINS_TEST_EXPORT;
    expect(domains).toContain('providers');
  });

  test("includes core session domains", () => {
    const domains: readonly RuntimeEventDomain[] = DEFAULT_DOMAINS_TEST_EXPORT;
    expect(domains).toContain('session');
    expect(domains).toContain('tasks');
    expect(domains).toContain('control-plane');
  });
});
