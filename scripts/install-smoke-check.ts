import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  cleanupStage,
  collectTarballs,
  createSdkTempDir,
  getAuthToken,
  getPublishRegistryOverride,
  getRootVersion,
  packStage,
  publicPackageDirs,
  readPackage,
  run,
  stagePackages,
} from './release-shared.ts';

const REGISTRY_MODE = process.argv.includes('--registry');
const PUBLIC_PACKAGE_DIR = 'packages/sdk';
const PUBLIC_PACKAGE_NAME = packageNameForDir(PUBLIC_PACKAGE_DIR);
const CONTRACTS_PACKAGE_NAME = packageNameForDir('packages/contracts');
const ERRORS_PACKAGE_NAME = packageNameForDir('packages/errors');
const DAEMON_SDK_PACKAGE_NAME = packageNameForDir('packages/daemon-sdk');
const TRANSPORT_CORE_PACKAGE_NAME = packageNameForDir('packages/transport-core');
const TRANSPORT_HTTP_PACKAGE_NAME = packageNameForDir('packages/transport-http');
const TRANSPORT_REALTIME_PACKAGE_NAME = packageNameForDir('packages/transport-realtime');
const OPERATOR_SDK_PACKAGE_NAME = packageNameForDir('packages/operator-sdk');
const PEER_SDK_PACKAGE_NAME = packageNameForDir('packages/peer-sdk');

function requirePackageName(dir: string): string {
  const name = readPackage(dir).name;
  if (typeof name !== 'string' || !name) throw new Error(`Package ${dir} is missing a string name.`);
  return name;
}

function packageNameForDir(dir: string): string {
  return requirePackageName(dir);
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
const PROVIDERS_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/providers`;
const FEATURE_ANNOUNCEMENTS_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/runtime/feature-announcements`;
const LOCALHOST_FETCH_APPROVAL_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/runtime/permissions/localhost-fetch-approval`;
const EXEC_PROMPT_WIRING_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/runtime/permissions/exec-prompt-wiring`;
const STORE_SNAPSHOTS_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/state/store-snapshots`;
const CONTROL_PLANE_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/control-plane`;
const SELF_UPDATE_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/runtime/self-update`;
const AUTO_UPDATER_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/daemon/auto-updater`;
const RECEIPTS_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/daemon/receipts`;
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
const providersEntry = await import('${PROVIDERS_ENTRY}');
const featureAnnouncements = await import('${FEATURE_ANNOUNCEMENTS_ENTRY}');
const localhostFetchApproval = await import('${LOCALHOST_FETCH_APPROVAL_ENTRY}');
const execPromptWiring = await import('${EXEC_PROMPT_WIRING_ENTRY}');
const storeSnapshots = await import('${STORE_SNAPSHOTS_ENTRY}');
const controlPlane = await import('${CONTROL_PLANE_ENTRY}');
const selfUpdate = await import('${SELF_UPDATE_ENTRY}');
const autoUpdater = await import('${AUTO_UPDATER_ENTRY}');
const daemonReceipts = await import('${RECEIPTS_ENTRY}');
const contractsPackage = await import('${CONTRACTS_PACKAGE_NAME}');
const errorsPackage = await import('${ERRORS_PACKAGE_NAME}');
const daemonSdkPackage = await import('${DAEMON_SDK_PACKAGE_NAME}');
const transportCorePackage = await import('${TRANSPORT_CORE_PACKAGE_NAME}');
const transportHttpPackage = await import('${TRANSPORT_HTTP_PACKAGE_NAME}');
const transportRealtimePackage = await import('${TRANSPORT_REALTIME_PACKAGE_NAME}');
const operatorSdkPackage = await import('${OPERATOR_SDK_PACKAGE_NAME}');
const peerSdkPackage = await import('${PEER_SDK_PACKAGE_NAME}');

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
if (!runtimeObservability.GATE_SUITES || typeof runtimeObservability.GATE_SUITES !== 'object') throw new Error('runtime observability GATE_SUITES export missing');
if (typeof providersEntry.resolveModelReference !== 'function') throw new Error('providers resolveModelReference export missing');
if (typeof providersEntry.findClosestModelIds !== 'function') throw new Error('providers findClosestModelIds export missing');
if (typeof featureAnnouncements.FeatureAnnouncementStore !== 'function') throw new Error('feature-announcements store export missing');
if (typeof featureAnnouncements.collectStartupAnnouncements !== 'function') throw new Error('feature-announcements collectStartupAnnouncements export missing');
if (typeof featureAnnouncements.createSandboxContainmentAnnouncer !== 'function') throw new Error('feature-announcements sandbox announcer export missing');
if (typeof featureAnnouncements.featureAnnouncementsPath !== 'function') throw new Error('feature-announcements path helper export missing');
if (typeof localhostFetchApproval.buildLocalhostFetchApproval !== 'function') throw new Error('localhost-fetch-approval builder export missing');
if (typeof execPromptWiring.buildExecPromptAnswerHandler !== 'function') throw new Error('exec-prompt-wiring builder export missing');
if (typeof storeSnapshots.StoreSnapshotScheduler !== 'function') throw new Error('store-snapshots scheduler export missing');
if (typeof storeSnapshots.RetentionPolicy !== 'function') throw new Error('store-snapshots RetentionPolicy export missing');
if (typeof storeSnapshots.SnapshotPruner !== 'function') throw new Error('store-snapshots SnapshotPruner export missing');
if (typeof storeSnapshots.defaultStoreSnapshotRetention !== 'function') throw new Error('store-snapshots default retention export missing');
if (typeof controlPlane.buildSharedSessionAgentSpawnRoutingInput !== 'function') throw new Error('control-plane spawn-routing builder export missing');
if (typeof controlPlane.hasFreshSurfaceParticipant !== 'function') throw new Error('control-plane surface-presence helper export missing');
if (typeof controlPlane.SURFACE_ROUTE_FRESHNESS_MS !== 'number') throw new Error('control-plane surface freshness window export missing');
if (typeof selfUpdate.compareVersions !== 'function') throw new Error('self-update compareVersions export missing');
if (typeof selfUpdate.verifyChecksum !== 'function') throw new Error('self-update verifyChecksum export missing');
if (typeof autoUpdater.DaemonAutoUpdater !== 'function') throw new Error('auto-updater DaemonAutoUpdater export missing');
if (typeof daemonReceipts.DaemonReceiptStore !== 'function') throw new Error('daemon receipts store export missing');
if (typeof root.createGoodVibesSdk !== 'function') throw new Error('umbrella sdk export missing');
if (typeof webEntry.createWebGoodVibesSdk !== 'function') throw new Error('web sdk export missing');
if (typeof nativeEntry.createReactNativeGoodVibesSdk !== 'function') throw new Error('react-native sdk export missing');
if (!contractsPackage.OPERATOR_METHOD_IDS || !contractsPackage.PEER_ENDPOINT_IDS) throw new Error('contracts package export missing');
if (typeof errorsPackage.GoodVibesSdkError !== 'function') throw new Error('errors package export missing');
if (typeof daemonSdkPackage.createDaemonControlRouteHandlers !== 'function') throw new Error('daemon-sdk package export missing');
if (typeof transportCorePackage.createDirectClientTransport !== 'function') throw new Error('transport-core package export missing');
if (typeof transportHttpPackage.createHttpTransport !== 'function') throw new Error('transport-http package export missing');
if (typeof transportRealtimePackage.createRemoteRuntimeEvents !== 'function') throw new Error('transport-realtime package export missing');
if (typeof operatorSdkPackage.createOperatorSdk !== 'function') throw new Error('operator-sdk package export missing');
if (typeof peerSdkPackage.createPeerSdk !== 'function') throw new Error('peer-sdk package export missing');
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

function writeConsumerFiles(projectDir: string): void {
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

function writeRegistryConfig(projectDir: string): void {
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
async function retryOnNetworkError(op: () => Promise<void> | void, label: string): Promise<void> {
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [0, 2000, 5000];
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        const delay = BACKOFF_MS[attempt - 1] ?? 5000;
        console.log(`[install-smoke] ${label}: attempt ${attempt}/${MAX_ATTEMPTS} after ${delay}ms backoff`);
        await new Promise<void>((r) => setTimeout(r, delay));
      }
      await op();
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

async function installWithNpm(specs: readonly string[]): Promise<void> {
  const projectDir = createSdkTempDir('goodvibes-sdk-npm-smoke-');
  try {
    writeConsumerFiles(projectDir);
    await retryOnNetworkError(() => {
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

async function installWithBun(specs: readonly string[]): Promise<void> {
  const projectDir = createSdkTempDir('goodvibes-sdk-bun-smoke-');
  try {
    writeConsumerFiles(projectDir);
    // Pin zod@^4 explicitly so Bun resolves the dist's `zod/v4` subpath import
    // even when another dependency tree brings an older zod.
    const bunSpecs = [...specs, 'zod@^4'];
    await retryOnNetworkError(() => {
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

function buildRegistrySpecs(): string[] {
  const version = getRootVersion();
  return publicPackageDirs.map((dir) => `${packageNameForDir(dir)}@${version}`);
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
  await installWithNpm(specs);
  await installWithBun(specs);
  console.log('registry install smoke passed');
} else {
  const { tempRoot, specs } = await buildTarballSpecs();
  const packDir = specs.length > 0 ? resolve(specs[0], '..') : null;
  try {
    await installWithNpm(specs);
    console.log('tarball install smoke passed');
  } finally {
    cleanupStage(tempRoot);
    if (packDir) {
      rmSync(packDir, { recursive: true, force: true });
    }
  }
}
