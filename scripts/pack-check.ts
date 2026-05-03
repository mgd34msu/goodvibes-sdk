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
  readonly peerDependencies?: Record<string, unknown>;
  readonly optionalDependencies?: Record<string, unknown>;
  readonly scripts?: Record<string, unknown>;
};

function assertNoWorkspaceRanges(manifest: PackageManifestLike, label: string): void {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
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

const sourceOfTruthSpecifiers = [
  '@pellux/goodvibes-contracts',
  '@pellux/goodvibes-daemon-sdk',
  '@pellux/goodvibes-errors',
  '@pellux/goodvibes-operator-sdk',
  '@pellux/goodvibes-peer-sdk',
  '@pellux/goodvibes-transport-core',
  '@pellux/goodvibes-transport-http',
  '@pellux/goodvibes-transport-realtime',
];

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

function assertFacadeImportsAreDeclared(
  tarball: string,
  files: readonly string[],
  manifest: PackageManifestLike,
): void {
  const distFiles = files.filter(
    (file) => file.startsWith('package/dist/') && (file.endsWith('.js') || file.endsWith('.d.ts')),
  );
  for (const file of distFiles) {
    const content = readPackedText(tarball, file);
    for (const specifier of sourceOfTruthSpecifiers) {
      if (content.includes(specifier) && manifest.dependencies?.[specifier] === undefined) {
        throw new Error(`${tarball} references source package ${specifier} in ${file} but does not declare it as a dependency`);
      }
    }
  }
}

const { tempRoot, publicStages } = await stagePackages();

try {
  const packDestination = createSdkTempDir('goodvibes-sdk-pack-');
  const packResults = publicStages
    .filter((stage) => stage.dir === 'packages/sdk')
    .map((stage) => packStage(stage.stageDir, packDestination));
  const tarballs = collectTarballs(packResults, packDestination);
  tarballs.forEach((tarball) => {
    const manifest = inspectPackedManifest(resolve(tarball));
    assertNoWorkspaceRanges(manifest, tarball);
    assertBundledBashLspMitigationManifest(manifest, tarball);
    const files = listPackedFiles(resolve(tarball));
    assertFlatPackageLayout(tarball, files);
    assertSecurityMitigationAssets(tarball, files);
    assertBundledBashLspPatchManifest(resolve(tarball));
    assertFacadeImportsAreDeclared(tarball, files, manifest);
  });
  console.log('pack check passed');
} finally {
  cleanupStage(tempRoot);
}
