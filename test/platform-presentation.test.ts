/**
 * platform-presentation.test.ts
 *
 * One-Platform Wave 4, S1 — the presentation contract. Covers:
 *  - resolveTones('dark') is reference-identical to TONE_TOKENS (the TUI
 *    no-op-swap guarantee); resolveTones('light') inverts exactly the
 *    documented chrome/accent/state roles and leaves everything else alone.
 *  - waitingPhrase returns the TUI's exact honest strings for
 *    approval/reconnecting/pre-first-token/stalled, and a THINKING_PHRASES
 *    rotation for 'thinking' at the same cadence as the TUI.
 *  - GLYPHS.status carries the TUI's reconciled idle/info/warn values and
 *    STATE_GLYPHS aliases into it (no independent literals).
 *  - purity: no file under platform/presentation/ imports fs/tty/process or
 *    reads process.stdout/stderr.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIFF_TONES,
  GLYPHS,
  SPINNER_FRAMES,
  STATE_GLYPHS,
  THINKING_PHRASES,
  TONE_TOKENS,
  resolveTones,
  waitingPhrase,
} from '../packages/sdk/src/platform/presentation/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESENTATION_DIR = resolve(__dirname, '../packages/sdk/src/platform/presentation');

describe('resolveTones', () => {
  test('dark is reference-identical to TONE_TOKENS', () => {
    expect(resolveTones('dark')).toBe(TONE_TOKENS);
  });

  test('light inverts exactly the documented roles', () => {
    const light = resolveTones('light');
    expect(light).not.toBe(TONE_TOKENS);

    // Overridden roles.
    expect(light.state.info).toBe('#0369a1');
    expect(light.state.reasoning).toBe('#7c3aed');
    expect(light.accent.brand).toBe('#0077aa');
    expect(light.accent.gradientStart).toBe('#0077aa');
    expect(light.accent.gradientEnd).toBe('#7c3aed');
    expect(light.chrome).toEqual({
      label: '#64748b',
      faint: '#94a3b8',
      warn: '#b45309',
      bad: '#dc2626',
      good: '#15803d',
      remote: '#6d28d9',
    });

    // Everything else carries the dark value forward unchanged.
    expect(light.fg).toEqual(TONE_TOKENS.fg);
    expect(light.bg).toEqual(TONE_TOKENS.bg);
    expect(light.border).toBe(TONE_TOKENS.border);
    expect(light.state.good).toBe(TONE_TOKENS.state.good);
    expect(light.state.warn).toBe(TONE_TOKENS.state.warn);
    expect(light.state.bad).toBe(TONE_TOKENS.state.bad);
    expect(light.state.blocked).toBe(TONE_TOKENS.state.blocked);
    expect(light.state.active).toBe(TONE_TOKENS.state.active);
    expect(light.accent.browser).toBe(TONE_TOKENS.accent.browser);
    expect(light.accent.control).toBe(TONE_TOKENS.accent.control);
    expect(light.accent.inspector).toBe(TONE_TOKENS.accent.inspector);
    expect(light.accent.workflow).toBe(TONE_TOKENS.accent.workflow);
    expect(light.accent.conversation).toBe(TONE_TOKENS.accent.conversation);
  });

  test('DIFF_TONES and SPINNER_FRAMES are exported verbatim', () => {
    expect(DIFF_TONES).toEqual({ add: '#00ff88', del: '#ff4444', hunk: '#88aaff' });
    expect(SPINNER_FRAMES).toEqual(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
  });
});

describe('GLYPHS / STATE_GLYPHS', () => {
  test('status group carries the TUI-reconciled values', () => {
    expect(GLYPHS.status.idle).toBe('◌');
    expect(GLYPHS.status.info).toBe('○');
    expect(GLYPHS.status.warn).toBe('⚠');
  });

  test('STATE_GLYPHS aliases GLYPHS.status, not independent literals', () => {
    expect(STATE_GLYPHS).toEqual({
      good: GLYPHS.status.success,
      warn: GLYPHS.status.warn,
      bad: GLYPHS.status.failure,
      info: GLYPHS.status.info,
    });
    expect(STATE_GLYPHS.good).toBe('✓');
    expect(STATE_GLYPHS.warn).toBe('⚠');
    expect(STATE_GLYPHS.bad).toBe('✕');
    expect(STATE_GLYPHS.info).toBe('○');
  });
});

describe('waitingPhrase', () => {
  test('approval', () => {
    expect(waitingPhrase('approval')).toBe('Waiting for your approval');
  });

  test('reconnecting', () => {
    expect(waitingPhrase('reconnecting', { reconnectAttempt: 2, reconnectMaxAttempts: 5 }))
      .toBe('Reconnecting (attempt 2/5)...');
  });

  test('pre-first-token', () => {
    expect(waitingPhrase('pre-first-token', { msSinceLastDelta: 7_400 }))
      .toBe('Waiting for model 7s...');
  });

  test('stalled', () => {
    expect(waitingPhrase('stalled', { msSinceLastDelta: 12_900 }))
      .toBe('Stalled 12s...');
  });

  test('thinking rotates through THINKING_PHRASES at the TUI cadence (375 frames/phrase)', () => {
    expect(waitingPhrase('thinking', { frame: 0 })).toBe(THINKING_PHRASES[0]);
    expect(waitingPhrase('thinking', { frame: 374 })).toBe(THINKING_PHRASES[0]);
    expect(waitingPhrase('thinking', { frame: 375 })).toBe(THINKING_PHRASES[1]);
    expect(waitingPhrase('thinking', { frame: 375 * THINKING_PHRASES.length }))
      .toBe(THINKING_PHRASES[0]); // wraps
  });

  test('missing context defaults honestly to zero, never throws', () => {
    expect(waitingPhrase('reconnecting')).toBe('Reconnecting (attempt 0/0)...');
    expect(waitingPhrase('pre-first-token')).toBe('Waiting for model 0s...');
    expect(waitingPhrase('stalled')).toBe('Stalled 0s...');
    expect(waitingPhrase('thinking')).toBe(THINKING_PHRASES[0]);
  });
});

describe('purity', () => {
  test('no file under platform/presentation/ touches fs/tty/process', () => {
    const files = readdirSync(PRESENTATION_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const forbidden = [
      /from\s+['"]node:fs['"]/,
      /from\s+['"]node:tty['"]/,
      /from\s+['"]node:process['"]/,
      /require\(['"]node:/,
      /process\.stdout/,
      /process\.stderr/,
      /process\.env/,
    ];
    for (const file of files) {
      const source = readFileSync(resolve(PRESENTATION_DIR, file), 'utf8');
      for (const pattern of forbidden) {
        expect(pattern.test(source)).toBe(false);
      }
    }
  });
});
