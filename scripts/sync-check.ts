/**
 * sync-check.ts — Mirror drift guard for ALL canonical packages → sdk/_internal mirrors.
 *
 * For every canonical file in each canonical package src directory, this script
 * locates the corresponding mirror under packages/sdk/src/_internal/<subsystem>/,
 * applies the same import rewrites the sync script applies (package specifiers +
 * .ts→.js extension normalization), strips the "Synced from" header comment block
 * from the mirror, then diffs the normalized texts. Any divergence causes the
 * process to exit 1 with a report identifying the drifted files and the first
 * diverging line.
 *
 * Covers all subsystems:
 *   contracts, errors, daemon, transport-core, transport-direct,
 *   transport-http, transport-realtime, operator, peer
 *
 * Usage:
 *   bun scripts/sync-check.ts
 *   bun scripts/sync-check.ts --scope=daemon
 *   bun scripts/sync-check.ts --scope=daemon,errors
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
const INTERNAL_ROOT = resolve(SDK_ROOT, 'packages/sdk/src/_internal');

interface SubsystemSpec {
  name: string;
  canonicalDir: string;
  mirrorDir: string;
}

const ALL_SUBSYSTEMS: SubsystemSpec[] = [
  {
    name: 'contracts',
    canonicalDir: resolve(SDK_ROOT, 'packages/contracts/src'),
    mirrorDir: resolve(INTERNAL_ROOT, 'contracts'),
  },
  {
    name: 'errors',
    canonicalDir: resolve(SDK_ROOT, 'packages/errors/src'),
    mirrorDir: resolve(INTERNAL_ROOT, 'errors'),
  },
  {
    name: 'daemon',
    canonicalDir: resolve(SDK_ROOT, 'packages/daemon-sdk/src'),
    mirrorDir: resolve(INTERNAL_ROOT, 'daemon'),
  },
  {
    name: 'transport-core',
    canonicalDir: resolve(SDK_ROOT, 'packages/transport-core/src'),
    mirrorDir: resolve(INTERNAL_ROOT, 'transport-core'),
  },
  {
    name: 'transport-direct',
    canonicalDir: resolve(SDK_ROOT, 'packages/transport-direct/src'),
    mirrorDir: resolve(INTERNAL_ROOT, 'transport-direct'),
  },
  {
    name: 'transport-http',
    canonicalDir: resolve(SDK_ROOT, 'packages/transport-http/src'),
    mirrorDir: resolve(INTERNAL_ROOT, 'transport-http'),
  },
  {
    name: 'transport-realtime',
    canonicalDir: resolve(SDK_ROOT, 'packages/transport-realtime/src'),
    mirrorDir: resolve(INTERNAL_ROOT, 'transport-realtime'),
  },
  {
    name: 'operator',
    canonicalDir: resolve(SDK_ROOT, 'packages/operator-sdk/src'),
    mirrorDir: resolve(INTERNAL_ROOT, 'operator'),
  },
  {
    name: 'peer',
    canonicalDir: resolve(SDK_ROOT, 'packages/peer-sdk/src'),
    mirrorDir: resolve(INTERNAL_ROOT, 'peer'),
  },
];

// Optional scope filter: --scope=daemon or --scope=daemon,errors
const SCOPE_ARG = process.argv.find((a) => a.startsWith('--scope='))?.slice('--scope='.length) ?? null;
const SCOPE_LIST = SCOPE_ARG ? SCOPE_ARG.split(',').map((s) => s.trim()).filter(Boolean) : null;

const VALID_SCOPES = ALL_SUBSYSTEMS.map((s) => s.name);
if (SCOPE_LIST) {
  const unknown = SCOPE_LIST.filter((s) => !VALID_SCOPES.includes(s));
  if (unknown.length > 0) {
    console.error(`sync:check: unknown scope(s): ${unknown.join(', ')}`);
    console.error(`Valid scopes: ${VALID_SCOPES.join(', ')}`);
    process.exit(1);
  }
}

const activeSubsystems = SCOPE_LIST
  ? ALL_SUBSYSTEMS.filter((s) => SCOPE_LIST.includes(s.name))
  : ALL_SUBSYSTEMS;

/** Apply the same transforms the sync script applies to produce the expected mirror content. */
function normalizeCanonical(content: string, mirrorPath: string): string {
  return rewritePackageSpecifiers(rewriteRelativeTsSpecifiers(content), mirrorPath);
}

/**
 * Strip the exact banner that withHeader() in sync-sdk-internals.ts emits.
 *
 * withHeader() writes exactly:
 *   - Non-shebang: "// Synced from <label>
" as the first line.
 *   - Shebang:     shebang line, then "// Synced from <label>
" immediately after.
 *
 * Only that single specific line is stripped. Any other leading comment text
 * is NOT removed — it is compared directly against the canonical content.
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
  subsystem: string;
  canonicalPath: string;
  mirrorPath: string;
  missingMirror?: boolean;
  staleFile?: boolean;
  firstDivergingLine?: number;
  canonicalLine?: string;
  mirrorLine?: string;
}

function checkFile(canonicalPath: string, canonicalDir: string, mirrorDir: string, subsystem: string): DriftResult | null {
  const rel = relative(canonicalDir, canonicalPath).replaceAll('\\', '/');
  const mirrorPath = resolve(mirrorDir, rel);

  let mirrorContent: string;
  try {
    mirrorContent = readFileSync(mirrorPath, 'utf8');
  } catch {
    return { subsystem, canonicalPath, mirrorPath, missingMirror: true };
  }

  const canonicalRaw = readFileSync(canonicalPath, 'utf8');
  const normalizedCanonical = normalizeCanonical(canonicalRaw, mirrorPath);
  const normalizedMirror = stripMirrorBanner(mirrorContent);

  if (normalizedCanonical === normalizedMirror) return null;

  // Find the first diverging line for a useful report.
  const canonLines = normalizedCanonical.split('\n');
  const mirrorLines = normalizedMirror.split('\n');
  const limit = Math.max(canonLines.length, mirrorLines.length);
  for (let i = 0; i < limit; i++) {
    if (canonLines[i] !== mirrorLines[i]) {
      return {
        subsystem,
        canonicalPath,
        mirrorPath,
        firstDivergingLine: i + 1,
        canonicalLine: canonLines[i] ?? '(end of file)',
        mirrorLine: mirrorLines[i] ?? '(end of file)',
      };
    }
  }

  // Lengths differ but lines up to the shorter match.
  return {
    subsystem,
    canonicalPath,
    mirrorPath,
    firstDivergingLine: Math.min(canonLines.length, mirrorLines.length) + 1,
    canonicalLine: canonLines[canonLines.length - 1] ?? '(empty)',
    mirrorLine: mirrorLines[mirrorLines.length - 1] ?? '(empty)',
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const drifted: DriftResult[] = [];

for (const subsystem of activeSubsystems) {
  const { name, canonicalDir, mirrorDir } = subsystem;

  if (!existsSync(canonicalDir)) {
    console.warn(`sync:check: canonical dir not found, skipping ${name}: ${canonicalDir}`);
    continue;
  }

  const canonicalFiles = walk(canonicalDir);
  const canonicalSet = new Set(
    canonicalFiles.map((p) => relative(canonicalDir, p).replaceAll('\\', '/')),
  );

  // Forward check: every canonical file has a valid, in-sync mirror.
  for (const canonicalPath of canonicalFiles) {
    const result = checkFile(canonicalPath, canonicalDir, mirrorDir, name);
    if (result) drifted.push(result);
  }

  // Reverse check: every mirror file has a corresponding canonical source.
  if (existsSync(mirrorDir)) {
    for (const mirrorPath of walk(mirrorDir)) {
      const rel = relative(mirrorDir, mirrorPath).replaceAll('\\', '/');
      if (!canonicalSet.has(rel)) {
        const canonicalPath = resolve(canonicalDir, rel);
        drifted.push({ subsystem: name, canonicalPath, mirrorPath, staleFile: true });
      }
    }
  }
}

if (drifted.length === 0) {
  const scopeLabel = SCOPE_LIST ? ` (${SCOPE_LIST.join(', ')})` : ' (all subsystems)';
  console.log(`sync:check passed — all mirrors in sync${scopeLabel}`);
  process.exit(0);
}

console.error(`sync:check FAILED — ${drifted.length} file(s) have drifted:
`);

for (const d of drifted) {
  const canonRel = relative(SDK_ROOT, d.canonicalPath);
  const mirrorRel = relative(SDK_ROOT, d.mirrorPath);
  if (d.staleFile) {
    console.error(`  [${d.subsystem}] STALE MIRROR (no canonical source)`);
    console.error(`    mirror    : ${mirrorRel}`);
    console.error(`    expected  : ${canonRel}`);
  } else if (d.missingMirror) {
    console.error(`  [${d.subsystem}] MISSING MIRROR`);
    console.error(`    canonical : ${canonRel}`);
    console.error(`    expected  : ${mirrorRel}`);
  } else {
    console.error(`  [${d.subsystem}] DRIFT DETECTED`);
    console.error(`    canonical : ${canonRel}`);
    console.error(`    mirror    : ${mirrorRel}`);
    console.error(`    first diff: line ${d.firstDivergingLine}`);
    console.error(`    canonical : ${d.canonicalLine}`);
    console.error(`    mirror    : ${d.mirrorLine}`);
  }
  console.error();
}

console.error('Run `bun run sync --scope=<subsystem>` to regenerate the affected mirror(s), then re-run `bun run sync:check`.');
process.exit(1);
