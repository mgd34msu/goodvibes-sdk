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

// Root-level test files
const files: string[] = [];
for await (const entry of glob('*.test.ts', { cwd: TEST_DIR })) {
  files.push(entry);
}
files.sort();

// Integration test files
const integrationFiles: string[] = [];
for await (const entry of glob('integration/**/*.test.ts', { cwd: TEST_DIR })) {
  integrationFiles.push(entry);
}
integrationFiles.sort();

// Workers / sub-runner test files
const workersFiles: string[] = [];
for await (const entry of glob('workers*/**/*.test.ts', { cwd: TEST_DIR })) {
  workersFiles.push(entry);
}
workersFiles.sort();

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

const integrationHeader = `
## Integration tests (\`test/integration/**/*.test.ts\`)

| # | File |
|---|------|`;

const integrationRows = integrationFiles
  .map((file, i) => `| I${String(i + 1).padStart(3, '0')} | \`test/${file}\` |`)
  .join('\n');

const workersHeader = `
## Sub-runner tests (\`test/workers*/**/*.test.ts\`)

| # | File |
|---|------|`;

const workersRows = workersFiles
  .map((file, i) => `| W${String(i + 1).padStart(3, '0')} | \`test/${file}\` |`)
  .join('\n');

console.log(`${header}\n${rows}\n`);
if (integrationFiles.length > 0) {
  console.log(`${integrationHeader}\n${integrationRows}\n`);
}
if (workersFiles.length > 0) {
  console.log(`${workersHeader}\n${workersRows}\n`);
}
