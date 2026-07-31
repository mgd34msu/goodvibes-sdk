/**
 * ansi-sanitize.test.ts — stripDangerousAnsi.
 *
 * The contract under test: after this function, a string cannot move the
 * cursor, switch screens, retitle the window, or ring the bell — and SGR
 * color/style codes survive intact, because colorized output is the one
 * legitimate, non-navigating use of the escape channel.
 *
 * A renderer that measures display width tends to drop the ESC byte on its
 * own, but the printable remnant of a sequence ("[2A") still lands on screen
 * as visible text. That is why the sanitizer, not the renderer, is the
 * authoritative defence.
 */
import { describe, expect, test } from 'bun:test';
import { stripDangerousAnsi } from '@pellux/goodvibes-terminal-shell';

describe('stripDangerousAnsi', () => {
  // ── Category: cursor movement CSI sequences
  describe('cursor move sequences (CSI A/B/C/D)', () => {
    test('strips cursor up (\\x1b[<n>A)', () => {
      expect(stripDangerousAnsi('before\x1b[2Aafter')).toBe('beforeafter');
    });

    test('strips cursor down (\\x1b[<n>B)', () => {
      expect(stripDangerousAnsi('a\x1b[5Bb')).toBe('ab');
    });

    test('strips cursor forward (\\x1b[<n>C)', () => {
      expect(stripDangerousAnsi('x\x1b[3Cy')).toBe('xy');
    });

    test('strips cursor back (\\x1b[<n>D)', () => {
      expect(stripDangerousAnsi('p\x1b[1Dq')).toBe('pq');
    });

    test('strips cursor position (\\x1b[row;colH)', () => {
      expect(stripDangerousAnsi('\x1b[10;20Htext')).toBe('text');
    });

    test('strips cursor position shorthand (\\x1b[H)', () => {
      expect(stripDangerousAnsi('\x1b[Htext')).toBe('text');
    });
  });

  // ── Category: OSC sequences
  describe('OSC sequences (\\x1b]...)', () => {
    test('strips OSC terminated by BEL', () => {
      // e.g. set window title
      expect(stripDangerousAnsi('\x1b]0;evil title\x07text')).toBe('text');
    });

    test('strips OSC terminated by ST (\\x1b\\\\)', () => {
      expect(stripDangerousAnsi('\x1b]8;;https://evil.com\x1b\\click\x1b]8;;\x1b\\text')).toBe('clicktext');
    });

    test('strips OSC with arbitrary payload', () => {
      expect(stripDangerousAnsi('prefix\x1b]52;c;payload\x07suffix')).toBe('prefixsuffix');
    });
  });

  // ── Category: BEL
  describe('BEL (\\x07)', () => {
    test('strips standalone BEL', () => {
      expect(stripDangerousAnsi('a\x07b')).toBe('ab');
    });

    test('strips multiple BELs', () => {
      expect(stripDangerousAnsi('\x07\x07\x07')).toBe('');
    });
  });

  // ── Category: alt-screen / DECSET private mode
  describe('alt-screen and DECSET private mode (\\x1b[?...h/l)', () => {
    test('strips alt-screen enter (\\x1b[?1049h)', () => {
      expect(stripDangerousAnsi('\x1b[?1049htext')).toBe('text');
    });

    test('strips alt-screen exit (\\x1b[?1049l)', () => {
      expect(stripDangerousAnsi('text\x1b[?1049l')).toBe('text');
    });

    test('strips cursor hide (\\x1b[?25l)', () => {
      expect(stripDangerousAnsi('\x1b[?25ltext')).toBe('text');
    });

    test('strips cursor show (\\x1b[?25h)', () => {
      expect(stripDangerousAnsi('text\x1b[?25h')).toBe('text');
    });

    test('strips mouse mode enable (\\x1b[?1000h)', () => {
      expect(stripDangerousAnsi('\x1b[?1000htext')).toBe('text');
    });

    test('strips bracketed paste mode (\\x1b[?2004h)', () => {
      expect(stripDangerousAnsi('\x1b[?2004htext')).toBe('text');
    });
  });

  // ── Category: SGR color codes (MUST be preserved)
  describe('SGR color/style codes (\\x1b[<n>m) — must be preserved', () => {
    test('preserves reset (\\x1b[0m)', () => {
      expect(stripDangerousAnsi('\x1b[0mtext')).toBe('\x1b[0mtext');
    });

    test('preserves bold (\\x1b[1m)', () => {
      expect(stripDangerousAnsi('\x1b[1mbold\x1b[0m')).toBe('\x1b[1mbold\x1b[0m');
    });

    test('preserves foreground color (\\x1b[31m)', () => {
      expect(stripDangerousAnsi('\x1b[31mred\x1b[0m')).toBe('\x1b[31mred\x1b[0m');
    });

    test('preserves 256-color foreground (\\x1b[38;5;208m)', () => {
      expect(stripDangerousAnsi('\x1b[38;5;208morange\x1b[0m')).toBe('\x1b[38;5;208morange\x1b[0m');
    });

    test('preserves truecolor foreground (\\x1b[38;2;r;g;bm)', () => {
      expect(stripDangerousAnsi('\x1b[38;2;0;255;136mgreen\x1b[0m')).toBe('\x1b[38;2;0;255;136mgreen\x1b[0m');
    });

    test('preserves multiple chained SGR sequences', () => {
      const input = '\x1b[1m\x1b[32mhello\x1b[0m';
      expect(stripDangerousAnsi(input)).toBe(input);
    });
  });

  // ── Mixed: dangerous + safe in same string
  describe('mixed dangerous and SGR sequences', () => {
    test('strips cursor move but keeps surrounding SGR', () => {
      const input = '\x1b[32mgreen\x1b[2Aattack\x1b[0m';
      const result = stripDangerousAnsi(input);
      expect(result).toBe('\x1b[32mgreenattack\x1b[0m');
      expect(result).not.toContain('\x1b[2A');
    });

    test('strips OSC but keeps SGR colors intact', () => {
      const input = '\x1b[1mbold\x1b]0;malicious title\x07text\x1b[0m';
      const result = stripDangerousAnsi(input);
      expect(result).toBe('\x1b[1mboldtext\x1b[0m');
    });

    test('strips BEL mid-string but keeps rest', () => {
      expect(stripDangerousAnsi('hello\x07world')).toBe('helloworld');
    });

    test('preserves plain text with no escape sequences unchanged', () => {
      const plain = 'hello world 123 /path/to/file.ts';
      expect(stripDangerousAnsi(plain)).toBe(plain);
    });

    test('empty string returns empty string', () => {
      expect(stripDangerousAnsi('')).toBe('');
    });
  });
});
