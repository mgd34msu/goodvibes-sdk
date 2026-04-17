import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

const runtimeNeutralEntries = [
  'packages/contracts/dist/index.js',
  'packages/errors/dist/index.js',
  'packages/operator-sdk/dist/index.js',
  'packages/peer-sdk/dist/index.js',
  'packages/sdk/dist/index.js',
  'packages/sdk/dist/browser.js',
  'packages/sdk/dist/react-native.js',
  'packages/sdk/dist/expo.js',
  // /auth subpath is used by RN consumers for token helpers — must be node:-free
  'packages/sdk/dist/auth.js',
  'packages/transport-core/dist/index.js',
  'packages/transport-http/dist/index.js',
  'packages/transport-realtime/dist/index.js',
];

const disallowedPatterns = [
  /from ['"]node:/,
  /require\(['"]node:/,
  /from ['"]fs['"]/,
  /require\(['"]fs['"]\)/,
];

for (const relativePath of runtimeNeutralEntries) {
  const content = readFileSync(resolve(SDK_ROOT, relativePath), 'utf8');
  for (const pattern of disallowedPatterns) {
    if (pattern.test(content)) {
      throw new Error(`Runtime-neutral entry leaked a Node-only import: ${relativePath}`);
    }
  }
}

console.log('browser/runtime-neutral compatibility check passed');
