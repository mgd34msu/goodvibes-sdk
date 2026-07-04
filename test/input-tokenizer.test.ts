/**
 * Tests for platform/core/tokenizer.ts (InputTokenizer).
 *
 * This tokenizer is consumed downstream by goodvibes-tui's input pipeline
 * (src/input/handler-feed.ts). It previously had no dedicated test file in
 * this repo even though the TUI depends on its exact token shapes — most
 * importantly the terminal focus-reporting sequences (DECSET ?1004h):
 * `\x1b[I` (focus-in) and `\x1b[O` (focus-out). Those tokens were parsed
 * here long before anything downstream consumed them; this file pins the
 * parsing contract so a future refactor of the escape-sequence branch can't
 * silently break the one thing the TUI's focus-tracking feature depends on.
 */
import { describe, expect, test } from 'bun:test';
import { InputTokenizer, type InputToken } from '../packages/sdk/src/platform/core/tokenizer.js';

describe('InputTokenizer — focus-reporting sequences (CSI ?1004h)', () => {
  test('\\x1b[I parses to a focus-in token', () => {
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\x1b[I');
    expect(tokens).toHaveLength(1);
    const t = tokens[0] as Extract<InputToken, { type: 'focus' }>;
    expect(t.type).toBe('focus');
    expect(t.action).toBe('in');
  });

  test('\\x1b[O parses to a focus-out token', () => {
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\x1b[O');
    expect(tokens).toHaveLength(1);
    const t = tokens[0] as Extract<InputToken, { type: 'focus' }>;
    expect(t.type).toBe('focus');
    expect(t.action).toBe('out');
  });

  test('focus sequences interleaved with printable text do not corrupt either stream', () => {
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('a\x1b[Ib\x1b[Oc');
    expect(tokens.map((t) => t.type)).toEqual(['text', 'focus', 'text', 'focus', 'text']);
    expect((tokens[1] as Extract<InputToken, { type: 'focus' }>).action).toBe('in');
    expect((tokens[3] as Extract<InputToken, { type: 'focus' }>).action).toBe('out');
  });

  test('a focus sequence split across two feed() calls is buffered, not dropped or misparsed', () => {
    const tokenizer = new InputTokenizer();
    const first = tokenizer.feed('\x1b[');
    expect(first).toHaveLength(0);
    const second = tokenizer.feed('I');
    expect(second).toHaveLength(1);
    expect(second[0]!.type).toBe('focus');
  });

  test('repeated focus-in tokens (no matching focus-out) parse independently, no state carried', () => {
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\x1b[I\x1b[I');
    expect(tokens).toHaveLength(2);
    expect(tokens.every((t) => t.type === 'focus' && t.action === 'in')).toBe(true);
  });
});

describe('InputTokenizer — baseline sanity (text and key tokens)', () => {
  test('a plain printable character produces a text token', () => {
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('a');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.type).toBe('text');
    expect((tokens[0] as Extract<InputToken, { type: 'text' }>).value).toBe('a');
  });

  test('Enter (\\r) produces a key token with logicalName=enter', () => {
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\r');
    expect(tokens).toHaveLength(1);
    const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
    expect(t.type).toBe('key');
    expect(t.logicalName).toBe('enter');
  });

  test('an unrecognized bare escape does not throw', () => {
    const tokenizer = new InputTokenizer();
    expect(() => tokenizer.feed('\x1b')).not.toThrow();
  });
});
