import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SDK_ROOT = resolve(__dirname, '..');
export const packageDirs = [
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

export function getRootPackage() {
  return JSON.parse(readFileSync(resolve(SDK_ROOT, 'package.json'), 'utf8'));
}

export function getRootVersion() {
  return getRootPackage().version;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function getPackageDirectoryPath(dir) {
  return resolve(SDK_ROOT, dir);
}

export function getPackageJsonPath(dir) {
  return resolve(getPackageDirectoryPath(dir), 'package.json');
}

export function readPackage(dir) {
  return readJson(getPackageJsonPath(dir));
}

function normalizeDependencyGroup(group, rootVersion) {
  if (!group || typeof group !== 'object') {
    return group;
  }
  const next = {};
  for (const [name, value] of Object.entries(group)) {
    next[name] = typeof value === 'string' && value.startsWith('workspace:')
      ? rootVersion
      : value;
  }
  return next;
}

function normalizeRepository(repository) {
  if (!repository || typeof repository !== 'object' || typeof repository.url !== 'string') {
    return repository;
  }
  const url = repository.url.startsWith('git+')
    ? repository.url
    : repository.url.endsWith('.git')
      ? `git+${repository.url}`
      : `git+${repository.url}.git`;
  return { ...repository, url };
}

export function normalizeManifest(pkg, rootVersion = getRootVersion()) {
  return {
    ...pkg,
    repository: normalizeRepository(pkg.repository),
    dependencies: normalizeDependencyGroup(pkg.dependencies, rootVersion),
    devDependencies: normalizeDependencyGroup(pkg.devDependencies, rootVersion),
    peerDependencies: normalizeDependencyGroup(pkg.peerDependencies, rootVersion),
    optionalDependencies: normalizeDependencyGroup(pkg.optionalDependencies, rootVersion),
  };
}

export function stagePackages() {
  const rootVersion = getRootVersion();
  const tempRoot = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-release-'));
  const stages = [];
  for (const dir of packageDirs) {
    const sourceDir = getPackageDirectoryPath(dir);
    const stageDir = resolve(tempRoot, dir);
    cpSync(sourceDir, stageDir, { recursive: true });
    const manifest = normalizeManifest(readPackage(dir), rootVersion);
    writeFileSync(resolve(stageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    stages.push({ dir, sourceDir, stageDir, manifest });
  }
  return { tempRoot, stages };
}

export function cleanupStage(tempRoot) {
  rmSync(tempRoot, { recursive: true, force: true });
}

export function getAuthToken() {
  return process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || null;
}

export function createAuthEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const token = getAuthToken();
  if (!token) {
    return env;
  }
  const userConfigPath = resolve(
    mkdtempSync(join(tmpdir(), 'goodvibes-sdk-npmrc-')),
    '.npmrc',
  );
  writeFileSync(
    userConfigPath,
    `//registry.npmjs.org/:_authToken=${token}\n`,
  );
  env.NODE_AUTH_TOKEN = token;
  env.NPM_CONFIG_USERCONFIG = userConfigPath;
  return env;
}

export function run(command, args, cwd, options = {}) {
  const env = options.auth ? createAuthEnv(options.env) : { ...process.env, ...options.env };
  return execFileSync(command, args, {
    cwd,
    env,
    stdio: options.stdio ?? 'inherit',
    encoding: options.encoding ?? 'utf8',
  });
}

export function packStage(stageDir, packDestination) {
  const output = run(
    'npm',
    ['pack', '--json', '--pack-destination', packDestination],
    stageDir,
    { stdio: 'pipe' },
  );
  return JSON.parse(output)[0];
}

export function inspectPackedManifest(tarballPath) {
  return JSON.parse(
    execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
}

export function collectTarballs(packResults, packDestination) {
  return packResults.map((result) => resolve(packDestination, result.filename));
}
