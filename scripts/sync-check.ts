/**
 * sync-check.ts — Mirror drift guard for transport-http → sdk/_internal/transport-http.
 *
 * For every canonical file in packages/transport-http/src/**‌/*.ts, this script
 * locates the corresponding mirror under packages/sdk/src/_internal/transport-http/,
 * applies the same import rewrites the sync script applies (package specifiers +
 * .ts→.js extension normalization), strips the "Synced from" header comment block
 * from the mirror, then diffs the normalized texts. Any divergence causes the
 * process to exit 1 with a report identifying the drifted files and the first
 * diverging line.
 *
 * Usage:
 *   bun scripts/sync-check.ts
 *
 * Exit codes:
 *   0 — all mirror files are in sync
 *   1 — one or more mirror files have drifted
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rewritePackageSpecifiers,
  rewriteRelativeTsSpecifiers,
} from './_internal/normalize.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const CANONICAL_DIR = resolve(SDK_ROOT, 'packages/transport-http/src');
const MIRROR_DIR = resolve(SDK_ROOT, 'packages/sdk/src/_internal/transport-http');

/** Apply the same transforms the sync script applies to produce the expected mirror content. */
function normalizeCanonical(content: string, mirrorPath: string): string {
  return rewritePackageSpecifiers(rewriteRelativeTsSpecifiers(content), mirrorPath);
}

/**
 * Strip the exact banner that withHeader() in sync-sdk-internals.ts emits.
 *
 * withHeader() writes exactly:
 *   - Non-shebang: "// Synced from <label>\n" as the first line.
 *   - Shebang:     shebang line, then "// Synced from <label>\n" immediately after.
 *
 * Only that single specific line is stripped. Any other leading comment text
 * is NOT removed — it is compared directly against the canonical content.
 * Files with non-matching banners (e.g. old "// Extracted from" headers)
 * will show up as drift, which is correct: fix them by running `bun run sync`.
 */
function stripMirrorBanner(content: string): string {
  const lines = content.split('\n');
  let i = 0;

  // If there is a shebang, skip it first.
  if (lines[0]?.startsWith('#!')) {
    i = 1;
  }

  // Strip exactly one banner line if it matches what withHeader() emits.
  if (lines[i]?.startsWith('// Synced from ')) {
    i++;
  }

  return lines.slice(i).join('\n');
}

// ── File walking ─────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

// ── Drift detection ──────────────────────────────────────────────────────────

interface DriftResult {
  canonicalPath: string;
  mirrorPath: string;
  missingMirror?: boolean;
  staleFile?: boolean;
  firstDivergingLine?: number;
  canonicalLine?: string;
  mirrorLine?: string;
}

function checkFile(canonicalPath: string): DriftResult | null {
  const rel = relative(CANONICAL_DIR, canonicalPath).replaceAll('\\', '/');
  const mirrorPath = resolve(MIRROR_DIR, rel);

  let mirrorContent: string;
  try {
    mirrorContent = readFileSync(mirrorPath, 'utf8');
  } catch {
    return { canonicalPath, mirrorPath, missingMirror: true };
  }

  const canonicalRaw = readFileSync(canonicalPath, 'utf8');
  const normalizedCanonical = normalizeCanonical(canonicalRaw, mirrorPath);
  const normalizedMirror = stripMirrorBanner(mirrorContent);

  if (normalizedCanonical === normalizedMirror) return null;

  // Find the first diverging line for a useful report.
  const canonLines = normalizedCanonical.split('\n');
  const mirrorLines = normalizedMirror.split('\n');
  const limit = Math.max(canonLines.length, mirrorLines.length);
  let firstDivergingLine = -1;
  for (let i = 0; i < limit; i++) {
    if (canonLines[i] !== mirrorLines[i]) {
      firstDivergingLine = i + 1;
      return {
        canonicalPath,
        mirrorPath,
        firstDivergingLine,
        canonicalLine: canonLines[i] ?? '(end of file)',
        mirrorLine: mirrorLines[i] ?? '(end of file)',
      };
    }
  }

  // Lengths differ but lines up to the shorter match.
  return {
    canonicalPath,
    mirrorPath,
    firstDivergingLine: Math.min(canonLines.length, mirrorLines.length) + 1,
    canonicalLine: canonLines[canonLines.length - 1] ?? '(empty)',
    mirrorLine: mirrorLines[mirrorLines.length - 1] ?? '(empty)',
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const canonicalFiles = walk(CANONICAL_DIR);
const canonicalSet = new Set(
  canonicalFiles.map((p) => relative(CANONICAL_DIR, p).replaceAll('\\', '/')),
);
const drifted: DriftResult[] = [];

// Forward check: every canonical file has a valid, in-sync mirror.
for (const canonicalPath of canonicalFiles) {
  const result = checkFile(canonicalPath);
  if (result) drifted.push(result);
}

// Reverse check: every mirror file has a corresponding canonical source.
// Mirrors without a canonical counterpart are stale and must be removed
// by running `bun run sync`.
if (existsSync(MIRROR_DIR)) {
  for (const mirrorPath of walk(MIRROR_DIR)) {
    const rel = relative(MIRROR_DIR, mirrorPath).replaceAll('\\', '/');
    if (!canonicalSet.has(rel)) {
      const canonicalPath = resolve(CANONICAL_DIR, rel);
      drifted.push({ canonicalPath, mirrorPath, staleFile: true });
    }
  }
}

if (drifted.length === 0) {
  console.log('sync:check passed — transport-http mirror is in sync');
  process.exit(0);
}

console.error(`sync:check FAILED — ${drifted.length} file(s) have drifted:\n`);

for (const d of drifted) {
  const canonRel = relative(SDK_ROOT, d.canonicalPath);
  const mirrorRel = relative(SDK_ROOT, d.mirrorPath);
  if (d.staleFile) {
    console.error(`  STALE MIRROR (no canonical source)`);
    console.error(`    mirror    : ${mirrorRel}`);
    console.error(`    expected  : ${canonRel}`);
  } else if (d.missingMirror) {
    console.error(`  MISSING MIRROR`);
    console.error(`    canonical : ${canonRel}`);
    console.error(`    expected  : ${mirrorRel}`);
  } else {
    console.error(`  DRIFT DETECTED`);
    console.error(`    canonical : ${canonRel}`);
    console.error(`    mirror    : ${mirrorRel}`);
    console.error(`    first diff: line ${d.firstDivergingLine}`);
    console.error(`    canonical : ${d.canonicalLine}`);
    console.error(`    mirror    : ${d.mirrorLine}`);
  }
  console.error();
}

console.error('Run `bun run sync` to regenerate the mirror, then re-run `bun run sync:check`.');
process.exit(1);
