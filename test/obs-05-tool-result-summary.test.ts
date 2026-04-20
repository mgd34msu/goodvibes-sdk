import { describe, expect, test } from 'bun:test';

/**
 * OBS-05: Tool result summary — verifies that toToolResultSummary correctly maps
 * ToolResult / SyntheticToolResult shapes to ToolResultSummary.
 */
describe('obs-05 tool result summary', () => {
  test('toToolResultSummary is exported from emitters barrel', async () => {
    const mod = await import('../packages/sdk/src/_internal/platform/runtime/emitters/index.js');
    expect(typeof mod.toToolResultSummary).toBe('function');
  });

  test('toToolResultSummary returns error kind on failure', async () => {
    const { toToolResultSummary } = await import('../packages/sdk/src/_internal/platform/runtime/emitters/index.js');
    const summary = toToolResultSummary({ success: false, error: 'Tool timed out' });
    expect(summary.kind).toBe('error');
    expect(summary.byteSize).toBeGreaterThan(0);
    expect(summary.preview).toContain('Tool timed out');
  });

  test('toToolResultSummary returns json kind when output is valid JSON', async () => {
    const { toToolResultSummary } = await import('../packages/sdk/src/_internal/platform/runtime/emitters/index.js');
    const summary = toToolResultSummary({ success: true, output: JSON.stringify({ files: ['a.ts'] }) });
    expect(summary.kind).toBe('json');
    expect(summary.byteSize).toBeGreaterThan(0);
  });

  test('toToolResultSummary returns text kind when output is plain text', async () => {
    const { toToolResultSummary } = await import('../packages/sdk/src/_internal/platform/runtime/emitters/index.js');
    const summary = toToolResultSummary({ success: true, output: 'hello world' });
    expect(summary.kind).toBe('text');
    expect(summary.byteSize).toBe('hello world'.length);
  });

  test('toToolResultSummary handles missing output gracefully', async () => {
    const { toToolResultSummary } = await import('../packages/sdk/src/_internal/platform/runtime/emitters/index.js');
    const summary = toToolResultSummary({ success: true });
    expect(summary.kind).toBe('text');
    expect(summary.byteSize).toBe(0);
  });
});
