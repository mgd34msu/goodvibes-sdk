/**
 * acp-connection-usage-mapping.test.ts
 *
 * Unit tests for `mapAcpUsage` — the pure mapping from the ACP protocol's
 * (unstable/experimental) `PromptResponse.usage` field, which uses
 * `cachedReadTokens`/`cachedWriteTokens` naming, onto the SDK's `AgentUsage`
 * shape (`cacheReadTokens`/`cacheWriteTokens`), forwarded into AGENT_COMPLETED.
 *
 * Only the pure mapping function is exercised here — spawning a real ACP
 * subprocess and driving the full handshake is out of scope for a unit test
 * and not something this repo's test suite currently does for the acp/
 * module (no existing acp test harness).
 */
import { describe, expect, test } from 'bun:test';
import { mapAcpUsage } from '../packages/sdk/src/platform/acp/connection.js';

describe('mapAcpUsage', () => {
  test('returns undefined when the prompt response carries no usage', () => {
    expect(mapAcpUsage(undefined)).toBeUndefined();
    expect(mapAcpUsage(null)).toBeUndefined();
  });

  test('maps ACP cachedRead/cachedWrite naming onto cacheRead/cacheWrite', () => {
    const result = mapAcpUsage({
      inputTokens: 500,
      outputTokens: 120,
      cachedReadTokens: 300,
      cachedWriteTokens: 40,
    });
    expect(result).toEqual({
      inputTokens: 500,
      outputTokens: 120,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
    });
  });

  test('omits cacheReadTokens/cacheWriteTokens when the ACP response omits or nulls them', () => {
    const result = mapAcpUsage({ inputTokens: 200, outputTokens: 80 });
    expect(result).toEqual({ inputTokens: 200, outputTokens: 80 });
    expect(result).not.toHaveProperty('cacheReadTokens');
    expect(result).not.toHaveProperty('cacheWriteTokens');

    const resultWithNulls = mapAcpUsage({
      inputTokens: 200,
      outputTokens: 80,
      cachedReadTokens: null,
      cachedWriteTokens: null,
    });
    expect(resultWithNulls).toEqual({ inputTokens: 200, outputTokens: 80 });
  });
});
