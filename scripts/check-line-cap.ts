// check-line-cap.ts
//
// CI/pre-commit gate: enforces an 800-line cap on hand-authored TypeScript
// source files under packages/*/src (WO-0C, One-Platform Wave 0). See
// line-cap-rule.ts for the ratchet semantics and line-cap-grandfather.ts for
// the current grandfather list.
//
// Excluded from scanning:
//   - dist/, node_modules/ (build output / vendored install)
//   - any directory named "generated" at any depth (e.g.
//     packages/contracts/src/generated/**) — generated code is not
//     hand-authored and isn't subject to hand-authored line-count discipline;
//     this generalizes past the WO's literal contracts/generated/** example
//     to also cover packages/sdk/src/platform/types/generated/, following
//     the same convention no-todo-markers.ts already uses.
//   - any directory named "vendor" at any depth (e.g.
//     packages/sdk/src/platform/pairing/vendor/qrcodegen.ts) — vendored
//     third-party code we don't control and don't want to modify to satisfy
//     an internal ratchet; also consistent with no-todo-markers.ts's
//     existing vendor/ exemption.
//   - *.d.ts (generated declaration files)
//   - *.test.ts / *.spec.ts / __tests__/ / test/ (defensive — the SDK's own
//     tests live under root test/, not packages/*/src, but this guards
//     against that changing silently)
//
// Test-harness overrides (mirrors version-consistency-check.ts):
//   LINE_CAP_ROOT               — override the repo root directory
//   LINE_CAP_PACKAGE_DIRS_JSON  — JSON array of dirs to scan, relative to
//                                 LINE_CAP_ROOT (default: auto-discovered
//                                 packages/*/src)
//   LINE_CAP_GRANDFATHER_JSON   — JSON object overriding the grandfather map
//                                 (default: LINE_CAP_GRANDFATHER)
//
// Usage:
//   bun run line:check
//   bun scripts/check-line-cap.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  MAX_SOURCE_LINES,
  checkLineCap,
  type FileLineCount,
  type GrandfatherEntry,
} from './line-cap-rule.ts';
import { LINE_CAP_GRANDFATHER } from './line-cap-grandfather.ts';

const REPO_ROOT = process.env.LINE_CAP_ROOT ?? resolve(import.meta.dir, '..');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git', 'generated', 'vendor']);

function isTestSource(relPath: string): boolean {
  return (
    /\.(test|spec)\.tsx?$/.test(relPath) ||
    relPath.includes('/__tests__/') ||
    relPath.includes('/test/') ||
    relPath.startsWith('test/')
  );
}

function walkSourceFiles(dir: string, root: string): FileLineCount[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: FileLineCount[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      results.push(...walkSourceFiles(join(dir, entry.name), root));
      continue;
    }
    if (!entry.isFile()) continue;

    const name = entry.name;
    if (name.endsWith('.d.ts')) continue;
    const dot = name.lastIndexOf('.');
    if (dot === -1) continue;
    const ext = name.slice(dot);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;

    const abs = join(dir, name);
    const relPath = relative(root, abs).split('\\').join('/');
    if (isTestSource(relPath)) continue;

    const text = readFileSync(abs, 'utf8');
    const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
    const lineCount = normalized.length === 0 ? 0 : normalized.split('\n').length;
    results.push({ relPath, lineCount });
  }
  return results;
}

/** Auto-discover packages/*\/src directories (relative to root). */
function discoverPackageSrcDirs(root: string): string[] {
  const packagesDir = join(root, 'packages');
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const srcDir = join(packagesDir, entry.name, 'src');
    try {
      if (statSync(srcDir).isDirectory()) {
        dirs.push(relative(root, srcDir));
      }
    } catch {
      // no src dir for this package — skip
    }
  }
  return dirs.sort();
}

const packageSrcDirs: string[] = process.env.LINE_CAP_PACKAGE_DIRS_JSON
  ? (JSON.parse(process.env.LINE_CAP_PACKAGE_DIRS_JSON) as string[])
  : discoverPackageSrcDirs(REPO_ROOT);

const grandfather: Readonly<Record<string, GrandfatherEntry>> =
  process.env.LINE_CAP_GRANDFATHER_JSON
    ? (JSON.parse(process.env.LINE_CAP_GRANDFATHER_JSON) as Record<string, GrandfatherEntry>)
    : LINE_CAP_GRANDFATHER;

const files: FileLineCount[] = packageSrcDirs.flatMap((dir) =>
  walkSourceFiles(join(REPO_ROOT, dir), REPO_ROOT),
);

const violations = checkLineCap(files, grandfather);

if (violations.length > 0) {
  console.error('line-cap-check FAILED:\n');
  for (const v of violations) {
    console.error(`- ${v}`);
  }
  process.exit(1);
}

console.log(
  `line-cap-check PASSED for ${files.length} source files ` +
    `(${Object.keys(grandfather).length} grandfathered, cap ${MAX_SOURCE_LINES} lines).`,
);
