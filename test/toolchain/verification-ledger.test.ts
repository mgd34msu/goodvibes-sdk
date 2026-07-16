import { describe, expect, test } from 'bun:test';
import { computeLedgerTotals, renderLedgerMarkdown, renderLedgerJson, type LedgerArea } from '@pellux/goodvibes-toolchain';

const areas: LedgerArea[] = [
  { area: 'settings', total: 100, localSignal: 80, localBehavior: 60, externalRequired: 5 },
  { area: 'commands', total: 100, localSignal: 90, localBehavior: 70, externalRequired: 3 },
];

describe('verification-ledger', () => {
  test('computes totals and percentages', () => {
    const totals = computeLedgerTotals(areas);
    expect(totals.total).toBe(200);
    expect(totals.localSignal).toBe(170);
    expect(totals.localSignalPercent).toBe(85);
    expect(totals.localBehaviorPercent).toBe(65);
  });
  test('handles an empty ledger without dividing by zero', () => {
    expect(computeLedgerTotals([]).localSignalPercent).toBe(0);
  });
  test('renders a markdown table with a totals row', () => {
    const md = renderLedgerMarkdown(areas);
    expect(md).toContain('| settings | 100 | 80 | 60 | 5 |');
    expect(md).toContain('**Total**');
  });
  test('renders JSON with computed totals', () => {
    const parsed = JSON.parse(renderLedgerJson(areas));
    expect(parsed.totals.total).toBe(200);
    expect(parsed.areas).toHaveLength(2);
  });
});
