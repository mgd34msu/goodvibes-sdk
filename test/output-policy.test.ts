import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.js';
import { applyOutputPolicy, type ToolOutputPolicy } from '../packages/sdk/src/platform/runtime/tools/output-policy.js';

function makeOverflowHandler(): OverflowHandler {
  return new OverflowHandler({ baseDir: mkdtempSync(join(tmpdir(), 'goodvibes-output-policy-')) });
}

describe('output policy', () => {
  test('summary truncation replaces oversized output with a bounded size/type summary', () => {
    const policy: ToolOutputPolicy = {
      toolClass: 'analyze',
      maxBytes: 128,
      maxTokens: 32,
      truncationMode: 'summary',
      spillMode: 'inline',
      auditMetadata: true,
    };

    const original = JSON.stringify({ rows: Array.from({ length: 200 }, (_, index) => ({ index })) });
    const { result, audit } = applyOutputPolicy(
      { success: true, output: original },
      policy,
      makeOverflowHandler(),
    );

    expect(audit.actionTaken).toBe('truncated');
    expect(audit.originalSize).toBeGreaterThan(policy.maxBytes);
    expect(audit.resultSize).toBeLessThanOrEqual(policy.maxBytes);
    expect(result.output).toContain('output summarized');
    expect(result.output).toContain('json');
    expect(result.output).not.toContain('"rows"');
    expect(result._policyAudit).toEqual(audit);
  });
});
