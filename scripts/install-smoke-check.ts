import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  cleanupStage,
  collectTarballs,
  createSdkTempDir,
  getAuthToken,
  getPublicPackageNameOverride,
  getPublishRegistryOverride,
  getRootVersion,
  packStage,
  readPackage,
  run,
  stagePackages,
} from './release-shared.ts';

const REGISTRY_MODE = process.argv.includes('--registry');
const PUBLIC_PACKAGE_DIR = 'packages/sdk';
const PUBLIC_PACKAGE_NAME = getPublicPackageNameOverride() || requirePackageName(PUBLIC_PACKAGE_DIR);

function requirePackageName(dir: string): string {
  const name = readPackage(dir).name;
  if (typeof name !== 'string' || !name) throw new Error(`Package ${dir} is missing a string name.`);
  return name;
}
const WEB_ENTRY = `${PUBLIC_PACKAGE_NAME}/web`;
const NATIVE_ENTRY = `${PUBLIC_PACKAGE_NAME}/react-native`;
const AUTH_ENTRY = `${PUBLIC_PACKAGE_NAME}/auth`;
const OPERATOR_ENTRY = `${PUBLIC_PACKAGE_NAME}/operator`;
const PEER_ENTRY = `${PUBLIC_PACKAGE_NAME}/peer`;
const DAEMON_ENTRY = `${PUBLIC_PACKAGE_NAME}/daemon`;
const CONTRACTS_ENTRY = `${PUBLIC_PACKAGE_NAME}/contracts`;
const REALTIME_ENTRY = `${PUBLIC_PACKAGE_NAME}/transport-realtime`;
const RUNTIME_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/runtime`;
const RUNTIME_OBSERVABILITY_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/runtime/observability`;
const REGISTRY = getPublishRegistryOverride() || 'https://registry.npmjs.org';

const smokeScript = `
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = await import('${PUBLIC_PACKAGE_NAME}');
const webEntry = await import('${WEB_ENTRY}');
const nativeEntry = await import('${NATIVE_ENTRY}');
const auth = await import('${AUTH_ENTRY}');
const operator = await import('${OPERATOR_ENTRY}');
const peer = await import('${PEER_ENTRY}');
const daemon = await import('${DAEMON_ENTRY}');
const contracts = await import('${CONTRACTS_ENTRY}');
const runtimeEvents = await import('${REALTIME_ENTRY}');
const runtime = await import('${RUNTIME_ENTRY}');
const runtimeObservability = await import('${RUNTIME_OBSERVABILITY_ENTRY}');

const sdk = root.createGoodVibesSdk({ baseUrl: 'http://127.0.0.1:3210' });
if (!sdk?.operator || !sdk?.peer || !sdk?.realtime) throw new Error('sdk entrypoint missing expected surfaces');
if (typeof auth.createMemoryTokenStore !== 'function') throw new Error('auth entrypoint missing token helpers');
if (typeof operator.createOperatorSdk !== 'function') throw new Error('operator client export missing');
if (typeof peer.createPeerSdk !== 'function') throw new Error('peer client export missing');
if (typeof daemon.createDaemonControlRouteHandlers !== 'function') throw new Error('daemon route export missing');
if (!contracts.OPERATOR_METHOD_IDS || !contracts.PEER_ENDPOINT_IDS) throw new Error('contracts export missing');
if (typeof runtimeEvents.createRemoteRuntimeEvents !== 'function') throw new Error('runtime realtime export missing');
if (!runtime.observability || !runtime.transport || !runtime.state) throw new Error('runtime namespace seams missing');
if (typeof runtimeObservability.TimelineBuffer !== 'function') throw new Error('runtime observability state inspector export missing');
if (typeof root.createGoodVibesSdk !== 'function') throw new Error('umbrella sdk export missing');
if (typeof webEntry.createWebGoodVibesSdk !== 'function') throw new Error('web sdk export missing');
if (typeof nativeEntry.createReactNativeGoodVibesSdk !== 'function') throw new Error('react-native sdk export missing');
const packageRoot = dirname(require.resolve('${PUBLIC_PACKAGE_NAME}/package.json'));
const nestedInternalRoot = join(packageRoot, 'node_modules', '@pellux');
if (existsSync(nestedInternalRoot)) {
  const leaked = readdirSync(nestedInternalRoot).filter((name) => name.startsWith('goodvibes-'));
  if (leaked.length > 0) {
    throw new Error('SDK package contains nested GoodVibes package installs: ' + leaked.join(', '));
  }
}
console.log('install smoke ok');
`;

function writeConsumerFiles(projectDir) {
  writeFileSync(
    resolve(projectDir, 'package.json'),
    `${JSON.stringify({
      name: 'goodvibes-sdk-install-smoke',
      private: true,
      type: 'module',
    }, null, 2)}\n`,
  );
  writeFileSync(resolve(projectDir, 'check.mjs'), `${smokeScript.trim()}\n`);
  if (REGISTRY_MODE) {
    writeRegistryConfig(projectDir);
  }
}

function writeRegistryConfig(projectDir) {
  const token = getAuthToken(REGISTRY);
  if (!token) {
    return;
  }
  const registryHost = new URL(REGISTRY).host;
  const scope = PUBLIC_PACKAGE_NAME.startsWith('@')
    ? PUBLIC_PACKAGE_NAME.slice(0, PUBLIC_PACKAGE_NAME.indexOf('/'))
    : null;
  const lines = [`//${registryHost}/:_authToken=${token}`];
  if (scope && registryHost !== 'registry.npmjs.org') {
    lines.push(`${scope}:registry=${REGISTRY}`);
  }
  writeFileSync(resolve(projectDir, '.npmrc'), `${lines.join('\n')}\n`);
}

// Network-aware retry for the install step. npm + bun fetches are prone to
// transient ECONNRESET / ETIMEDOUT on CI runners; without retry a single
// network blip fails the release. Code-level errors (parse, missing entry)
// are NOT retried.
function retryOnNetworkError(op, label) {
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [0, 2000, 5000];
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        const delay = BACKOFF_MS[attempt - 1] ?? 5000;
        console.log(`[install-smoke] ${label}: attempt ${attempt}/${MAX_ATTEMPTS} after ${delay}ms backoff`);
        const wait = Date.now() + delay;
        while (Date.now() < wait) { /* sync sleep */ }
      }
      op();
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isNetwork = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|aborted/i.test(msg);
      if (!isNetwork || attempt === MAX_ATTEMPTS) throw err;
      console.log(`[install-smoke] ${label}: transient network error detected, retrying. (${msg.slice(0, 200)})`);
    }
  }
  throw lastErr;
}

function installWithNpm(specs) {
  const projectDir = createSdkTempDir('goodvibes-sdk-npm-smoke-');
  try {
    writeConsumerFiles(projectDir);
    retryOnNetworkError(() => {
      run('npm', ['install', ...specs], projectDir, {
        auth: REGISTRY_MODE,
        registry: REGISTRY,
        packageName: PUBLIC_PACKAGE_NAME,
      });
    }, 'npm install');
    run('node', ['check.mjs'], projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function installWithBun(specs) {
  const projectDir = createSdkTempDir('goodvibes-sdk-bun-smoke-');
  try {
    writeConsumerFiles(projectDir);
    // Pin zod@^4 explicitly so Bun resolves the dist's `zod/v4` subpath import
    // even when another dependency tree brings an older zod.
    const bunSpecs = [...specs, 'zod@^4'];
    retryOnNetworkError(() => {
      run('bun', ['add', '--force', '--no-cache', ...bunSpecs], projectDir, {
        auth: REGISTRY_MODE,
        registry: REGISTRY,
        packageName: PUBLIC_PACKAGE_NAME,
      });
    }, 'bun add');
    run('bun', ['run', 'check.mjs'], projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function buildRegistrySpecs() {
  const version = getRootVersion();
  return [`${PUBLIC_PACKAGE_NAME}@${version}`];
}

async function buildTarballSpecs() {
  const { tempRoot, publicStages } = await stagePackages();
  const packDestination = createSdkTempDir('goodvibes-sdk-tarballs-');
  const packResults = publicStages.map((stage) => packStage(stage.stageDir, packDestination));
  const tarballs = collectTarballs(packResults, packDestination);
  return { tempRoot, specs: tarballs };
}

if (REGISTRY_MODE) {
  const specs = buildRegistrySpecs();
  installWithNpm(specs);
  installWithBun(specs);
  console.log('registry install smoke passed');
} else {
  const { tempRoot, specs } = await buildTarballSpecs();
  const packDir = specs.length > 0 ? resolve(specs[0], '..') : null;
  try {
    installWithNpm(specs);
    console.log('tarball install smoke passed');
  } finally {
    cleanupStage(tempRoot);
    if (packDir) {
      rmSync(packDir, { recursive: true, force: true });
    }
  }
}
