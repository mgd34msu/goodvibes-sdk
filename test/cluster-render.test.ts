/**
 * cluster-render.test.ts, clipboardEscapeSequence byte pinning.
 *
 * OSC 52 is the only clipboard path that survives SSH, and it is written by
 * hand as a string. That makes it uniquely fragile: the introducer (ESC, 0x1b)
 * and the terminator (BEL, 0x07) are invisible, so a copy between files, an
 * editor normalising a line, or a careless diff can drop them and leave a
 * function that still returns a plausible-looking `]52;c;<base64>`, which the
 * terminal does not act on, and instead prints at the operator.
 *
 * That is not hypothetical: the bytes HAVE been lost this way, and it shipped
 * because the only assertion covering it compared the function to itself.
 * `expect(rawOutput).toBe(clipboardEscapeSequence(key))` is true no matter what
 * the function returns. So every assertion here is against literal expected
 * text, never against another call to the thing under test.
 */
import { describe, expect, test } from 'bun:test';
import { clipboardEscapeSequence } from '@pellux/goodvibes-terminal-shell';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe('clipboardEscapeSequence', () => {
  test('opens with a real ESC byte, not the two characters "\\x1b"', () => {
    const sequence = clipboardEscapeSequence('gvj1-THEKEY');
    expect(sequence.charCodeAt(0)).toBe(0x1b);
    expect(sequence.startsWith('\\x1b')).toBe(false);
  });

  test('carries the OSC 52 clipboard introducer', () => {
    expect(clipboardEscapeSequence('gvj1-THEKEY').startsWith(`${ESC}]52;c;`)).toBe(true);
  });

  test('terminates with a real BEL byte', () => {
    const sequence = clipboardEscapeSequence('gvj1-THEKEY');
    expect(sequence.charCodeAt(sequence.length - 1)).toBe(0x07);
    expect(sequence.endsWith(BEL)).toBe(true);
    expect(sequence.endsWith('\\x07')).toBe(false);
  });

  test('the payload between introducer and terminator is the base64 of the value', () => {
    const sequence = clipboardEscapeSequence('gvj1-THEKEY');
    const payload = sequence.slice(`${ESC}]52;c;`.length, -1);
    expect(payload).toBe('Z3ZqMS1USEVLRVk=');
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('gvj1-THEKEY');
  });

  test('the whole sequence equals the expected literal, end to end', () => {
    expect(clipboardEscapeSequence('hello')).toBe(`${ESC}]52;c;aGVsbG8=${BEL}`);
  });

  test('exactly one ESC and one BEL — no stray or doubled control bytes', () => {
    const sequence = clipboardEscapeSequence('gvj1-THEKEY');
    expect([...sequence].filter((ch) => ch.charCodeAt(0) === 0x1b)).toHaveLength(1);
    expect([...sequence].filter((ch) => ch.charCodeAt(0) === 0x07)).toHaveLength(1);
  });

  test('non-ASCII values are base64-encoded as UTF-8, not as code units', () => {
    const sequence = clipboardEscapeSequence('kääntää');
    const payload = sequence.slice(`${ESC}]52;c;`.length, -1);
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('kääntää');
  });

  test('an empty value still produces a well-formed, actionable sequence', () => {
    expect(clipboardEscapeSequence('')).toBe(`${ESC}]52;c;${BEL}`);
  });
});
