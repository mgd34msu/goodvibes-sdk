import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

function run(cmd) {
  execSync(cmd, {
    cwd: SDK_ROOT,
    stdio: 'inherit',
  });
}

run('node scripts/sync-contract-artifacts.mjs --check');
run('node scripts/sync-transport-seams.mjs --check');
run('node scripts/sync-error-seams.mjs --check');
run('node scripts/sync-daemon-seams.mjs --check');
run('node scripts/generate-api-docs.mjs --check');
run('node scripts/docs-completeness-check.mjs');
run('bun run build');
run('bun run types:check');
run('node scripts/browser-compat-check.mjs');
run('node scripts/package-metadata-check.mjs');
run('bun test test');
run('bun run pack:check');
