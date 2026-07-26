/**
 * Obfuscation detection: printf/strftime format specifiers are not URL-encoding.
 *
 * `%` followed by two hex-ish characters is grammatically identical in a printf
 * width/conversion (`%4d`, `%02d`, `%2f`) and in a URL escape (`%2F`, `%20`), so
 * testing every argument against `/%[0-9a-fA-F]{2}/` denied ordinary formatting
 * commands as "obfuscation detected". These tests pin the narrowed detector.
 *
 * This narrows a false positive only — no new denial class is added.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeCommandWithVerdicts } from '../packages/sdk/src/platform/runtime/permissions/normalization/index.js';

function urlEncodingFlagged(command: string): boolean {
  const result = normalizeCommandWithVerdicts(command);
  return result.segments.some((segment) =>
    segment.obfuscationPatterns.some((pattern) => pattern.includes('URL-encoded')),
  );
}

describe('obfuscation detection — format specifiers are not URL-encoded content', () => {
  const allowed: ReadonlyArray<[label: string, command: string]> = [
    ['printf width specifiers', 'printf "%4d %4d %-20s\\n" 1 2 three'],
    ['printf zero-padded pairs', 'printf "%02d:%02d\\n" 7 5'],
    ['printf short width', 'printf "%2d\\n" 9'],
    ['printf hex-float conversion', 'printf "%0a\\n" 1'],
    ['printf float conversion', 'printf "%2f\\n" 3.14'],
    ['date strftime specifier', 'date +%ad'],
    ['awk formatted report', 'awk "{printf \\"%20s %02d\\", $1, $2}" report.txt'],
    ['seq format', 'seq -f "%02g" 1 5'],
    ['bare percent token outside a URI', 'echo %4d'],
  ];

  for (const [label, command] of allowed) {
    test(`does not flag ${label}`, () => {
      expect(urlEncodingFlagged(command)).toBe(false);
    });
  }
});

describe('obfuscation detection — genuine percent-encoding is still detected', () => {
  // This check reads `node.args`. The tokenizer emits a URL as its own `url`
  // token rather than an argument, so a percent-encoded URL never reaches this
  // predicate at all — that is unchanged by the narrowing above, and the
  // agent-layer check (which reads the raw segment text) is what covers URLs.
  // The cases below are the ones this layer actually sees.
  const flagged: ReadonlyArray<[label: string, command: string]> = [
    ['encoded forward-slash separator', 'bash %2Fbin%2Fsh'],
    ['encoded backslash separator', 'cat %5Cetc%5Cpasswd'],
    ['encoded traversal passed as an argument', 'sh %2e%2e%2fetc%2fpasswd'],
  ];

  for (const [label, command] of flagged) {
    test(`flags ${label}`, () => {
      expect(urlEncodingFlagged(command)).toBe(true);
    });
  }

  test('an encoded null byte is still reported as a null-byte injection', () => {
    const result = normalizeCommandWithVerdicts('curl http://example.com/a%00b');
    const patterns = result.segments.flatMap((segment) => [...segment.obfuscationPatterns]);
    expect(patterns.some((pattern) => pattern.includes('null-byte'))).toBe(true);
  });
});
