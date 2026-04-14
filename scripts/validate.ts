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

run('bun scripts/generate-api-docs.ts --check');
run('bun scripts/docs-completeness-check.ts');
run('bun run build');
run('bun run types:check');
run('bun scripts/browser-compat-check.ts');
run('bun scripts/package-metadata-check.ts');
run('bun test test');
run('bun run pack:check');
run('bun run install:smoke');
