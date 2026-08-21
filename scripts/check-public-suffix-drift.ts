#!/usr/bin/env bun
/**
 * check-public-suffix-drift.ts
 *
 * Compares the BUNDLED public-suffix snapshot
 * (packages/sdk/src/platform/security/public-suffix.ts) against the upstream
 * Mozilla Public Suffix List, and FAILS on drift.
 *
 * ── Why bundled, and why a separate check ─────────────────────────────────
 *
 * The list is bundled and never fetched at runtime. A security gate that
 * reaches the network to reach a decision is a gate an attacker can influence
 * by making that fetch fail or hang, and the failure would land exactly when
 * validation matters. So the data ships in the package, and the cost of that
 * choice is that it can go stale. This script is how the staleness is caught.
 *
 * It runs on its own schedule, deliberately OUTSIDE the normal CI lane, so an
 * upstream publication cadence can never block a release. And it FAILS rather
 * than warns, because a nudge that cannot fail is not a guard, this platform
 * has already been bitten by exactly that, where several checks looked like
 * enforcement and none of them could go red.
 *
 * ── What counts as drift, and which direction is dangerous ────────────────
 *
 * Only MULTI-LABEL suffixes are compared. Single-label suffixes (`com`, `dev`,
 * `app`, every new gTLD) need no rule at all: the module's fallback treats one
 * label as the suffix, which is correct for all of them. That fallback is why
 * a stale snapshot degrades in the HARMLESS direction, an unknown new gTLD
 * still resolves correctly.
 *
 * The direction that matters is a multi-label suffix upstream has and we do
 * not. Under that rule two DIFFERENT registrants compare equal, `a.foo.xx`
 * and `b.foo.xx` would both reduce to `foo.xx`, and a link check would accept
 * a stranger's domain as the authorized one. That is reported as MISSING and
 * fails the run.
 *
 * A suffix we carry that upstream has REMOVED is the opposite error: the
 * comparison becomes needlessly narrow and a legitimate link is refused. That
 * is a correctness bug rather than a security hole, so it is reported as STALE
 * and also fails, but the message says which kind it is so whoever picks it up
 * knows whether they are fixing a hole or an annoyance.
 *
 * Fixing either is a DATA-ONLY change: edit the tables in public-suffix.ts.
 *
 * Usage:
 *   bun scripts/check-public-suffix-drift.ts            # fails on drift
 *   bun scripts/check-public-suffix-drift.ts --report   # prints, exits 0
 */

import {
  bundledMultiLabelSuffixes,
  bundledWildcardSuffixParents,
} from '../packages/sdk/src/platform/security/public-suffix.ts';

const UPSTREAM_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
const ICANN_BEGIN = '// ===BEGIN ICANN DOMAINS===';
const ICANN_END = '// ===END ICANN DOMAINS===';

const reportOnly = process.argv.includes('--report');

/**
 * The ICANN section only.
 *
 * The PRIVATE section is where hosting providers register their own suffixes.
 * The bundled snapshot carries a hand-picked handful of those (github.io,
 * pages.dev, …) because getting them wrong makes two unrelated sites compare
 * equal, but the private section is thousands of entries and churns
 * constantly, so comparing against all of it would produce a permanently red
 * check that everyone learns to ignore. Private entries are therefore excluded
 * from the comparison and curated by hand.
 */
function icannSection(text: string): string[] {
  const start = text.indexOf(ICANN_BEGIN);
  const end = text.indexOf(ICANN_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      'public-suffix drift: could not find the ICANN section markers in the upstream list. '
      + 'The upstream format may have changed; inspect it before trusting this check again.',
    );
  }
  return text.slice(start, end).split('\n');
}

function upstreamMultiLabelSuffixes(lines: readonly string[]): Set<string> {
  const suffixes = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('//')) continue;
    // `!foo.bar` exception rules and `*.foo` wildcards are handled separately
    // by the module; only plain multi-label rules are compared here.
    if (line.startsWith('!') || line.startsWith('*')) continue;
    if (!line.includes('.')) continue;
    suffixes.add(line.toLowerCase());
  }
  return suffixes;
}

async function main(): Promise<void> {
  const bundled = bundledMultiLabelSuffixes();
  const wildcards = new Set(bundledWildcardSuffixParents());

  let text: string;
  try {
    const response = await fetch(UPSTREAM_URL);
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    text = await response.text();
  } catch (error) {
    // A fetch failure is NOT drift and must not read as one, reporting a
    // network blip as a security finding is how a real finding gets ignored.
    console.error(
      `public-suffix drift: could not reach ${UPSTREAM_URL} (${error instanceof Error ? error.message : String(error)}).`,
    );
    console.error('This is a check failure, not a drift finding. The bundled list is unchanged and still correct.');
    process.exit(reportOnly ? 0 : 2);
  }

  const upstream = upstreamMultiLabelSuffixes(icannSection(text));

  // A bundled entry that is a private-section suffix (github.io and friends)
  // legitimately does not appear in the ICANN section.
  const curatedPrivate = new Set<string>([
    'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
    'herokuapp.com', 'azurewebsites.net', 'cloudfront.net', 'r2.dev', 'web.app', 'firebaseapp.com',
    's3.amazonaws.com', 'blogspot.com', 'wordpress.com', 'sharepoint.com', 'myshopify.com',
  ]);

  const missing: string[] = [];
  for (const suffix of upstream) {
    if (bundled.has(suffix)) continue;
    if (wildcards.has(suffix)) continue;
    missing.push(suffix);
  }

  const stale: string[] = [];
  for (const suffix of bundled) {
    if (upstream.has(suffix)) continue;
    if (curatedPrivate.has(suffix)) continue;
    stale.push(suffix);
  }

  console.log(`public-suffix drift: bundled ${String(bundled.size)}, upstream ICANN multi-label ${String(upstream.size)}.`);

  if (missing.length === 0 && stale.length === 0) {
    console.log('public-suffix drift: OK, the bundled snapshot matches upstream for every suffix it claims.');
    return;
  }

  if (missing.length > 0) {
    console.error('');
    console.error(`SECURITY-RELEVANT, ${String(missing.length)} multi-label suffix(es) upstream has and the snapshot does not.`);
    console.error('Under each of these, two DIFFERENT registrants currently compare equal, so a link check');
    console.error('could accept a stranger\'s domain as the authorized one. Add them to MULTI_LABEL_SUFFIXES.');
    for (const suffix of missing.slice(0, 60).sort()) console.error(`  + ${suffix}`);
    if (missing.length > 60) console.error(`  … and ${String(missing.length - 60)} more`);
  }

  if (stale.length > 0) {
    console.error('');
    console.error(`CORRECTNESS, ${String(stale.length)} suffix(es) the snapshot carries that upstream no longer lists.`);
    console.error('These make the comparison needlessly narrow: a legitimate link may be refused. Not a hole.');
    for (const suffix of stale.slice(0, 60).sort()) console.error(`  - ${suffix}`);
    if (stale.length > 60) console.error(`  … and ${String(stale.length - 60)} more`);
  }

  console.error('');
  console.error('This is a DATA-ONLY fix: edit the tables in');
  console.error('  packages/sdk/src/platform/security/public-suffix.ts');
  console.error('No code change is needed, and the module header carries the refresh procedure.');
  console.error('');
  console.error('Note the blast radius before treating this as urgent: the module falls back to a');
  console.error('single-label suffix for anything it does not know, which is CORRECT for com, dev,');
  console.error('app and every new gTLD. Staleness narrows coverage; it does not break resolution.');

  if (!reportOnly) process.exit(1);
}

await main();
