import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

const packageDirs = [
  'packages/contracts',
  'packages/errors',
  'packages/daemon-sdk',
  'packages/transport-core',
  'packages/transport-direct',
  'packages/transport-http',
  'packages/transport-realtime',
  'packages/operator-sdk',
  'packages/peer-sdk',
  'packages/sdk',
];

for (const dir of packageDirs) {
  execSync('npm pack --dry-run', {
    cwd: resolve(SDK_ROOT, dir),
    stdio: 'inherit',
  });
}
