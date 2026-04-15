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

function assertNoWorkspaceRanges(manifest, label) {
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

const forbiddenSpecifiers = [
  '@pellux/goodvibes-contracts',
  '@pellux/goodvibes-daemon-sdk',
  '@pellux/goodvibes-errors',
  '@pellux/goodvibes-operator-sdk',
  '@pellux/goodvibes-peer-sdk',
  '@pellux/goodvibes-transport-core',
  '@pellux/goodvibes-transport-direct',
  '@pellux/goodvibes-transport-http',
  '@pellux/goodvibes-transport-realtime',
];

function assertFlatPackageLayout(tarball, files) {
  const leakedEntries = files.filter((file) => file.startsWith('package/node_modules/'));
  if (leakedEntries.length > 0) {
    throw new Error(`${tarball} contains nested node_modules entries: ${leakedEntries.slice(0, 5).join(', ')}`);
  }
}

function assertNoLeakedInternalImports(tarball, files) {
  const distFiles = files.filter(
    (file) => file.startsWith('package/dist/') && (file.endsWith('.js') || file.endsWith('.d.ts')),
  );
  for (const file of distFiles) {
    const content = readPackedText(tarball, file);
    for (const specifier of forbiddenSpecifiers) {
      if (content.includes(specifier)) {
        throw new Error(`${tarball} still references internal workspace specifier ${specifier} in ${file}`);
      }
    }
  }
}

const { tempRoot, publicStages } = stagePackages();

try {
  const packDestination = createSdkTempDir('goodvibes-sdk-pack-');
  const packResults = publicStages
    .filter((stage) => stage.dir === 'packages/sdk')
    .map((stage) => packStage(stage.stageDir, packDestination));
  const tarballs = collectTarballs(packResults, packDestination);
  tarballs.forEach((tarball) => {
    const manifest = inspectPackedManifest(resolve(tarball));
    assertNoWorkspaceRanges(manifest, tarball);
    const files = listPackedFiles(resolve(tarball));
    assertFlatPackageLayout(tarball, files);
    assertNoLeakedInternalImports(tarball, files);
  });
  console.log('pack check passed');
} finally {
  cleanupStage(tempRoot);
}
