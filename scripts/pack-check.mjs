import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  cleanupStage,
  collectTarballs,
  inspectPackedManifest,
  packStage,
  stagePackages,
} from './release-shared.mjs';

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

const { tempRoot, stages } = stagePackages();

try {
  const packDestination = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-pack-'));
  const packResults = stages.map((stage) => packStage(stage.stageDir, packDestination));
  const tarballs = collectTarballs(packResults, packDestination);
  tarballs.forEach((tarball) => {
    const manifest = inspectPackedManifest(resolve(tarball));
    assertNoWorkspaceRanges(manifest, tarball);
  });
  console.log('pack check passed');
} finally {
  cleanupStage(tempRoot);
}
