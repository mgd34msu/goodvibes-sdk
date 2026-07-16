import { describe, expect, test } from 'bun:test';
import { parseCoverageSummary, parseFailCount, evaluateCoverageGate } from '@pellux/goodvibes-toolchain';

const TABLE = [
  '-------------|---------|---------|',
  'File         | % Funcs | % Lines |',
  '-------------|---------|---------|',
  'All files    |   84.21 |   82.50 |',
  '-------------|---------|---------|',
].join('\n');

describe('coverage-gate', () => {
  test('parses the All files row', () => {
    expect(parseCoverageSummary(TABLE)).toEqual({ funcsPct: 84.21, linesPct: 82.5 });
  });
  test('strips ANSI before parsing', () => {
    const colored = TABLE.replace('All files', '\x1b[32mAll files\x1b[0m');
    expect(parseCoverageSummary(colored)?.funcsPct).toBe(84.21);
  });
  test('passes when both floors are met', () => {
    expect(evaluateCoverageGate(TABLE, { funcsFloor: 84, linesFloor: 82 }).ok).toBe(true);
  });
  test('fails when a floor is missed', () => {
    expect(evaluateCoverageGate(TABLE, { funcsFloor: 85, linesFloor: 82 }).ok).toBe(false);
  });
  test('fails with no table (crashed run)', () => {
    const result = evaluateCoverageGate('boom', { funcsFloor: 1, linesFloor: 1 });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no coverage table');
  });
  test('reports a fail count as a note without failing the gate', () => {
    const withFails = `${TABLE}\n 3 fail\n`;
    expect(parseFailCount(withFails)).toBe(3);
    const result = evaluateCoverageGate(withFails, { funcsFloor: 84, linesFloor: 82 });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('3 single-process test failure');
  });
});
