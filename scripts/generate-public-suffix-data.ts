#!/usr/bin/env bun
/**
 * generate-public-suffix-data.ts
 *
 * Regenerates the bundled public-suffix data from upstream. This is the
 * "refresh" the drift check tells you to run, and it is deliberately a
 * generator rather than a hand-edit: the first hand-curated snapshot carried
 * 174 of the 5,484 multi-label ICANN suffixes, which left 5,332 suffixes under
 * which two different registrants compared equal. Curation by hand is how that
 * happens.
 *
 * Run:  bun scripts/generate-public-suffix-data.ts
 * Then: bun scripts/check-public-suffix-drift.ts   (should print OK)
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UPSTREAM_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
const ICANN_BEGIN = '// ===BEGIN ICANN DOMAINS===';
const ICANN_END = '// ===END ICANN DOMAINS===';

/**
 * Private-section entries kept by hand.
 *
 * The private section is thousands of entries that churn constantly, so
 * bundling all of it would make the drift check permanently red. These are the
 * hosting suffixes where getting it wrong makes two unrelated sites compare
 * equal, the failure that actually matters for link validation.
 */
const CURATED_PRIVATE = [
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
  'herokuapp.com', 'azurewebsites.net', 'cloudfront.net', 'r2.dev', 'web.app', 'firebaseapp.com',
  's3.amazonaws.com', 'blogspot.com', 'wordpress.com', 'sharepoint.com', 'myshopify.com',
];

const response = await fetch(UPSTREAM_URL);
if (!response.ok) throw new Error(`upstream fetch failed: HTTP ${String(response.status)}`);
const text = await response.text();

const start = text.indexOf(ICANN_BEGIN);
const end = text.indexOf(ICANN_END);
if (start === -1 || end === -1) throw new Error('ICANN section markers not found');

const multiLabel = new Set<string>();
const wildcardParents = new Set<string>();
const exceptions = new Set<string>();

for (const raw of text.slice(start, end).split('\n')) {
  const line = raw.trim();
  if (line.length === 0 || line.startsWith('//')) continue;
  if (line.startsWith('!')) {
    exceptions.add(line.slice(1).toLowerCase());
    continue;
  }
  if (line.startsWith('*.')) {
    wildcardParents.add(line.slice(2).toLowerCase());
    continue;
  }
  if (line.includes('.')) multiLabel.add(line.toLowerCase());
}

for (const suffix of CURATED_PRIVATE) multiLabel.add(suffix);

function serialize(values: Iterable<string>): string {
  return [...values].sort().map((value) => `  '${value}',`).join('\n');
}

const file = `// GENERATED FILE — do not edit by hand.
//
// Regenerate with:  bun scripts/generate-public-suffix-data.ts
// Drift is caught by the weekly Public Suffix Drift workflow, which FAILS
// rather than warns. See security/public-suffix.ts for what the data is for
// and why it is bundled rather than fetched at runtime.
//
// Source: ${UPSTREAM_URL} (ICANN section) plus a small hand-kept set of
// private-section hosting suffixes where two sites under one suffix are
// genuinely different registrants.
//
// Snapshot taken: ${new Date().toISOString().slice(0, 10)}

/** Multi-label public suffixes. Single-label suffixes need no rule, see the module header. */
export const PUBLIC_SUFFIX_MULTI_LABEL: readonly string[] = [
${serialize(multiLabel)}
];

/** \`*.parent\` rules: every label directly under these is itself a suffix. */
export const PUBLIC_SUFFIX_WILDCARD_PARENTS: readonly string[] = [
${serialize(wildcardParents)}
];

/** \`!exception\` rules: these are registrable despite matching a wildcard above. */
export const PUBLIC_SUFFIX_EXCEPTIONS: readonly string[] = [
${serialize(exceptions)}
];
`;

const target = join(
  import.meta.dir,
  '..',
  'packages/sdk/src/platform/security/generated/public-suffix-data.ts',
);
writeFileSync(target, file, 'utf8');
console.log(
  `wrote ${target}\n  multi-label: ${String(multiLabel.size)}\n  wildcard parents: ${String(wildcardParents.size)}\n  exceptions: ${String(exceptions.size)}`,
);
