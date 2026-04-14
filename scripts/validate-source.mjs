import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTuiRoot } from './source-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

function run(cmd) {
  execSync(cmd, {
    cwd: SDK_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
}

resolveTuiRoot({ required: true });

run('node scripts/sync-contract-artifacts.mjs --check');
run('node scripts/sync-transport-seams.mjs --check');
run('node scripts/sync-error-seams.mjs --check');
run('node scripts/sync-daemon-seams.mjs --check');
run('node scripts/validate.mjs');
