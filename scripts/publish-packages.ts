import {
  cleanupStage,
  getAuthToken,
  getPublishRegistryOverride,
  run,
  stagePackages,
} from './release-shared.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const USE_PROVENANCE = process.argv.includes('--provenance') || process.env.GITHUB_ACTIONS === 'true';
const REGISTRY = getPublishRegistryOverride() || 'https://registry.npmjs.org';
const SUPPORTS_PROVENANCE = REGISTRY === 'https://registry.npmjs.org';

function isPublished(name, version) {
  try {
    const output = run(
      'npm',
      ['view', `${name}@${version}`, 'version', '--registry', REGISTRY],
      process.cwd(),
      {
        auth: true,
        registry: REGISTRY,
        packageName: name,
        stdio: 'pipe',
      },
    ).trim();
    return output === version;
  } catch {
    return false;
  }
}

if (!DRY_RUN && !getAuthToken(REGISTRY)) {
  throw new Error(`No publish token available for ${REGISTRY}.`);
}

const { tempRoot, publicStages } = stagePackages();

try {
  for (const stage of publicStages) {
    if (!DRY_RUN && isPublished(stage.manifest.name, stage.manifest.version)) {
      console.log(`Skipping ${stage.manifest.name}@${stage.manifest.version}; already published.`);
      continue;
    }

    const args = ['publish', '--access', 'public', '--registry', REGISTRY];
    if (USE_PROVENANCE && SUPPORTS_PROVENANCE) {
      args.push('--provenance');
    }
    if (DRY_RUN) {
      args.push('--dry-run');
    }

    console.log(
      `${DRY_RUN ? 'Dry-running' : 'Publishing'} ${stage.manifest.name}@${stage.manifest.version} -> ${REGISTRY}`,
    );
    run('npm', args, stage.stageDir, {
      auth: true,
      registry: REGISTRY,
      packageName: stage.manifest.name,
    });
  }
} finally {
  cleanupStage(tempRoot);
}
