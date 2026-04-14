import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const SDK_DIST = resolve(SDK_ROOT, 'packages/sdk/dist');
const SOURCE_ARTIFACTS = resolve(
  SDK_ROOT,
  'packages/sdk/src/_internal/contracts/artifacts',
);
const DIST_ARTIFACTS = resolve(
  SDK_DIST,
  '_internal/contracts/artifacts',
);

function ensureExists(path) {
  if (!existsSync(path)) {
    throw new Error(`Expected path to exist: ${path}`);
  }
}

ensureExists(SDK_DIST);
ensureExists(SOURCE_ARTIFACTS);

rmSync(DIST_ARTIFACTS, { recursive: true, force: true });
mkdirSync(resolve(SDK_DIST, '_internal/contracts'), { recursive: true });
cpSync(SOURCE_ARTIFACTS, DIST_ARTIFACTS, { recursive: true });

console.log('prepared sdk package');
