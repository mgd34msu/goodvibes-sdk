import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  cleanupStage,
  collectTarballs,
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
const PUBLIC_PACKAGE_NAME = getPublicPackageNameOverride() || readPackage(PUBLIC_PACKAGE_DIR).name;
const NODE_ENTRY = `${PUBLIC_PACKAGE_NAME}/node`;
const WEB_ENTRY = `${PUBLIC_PACKAGE_NAME}/web`;
const NATIVE_ENTRY = `${PUBLIC_PACKAGE_NAME}/react-native`;
const AUTH_ENTRY = `${PUBLIC_PACKAGE_NAME}/auth`;
const OPERATOR_ENTRY = `${PUBLIC_PACKAGE_NAME}/operator`;
const PEER_ENTRY = `${PUBLIC_PACKAGE_NAME}/peer`;
const DAEMON_ENTRY = `${PUBLIC_PACKAGE_NAME}/daemon`;
const CONTRACTS_ENTRY = `${PUBLIC_PACKAGE_NAME}/contracts`;
const REALTIME_ENTRY = `${PUBLIC_PACKAGE_NAME}/transport-realtime`;
const REGISTRY = getPublishRegistryOverride() || 'https://registry.npmjs.org';

const smokeScript = `
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = await import('${PUBLIC_PACKAGE_NAME}');
const nodeEntry = await import('${NODE_ENTRY}');
const webEntry = await import('${WEB_ENTRY}');
const nativeEntry = await import('${NATIVE_ENTRY}');
const auth = await import('${AUTH_ENTRY}');
const operator = await import('${OPERATOR_ENTRY}');
const peer = await import('${PEER_ENTRY}');
const daemon = await import('${DAEMON_ENTRY}');
const contracts = await import('${CONTRACTS_ENTRY}');
const runtimeEvents = await import('${REALTIME_ENTRY}');

const sdk = nodeEntry.createNodeGoodVibesSdk({ baseUrl: 'http://127.0.0.1:3210' });
if (!sdk?.operator || !sdk?.peer || !sdk?.realtime) throw new Error('sdk entrypoint missing expected surfaces');
if (typeof auth.createMemoryTokenStore !== 'function') throw new Error('auth entrypoint missing token helpers');
if (typeof operator.createOperatorSdk !== 'function') throw new Error('operator client export missing');
if (typeof peer.createPeerSdk !== 'function') throw new Error('peer client export missing');
if (typeof daemon.createDaemonControlRouteHandlers !== 'function') throw new Error('daemon route export missing');
if (!contracts.OPERATOR_METHOD_IDS || !contracts.PEER_ENDPOINT_IDS) throw new Error('contracts export missing');
if (typeof runtimeEvents.createRemoteRuntimeEvents !== 'function') throw new Error('runtime realtime export missing');
if (typeof root.createGoodVibesSdk !== 'function') throw new Error('umbrella sdk export missing');
if (typeof webEntry.createWebGoodVibesSdk !== 'function') throw new Error('web sdk export missing');
if (typeof nativeEntry.createReactNativeGoodVibesSdk !== 'function') throw new Error('react-native sdk export missing');
const packageRoot = dirname(require.resolve('${PUBLIC_PACKAGE_NAME}/package.json'));
const nestedInternalRoot = join(packageRoot, 'node_modules', '@pellux');
if (existsSync(nestedInternalRoot)) {
  const leaked = readdirSync(nestedInternalRoot).filter((name) => name.startsWith('goodvibes-'));
  if (leaked.length > 0) {
    throw new Error('umbrella package leaked nested internal packages: ' + leaked.join(', '));
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
}

function installWithNpm(specs) {
  const projectDir = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-npm-smoke-'));
  try {
    writeConsumerFiles(projectDir);
    run('npm', ['install', ...specs], projectDir, {
      auth: REGISTRY_MODE,
      registry: REGISTRY,
      packageName: PUBLIC_PACKAGE_NAME,
    });
    run('node', ['check.mjs'], projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function installWithBun(specs) {
  const projectDir = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-bun-smoke-'));
  try {
    writeConsumerFiles(projectDir);
    run('bun', ['add', ...specs], projectDir, {
      auth: REGISTRY_MODE,
      registry: REGISTRY,
      packageName: PUBLIC_PACKAGE_NAME,
    });
    run('bun', ['run', 'check.mjs'], projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function buildRegistrySpecs() {
  const version = getRootVersion();
  return [`${PUBLIC_PACKAGE_NAME}@${version}`];
}

function buildTarballSpecs() {
  const { tempRoot, publicStages } = stagePackages();
  const packDestination = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-tarballs-'));
  const packResults = publicStages
    .filter((stage) => stage.dir === PUBLIC_PACKAGE_DIR)
    .map((stage) => packStage(stage.stageDir, packDestination));
  const tarballs = collectTarballs(packResults, packDestination);
  return { tempRoot, specs: tarballs };
}

if (REGISTRY_MODE) {
  const specs = buildRegistrySpecs();
  installWithNpm(specs);
  installWithBun(specs);
  console.log('registry install smoke passed');
} else {
  const { tempRoot, specs } = buildTarballSpecs();
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
