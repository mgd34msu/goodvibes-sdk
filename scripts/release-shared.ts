import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SDK_ROOT = resolve(__dirname, '..');
const SDK_TEMP_ROOT = resolve(SDK_ROOT, '.tmp');
export const packageDirs = [
  'packages/contracts',
  'packages/errors',
  'packages/daemon-sdk',
  'packages/transport-core',
  'packages/transport-http',
  'packages/transport-realtime',
  'packages/operator-sdk',
  'packages/peer-sdk',
  'packages/sdk',
];

export const publicPackageDirs = packageDirs;

export interface PackageManifest extends Record<string, unknown> {
  name?: string;
  version?: string;
  files?: readonly string[];
  repository?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

export interface PackageStage {
  readonly dir: string;
  readonly sourceDir: string;
  readonly stageDir: string;
  readonly manifest: PackageManifest;
}

export interface RunOptions {
  readonly auth?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly registry?: string;
  readonly packageName?: string;
  readonly stdio?: 'inherit' | 'pipe' | 'ignore';
  readonly encoding?: BufferEncoding;
  /**
   * When provided along with `auth: true`, the caller-supplied AuthEnv is used
   * instead of creating a new one. Allows the caller to track and clean up
   * the temp npmrc directory via cleanupAuthEnv().
   */
  readonly authEnv?: AuthEnv;
}

export function getRootPackage(): PackageManifest {
  return JSON.parse(readFileSync(resolve(SDK_ROOT, 'package.json'), 'utf8'));
}

export function getRootVersion(): string {
  const version = getRootPackage().version;
  if (typeof version !== 'string') throw new Error('Root package version must be a string.');
  return version;
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function getPackageDirectoryPath(dir: string): string {
  return resolve(SDK_ROOT, dir);
}

export function getPackageJsonPath(dir: string): string {
  return resolve(getPackageDirectoryPath(dir), 'package.json');
}

export function readPackage(dir: string): PackageManifest {
  const value = readJson(getPackageJsonPath(dir));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Package JSON is not an object: ${dir}`);
  return value as PackageManifest;
}

export function getPublicPackageNameOverride(): string | null {
  const value = process.env.GOODVIBES_PUBLIC_PACKAGE_NAME?.trim();
  return value ? value : null;
}

export function getPublishRegistryOverride(): string | null {
  const value = process.env.GOODVIBES_PUBLISH_REGISTRY?.trim();
  return value ? value.replace(/\/+$/, '') : null;
}

export function isPublicPackageDir(dir: string): boolean {
  return publicPackageDirs.includes(dir);
}

function shouldCopyPath(path: string): boolean {
  const parts = path.split('/');
  return (
    !parts.some((p) => p === 'node_modules' || p === '.git' || p === 'coverage') &&
    !path.endsWith('.tsbuildinfo')
  );
}

function stageSdkSecurityMitigationAssets(stageDir: string): void {
  const vendorDir = resolve(stageDir, 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  rmSync(resolve(vendorDir, 'bash-language-server'), { recursive: true, force: true });
  cpSync(
    resolve(SDK_ROOT, 'vendor/bash-language-server'),
    resolve(vendorDir, 'bash-language-server'),
    { recursive: true },
  );
}

function normalizeDependencyGroup(group: unknown, rootVersion: string): unknown {
  if (!group || typeof group !== 'object') {
    return group;
  }
  const next: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(group)) {
    next[name] = typeof value === 'string' && value.startsWith('workspace:')
      ? rootVersion
      : value;
  }
  return next;
}

function addUniqueFiles(files: unknown, entries: readonly string[]): readonly string[] {
  const next = Array.isArray(files)
    ? files.filter((entry): entry is string => typeof entry === 'string')
    : [];
  for (const entry of entries) {
    if (!next.includes(entry)) next.push(entry);
  }
  return next;
}

function applySdkVendorMitigations(manifest: PackageManifest): PackageManifest {
  return {
    ...manifest,
    dependencies: omitPackageName(manifest.dependencies, 'bash-language-server'),
    optionalDependencies: {
      ...(manifest.optionalDependencies ?? {}),
      'bash-language-server': 'file:vendor/bash-language-server',
    },
    files: addUniqueFiles(manifest.files, [
      'vendor/bash-language-server',
    ]),
  };
}

function omitPackageName(group: unknown, name: string): unknown {
  if (!group || typeof group !== 'object') return group;
  const next = Object.fromEntries(Object.entries(group).filter(([entry]) => entry !== name));
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeRepository(repository: unknown): unknown {
  if (!repository || typeof repository !== 'object' || typeof (repository as { readonly url?: unknown }).url !== 'string') {
    return repository;
  }
  const record = repository as Record<string, unknown> & { readonly url: string };
  const url = record.url.startsWith('git+')
    ? record.url
    : record.url.endsWith('.git')
      ? `git+${record.url}`
      : `git+${record.url}.git`;
  return { ...record, url };
}

export function normalizeManifest(pkg: PackageManifest, rootVersion = getRootVersion()): PackageManifest {
  return {
    ...pkg,
    repository: normalizeRepository(pkg.repository),
    dependencies: normalizeDependencyGroup(pkg.dependencies, rootVersion),
    devDependencies: normalizeDependencyGroup(pkg.devDependencies, rootVersion),
    peerDependencies: normalizeDependencyGroup(pkg.peerDependencies, rootVersion),
    optionalDependencies: normalizeDependencyGroup(pkg.optionalDependencies, rootVersion),
  };
}

export function createSdkTempDir(prefix: string): string {
  mkdirSync(SDK_TEMP_ROOT, { recursive: true });
  return mkdtempSync(join(SDK_TEMP_ROOT, prefix));
}

export async function stagePackages(): Promise<{ readonly tempRoot: string; readonly stages: readonly PackageStage[]; readonly publicStages: readonly PackageStage[] }> {
  return withWorkspaceLock('stage packages', () => {
    const rootVersion = getRootVersion();
    const publicPackageNameOverride = getPublicPackageNameOverride();
    const tempRoot = createSdkTempDir('goodvibes-sdk-release-');
    const stages: PackageStage[] = [];
    for (const dir of packageDirs) {
      const sourceDir = getPackageDirectoryPath(dir);
      const stageDir = resolve(tempRoot, dir);
      cpSync(sourceDir, stageDir, { recursive: true, filter: shouldCopyPath });
      if (dir === 'packages/sdk') {
        stageSdkSecurityMitigationAssets(stageDir);
      }
      const manifest = normalizeManifest(readPackage(dir), rootVersion);
      if (dir === 'packages/sdk' && publicPackageNameOverride) {
        manifest.name = publicPackageNameOverride;
      }
      if (dir === 'packages/sdk') {
        Object.assign(manifest, applySdkVendorMitigations(manifest));
      }
      writeFileSync(resolve(stageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      stages.push({ dir, sourceDir, stageDir, manifest });
    }
    const publicStages = stages.filter((stage) => publicPackageDirs.includes(stage.dir));
    return { tempRoot, stages, publicStages };
  });
}

export function cleanupStage(tempRoot: string): void {
  rmSync(tempRoot, { recursive: true, force: true });
}

export function getRegistryHost(registryUrl: string): string {
  const normalized = (registryUrl || 'https://registry.npmjs.org').replace(/\/+$/, '');
  return new URL(normalized).host;
}

export function getAuthToken(registryUrl = 'https://registry.npmjs.org'): string | null {
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

function getPackageScope(packageName: unknown): string | null {
  if (typeof packageName !== 'string' || !packageName.startsWith('@')) {
    return null;
  }
  const slashIndex = packageName.indexOf('/');
  return slashIndex > 1 ? packageName.slice(0, slashIndex) : null;
}

export interface AuthEnv {
  /** The full process environment including auth token and npmrc config path. */
  readonly env: NodeJS.ProcessEnv;
  /** Absolute path to the temp npmrc directory created by createAuthEnv, or undefined if no token. */
  readonly tempDir?: string;
}

export function createAuthEnv(extraEnv: NodeJS.ProcessEnv = {}, options: { readonly registry?: string; readonly packageName?: string } = {}): AuthEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const registry = options.registry || 'https://registry.npmjs.org';
  const token = getAuthToken(registry);
  if (!token) {
    return { env: merged };
  }
  const registryHost = getRegistryHost(registry);
  const npmrcTempDir = createSdkTempDir('goodvibes-sdk-npmrc-');
  const userConfigPath = resolve(npmrcTempDir, '.npmrc');
  const npmrcLines = [`//${registryHost}/:_authToken=${token}`];
  const scope = getPackageScope(options.packageName);
  if (scope && registryHost !== 'registry.npmjs.org') {
    npmrcLines.push(`${scope}:registry=${registry}`);
  }
  writeFileSync(userConfigPath, `${npmrcLines.join('\n')}\n`);
  const env: NodeJS.ProcessEnv = {
    ...merged,
    NODE_AUTH_TOKEN: token,
    NPM_CONFIG_USERCONFIG: userConfigPath,
  };
  return { env, tempDir: npmrcTempDir };
}

export function cleanupAuthEnv(authEnv: AuthEnv): void {
  if (authEnv.tempDir) {
    rmSync(authEnv.tempDir, { recursive: true, force: true });
  }
}

// Security note: `command` and `args` are hardcoded caller-controlled literals ('npm', 'tar', 'node').
// `process.env` is inherited unfiltered. If process.env contains an attacker-controlled NODE_OPTIONS,
// NODE_PATH, npm_config_*, or PATH, the child process will inherit it. This is acceptable for
// developer-facing release tooling (not a public API), but callers must not pass untrusted env.
export function run(command: string, args: readonly string[], cwd: string, options: RunOptions = {}): string {
  const childEnv = options.auth
    ? (options.authEnv ?? createAuthEnv(options.env, {
      registry: options.registry,
      packageName: options.packageName,
    })).env
    : { ...process.env, ...options.env };
  return execFileSync(command, args, {
    cwd,
    env: childEnv,
    stdio: options.stdio ?? 'inherit',
    encoding: options.encoding ?? 'utf8',
  });
}

export function packStage(stageDir: string, packDestination: string): { readonly filename: string } {
  const output = run(
    'npm',
    ['pack', '--json', '--pack-destination', packDestination],
    stageDir,
    { stdio: 'pipe' },
  );
  return JSON.parse(output)[0];
}

export function inspectPackedManifest(tarballPath: string): PackageManifest {
  return JSON.parse(
    execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
}

export function listPackedFiles(tarballPath: string): string[] {
  return execFileSync('tar', ['-tf', tarballPath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function readPackedText(tarballPath: string, entryPath: string): string {
  return execFileSync('tar', ['-xOf', tarballPath, entryPath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

export function collectTarballs(packResults: readonly { readonly filename: string }[], packDestination: string): string[] {
  return packResults.map((result) => resolve(packDestination, result.filename));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assertChangelogSection(version: string, label: string): void {
  const changelogPath = resolve(SDK_ROOT, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  const headerPattern = new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\]`, 'm');
  if (headerPattern.test(changelog)) return;
  throw new Error(
    `[${label}] RELEASE BLOCKED: CHANGELOG.md is missing a section for v${version}.\n\n` +
    `  Add a section before publishing:\n\n` +
    `    ## [${version}] - YYYY-MM-DD\n` +
    `    ### Breaking\n` +
    `    ### Added\n` +
    `    ### Fixed\n` +
    `    ### Migration\n\n` +
    `  See docs/release-and-publishing.md for the Changelog Gate requirements.`,
  );
}
