/**
 * platform/export/ smoke test.
 * Verifies that session export functions are importable and produce correct output types.
 */
import { describe, expect, test } from 'bun:test';

describe('platform/export: smoke', () => {
  test('defaultExportPath returns a non-empty string path', async () => {
    const { defaultExportPath } = await import('../packages/sdk/src/platform/export/index.js');
    const path = defaultExportPath('json', '/tmp');
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
    expect(path).toContain('.json');
  });
});
