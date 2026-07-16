/**
 * verification-ledger — aggregation + rendering of a per-area verification
 * inventory.
 *
 * The data collection is deeply repo-specific (each repo introspects its own
 * settings/commands/panels), so it stays a per-repo hook. What is genuinely
 * shared — the totals math and the JSON/Markdown rendering — lives here.
 */

export interface LedgerArea {
  readonly area: string;
  readonly total: number;
  readonly localSignal: number;
  readonly localBehavior: number;
  readonly externalRequired: number;
}

export interface LedgerTotals {
  readonly total: number;
  readonly localSignal: number;
  readonly localBehavior: number;
  readonly externalRequired: number;
  readonly localSignalPercent: number;
  readonly localBehaviorPercent: number;
}

/** Sum areas and compute coverage percentages. */
export function computeLedgerTotals(areas: readonly LedgerArea[]): LedgerTotals {
  const total = areas.reduce((n, a) => n + a.total, 0);
  const localSignal = areas.reduce((n, a) => n + a.localSignal, 0);
  const localBehavior = areas.reduce((n, a) => n + a.localBehavior, 0);
  const externalRequired = areas.reduce((n, a) => n + a.externalRequired, 0);
  const pct = (n: number): number => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);
  return { total, localSignal, localBehavior, externalRequired, localSignalPercent: pct(localSignal), localBehaviorPercent: pct(localBehavior) };
}

/** Render the ledger as Markdown. */
export function renderLedgerMarkdown(areas: readonly LedgerArea[]): string {
  const totals = computeLedgerTotals(areas);
  const rows = areas.map((a) => `| ${a.area} | ${a.total} | ${a.localSignal} | ${a.localBehavior} | ${a.externalRequired} |`);
  return [
    '# Verification Ledger',
    '',
    '| Area | Total | Local signal | Local behavior | External required |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows,
    `| **Total** | **${totals.total}** | **${totals.localSignal}** | **${totals.localBehavior}** | **${totals.externalRequired}** |`,
    '',
    `Local-signal coverage: ${totals.localSignalPercent}% · local-behavior coverage: ${totals.localBehaviorPercent}%`,
    '',
  ].join('\n');
}

/** Render the ledger as JSON (areas + computed totals). */
export function renderLedgerJson(areas: readonly LedgerArea[]): string {
  return `${JSON.stringify({ areas, totals: computeLedgerTotals(areas) }, null, 2)}\n`;
}
