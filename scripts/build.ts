import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const PACKAGES_ROOT = resolve(SDK_ROOT, 'packages');

function run(command: string, args: readonly string[]): void {
  execFileSync(command, args, {
    cwd: SDK_ROOT,
    stdio: 'inherit',
  });
}

function cleanPackageDists(): void {
  for (const entry of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    rmSync(resolve(PACKAGES_ROOT, entry.name, 'dist'), { recursive: true, force: true });
  }
}

await withWorkspaceLock('build', () => {
  run('bun', ['run', 'sync:version']);
  cleanPackageDists();
  run('bunx', ['tsc', '-b', '--force']);
  run('bun', ['run', 'prepare:sdk']);
});
