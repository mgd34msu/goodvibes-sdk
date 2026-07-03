/**
 * overflow-tail-preservation.test.ts
 *
 * Regression coverage for W0.1 secondary fix #3: OverflowHandler.handle()
 * truncation must preserve the tail (not just the head). Test runners print
 * their failure summary at the very end of output, so a marker placed near
 * the end of long content must survive truncation.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.js';

function makeHandler(): OverflowHandler {
  return new OverflowHandler({ baseDir: mkdtempSync(join(tmpdir(), 'gv-overflow-tail-')) });
}

describe('OverflowHandler.handle — tail preservation', () => {
  test('a unique marker near the end of long content survives truncation', () => {
    const handler = makeHandler();
    const maxChars = 1000;
    const marker = 'UNIQUE_FAILURE_SUMMARY_MARKER';
    // Simulate a test-runner run: lots of head content (progress dots), the
    // failure summary marker right at the end.
    const head = 'x'.repeat(maxChars * 3);
    const content = `${head}\n${marker}`;

    const result = handler.handle(content, { maxChars });

    expect(result.content).toContain(marker);
  });

  test('truncated content still carries the honest truncation marker', () => {
    const handler = makeHandler();
    const maxChars = 1000;
    const content = 'y'.repeat(maxChars * 3);

    const result = handler.handle(content, { maxChars });

    expect(result.content).toMatch(/truncat/i);
  });

  test('content within the limit is returned unchanged', () => {
    const handler = makeHandler();
    const content = 'short content';

    const result = handler.handle(content, { maxChars: 1000 });

    expect(result.content).toBe(content);
  });
});
