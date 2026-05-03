import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);

function defaultTestArgs(): readonly string[] {
  const testRoot = resolve(SDK_ROOT, 'test');
  const rootTestFiles = readdirSync(testRoot)
    .filter((entry) => entry.endsWith('.test.ts'))
    .sort()
    .map((entry) => `test/${entry}`);
  // Include integration subdirectory only if it exists and contains test files.
  const integrationDir = resolve(testRoot, 'integration');
  let integrationArgs: string[] = [];
  try {
    const entries = readdirSync(integrationDir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && /\.test\.(ts|tsx|mjs)$/.test(e.name))) {
      integrationArgs = ['test/integration'];
    }
  } catch {
    // integration directory does not exist — skip silently
  }
  return [...rootTestFiles, ...integrationArgs];
}

function resolveTestArgs(): readonly string[] {
  return args.length > 0 ? args : defaultTestArgs();
}

await withWorkspaceLock('test', () => {
  const testArgs = resolveTestArgs();
  execFileSync('bun', ['test', ...testArgs], {
    cwd: SDK_ROOT,
    stdio: 'inherit',
  });
});
