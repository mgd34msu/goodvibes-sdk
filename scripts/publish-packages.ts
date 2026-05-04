import {
  type AuthEnv,
  assertChangelogSection,
  cleanupAuthEnv,
  cleanupStage,
  createAuthEnv,
  getAuthToken,
  getPublishRegistryOverride,
  readPackage,
  run,
  stagePackages,
} from './release-shared.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const USE_PROVENANCE = process.argv.includes('--provenance') || process.env.GITHUB_ACTIONS === 'true';
const REGISTRY = getPublishRegistryOverride() || 'https://registry.npmjs.org';
const SUPPORTS_PROVENANCE = REGISTRY === 'https://registry.npmjs.org';

function isPublished(name: string, version: string): boolean {
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

// Changelog gate: must have a CHANGELOG.md section for the version being published.
// Runs before any staging so the failure is fast and clear.
(function checkChangelog() {
  const version = readPackage('packages/sdk').version;
  if (typeof version !== 'string' || !version) {
    throw new Error('[publish] RELEASE BLOCKED: packages/sdk/package.json is missing a string version.');
  }
  assertChangelogSection(version, 'publish');
  console.log(`[publish] changelog-check OK — CHANGELOG.md contains section for v${version}`);
})();

const { tempRoot, publicStages } = await stagePackages();

// Create a single shared auth env for all publish calls in this run so that
// the temp npmrc directory can be reliably cleaned up in the finally block.
const sharedAuthEnv: AuthEnv = createAuthEnv({}, { registry: REGISTRY });

try {
  for (const stage of publicStages) {
    const packageName = stage.manifest.name;
    const packageVersion = stage.manifest.version;
    if (typeof packageName !== 'string' || typeof packageVersion !== 'string') {
      throw new Error(`Staged package ${stage.dir} is missing a string name/version.`);
    }
    if (!DRY_RUN && isPublished(packageName, packageVersion)) {
      console.log(`Skipping ${packageName}@${packageVersion}; already published.`);
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
      `${DRY_RUN ? 'Dry-running' : 'Publishing'} ${packageName}@${packageVersion} -> ${REGISTRY}`,
    );
    run('npm', args, stage.stageDir, {
      auth: true,
      registry: REGISTRY,
      packageName,
      authEnv: sharedAuthEnv,
    });
  }
} finally {
  cleanupAuthEnv(sharedAuthEnv);
  cleanupStage(tempRoot);
}
