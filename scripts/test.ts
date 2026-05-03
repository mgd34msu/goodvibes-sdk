import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);

function defaultTestArgs(): readonly string[] {
  return [
    ...readdirSync(resolve(SDK_ROOT, 'test'))
      .filter((entry) => entry.endsWith('.test.ts'))
      .sort()
      .map((entry) => `test/${entry}`),
    'test/integration',
  ];
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
