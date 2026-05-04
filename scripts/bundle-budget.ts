/**
 * bundle-budget.ts
 *
 * Enforces per-runtime-entry gzipped bundle-size budgets for @pellux/goodvibes-sdk.
 *
 * Usage:
 *   bun run bundle:check
 *   bun scripts/bundle-budget.ts
 *
 * Behaviour:
 *   1. Builds the SDK if dist/ is missing. Warns (but does NOT rebuild) if dist/
 *      exists but appears stale — the build step is left to the caller in CI so
 *      that a concurrent build failure does not mask a budget violation.
 *      Pass --build to force a rebuild when dist/ is stale.
 *   2. Reads budget config from bundle-budgets.json at the repo root.
 *   3. Gzips each built entry-point JS file and compares against its budget.
 *   4. Prints a table: entry | actual | budget | delta | status.
 *   5. Exits non-zero if ANY entry exceeds its budget OR has no budget defined.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SDK_PKG = resolve(REPO_ROOT, 'packages', 'sdk');
const DIST_DIR = resolve(SDK_PKG, 'dist');
const SDK_PKG_JSON_PATH = resolve(SDK_PKG, 'package.json');
const BUDGETS_PATH = resolve(REPO_ROOT, 'bundle-budgets.json');

const FORCE_BUILD = process.argv.includes('--build');
// --no-build: error instead of rebuilding when dist/ is missing (for CI use).
const NO_BUILD = process.argv.includes('--no-build');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function newestMtime(dir: string): number {
  let newest = 0;
  try {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      // Node 20+ withFileTypes recursive gives entry.path; fall back to dir
      const entryPath: string = entry.parentPath ?? dir;
      const fullPath = resolve(entryPath, entry.name);
      try {
        const mt = statSync(fullPath).mtimeMs;
        if (mt > newest) newest = mt;
      } catch {
        // ignore stat errors on individual files
      }
    }
  } catch {
    // dir doesn't exist or is unreadable
  }
  return newest;
}

function distExists(): boolean {
  if (!existsSync(DIST_DIR)) return false;
  // Consider dist present if at least one .js file is there
  try {
    return readdirSync(DIST_DIR).some((f) => f.endsWith('.js'));
  } catch {
    return false;
  }
}

function isStale(): boolean {
  const distMtime = newestMtime(DIST_DIR);
  if (distMtime === 0) return true;
  const srcDir = resolve(SDK_PKG, 'src');
  return newestMtime(srcDir) > distMtime;
}

// Note: runBuild() uses execFileSync directly rather than the run() helper from
// release-shared.ts because bundle-budget.ts is a standalone script that must
// not import release pipeline code. A shared lightweight exec helper could be
// extracted to scripts/_runtime.ts in a future cleanup pass.
function runBuild(): void {
  console.log('Running bun run build …');
  execFileSync('bun', ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function gzipSize(filePath: string): number {
  const buf = readFileSync(filePath);
  return gzipSync(buf).length;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface BudgetEntry {
  gzip_bytes: number;
  rationale?: string;
}

interface BudgetConfig {
  [entry: string]: BudgetEntry;
}

interface ExportCondition {
  types?: string;
  import?: string;
  require?: string;
  default?: string;
}

type ExportValue = string | ExportCondition | null;

interface PkgJson {
  exports?: Record<string, ExportValue>;
}

// ─── Logic ────────────────────────────────────────────────────────────────────

function resolveDistJs(exportValue: ExportValue): string | null {
  if (!exportValue) return null;
  if (typeof exportValue === 'string') {
    return exportValue.endsWith('.js') ? exportValue : null;
  }
  // Prefer `import` over `require` over `default`; skip `types`
  const candidate = exportValue.import ?? exportValue.require ?? exportValue.default;
  if (candidate && candidate.endsWith('.js')) return candidate;
  return null;
}

function loadBudgets(): BudgetConfig {
  if (!existsSync(BUDGETS_PATH)) {
    console.error(`ERROR: bundle-budgets.json not found at ${BUDGETS_PATH}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(BUDGETS_PATH, 'utf8')) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !key.startsWith('_')),
  ) as BudgetConfig;
}

function loadExports(): Record<string, ExportValue> {
  const pkg = JSON.parse(readFileSync(SDK_PKG_JSON_PATH, 'utf8')) as PkgJson;
  return pkg.exports ?? {};
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (!distExists()) {
  if (NO_BUILD) {
    console.error('ERROR: dist/ is missing and --no-build was passed. Run `bun run build` first.');
    process.exit(1);
  }
  console.log('dist/ is missing — running bun run build …');
  runBuild();
} else if (FORCE_BUILD && isStale()) {
  console.log('dist/ is stale and --build was passed — running bun run build …');
  runBuild();
} else if (isStale()) {
  console.warn(
    'WARN: dist/ is stale (src/ has newer files). ' +
      'Pass --build to force a rebuild, or run `bun run build` first.',
  );
}

const budgets = loadBudgets();
const pkgExports = loadExports();

// Collect the JS entries we want to check (skip wildcard globs, json assets, etc.)
const entries: Array<{ entry: string; distRel: string }> = [];
for (const [key, val] of Object.entries(pkgExports)) {
  // Skip wildcard / non-JS / json assets
  if (key.includes('*')) continue;
  if (key === './package.json') continue;
  const distRel = resolveDistJs(val);
  if (!distRel) continue;
  entries.push({ entry: key, distRel });
}

// Sort for stable output
entries.sort((a, b) => a.entry.localeCompare(b.entry));

// ─── Measurement ─────────────────────────────────────────────────────────────

type Row = {
  entry: string;
  actual: number;
  budget: number | null;
  delta: number | null;
  status: 'PASS' | 'FAIL' | 'NO BUDGET';
};

const rows: Row[] = [];
let anyFail = false;
const measuredEntries = new Set(entries.map((entry) => entry.entry));
const staleBudgetEntries = Object.keys(budgets).filter((entry) => !measuredEntries.has(entry));
if (staleBudgetEntries.length > 0) anyFail = true;

for (const { entry, distRel } of entries) {
  const filePath = resolve(SDK_PKG, distRel);
  if (!existsSync(filePath)) {
    if (isStale()) {
      // File is absent because dist/ is stale — the entry exists in package.json
      // exports but has no corresponding built file yet. Fail fast with an
      // actionable message instead of blaming bundle-budgets.json.
      console.error(
        `ERROR: dist/ is stale and built file is missing for entry ${entry}.\n` +
          'Run `bun run build` first, or pass --build to force a rebuild.',
      );
      process.exit(1);
    }
    console.warn(`WARN: built file not found for entry ${entry}: ${filePath}`);
    rows.push({ entry, actual: 0, budget: null, delta: null, status: 'NO BUDGET' });
    anyFail = true;
    continue;
  }

  const actual = gzipSize(filePath);
  const budgetEntry = budgets[entry];

  if (!budgetEntry) {
    rows.push({ entry, actual, budget: null, delta: null, status: 'NO BUDGET' });
    anyFail = true;
    continue;
  }

  const budget = budgetEntry.gzip_bytes;
  const delta = actual - budget;
  const status: Row['status'] = actual <= budget ? 'PASS' : 'FAIL';
  if (status === 'FAIL') anyFail = true;
  rows.push({ entry, actual, budget, delta, status });
}

// ─── Table output ─────────────────────────────────────────────────────────────

// NIT-04 + NIT-12: drift check for the `./events` aggregate `domains` array.
// The aggregate `./events` budget entry carries a `domains` array enumerating
// the in-scope event-domain identifiers. The list is documentation-only for
// human readers, but stale entries (a domain was removed but the list wasn't
// updated, or a new domain was added without listing it) silently skew
// expectations. This check asserts the list matches dist/events/<domain>.js
// exactly. Single source of truth for the domain inventory remains the dist
// filesystem; this gate just keeps the readable list in lockstep.
const eventsBudget = (budgets as Record<string, { gzip_bytes: number; domains?: readonly string[] } | undefined>)['./events'];
if (eventsBudget?.domains) {
  const distEventsDir = resolve(SDK_PKG, 'dist', 'events');
  if (existsSync(distEventsDir)) {
    const declared = new Set<string>(eventsBudget.domains);
    const SKIP_NON_DOMAIN_FILES = new Set(['index']);
    const distDomains = new Set<string>(
      readdirSync(distEventsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
        .map((entry) => entry.name.replace(/\.js$/, ''))
        .filter((name) => !SKIP_NON_DOMAIN_FILES.has(name)),
    );
    const missingFromDist = [...declared].filter((d) => !distDomains.has(d)).sort();
    const missingFromList = [...distDomains].filter((d) => !declared.has(d)).sort();
    if (missingFromDist.length > 0 || missingFromList.length > 0) {
      const lines = ['ERROR: bundle-budgets.json `./events.domains` drift detected:'];
      if (missingFromDist.length > 0) {
        lines.push(`  Listed in domains but no matching dist/events/<name>.js: ${missingFromDist.join(', ')}`);
      }
      if (missingFromList.length > 0) {
        lines.push(`  Present in dist/events/ but not listed in domains: ${missingFromList.join(', ')}`);
      }
      lines.push('Update bundle-budgets.json#events.domains to match dist/events/, then update');
      lines.push('the parallel domain lists in bundle-budgets.README.md and docs/public-surface.md.');
      console.error(lines.join('\n'));
      process.exit(1);
    }
  }
}

const COL = {
  entry: Math.max(7, ...rows.map((r) => r.entry.length)),
  actual: 10,
  budget: 10,
  delta: 10,
  status: 11,
};

function padEnd(s: string, n: number): string {
  return s.padEnd(n);
}

function padStart(s: string, n: number): string {
  return s.padStart(n);
}

const header = [
  padEnd('Entry', COL.entry),
  padStart('Actual', COL.actual),
  padStart('Budget', COL.budget),
  padStart('Delta', COL.delta),
  padEnd('Status', COL.status),
].join('  ');

const sep = '-'.repeat(header.length);
console.log('\n' + sep);
console.log(header);
console.log(sep);

for (const row of rows) {
  const actualStr = row.actual > 0 ? `${row.actual} B` : '-';
  const budgetStr = row.budget != null ? `${row.budget} B` : '-';
  const deltaStr =
    row.delta != null ? (row.delta > 0 ? `+${row.delta} B` : `${row.delta} B`) : '-';
  const statusMark =
    row.status === 'PASS' ? '✓ PASS' : row.status === 'FAIL' ? '✗ FAIL' : '! NO BUDGET';

  console.log(
    [
      padEnd(row.entry, COL.entry),
      padStart(actualStr, COL.actual),
      padStart(budgetStr, COL.budget),
      padStart(deltaStr, COL.delta),
      padEnd(statusMark, COL.status),
    ].join('  '),
  );
}

console.log(sep + '\n');

// ─── Exit code ────────────────────────────────────────────────────────────────

if (anyFail) {
  const overBudget = rows.filter((r) => r.status === 'FAIL');
  const noBudget = rows.filter((r) => r.status === 'NO BUDGET');
  if (staleBudgetEntries.length > 0) {
    console.error(
      `ERROR: ${staleBudgetEntries.length} stale bundle budget entr${staleBudgetEntries.length === 1 ? 'y' : 'ies'} do not match a JS export:\n` +
        staleBudgetEntries.map((entry) => `  ${entry}`).join('\n') +
        '\nRemove stale entries or add the corresponding package export.',
    );
  }

  if (overBudget.length > 0) {
    console.error(
      `ERROR: ${overBudget.length} entry(s) exceed their budget:\n` +
        overBudget.map((r) => `  ${r.entry}: ${r.actual} B > ${r.budget} B budget`).join('\n'),
    );
  }
  if (noBudget.length > 0) {
    console.error(
      `ERROR: ${noBudget.length} entry(s) have no budget defined in bundle-budgets.json:\n` +
        noBudget.map((r) => `  ${r.entry}`).join('\n') +
        '\nAdd an explicit gzip_bytes budget for each entry to bundle-budgets.json.',
    );
  }
  process.exit(1);
}

console.log(`All ${rows.length} entries within budget.`);
