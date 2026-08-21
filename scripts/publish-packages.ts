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

/**
 * `authEnv` is null on the dry-run path, which must not consult publish tokens.
 * `npm view` on a public package needs no credentials, so the same question is
 * answerable either way; a network or lookup failure returns false and the
 * caller proceeds exactly as it did before this check existed.
 */
function isPublished(name: string, version: string, authEnv: AuthEnv | null): boolean {
  try {
    const output = run(
      'npm',
      ['view', `${name}@${version}`, 'version', '--registry', REGISTRY],
      process.cwd(),
      {
        auth: authEnv !== null,
        registry: REGISTRY,
        packageName: name,
        stdio: 'pipe',
        ...(authEnv ? { authEnv } : {}),
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
  console.log(`[publish] changelog-check OK, CHANGELOG.md contains section for v${version}`);
})();

const { tempRoot, publicStages } = await stagePackages();

// Create a single shared auth env for real publish calls so that the temp
// npmrc directory can be reliably cleaned up in the finally block. Dry-runs
// must not create auth files or consult publish tokens.
const sharedAuthEnv: AuthEnv | null = DRY_RUN
  ? null
  : createAuthEnv({}, { registry: REGISTRY });

let packOnlyCount = 0;
let fullRehearsalCount = 0;

try {
  for (const stage of publicStages) {
    const packageName = stage.manifest.name;
    const packageVersion = stage.manifest.version;
    if (typeof packageName !== 'string' || typeof packageVersion !== 'string') {
      throw new Error(`Staged package ${stage.dir} is missing a string name/version.`);
    }
    if (!DRY_RUN) {
      if (!sharedAuthEnv) throw new Error('Publish auth environment was not initialized.');
      if (isPublished(packageName, packageVersion, sharedAuthEnv)) {
        console.log(`Skipping ${packageName}@${packageVersion}; already published.`);
        continue;
      }
    } else if (isPublished(packageName, packageVersion, null)) {
      // `npm publish --dry-run` does two things: it assembles the tarball, and
      // it asks the registry whether the publish would be allowed. The second
      // one is a hard error for a version that already exists, so the dry run
      // failed on a state the REAL publish handles fine, by skipping it a few
      // lines up. A rehearsal that is stricter than the performance is a broken
      // rehearsal: it made the pre-publish chain unpassable on any branch
      // sitting at an already-released version, which is exactly where a
      // release train stands before its version bump.
      //
      // So run the half that still means something. `npm pack --dry-run`
      // assembles the same tarball from the same staged, normalized manifest
      // and fails on the same packing faults; only the registry precondition,
      // the part whose answer is already known, is skipped. This is not a
      // no-op: every package still gets its tarball built and its file list
      // checked, and the count is reported below so a fully-skipped run can
      // never read as a fully-rehearsed one.
      console.log(
        `Dry-run: ${packageName}@${packageVersion} is already on ${REGISTRY}, packing only, registry precondition not applicable.`,
      );
      run('npm', ['pack', '--dry-run'], stage.stageDir, {
        auth: false,
        registry: REGISTRY,
        packageName,
      });
      packOnlyCount += 1;
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
      auth: !DRY_RUN,
      registry: REGISTRY,
      packageName,
      ...(sharedAuthEnv ? { authEnv: sharedAuthEnv } : {}),
    });
    if (DRY_RUN) fullRehearsalCount += 1;
  }
} finally {
  if (sharedAuthEnv) cleanupAuthEnv(sharedAuthEnv);
  cleanupStage(tempRoot);
}

if (DRY_RUN) {
  console.log(
    `[publish] dry-run summary: ${publicStages.length} public package(s), ` +
      `${fullRehearsalCount} full publish rehearsal(s), ${packOnlyCount} pack-only ` +
      `(version already on ${REGISTRY}).`,
  );
}
