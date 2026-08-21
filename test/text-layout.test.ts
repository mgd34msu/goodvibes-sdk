/**
 * text-layout.test.ts, wrapWithHangingIndent / fitLabelDetailColumns.
 *
 * Both helpers exist because `.length` is the wrong measure for a terminal.
 * The tests below therefore assert in display cells, and pin the two floors
 * that stop hostile-narrow terminals from producing nonsense: a wrap width
 * that never drops below one column, and a label/detail split whose gutter
 * survives even when the detail column has to collapse to nothing.
 */
import { describe, expect, test } from 'bun:test';
import { getDisplayWidth } from '@pellux/goodvibes-sdk/platform/utils';
import {
  fitLabelDetailColumns,
  wrapWithHangingIndent,
} from '@pellux/goodvibes-terminal-shell';

describe('wrapWithHangingIndent', () => {
  test('leaves the first line unindented and indents every continuation', () => {
    const lines = wrapWithHangingIndent('alpha bravo charlie delta echo', 12, '>> ');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]!.startsWith('>> ')).toBe(false);
    for (const line of lines.slice(1)) {
      expect(line.startsWith('>> ')).toBe(true);
    }
  });

  test('no line exceeds the requested width in display cells', () => {
    const width = 16;
    const lines = wrapWithHangingIndent(
      'the quick brown fox jumps over the lazy dog repeatedly',
      width,
      '    ',
    );
    for (const line of lines) {
      expect(getDisplayWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test('the indent eats into the continuation budget rather than overflowing', () => {
    const width = 20;
    const wide = wrapWithHangingIndent('alpha bravo charlie delta echo foxtrot', width, '');
    const indented = wrapWithHangingIndent('alpha bravo charlie delta echo foxtrot', width, '        ');
    for (const line of indented) {
      expect(getDisplayWidth(line)).toBeLessThanOrEqual(width);
    }
    // Same wrap points, but the indented continuations carry less text each.
    expect(indented.length).toBe(wide.length);
  });

  test('maxLines truncates the result without appending an ellipsis', () => {
    const lines = wrapWithHangingIndent('alpha bravo charlie delta echo foxtrot golf', 10, '  ', 2);
    expect(lines).toHaveLength(2);
    expect(lines.join('')).not.toContain('…');
  });

  test('maxLines larger than the wrap result is a no-op', () => {
    const text = 'short text';
    expect(wrapWithHangingIndent(text, 40, '  ', 99)).toEqual(wrapWithHangingIndent(text, 40, '  '));
  });

  test('a zero or negative width floors at one column instead of dropping content', () => {
    for (const width of [0, -5]) {
      const lines = wrapWithHangingIndent('abc def', width, '  ');
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(getDisplayWidth(line)).toBeGreaterThan(0);
      }
    }
  });

  test('measures wide glyphs in cells, not code units', () => {
    const lines = wrapWithHangingIndent('日本語のテキストです', 8, '  ');
    for (const line of lines) {
      expect(getDisplayWidth(line)).toBeLessThanOrEqual(8);
    }
  });
});

describe('fitLabelDetailColumns', () => {
  test('splits a roomy width by the requested ratio and reserves a two-cell gutter', () => {
    const { labelWidth, detailWidth } = fitLabelDetailColumns('label', 'detail', 100, 0.5);
    expect(labelWidth).toBe(50);
    expect(labelWidth + detailWidth + 2).toBe(100);
  });

  test('honours a non-default ratio', () => {
    expect(fitLabelDetailColumns('label', 'detail', 100, 0.8).labelWidth).toBe(80);
    expect(fitLabelDetailColumns('label', 'detail', 100, 0.2).labelWidth).toBe(20);
  });

  test('the label column never drops below ten cells', () => {
    expect(fitLabelDetailColumns('label', 'detail', 40, 0.01).labelWidth).toBe(10);
  });

  test('the gutter survives on a narrow width, collapsing the detail column instead', () => {
    const { labelWidth, detailWidth } = fitLabelDetailColumns('label', 'detail', 12, 0.99);
    expect(labelWidth).toBe(10);
    expect(detailWidth).toBe(0);
  });

  test('never returns a negative detail width, however hostile the input', () => {
    for (const total of [0, 1, 8, 11, 12]) {
      expect(fitLabelDetailColumns('l', 'd', total).detailWidth).toBeGreaterThanOrEqual(0);
    }
  });
});
