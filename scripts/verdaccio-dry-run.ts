/**
 * verdaccio-dry-run.ts
 *
 * End-to-end publish pipeline smoke test using a local Verdaccio registry.
 *
 * Steps:
 *   1. Find a free port and spawn a local Verdaccio process
 *      (with npmjs uplink so transitive deps resolve from real npm)
 *   2. Wait for Verdaccio to be ready (HTTP health check)
 *   3. Stage packages and publish @pellux/goodvibes-sdk to local Verdaccio
 *   4. Create a temporary scratch project in a tmp dir
 *   5. Install @pellux/goodvibes-sdk@<version> from local Verdaccio
 *      (transitive deps fetched transparently from npm via uplink)
 *   6. Run a smoke-test script that imports each documented entry point and
 *      verifies exports resolve
 *   7. Tear down Verdaccio, delete scratch project and local registry storage
 *   8. Exit 0 with summary on success, non-zero if any step fails
 */

import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  cleanupStage,
  getRootVersion,
  getPublicPackageNameOverride,
  readPackage,
  run,
  stagePackages,
} from './release-shared.ts';

// ─── constants ───────────────────────────────────────────────────────────────

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const SDK_ROOT = resolve(__dirname, '..');
const PUBLIC_PACKAGE_DIR = 'packages/sdk';
const PUBLIC_PACKAGE_NAME = getPublicPackageNameOverride() || readPackage(PUBLIC_PACKAGE_DIR).name;

// ─── port helpers ────────────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Could not determine free port')));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

// ─── Verdaccio launcher ──────────────────────────────────────────────────────

interface VerdaccioHandle {
  port: number;
  registryUrl: string;
  storageDir: string;
  configDir: string;
  stop: () => Promise<void>;
}

async function startVerdaccio(): Promise<VerdaccioHandle> {
  const port = await findFreePort();
  const storageDir = mkdtempSync(join(tmpdir(), 'verdaccio-storage-'));
  const configDir = mkdtempSync(join(tmpdir(), 'verdaccio-config-'));

  const configPath = join(configDir, 'config.yaml');

  // Verdaccio config:
  // - @pellux/* packages are served locally (publish allowed, no proxy)
  // - all other packages proxy through to real npm (for transitive deps)
  const configContent = [
    `storage: ${storageDir}`,
    ``,
    `auth:`,
    `  htpasswd:`,
    `    file: ${join(configDir, 'htpasswd')}`,
    `    max_users: -1`,
    ``,
    `uplinks:`,
    `  npmjs:`,
    `    url: https://registry.npmjs.org/`,
    `    timeout: 30s`,
    `    max_fails: 2`,
    `    fail_timeout: 5m`,
    ``,
    `packages:`,
    `  '@pellux/*':`,
    `    access: $all`,
    `    publish: $all`,
    `    unpublish: $all`,
    `    # No proxy — these must be published locally first`,
    `  '**':`,
    `    access: $all`,
    `    publish: $all`,
    `    proxy: npmjs`,
    ``,
    `server:`,
    `  keepAliveTimeout: 60`,
    ``,
    `logs:`,
    `  - { type: stdout, format: pretty, level: warn }`,
  ].join('\n');
  writeFileSync(configPath, configContent + '\n');

  const verdaccioBin = resolve(SDK_ROOT, 'node_modules/.bin/verdaccio');
  if (!existsSync(verdaccioBin)) {
    throw new Error(
      `verdaccio binary not found at ${verdaccioBin}.\n` +
        `Run: bun add -d verdaccio@^6.5.1 && bun install`,
    );
  }

  const registryUrl = `http://127.0.0.1:${port}`;
  console.log(`[verdaccio] starting on ${registryUrl} ...`);

  const proc = spawn(verdaccioBin, ['--config', configPath, '--listen', `127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let procExited = false;
  proc.on('exit', () => { procExited = true; });
  // Drain pipes to prevent backpressure stalls
  proc.stdout?.resume();
  proc.stderr?.resume();

  await waitForVerdaccio(registryUrl, 30_000);
  console.log(`[verdaccio] ready at ${registryUrl}`);

  const stop = (): Promise<void> =>
    new Promise((res) => {
      if (procExited) { res(); return; }
      proc.once('exit', () => res());
      try { proc.kill('SIGTERM'); } catch { res(); return; }
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        res();
      }, 5000);
    });

  return { port, registryUrl, storageDir, configDir, stop };
}

async function waitForVerdaccio(registryUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${registryUrl}/-/ping`);
      if (resp.ok || resp.status === 401) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `Verdaccio did not become ready within ${timeoutMs}ms. Last error: ${lastError}`,
  );
}

// ─── npm auth + registry config helpers ──────────────────────────────────────

/**
 * Write a .npmrc that:
 *  - Routes @pellux scope to local Verdaccio
 *  - Sets a dummy auth token for the local registry host
 *  - Falls back to real npm for all other scopes
 */
function writeNpmrc(projectDir: string, registryUrl: string): void {
  const host = new URL(registryUrl).host;
  const lines = [
    `@pellux:registry=${registryUrl}`,
    `//${host}/:_authToken=verdaccio-local-token`,
  ];
  writeFileSync(join(projectDir, '.npmrc'), lines.join('\n') + '\n');
}

// ─── publish to local Verdaccio ──────────────────────────────────────────────

function publishToLocalRegistry(registryUrl: string): { tempRoot: string } {
  console.log('[publish] staging packages ...');
  const { tempRoot, publicStages } = stagePackages();

  try {
    for (const stage of publicStages) {
      console.log(
        `[publish] ${stage.manifest.name}@${stage.manifest.version} → ${registryUrl}`,
      );
      writeNpmrc(stage.stageDir, registryUrl);
      run('npm', ['publish', '--access', 'public', '--registry', registryUrl], stage.stageDir, {
        auth: false,
        registry: registryUrl,
        packageName: stage.manifest.name,
      });
      console.log(`[publish] ${stage.manifest.name}@${stage.manifest.version} OK`);
    }
  } catch (err) {
    cleanupStage(tempRoot);
    throw err;
  }

  return { tempRoot };
}

// ─── smoke test ──────────────────────────────────────────────────────────────

function buildSmokeScript(pkgName: string): string {
  return `
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);

async function check(label, fn) {
  try {
    const mod = await fn();
    if (!mod || typeof mod !== 'object') throw new Error('module is not an object');
    console.log('[smoke] OK: ' + label);
    return mod;
  } catch (err) {
    console.error('[smoke] FAIL: ' + label + ' — ' + err.message);
    throw err;
  }
}

const PKG = ${JSON.stringify(pkgName)};

// Verify every documented export entry resolves
const root          = await check(PKG,                         () => import(PKG));
const auth          = await check(PKG + '/auth',               () => import(PKG + '/auth'));
const errors        = await check(PKG + '/errors',             () => import(PKG + '/errors'));
const browser       = await check(PKG + '/browser',            () => import(PKG + '/browser'));
const web           = await check(PKG + '/web',                () => import(PKG + '/web'));
const reactNative   = await check(PKG + '/react-native',       () => import(PKG + '/react-native'));
const expo          = await check(PKG + '/expo',               () => import(PKG + '/expo'));
const contracts     = await check(PKG + '/contracts',          () => import(PKG + '/contracts'));
const contractsNode = await check(PKG + '/contracts/node',     () => import(PKG + '/contracts/node'));
const operator      = await check(PKG + '/operator',           () => import(PKG + '/operator'));
const peer          = await check(PKG + '/peer',               () => import(PKG + '/peer'));
const daemon        = await check(PKG + '/daemon',             () => import(PKG + '/daemon'));
const txCore        = await check(PKG + '/transport-core',     () => import(PKG + '/transport-core'));
const txDirect      = await check(PKG + '/transport-direct',   () => import(PKG + '/transport-direct'));
const txHttp        = await check(PKG + '/transport-http',     () => import(PKG + '/transport-http'));
const txRT          = await check(PKG + '/transport-realtime', () => import(PKG + '/transport-realtime'));

// Validate key named exports are present
if (typeof root.createGoodVibesSdk !== 'function')
  throw new Error('root: missing createGoodVibesSdk');
if (typeof auth.createMemoryTokenStore !== 'function')
  throw new Error('auth: missing createMemoryTokenStore');
if (typeof operator.createOperatorSdk !== 'function')
  throw new Error('operator: missing createOperatorSdk');
if (typeof peer.createPeerSdk !== 'function')
  throw new Error('peer: missing createPeerSdk');
if (typeof daemon.createDaemonControlRouteHandlers !== 'function')
  throw new Error('daemon: missing createDaemonControlRouteHandlers');
if (!contracts.OPERATOR_METHOD_IDS || !contracts.PEER_ENDPOINT_IDS)
  throw new Error('contracts: missing OPERATOR_METHOD_IDS / PEER_ENDPOINT_IDS');
if (typeof web.createWebGoodVibesSdk !== 'function')
  throw new Error('web: missing createWebGoodVibesSdk');
if (typeof reactNative.createReactNativeGoodVibesSdk !== 'function')
  throw new Error('react-native: missing createReactNativeGoodVibesSdk');
if (typeof txRT.createRemoteRuntimeEvents !== 'function')
  throw new Error('transport-realtime: missing createRemoteRuntimeEvents');

// Verify no internal @pellux packages leaked into the published tarball
const packageRoot = dirname(req.resolve(PKG + '/package.json'));
const nestedInternal = join(packageRoot, 'node_modules', '@pellux');
if (existsSync(nestedInternal)) {
  const leaked = readdirSync(nestedInternal).filter((n) => n.startsWith('goodvibes-'));
  if (leaked.length > 0)
    throw new Error('published package leaked internal deps: ' + leaked.join(', '));
}

console.log('[smoke] ALL ENTRY POINTS RESOLVED OK');
`.trim();
}

function runSmokeTest(scratchDir: string, registryUrl: string): void {
  console.log('[smoke] installing SDK from local registry ...');

  const version = getRootVersion();
  const packageSpec = `${PUBLIC_PACKAGE_NAME}@${version}`;

  writeFileSync(
    join(scratchDir, 'package.json'),
    JSON.stringify({ name: 'verdaccio-smoke', private: true, type: 'module' }, null, 2) + '\n',
  );
  writeFileSync(join(scratchDir, 'smoke.mjs'), buildSmokeScript(PUBLIC_PACKAGE_NAME) + '\n');
  // .npmrc: @pellux scope → local Verdaccio; everything else → real npm
  writeNpmrc(scratchDir, registryUrl);

  execFileSync(
    'npm',
    ['install', packageSpec, '--registry', registryUrl],
    {
      cwd: scratchDir,
      stdio: 'inherit',
    },
  );

  console.log('[smoke] running import resolution checks ...');
  execFileSync('node', ['smoke.mjs'], {
    cwd: scratchDir,
    stdio: 'inherit',
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

const startTime = Date.now();
let verdaccioHandle: VerdaccioHandle | null = null;
let stageRoot: string | null = null;
let scratchDir: string | null = null;

function cleanup(): void {
  if (scratchDir) {
    try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
    scratchDir = null;
  }
  if (stageRoot) {
    try { cleanupStage(stageRoot); } catch { /* ignore */ }
    stageRoot = null;
  }
}

async function main(): Promise<void> {
  verdaccioHandle = await startVerdaccio();
  const { registryUrl, storageDir, configDir } = verdaccioHandle;

  let runError: unknown = null;
  try {
    const { tempRoot } = publishToLocalRegistry(registryUrl);
    stageRoot = tempRoot;

    scratchDir = mkdtempSync(join(tmpdir(), 'verdaccio-scratch-'));
    runSmokeTest(scratchDir, registryUrl);
  } catch (err) {
    runError = err;
  } finally {
    cleanup();
    if (verdaccioHandle) {
      console.log('[verdaccio] shutting down ...');
      await verdaccioHandle.stop();
      try { rmSync(storageDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
      verdaccioHandle = null;
    }
  }

  if (runError) throw runError;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const version = getRootVersion();
  console.log('');
  console.log('verdaccio-dry-run PASSED');
  console.log(`  package : ${PUBLIC_PACKAGE_NAME}@${version}`);
  console.log(`  elapsed : ${elapsed}s`);
}

main().catch((err) => {
  cleanup();
  void verdaccioHandle?.stop().catch(() => {});
  if (verdaccioHandle?.storageDir) {
    try { rmSync(verdaccioHandle.storageDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (verdaccioHandle?.configDir) {
    try { rmSync(verdaccioHandle.configDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.error('[verdaccio-dry-run] FAILED:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
