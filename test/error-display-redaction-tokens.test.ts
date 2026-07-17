import { describe, expect, test } from 'bun:test';
import { normalizeError, summarizeError } from '../packages/sdk/src/platform/utils/error-display.js';

/**
 * Redaction tokens vs. the JSON stripper — redaction rewrites home paths to
 * /home/[REDACTED]/... before cleanMessage runs. The bracket-stripping pass
 * (which exists to drop inline JSON blobs from provider error messages) must
 * not eat those placeholders: stripping them turned
 * /home/[REDACTED]/hooks.json into '/home/ /hooks.json', which reads as a
 * real (and wrong) filesystem path in logs.
 */
describe('error-display redaction token preservation', () => {
  test('summarizeError keeps [REDACTED] inside a redacted home path', () => {
    const err = new Error("ENOENT: no such file or directory, open '/home/somebody/hooks.json'");
    const summary = summarizeError(err);
    expect(summary).toContain('/home/[REDACTED]/hooks.json');
    expect(summary).not.toContain('/home/ /');
  });

  test('normalizeError message keeps [REDACTED] tokens', () => {
    const err = new Error("cannot stat '/home/somebody/.goodvibes/settings.json'");
    const result = normalizeError(err);
    expect(result.message).toContain('[REDACTED]');
    expect(result.message).not.toContain('/home/ /');
  });

  test('inline JSON blobs and non-redaction brackets are still stripped', () => {
    const err = new Error('provider rejected {"code":"bad_request"} [request-id 123] retry later');
    const summary = summarizeError(err);
    expect(summary).not.toContain('bad_request');
    expect(summary).not.toContain('request-id');
    expect(summary).toContain('retry later');
  });
});
