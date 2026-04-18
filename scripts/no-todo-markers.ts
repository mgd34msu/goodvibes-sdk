// no-todo-markers.ts
//
// CI gate: fails the build if TODO, FIXME, XXX, HACK, or STUB appears in any
// non-exempt source file.
//
// Usage:
//   bun run todo:check
//   bun scripts/no-todo-markers.ts
//
// Exempt paths (never flagged):
//   - _internal/
//   - vendor/ (nested)
//   - generated/ (nested)
//   - *.test.ts and *.spec.ts files
//   - node_modules/ (nested)
//   - dist/ (nested)
//
// Exits non-zero and prints file:line with context if any marker is found.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ─── Configuration ──────────────────────────────────────────────────────────

/** Regex that matches any marker (word-boundary anchored). */
const MARKER_RE = /\b(TODO|FIXME|XXX|HACK|STUB)\b/;

/** Source extensions we care about. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/**
 * Exemption predicates applied to the relative path (forward-slash normalised).
 * A file is skipped if ANY predicate returns true.
 */
const EXEMPT: Array<(rel: string) => boolean> = [
  (rel) => rel.includes('/_internal/') || rel.startsWith('_internal/'),
  (rel) => rel.includes('/vendor/')    || rel.startsWith('vendor/'),
  (rel) => rel.includes('/generated/') || rel.startsWith('generated/'),
  (rel) => /\.(test|spec)\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(rel),
  (rel) => rel.includes('/node_modules/') || rel.startsWith('node_modules/'),
  (rel) => rel.includes('/dist/')     || rel.startsWith('dist/'),
];

/** Directory names to never descend into. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.cache', 'coverage', '.turbo']);

// ─── Helpers ────────────────────────────────────────────────────────────────

function isExempt(absPath: string): boolean {
  const rel = relative(REPO_ROOT, absPath).replace(/\\/g, '/');
  return EXEMPT.some((p) => p(rel));
}

function walkSourceFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) results.push(...walkSourceFiles(full));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

// ─── Scan roots ─────────────────────────────────────────────────────────────

// Scan only the package source tree — scripts/ is build tooling, not published source.
const SCAN_ROOTS = [
  resolve(REPO_ROOT, 'packages'),
];

// ─── Main ───────────────────────────────────────────────────────────────────

interface Finding {
  rel: string;
  line: number;
  col: number;
  marker: string;
  text: string;
}

const findings: Finding[] = [];

for (const root of SCAN_ROOTS) {
  try {
    if (!statSync(root).isDirectory()) continue;
  } catch {
    continue;
  }
  for (const absPath of walkSourceFiles(root)) {
    if (isExempt(absPath)) continue;
    let content: string;
    try {
      content = readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = MARKER_RE.exec(lines[i]);
      if (m) {
        findings.push({
          rel: relative(REPO_ROOT, absPath).replace(/\\/g, '/'),
          line: i + 1,
          col: m.index + 1,
          marker: m[1],
          text: lines[i].trimEnd(),
        });
      }
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

if (findings.length === 0) {
  console.log('todo-check: OK — no TODO/FIXME/XXX/HACK/STUB markers in non-exempt source files.');
  process.exit(0);
}

console.error(`\ntodo-check: FAIL — ${findings.length} marker(s) found in non-exempt source files:\n`);
for (const f of findings) {
  console.error(`  ${f.rel}:${f.line}:${f.col}  [${f.marker}]`);
  console.error(`    ${f.text}\n`);
}
console.error(
  'Markers are forbidden in published source.\n' +
  'Move work-in-progress notes to _internal/, *.test.ts, or a tracking doc.\n',
);
process.exit(1);
