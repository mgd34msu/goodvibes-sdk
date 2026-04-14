import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  cleanupStage,
  collectTarballs,
  getRootVersion,
  packStage,
  packageDirs,
  readPackage,
  run,
  stagePackages,
} from './release-shared.mjs';

const REGISTRY_MODE = process.argv.includes('--registry');

const smokeScript = `
const root = await import('@goodvibes/sdk');
const nodeEntry = await import('@goodvibes/sdk/node');
const webEntry = await import('@goodvibes/sdk/web');
const nativeEntry = await import('@goodvibes/sdk/react-native');
const operator = await import('@goodvibes/operator-sdk');
const peer = await import('@goodvibes/peer-sdk');
const daemon = await import('@goodvibes/daemon-sdk');
const contracts = await import('@goodvibes/contracts');
const runtimeEvents = await import('@goodvibes/transport-realtime');

const sdk = nodeEntry.createNodeGoodVibesSdk({ baseUrl: 'http://127.0.0.1:3210' });
if (!sdk?.operator || !sdk?.peer || !sdk?.realtime) throw new Error('sdk entrypoint missing expected surfaces');
if (typeof operator.createOperatorSdk !== 'function') throw new Error('operator client export missing');
if (typeof peer.createPeerSdk !== 'function') throw new Error('peer client export missing');
if (typeof daemon.createDaemonControlRouteHandlers !== 'function') throw new Error('daemon route export missing');
if (!contracts.OPERATOR_METHOD_IDS || !contracts.PEER_ENDPOINT_IDS) throw new Error('contracts export missing');
if (typeof runtimeEvents.createRemoteRuntimeEvents !== 'function') throw new Error('runtime realtime export missing');
if (typeof root.createGoodVibesSdk !== 'function') throw new Error('umbrella sdk export missing');
if (typeof webEntry.createWebGoodVibesSdk !== 'function') throw new Error('web sdk export missing');
if (typeof nativeEntry.createReactNativeGoodVibesSdk !== 'function') throw new Error('react-native sdk export missing');
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
  writeConsumerFiles(projectDir);
  run('npm', ['install', ...specs], projectDir);
  run('node', ['check.mjs'], projectDir);
}

function installWithBun(specs) {
  const projectDir = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-bun-smoke-'));
  writeConsumerFiles(projectDir);
  run('bun', ['add', ...specs], projectDir);
  run('bun', ['run', 'check.mjs'], projectDir);
}

function buildRegistrySpecs() {
  const version = getRootVersion();
  return packageDirs.map((dir) => `${readPackage(dir).name}@${version}`);
}

function buildTarballSpecs() {
  const { tempRoot, stages } = stagePackages();
  const packDestination = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-tarballs-'));
  const packResults = stages.map((stage) => packStage(stage.stageDir, packDestination));
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
  try {
    installWithNpm(specs);
    console.log('tarball install smoke passed');
  } finally {
    cleanupStage(tempRoot);
  }
}
