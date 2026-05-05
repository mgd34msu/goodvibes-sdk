import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = resolve(repoRoot, 'test');
const testFilePattern = /\.test\.(ts|tsx|mjs)$/;
// Also catch .skipIf, .skip.if, .each.skip, and .runIf variants that Bun supports.
const forbidden = /\b(?:describe|test|it)\.(?:skip(?:If|\.if)?|todo)\b/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(abs);
      continue;
    }
    if (entry.isFile() && testFilePattern.test(entry.name)) yield abs;
  }
}

const failures: string[] = [];
for (const abs of walk(testRoot)) {
  const source = readFileSync(abs, 'utf8');
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!forbidden.test(lines[index] ?? '')) continue;
    failures.push(`${relative(repoRoot, abs)}:${index + 1}: ${lines[index]?.trim() ?? ''}`);
  }
}

if (failures.length > 0) {
  console.error(`Skipped or todo tests are not allowed:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log('test-skip-check: OK - no describe.skip/test.skip/it.skip or todo tests.');
