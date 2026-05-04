/**
 * COV-02 (ninth-review): platform/export/ smoke test.
 * Verifies that session export functions are importable and produce correct output types.
 */
import { describe, expect, test } from 'bun:test';

describe('platform/export — smoke', () => {
  test('exportToJSON is a function', async () => {
    const mod = await import('../packages/sdk/src/platform/export/index.js');
    expect(typeof mod.exportToJSON).toBe('function');
  });

  test('exportToMarkdown is a function', async () => {
    const mod = await import('../packages/sdk/src/platform/export/index.js');
    expect(typeof mod.exportToMarkdown).toBe('function');
  });

  test('exportToHTML is a function', async () => {
    const mod = await import('../packages/sdk/src/platform/export/index.js');
    expect(typeof mod.exportToHTML).toBe('function');
  });

  test('exportToJSON returns a string for minimal session data', async () => {
    const { exportToJSON } = await import('../packages/sdk/src/platform/export/index.js');
    // Call with minimal session-like object; expect a JSON string output
    const result = exportToJSON({ messages: [], sessionId: 'test-123' } as Parameters<typeof exportToJSON>[0]);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Must be valid JSON
    const parsed = JSON.parse(result) as unknown;
    expect(parsed).toBeDefined();
  });

  test('defaultExportPath returns a non-empty string path', async () => {
    const { defaultExportPath } = await import('../packages/sdk/src/platform/export/index.js');
    const path = defaultExportPath('json', '/tmp');
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
    expect(path).toContain('.json');
  });
});
