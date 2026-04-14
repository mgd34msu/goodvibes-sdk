import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

const requiredDocs = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/README.md',
  'docs/getting-started.md',
  'docs/packages.md',
  'docs/authentication.md',
  'docs/browser-integration.md',
  'docs/web-ui-integration.md',
  'docs/react-native-integration.md',
  'docs/expo-integration.md',
  'docs/android-integration.md',
  'docs/ios-integration.md',
  'docs/daemon-embedding.md',
  'docs/realtime-and-telemetry.md',
  'docs/retries-and-reconnect.md',
  'docs/companion-app-patterns.md',
  'docs/error-handling.md',
  'docs/troubleshooting.md',
  'docs/compatibility.md',
  'docs/release-and-publishing.md',
  'docs/testing-and-validation.md',
  'docs/reference-operator.md',
  'docs/reference-peer.md',
  'docs/reference-runtime-events.md',
];

const requiredExamples = [
  'examples/operator-http-quickstart.mjs',
  'examples/peer-http-quickstart.mjs',
  'examples/realtime-events-quickstart.mjs',
  'examples/auth-login-and-token-store.ts',
  'examples/retry-and-reconnect.mjs',
  'examples/companion-approvals-feed.ts',
  'examples/browser-web-ui-quickstart.ts',
  'examples/react-native-quickstart.ts',
  'examples/expo-quickstart.tsx',
  'examples/android-kotlin-quickstart.kt',
  'examples/ios-swift-quickstart.swift',
  'examples/daemon-fetch-handler-quickstart.ts',
  'examples/direct-transport-quickstart.ts',
];

for (const relativePath of [...requiredDocs, ...requiredExamples]) {
  const fullPath = resolve(SDK_ROOT, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing required SDK doc/example: ${relativePath}`);
  }
  const content = readFileSync(fullPath, 'utf8').trim();
  if (!content) {
    throw new Error(`Empty required SDK doc/example: ${relativePath}`);
  }
}

console.log('docs/examples completeness check passed');
