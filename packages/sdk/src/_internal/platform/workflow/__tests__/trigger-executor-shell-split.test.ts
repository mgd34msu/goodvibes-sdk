import { describe, it, expect } from 'vitest';
import { shellSplit } from '../../utils/shell-split.js';

describe('shellSplit', () => {
  it('splits simple space-separated args', () => {
    expect(shellSplit('echo hello world')).toEqual(['echo', 'hello', 'world']);
  });

  it('preserves spaces inside double-quoted strings', () => {
    expect(shellSplit('echo "hello world"')).toEqual(['echo', 'hello world']);
  });

  it('handles backslash-escaped spaces outside quotes', () => {
    expect(shellSplit('path/with\\ space')).toEqual(['path/with space']);
  });

  it('preserves spaces inside single-quoted strings', () => {
    expect(shellSplit("notify-send 'build done'")).toEqual(['notify-send', 'build done']);
  });

  it('handles double-quote escape sequences', () => {
    expect(shellSplit('echo "say \\"hi\\""')).toEqual(['echo', 'say "hi"']);
  });

  it('handles multiple quoted and unquoted segments concatenated', () => {
    expect(shellSplit('echo "hello"world')).toEqual(['echo', 'helloworld']);
  });

  it('returns empty array for empty string', () => {
    expect(shellSplit('')).toEqual([]);
  });

  it('handles extra whitespace between args', () => {
    expect(shellSplit('echo   hello   world')).toEqual(['echo', 'hello', 'world']);
  });

  it('handles backslash-escaped backslash inside double quotes', () => {
    expect(shellSplit('echo "a\\\\b"')).toEqual(['echo', 'a\\b']);
  });
});
