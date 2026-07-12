// check-internal-identifiers.ts
//
// CI/pre-commit gate: fails the build when internal planning identifiers
// (wave/work-order/debt-register/UX-workstream/lettered-finding shorthand)
// appear in tracked text. See internal-identifier-rule.ts for the pattern
// set, the owner doctrine quoted verbatim, and the exemption rules
// (docs/decisions/** is the sanctioned home for that shorthand).
//
// Scanned: packages/*/src, scripts/, docs/, test/, eval/, examples/, and
// root-level markdown — .ts/.tsx/.md files, excluding dist/, node_modules/,
// generated/, and vendor/ (the same exclusions the line-cap check uses;
// generated and vendored text is not hand-authored here).
//
// Test-harness overrides (mirrors check-line-cap.ts):
//   INTERNAL_ID_ROOT       — override the repo root directory
//   INTERNAL_ID_DIRS_JSON  — JSON array of dirs/files to scan, relative to
//                            INTERNAL_ID_ROOT (default: the standard set)
//
// Usage:
//   bun run internal-id:check
//   bun scripts/check-internal-identifiers.ts

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  checkNoInternalIdentifiers,
  type InternalIdentifierCandidate,
} from './internal-identifier-rule.ts';

const REPO_ROOT = process.env.INTERNAL_ID_ROOT ?? resolve(import.meta.dir, '..');

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.md']);
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git', 'generated', 'vendor']);

function walkTextFiles(target: string, root: string): InternalIdentifierCandidate[] {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(target);
  } catch {
    return [];
  }

  if (stat.isFile()) {
    const relPath = relative(root, target).split('\\').join('/');
    const dot = target.lastIndexOf('.');
    if (dot === -1 || !TEXT_EXTENSIONS.has(target.slice(dot))) return [];
    return [{ relPath, text: readFileSync(target, 'utf8') }];
  }

  if (!stat.isDirectory()) return [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: InternalIdentifierCandidate[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      results.push(...walkTextFiles(join(target, entry.name), root));
      continue;
    }
    if (!entry.isFile()) continue;
    results.push(...walkTextFiles(join(target, entry.name), root));
  }
  return results;
}

function defaultScanTargets(root: string): string[] {
  const targets: string[] = [];
  const packagesDir = join(root, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const srcDir = join('packages', entry.name, 'src');
      if (existsSync(join(root, srcDir))) targets.push(srcDir);
    }
  }
  for (const dir of ['scripts', 'docs', 'test', 'eval', 'examples']) {
    if (existsSync(join(root, dir))) targets.push(dir);
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) targets.push(entry.name);
  }
  return targets.sort();
}

const scanTargets: string[] = process.env.INTERNAL_ID_DIRS_JSON
  ? (JSON.parse(process.env.INTERNAL_ID_DIRS_JSON) as string[])
  : defaultScanTargets(REPO_ROOT);

const candidates = scanTargets.flatMap((target) => walkTextFiles(join(REPO_ROOT, target), REPO_ROOT));
const violations = checkNoInternalIdentifiers(candidates);

if (violations.length > 0) {
  console.error('internal-identifier-check FAILED:\n');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`internal-identifier-check PASSED for ${candidates.length} text files.`);
