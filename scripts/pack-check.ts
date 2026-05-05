import { resolve } from 'node:path';

import {
  cleanupStage,
  collectTarballs,
  createSdkTempDir,
  inspectPackedManifest,
  listPackedFiles,
  packStage,
  readPackedText,
  stagePackages,
} from './release-shared.ts';

type PackageManifestLike = Record<string, unknown> & {
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
  readonly exports?: unknown;
  readonly peerDependencies?: Record<string, unknown>;
  readonly optionalDependencies?: Record<string, unknown>;
  readonly scripts?: Record<string, unknown>;
};

function assertNoWorkspaceRanges(manifest: PackageManifestLike, label: string): void {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const group = manifest[field];
    if (!group || typeof group !== 'object') {
      continue;
    }
    for (const [name, value] of Object.entries(group)) {
      if (typeof value === 'string' && value.startsWith('workspace:')) {
        throw new Error(`${label} contains unresolved workspace dependency ${field}.${name}=${value}`);
      }
    }
  }
}

function assertBundledBashLspMitigationManifest(manifest: PackageManifestLike, label: string): void {
  if (manifest.optionalDependencies?.['bash-language-server'] !== 'file:vendor/bash-language-server') {
    throw new Error(`${label} must publish the vendored bash-language-server mitigation`);
  }
  if (manifest.dependencies?.['bash-language-server'] !== undefined) {
    throw new Error(`${label} must not duplicate bash-language-server in dependencies`);
  }
}

function assertBundledBashLspPatchManifest(tarball: string): void {
  const manifest = JSON.parse(readPackedText(tarball, 'package/vendor/bash-language-server/package.json')) as PackageManifestLike & {
    readonly goodvibesPatch?: { readonly source?: unknown };
  };
  if (manifest.dependencies?.editorconfig !== '3.0.2') {
    throw new Error(`${tarball} vendored bash-language-server must pin editorconfig@3.0.2`);
  }
  if ('prepublishOnly' in (manifest.scripts ?? {})) {
    throw new Error(`${tarball} vendored bash-language-server must not ship prepublishOnly`);
  }
  if (manifest.goodvibesPatch?.source !== 'bash-language-server@5.6.0') {
    throw new Error(`${tarball} vendored bash-language-server is missing GoodVibes patch provenance`);
  }
}

function isSdkPackage(manifest: PackageManifestLike): boolean {
  return typeof manifest.name === 'string'
    && (manifest.name === 'goodvibes-sdk' || manifest.name.endsWith('/goodvibes-sdk'));
}

function assertFlatPackageLayout(tarball: string, files: readonly string[]): void {
  const leakedEntries = files.filter((file) => file.startsWith('package/node_modules/'));
  if (leakedEntries.length > 0) {
    throw new Error(`${tarball} contains nested node_modules entries: ${leakedEntries.slice(0, 5).join(', ')}`);
  }
}

function assertSecurityMitigationAssets(tarball: string, files: readonly string[]): void {
  const requiredEntries = [
    'package/vendor/bash-language-server/package.json',
    'package/vendor/bash-language-server/GOODVIBES_PATCH.md',
    'package/vendor/bash-language-server/out/cli.js',
    'package/vendor/bash-language-server/tree-sitter-bash.wasm',
  ];
  const missing = requiredEntries.filter((entry) => !files.includes(entry));
  if (missing.length > 0) {
    throw new Error(`${tarball} is missing security mitigation asset(s): ${missing.join(', ')}`);
  }
}

function assertExportTargetsExist(
  tarball: string,
  files: readonly string[],
  manifest: PackageManifestLike,
): void {
  for (const target of collectConcreteExportTargets(manifest.exports)) {
    const packedPath = `package/${target.slice(2)}`;
    if (!files.includes(packedPath)) {
      throw new Error(`${tarball} export target ${target} is missing from the packed package`);
    }
  }
}

function collectConcreteExportTargets(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.startsWith('./') && !value.includes('*') ? [value] : [];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.values(value).flatMap((entry) => collectConcreteExportTargets(entry));
}

function assertFacadeImportsAreDeclared(
  tarball: string,
  files: readonly string[],
  manifest: PackageManifestLike,
  packageSpecifiers: readonly string[],
): void {
  const distFiles = files.filter(
    (file) => file.startsWith('package/dist/') && (file.endsWith('.js') || file.endsWith('.d.ts')),
  );
  for (const file of distFiles) {
    const content = readPackedText(tarball, file);
    for (const specifier of packageSpecifiers) {
      if (specifier === manifest.name) continue;
      if (referencesPackageSpecifier(content, specifier) && manifest.dependencies?.[specifier] === undefined) {
        throw new Error(`${tarball} references source package ${specifier} in ${file} but does not declare it as a dependency`);
      }
    }
  }
}

function referencesPackageSpecifier(content: string, specifier: string): boolean {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:from|import)\\s*\\(?\\s*['"]${escaped}(?:/[^'"]*)?['"]`).test(content)
    || new RegExp(`\\brequire\\(\\s*['"]${escaped}(?:/[^'"]*)?['"]\\s*\\)`).test(content);
}

const { tempRoot, publicStages } = await stagePackages();
const packDestination = createSdkTempDir('goodvibes-sdk-pack-');

try {
  const packageSpecifiers = publicStages
    .map((stage) => stage.manifest.name)
    .filter((name): name is string => typeof name === 'string' && !name.endsWith('/goodvibes-sdk'));
  const packResults = publicStages.map((stage) => packStage(stage.stageDir, packDestination));
  const tarballs = collectTarballs(packResults, packDestination);
  tarballs.forEach((tarball) => {
    const manifest = inspectPackedManifest(resolve(tarball));
    assertNoWorkspaceRanges(manifest, tarball);
    const files = listPackedFiles(resolve(tarball));
    assertFlatPackageLayout(tarball, files);
    assertExportTargetsExist(tarball, files, manifest);
    if (isSdkPackage(manifest)) {
      assertBundledBashLspMitigationManifest(manifest, tarball);
      assertSecurityMitigationAssets(tarball, files);
      assertBundledBashLspPatchManifest(resolve(tarball));
    }
    assertFacadeImportsAreDeclared(tarball, files, manifest, packageSpecifiers);
  });
  console.log('pack check passed');
} finally {
  cleanupStage(packDestination);
  cleanupStage(tempRoot);
}
