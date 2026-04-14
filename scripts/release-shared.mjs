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

export const publicPackageDirs = [
  'packages/sdk',
];

const INTERNAL_PACKAGE_NAMES = new Set([
  '@pellux/goodvibes-contracts',
  '@pellux/goodvibes-errors',
  '@pellux/goodvibes-daemon-sdk',
  '@pellux/goodvibes-transport-core',
  '@pellux/goodvibes-transport-direct',
  '@pellux/goodvibes-transport-http',
  '@pellux/goodvibes-transport-realtime',
  '@pellux/goodvibes-operator-sdk',
  '@pellux/goodvibes-peer-sdk',
]);

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

export function getPublicPackageNameOverride() {
  const value = process.env.GOODVIBES_PUBLIC_PACKAGE_NAME?.trim();
  return value ? value : null;
}

export function getPublishRegistryOverride() {
  const value = process.env.GOODVIBES_PUBLISH_REGISTRY?.trim();
  return value ? value.replace(/\/+$/, '') : null;
}

export function isPublicPackageDir(dir) {
  return publicPackageDirs.includes(dir);
}

function shouldCopyPath(path) {
  return !path.split('/').includes('node_modules');
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

function stripInternalDependencies(group) {
  if (!group || typeof group !== 'object') {
    return group;
  }
  const next = Object.fromEntries(
    Object.entries(group).filter(([name]) => !INTERNAL_PACKAGE_NAMES.has(name)),
  );
  return Object.keys(next).length > 0 ? next : undefined;
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
  const publicPackageNameOverride = getPublicPackageNameOverride();
  const tempRoot = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-release-'));
  const stages = [];
  for (const dir of packageDirs) {
    const sourceDir = getPackageDirectoryPath(dir);
    const stageDir = resolve(tempRoot, dir);
    cpSync(sourceDir, stageDir, { recursive: true, filter: shouldCopyPath });
    const manifest = normalizeManifest(readPackage(dir), rootVersion);
    if (dir === 'packages/sdk' && publicPackageNameOverride) {
      manifest.name = publicPackageNameOverride;
    }
    if (publicPackageDirs.includes(dir)) {
      manifest.dependencies = stripInternalDependencies(manifest.dependencies);
      manifest.devDependencies = stripInternalDependencies(manifest.devDependencies);
      manifest.peerDependencies = stripInternalDependencies(manifest.peerDependencies);
      manifest.optionalDependencies = stripInternalDependencies(manifest.optionalDependencies);
    }
    writeFileSync(resolve(stageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    stages.push({ dir, sourceDir, stageDir, manifest });
  }
  const publicStages = stages.filter((stage) => publicPackageDirs.includes(stage.dir));
  return { tempRoot, stages, publicStages };
}

export function cleanupStage(tempRoot) {
  rmSync(tempRoot, { recursive: true, force: true });
}

function getRegistryHost(registryUrl) {
  const normalized = (registryUrl || 'https://registry.npmjs.org').replace(/\/+$/, '');
  return new URL(normalized).host;
}

export function getAuthToken(registryUrl = 'https://registry.npmjs.org') {
  const host = getRegistryHost(registryUrl);
  if (host === 'npm.pkg.github.com') {
    return process.env.GITHUB_PACKAGES_TOKEN
      || process.env.GH_PACKAGES_TOKEN
      || process.env.GITHUB_TOKEN
      || process.env.NODE_AUTH_TOKEN
      || process.env.NPM_TOKEN
      || null;
  }
  return process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || null;
}

function getPackageScope(packageName) {
  if (typeof packageName !== 'string' || !packageName.startsWith('@')) {
    return null;
  }
  const slashIndex = packageName.indexOf('/');
  return slashIndex > 1 ? packageName.slice(0, slashIndex) : null;
}

export function createAuthEnv(extraEnv = {}, options = {}) {
  const env = { ...process.env, ...extraEnv };
  const registry = options.registry || 'https://registry.npmjs.org';
  const token = getAuthToken(registry);
  if (!token) {
    return env;
  }
  const registryHost = getRegistryHost(registry);
  const userConfigPath = resolve(
    mkdtempSync(join(tmpdir(), 'goodvibes-sdk-npmrc-')),
    '.npmrc',
  );
  const npmrcLines = [`//${registryHost}/:_authToken=${token}`];
  const scope = getPackageScope(options.packageName);
  if (scope && registryHost !== 'registry.npmjs.org') {
    npmrcLines.push(`${scope}:registry=${registry}`);
  }
  writeFileSync(userConfigPath, `${npmrcLines.join('\n')}\n`);
  env.NODE_AUTH_TOKEN = token;
  env.NPM_CONFIG_USERCONFIG = userConfigPath;
  return env;
}

export function run(command, args, cwd, options = {}) {
  const env = options.auth
    ? createAuthEnv(options.env, {
      registry: options.registry,
      packageName: options.packageName,
    })
    : { ...process.env, ...options.env };
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
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
}

export function listPackedFiles(tarballPath) {
  return execFileSync('tar', ['-tf', tarballPath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function readPackedText(tarballPath, entryPath) {
  return execFileSync('tar', ['-xOf', tarballPath, entryPath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

export function collectTarballs(packResults, packDestination) {
  return packResults.map((result) => resolve(packDestination, result.filename));
}
