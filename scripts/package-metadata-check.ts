import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageDirs, publicPackageDirs } from './release-shared.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const rootPackage = JSON.parse(readFileSync(resolve(SDK_ROOT, 'package.json'), 'utf8'));

const requiredStringFields = [
  'name',
  'version',
  'description',
  'license',
  'homepage',
];

const rootSharedMetadata = {
  license: rootPackage.license,
  homepage: rootPackage.homepage,
  repositoryUrl: rootPackage.repository?.url,
  bugsUrl: rootPackage.bugs?.url,
  engines: rootPackage.engines,
};

interface ExportEntry {
  readonly keyPath: string;
  readonly target?: string;
}

function collectExportEntries(value: unknown, keyPath = 'exports'): ExportEntry[] {
  if (typeof value === 'string') return [{ keyPath, target: value }];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => collectExportEntries(entry, `${keyPath}.${key}`));
}

function assertCleanExportEntry(dir: string, entry: ExportEntry): void {
  const values = [entry.keyPath, entry.target].filter((value): value is string => typeof value === 'string');
  if (values.some((value) => value.includes('*'))) {
    throw new Error(`${dir}/package.json must not use wildcard exports: ${entry.keyPath}${entry.target ? ` -> ${entry.target}` : ''}`);
  }
  const blockedSegmentPattern = /(^|[./])(?:_internal|internal|src)(?=$|[./])/;
  const blocked = values.find((value) => blockedSegmentPattern.test(value));
  if (blocked) {
    throw new Error(`${dir}/package.json must not expose internal/source paths: ${blocked}`);
  }
}

function resolveExportBackingPath(dir: string, target: string): string | null {
  if (target === './package.json') {
    return resolve(SDK_ROOT, dir, 'package.json');
  }
  if (target.startsWith('./artifacts/')) {
    return resolve(SDK_ROOT, dir, target);
  }
  if (!target.startsWith('./dist/')) {
    return null;
  }
  if (target.endsWith('.json')) {
    if (dir === 'packages/sdk' && target.startsWith('./dist/contracts/artifacts/')) {
      return resolve(SDK_ROOT, 'packages/contracts/artifacts', target.split('/').at(-1) ?? '');
    }
    return resolve(SDK_ROOT, dir, target);
  }
  if (target.endsWith('.js') || target.endsWith('.d.ts')) {
    const sourcePath = target
      .replace('./dist/', './src/')
      .replace(/\.d\.ts$/, '.ts')
      .replace(/\.js$/, '.ts');
    return resolve(SDK_ROOT, dir, sourcePath);
  }
  return null;
}

function assertExportTargetBacked(dir: string, entry: ExportEntry): void {
  if (!entry.target) return;
  const backingPath = resolveExportBackingPath(dir, entry.target);
  if (backingPath && !existsSync(backingPath)) {
    throw new Error(`${dir}/package.json export target is not backed by a source/artifact file: ${entry.keyPath} -> ${entry.target}`);
  }
}

function assertNoInternalManifestFields(dir: string, pkg: Record<string, unknown>): void {
  const internalFields = Object.keys(pkg).filter((key) => key.startsWith('_'));
  if (internalFields.length > 0) {
    throw new Error(`${dir}/package.json must not publish internal manifest fields: ${internalFields.join(', ')}`);
  }
}

function sdkExportKey(entrypoint: string): string {
  const packageName = '@pellux/goodvibes-sdk';
  if (entrypoint === packageName) return '.';
  if (entrypoint.startsWith(`${packageName}/`)) return `.${entrypoint.slice(packageName.length)}`;
  return entrypoint;
}

function assertSdkCapabilitiesExported(pkg: Record<string, unknown>): void {
  if (!pkg.exports || typeof pkg.exports !== 'object' || Array.isArray(pkg.exports)) return;
  const source = readFileSync(
    resolve(SDK_ROOT, 'packages/sdk/src/platform/node/capabilities.ts'),
    'utf8',
  );
  const entrypoints = new Set(
    [...source.matchAll(/'@pellux\/goodvibes-sdk(?:\/[^']*)?'/g)].map((match) => match[0].slice(1, -1)),
  );
  const exports = pkg.exports as Record<string, unknown>;
  const missing = [...entrypoints].map(sdkExportKey).filter((key) => !(key in exports));
  if (missing.length > 0) {
    throw new Error(`packages/sdk/package.json is missing exports declared by runtime capabilities: ${missing.join(', ')}`);
  }
}

function collectGeneratedFoundationTypeNames(): readonly string[] {
  const source = readFileSync(
    resolve(SDK_ROOT, 'packages/contracts/src/generated/foundation-client-types.ts'),
    'utf8',
  );
  return [...source.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z0-9_]+)/gm)].map((match) => match[1]);
}

function assertContractsGeneratedTypesReexported(): void {
  const source = readFileSync(resolve(SDK_ROOT, 'packages/contracts/src/index.ts'), 'utf8');
  const missing = collectGeneratedFoundationTypeNames().filter((name) => !new RegExp(`\\b${name}\\b`).test(source));
  if (missing.length > 0) {
    throw new Error(`packages/contracts/src/index.ts must re-export generated foundation client types: ${missing.join(', ')}`);
  }
}

function assertReadmePublicWording(dir: string, readme: string): void {
  if (!publicPackageDirs.includes(dir)) return;
  const stalePatterns = [
    /Internal workspace package backing/,
    /umbrella package/,
    /umbrella SDK/,
  ];
  const stale = stalePatterns.find((pattern) => pattern.test(readme));
  if (stale) {
    throw new Error(`${dir}/README.md contains stale public package wording: ${stale.source}`);
  }
}

for (const dir of packageDirs) {
  const pkg = JSON.parse(readFileSync(resolve(SDK_ROOT, dir, 'package.json'), 'utf8'));
  assertNoInternalManifestFields(dir, pkg);
  if (pkg.version !== rootPackage.version) {
    throw new Error(`${dir}/package.json version ${pkg.version} does not match root version ${rootPackage.version}`);
  }
  for (const field of requiredStringFields) {
    if (typeof pkg[field] !== 'string' || pkg[field].trim().length === 0) {
      throw new Error(`${dir}/package.json is missing required field: ${field}`);
    }
  }
  if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0) {
    throw new Error(`${dir}/package.json is missing keywords`);
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new Error(`${dir}/package.json is missing files`);
  }
  if (!pkg.repository || typeof pkg.repository.url !== 'string') {
    throw new Error(`${dir}/package.json is missing repository metadata`);
  }
  if (pkg.license !== rootSharedMetadata.license) {
    throw new Error(`${dir}/package.json license must match root package.json`);
  }
  if (pkg.homepage !== rootSharedMetadata.homepage) {
    throw new Error(`${dir}/package.json homepage must match root package.json`);
  }
  if (pkg.repository.url !== rootSharedMetadata.repositoryUrl) {
    throw new Error(`${dir}/package.json repository.url must match root package.json`);
  }
  if (!pkg.repository.url.startsWith('git+https://github.com/')) {
    throw new Error(`${dir}/package.json repository.url must use git+https://github.com/... form`);
  }
  if (!pkg.bugs || typeof pkg.bugs.url !== 'string') {
    throw new Error(`${dir}/package.json is missing bugs metadata`);
  }
  if (pkg.bugs.url !== rootSharedMetadata.bugsUrl) {
    throw new Error(`${dir}/package.json bugs.url must match root package.json`);
  }
  if (!pkg.engines || typeof pkg.engines !== 'object') {
    throw new Error(`${dir}/package.json is missing engines field`);
  }
  if (pkg.engines.bun !== rootSharedMetadata.engines?.bun) {
    throw new Error(`${dir}/package.json must declare engines.bun: ${JSON.stringify(rootSharedMetadata.engines?.bun)} (found: ${JSON.stringify(pkg.engines.bun)})`);
  }
  if (pkg.engines.node !== rootSharedMetadata.engines?.node) {
    throw new Error(`${dir}/package.json must declare engines.node: ${JSON.stringify(rootSharedMetadata.engines?.node)} (found: ${JSON.stringify(pkg.engines.node)})`);
  }
  const isPublic = publicPackageDirs.includes(dir);
  if (isPublic) {
    if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') {
      throw new Error(`${dir}/package.json must publish with access=public`);
    }
    if ('registry' in pkg.publishConfig) {
      throw new Error(`${dir}/package.json must not set publishConfig.registry; release tooling controls the npm registry`);
    }
    if (pkg.private === true) {
      throw new Error(`${dir}/package.json must not be private`);
    }
    if (Array.isArray(pkg.bundledDependencies) && pkg.bundledDependencies.length > 0) {
      throw new Error(`${dir}/package.json must not use bundledDependencies; keep package splits explicit instead`);
    }
  }
  if (!pkg.exports || typeof pkg.exports !== 'object') {
    throw new Error(`${dir}/package.json is missing exports`);
  }
  for (const entry of collectExportEntries(pkg.exports)) {
    assertCleanExportEntry(dir, entry);
    assertExportTargetBacked(dir, entry);
  }
  if (dir === 'packages/sdk') {
    assertSdkCapabilitiesExported(pkg);
  }
  const readmePath = resolve(SDK_ROOT, dir, 'README.md');
  if (!existsSync(readmePath)) {
    throw new Error(`${dir} is missing README.md`);
  }
  const readme = readFileSync(readmePath, 'utf8').trim();
  if (readme.length < 200) {
    throw new Error(`${dir}/README.md is too short to be considered package-level documentation`);
  }
  assertReadmePublicWording(dir, readme);
}

assertContractsGeneratedTypesReexported();

console.log('package metadata check passed');
