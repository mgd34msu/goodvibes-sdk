/**
 * platform/export/ smoke test.
 * Verifies that session export functions are importable and produce correct output types.
 */
import { describe, expect, test } from 'bun:test';

describe('platform/export — smoke', () => {
  test('exportToJSON returns a string for minimal session data', async () => {
    const { exportToJSON } = await import('../packages/sdk/src/platform/export/index.js');
    // exportToJSON(messages, metadata?, options?) — pass empty messages array.
    const result = exportToJSON([]);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Must be valid JSON
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed).toBeTypeOf('object');
  });

  test('defaultExportPath returns a non-empty string path', async () => {
    const { defaultExportPath } = await import('../packages/sdk/src/platform/export/index.js');
    const path = defaultExportPath('json', '/tmp');
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
    expect(path).toContain('.json');
  });
});
