import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cleanupStage,
  getAuthToken,
  getPublishRegistryOverride,
  run,
  stagePackages,
  SDK_ROOT,
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

// Changelog gate: must have a CHANGELOG.md section for the version being published.
// Runs before any staging so the failure is fast and clear.
(function checkChangelog() {
  const changelogPath = resolve(SDK_ROOT, 'CHANGELOG.md');
  const sdkPkgPath = resolve(SDK_ROOT, 'packages/sdk/package.json');

  if (!existsSync(changelogPath)) {
    throw new Error(
      `[publish] RELEASE BLOCKED: CHANGELOG.md not found at ${changelogPath}.\n` +
      `  Create it with a ## [X.Y.Z] section matching the SDK version before publishing.`,
    );
  }

  const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, 'utf8'));
  const version: string = sdkPkg.version;
  const changelog = readFileSync(changelogPath, 'utf8');
  const headerPattern = new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`, 'm');

  if (!headerPattern.test(changelog)) {
    throw new Error(
      `[publish] RELEASE BLOCKED: CHANGELOG.md is missing a section for v${version}.\n\n` +
      `  Add a section before publishing:\n\n` +
      `    ## [${version}] - YYYY-MM-DD\n` +
      `    ### Breaking\n` +
      `    ### Added\n` +
      `    ### Fixed\n` +
      `    ### Migration\n\n` +
      `  Run: bun run changelog:check\n` +
      `  See: docs/release-and-publishing.md`,
    );
  }

  console.log(`[publish] changelog-check OK — CHANGELOG.md contains section for v${version}`);
})();

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
