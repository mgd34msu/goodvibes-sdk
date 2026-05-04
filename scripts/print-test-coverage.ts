/**
 * Print (or regenerate) COVERAGE.md from the sorted list of test/*.test.ts files.
 *
 * Usage:
 *   bun scripts/print-test-coverage.ts
 *
 * This script globs all test/*.test.ts files, sorts them, numbers them T001+,
 * and prints a Markdown table to stdout. Redirect to COVERAGE.md to regenerate:
 *
 *   bun scripts/print-test-coverage.ts > COVERAGE.md
 *
 * Or pipe to the file directly.
 */

import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const TEST_DIR = resolve(ROOT, 'test');

const files: string[] = [];
for await (const entry of glob('*.test.ts', { cwd: TEST_DIR })) {
  files.push(entry);
}
files.sort();

const header = `# Test Coverage Map

This file maps test file numbers to test files for navigation and review.
Generated from the sorted list of \`test/*.test.ts\` root-level files.
Integration tests live under \`test/integration/\` and are listed separately.

Regenerate via \`bun scripts/print-test-coverage.ts > COVERAGE.md\`

## Root-level tests (\`test/*.test.ts\`)

| # | File |
|---|------|`;

const rows = files
  .map((file, i) => `| T${String(i + 1).padStart(3, '0')} | \`test/${file}\` |`)
  .join('\n');

console.log(`${header}\n${rows}\n`);
