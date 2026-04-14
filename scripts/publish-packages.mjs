import {
  cleanupStage,
  getAuthToken,
  run,
  stagePackages,
} from './release-shared.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const USE_PROVENANCE = process.argv.includes('--provenance') || process.env.GITHUB_ACTIONS === 'true';

function isPublished(name, version) {
  try {
    const output = run(
      'npm',
      ['view', `${name}@${version}`, 'version'],
      process.cwd(),
      {
        auth: true,
        stdio: 'pipe',
      },
    ).trim();
    return output === version;
  } catch {
    return false;
  }
}

if (!DRY_RUN && !getAuthToken()) {
  throw new Error('NODE_AUTH_TOKEN or NPM_TOKEN is required for publishing.');
}

const { tempRoot, stages } = stagePackages();

try {
  for (const stage of stages) {
    if (!DRY_RUN && isPublished(stage.manifest.name, stage.manifest.version)) {
      console.log(`Skipping ${stage.manifest.name}@${stage.manifest.version}; already published.`);
      continue;
    }

    const args = ['publish', '--access', 'public'];
    if (USE_PROVENANCE) {
      args.push('--provenance');
    }
    if (DRY_RUN) {
      args.push('--dry-run');
    }

    console.log(`${DRY_RUN ? 'Dry-running' : 'Publishing'} ${stage.manifest.name}@${stage.manifest.version}`);
    run('npm', args, stage.stageDir, { auth: true });
  }
} finally {
  cleanupStage(tempRoot);
}
