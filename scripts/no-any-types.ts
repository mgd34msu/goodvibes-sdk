// no-any-types.ts
//
// CI gate: fails the build if `any` appears as a TypeScript type annotation in source files.
// Prevents regression of the zero-`any` policy established in 0.18.44.
//
// Detected patterns (TypeScript type positions only):
//   : any           (type annotation — colon then any)
//   : any[]         (array type annotation)
//   <any>           (generic type argument)
//   <any,           (generic first arg)
//   , any>          (generic last arg)
//   , any,          (generic middle arg)
//   as any          (type assertion)
//   extends any     (constraint)
//   = any           (type alias RHS — space-equals-space-any)
//
// NOT flagged:
//   // comments     (line comments)
//   * doc comments  (JSDoc lines)
//   string/template literals containing "any" as English word
//   .d.ts files     (generated declarations)
//   vendor/         (third-party code)
//   dist/           (build output)
//   node_modules/
//
// Usage:
//   bun run any:check
//   bun scripts/no-any-types.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Matches TypeScript `any` type in type positions only.
 * Each pattern requires a type-position prefix and type-terminator suffix.
 *
 * Type-position prefixes:
 *   :\s*    — type annotation (e.g., foo: any)
 *   <\s*    — generic arg start (e.g., Array<any>, Array < any >)
 *   [\s*    — tuple/array element start (e.g., [any, string])
 *   ,\s*    — generic/tuple arg separator (e.g., Foo<T, any>, [string, any])
 *   \|\s*   — union member (e.g., string | any)
 *   &\s*    — intersection member
 *   as\s+   — type assertion (e.g., x as any)
 *   extends\s+ — constraint
 *   =\s*    — type alias RHS (e.g., type Foo = any)
 *   =>\s*   — function return type (e.g., () => any)
 *   keyof\s+ — keyof constraint root (e.g., keyof any)
 *
 * Type-terminator suffixes (what can follow `any` in a type position):
 *   > [ ] ) , ; ? : | & space newline
 */
const ANY_TYPE_PATTERNS: RegExp[] = [
  /:\s*(?:readonly\s+)?any(?=[\s>\[\]\),;?:&|]|$)/,        // : any, : readonly any[]
  /<\s*(?:readonly\s+)?any(?=[\s>\[\]\),;?:&|]|$)/,        // <any, < readonly any
  /\[\s*(?:readonly\s+)?any(?=[\s>\[\]\),;?:&|]|$)/,       // [any
  /,\s*(?:readonly\s+)?any(?=[\s>\[\]\),;?:&|]|$)/,        // , any
  /\|\s*(?:readonly\s+)?any(?=[\s>\[\]\),;?:&|]|$)/,       // | any
  /&\s*(?:readonly\s+)?any(?=[\s>\[\]\),;?:&|]|$)/,        // & any
  /=>\s*(?:readonly\s+)?any(?=[\s>\[\]\),;?:&|]|$)/,       // => any
  /\bas\s+any(?=[\s>\[\]\),;?:&|]|$)/,                     // as any
  /\bextends\s+(?:readonly\s+)?any(?=[\s>\[\]\),;?:&|]|$)/, // extends any
  /=\s*(?:readonly\s+)?any(?=[\s>\[\]\),;?:&|]|$)/,        // = any
  /\bkeyof\s+any(?=[\s>\[\]\),;?:&|]|$)/,                  // keyof any
];

/** Source extensions we care about. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * Exemption predicates applied to the relative path (forward-slash normalised).
 * A file is skipped if ANY predicate returns true.
 */
const EXEMPT: Array<(rel: string) => boolean> = [
  (rel) => rel.endsWith('.d.ts') || rel.endsWith('.d.mts') || rel.endsWith('.d.cts'),
  (rel) => rel.includes('/vendor/') || rel.startsWith('vendor/'),
  (rel) => rel.includes('/node_modules/') || rel.startsWith('node_modules/'),
  (rel) => rel.includes('/dist/') || rel.startsWith('dist/'),
  (rel) => rel.includes('/temp/') || rel.startsWith('temp/'),
];

/** Directory names to never descend into. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.cache', 'coverage', '.turbo', 'temp']);

// ─── Helpers ────────────────────────────────────────────────────────────────

function isExempt(absPath: string): boolean {
  const rel = relative(REPO_ROOT, absPath).replace(/\\/g, '/');
  return EXEMPT.some((p) => p(rel));
}

function isLineCommentOrDoc(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Strip string literals and template literal content from a line before pattern matching.
 * This prevents false positives from English word "any" in strings.
 * Simple heuristic: replace content between quotes with placeholder.
 */
function stripStringLiterals(line: string): string {
  // Replace double-quoted strings
  let result = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // Replace single-quoted strings
  result = result.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  // Replace template literal content (simple heuristic — no nested templates)
  result = result.replace(/`(?:[^`\\]|\\.)*`/g, '``');
  return result;
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

const SCAN_ROOTS = [
  resolve(REPO_ROOT, 'packages'),
  resolve(REPO_ROOT, 'scripts'),
  resolve(REPO_ROOT, 'test'),
  resolve(REPO_ROOT, 'tests'),
];

// ─── Main ───────────────────────────────────────────────────────────────────

interface Finding {
  rel: string;
  line: number;
  col: number;
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
      const line = lines[i];
      if (isLineCommentOrDoc(line)) continue;
      const stripped = stripStringLiterals(line);
      // Strip inline comment from end
      const noInlineComment = stripped.replace(/\/\/.*$/, '');
      for (const pattern of ANY_TYPE_PATTERNS) {
        const m = pattern.exec(noInlineComment);
        if (m) {
          findings.push({
            rel: relative(REPO_ROOT, absPath).replace(/\\/g, '/'),
            line: i + 1,
            col: m.index + 1,
            text: line.trimEnd(),
          });
          break; // only report once per line
        }
      }
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

if (findings.length === 0) {
  console.log('any-check: OK — zero `any` type occurrences in source files.');
  process.exit(0);
}

console.error(`\nany-check: FAIL — ${findings.length} \`any\` type occurrence(s) found:\n`);
for (const f of findings) {
  console.error(`  ${f.rel}:${f.line}:${f.col}`);
  console.error(`    ${f.text}\n`);
}
console.error(
  'The zero-`any` policy is enforced repo-wide. Replace with:\n' +
  '  1. Named type (preferred)\n' +
  '  2. `unknown` + narrowing\n' +
  '  3. Generic parameter <T>\n' +
  '  4. `Record<string, unknown>`\n' +
  '  5. eslint-disable-next-line @typescript-eslint/no-explicit-any  (with justification comment)\n',
);
process.exit(1);
