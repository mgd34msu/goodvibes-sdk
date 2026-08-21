import {
  getPublishRegistryOverride,
  publicPackageDirs,
  getRootVersion,
  readPackage,
  run,
} from './release-shared.ts';

interface VerifyPublishedOptions {
  readonly version: string;
  readonly registry: string;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}

export interface PublishedState {
  readonly packageName: string;
  /** Version the registry reports for `packageName@<version being cut>`, or null when absent. */
  readonly publishedVersion: string | null;
  /**
   * `gitHead` the registry holds for that published version, or null when the
   * package is not published at this version or the registry carries no
   * gitHead for it. Only meaningful when `publishedVersion` matches.
   */
  readonly gitHead: string | null;
}

export type PrepublishDecisionKind = 'empty' | 'complete' | 'resume' | 'refuse';

export interface PrepublishDecision {
  readonly kind: PrepublishDecisionKind;
  readonly message: string;
  /** Non-fatal findings the caller must print (an absent gitHead is one). */
  readonly warnings: readonly string[];
}

type CommandError = Error & {
  readonly stderr?: Buffer | string;
  readonly stdout?: Buffer | string;
};

function packageNameForDir(dir: string): string {
  const pkg = readPackage(dir);
  const name = pkg.name;
  if (typeof name !== 'string' || !name) throw new Error(`Package ${dir} is missing a string name.`);
  return name;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function parsePositiveIntegerEnv(name: string, fallback: string): number {
  const raw = process.env[name] || fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return value;
}

function readVerifyPublishedOptions(): VerifyPublishedOptions {
  const versionArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const options = {
    version: versionArg || getRootVersion(),
    registry: getPublishRegistryOverride() || 'https://registry.npmjs.org',
    maxAttempts: parsePositiveIntegerEnv('GOODVIBES_VERIFY_ATTEMPTS', '48'),
    retryDelayMs: parsePositiveIntegerEnv('GOODVIBES_VERIFY_DELAY_MS', '5000'),
  };
  return options;
}

function commandErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const commandError = error as CommandError;
  return [
    commandError.message,
    commandError.stderr?.toString(),
    commandError.stdout?.toString(),
  ].filter(Boolean).join('\n');
}

function isMissingPublishedVersionError(error: unknown): boolean {
  const text = commandErrorText(error);
  return /\b(?:E404|ETARGET)\b/.test(text)
    || /No match found for version/i.test(text)
    || /No matching version found/i.test(text)
    || /is not in this registry/i.test(text);
}

function readPublishedVersion(packageName: string, options: VerifyPublishedOptions): string | null {
  try {
    const publishedVersion = run(
      'npm',
      ['view', `${packageName}@${options.version}`, 'version', '--registry', options.registry],
      process.cwd(),
      {
        auth: true,
        registry: options.registry,
        packageName,
        stdio: 'pipe',
      },
    ).trim();

    return publishedVersion || null;
  } catch (error) {
    if (isMissingPublishedVersionError(error)) {
      return null;
    }
    throw new Error(
      `Failed to read ${packageName}@${options.version} from ${options.registry}; refusing to treat the registry as empty.\n`
      + commandErrorText(error),
    );
  }
}

/**
 * The `gitHead` the registry holds for an already-published version.
 *
 * Absent is normal, not exceptional: npm records gitHead only when it can read
 * a git repo from the directory it packs, and this release publishes from a
 * staged copy in a temp directory. A registry response with no gitHead field
 * prints nothing and exits 0, which is why an empty read is null rather than an
 * error.
 */
function readPublishedGitHead(packageName: string, options: VerifyPublishedOptions): string | null {
  try {
    const gitHead = run(
      'npm',
      ['view', `${packageName}@${options.version}`, 'gitHead', '--registry', options.registry],
      process.cwd(),
      {
        auth: true,
        registry: options.registry,
        packageName,
        stdio: 'pipe',
      },
    ).trim();
    return gitHead || null;
  } catch (error) {
    if (isMissingPublishedVersionError(error)) return null;
    throw new Error(
      `Failed to read gitHead for ${packageName}@${options.version} from ${options.registry}.\n`
      + commandErrorText(error),
    );
  }
}

function getPublishedState(options: VerifyPublishedOptions): PublishedState[] {
  return publicPackageDirs.map((dir) => {
    const packageName = packageNameForDir(dir);
    const publishedVersion = readPublishedVersion(packageName, options);
    // Only a package that IS published at this version has a gitHead worth
    // asking about, so the extra registry round-trip is skipped entirely on the
    // common empty-registry path.
    const gitHead = publishedVersion === options.version
      ? readPublishedGitHead(packageName, options)
      : null;
    return { packageName, publishedVersion, gitHead };
  });
}

// ---------------------------------------------------------------------------
// Prepublish registry-state decision
// ---------------------------------------------------------------------------

/**
 * Decide whether the publish loop may run against the registry state it found.
 *
 * A partial state at EXACTLY the version being cut is the shape a mid-loop
 * publish failure leaves behind (say 6 of 11 packages up), and it is exactly
 * what `scripts/publish-packages.ts` converges: its per-package `isPublished`
 * skip means a re-run finishes the remaining packages and touches none of the
 * ones already up. Refusing that state permanently wedged the release, the
 * only way forward was a hand-cut version bump.
 *
 * What separates a genuine resume from a dangerous partial is not the version
 * string. `npm view <name>@<version> version` pins the version in the query, so
 * it can only echo that version back or 404; a "different version" answer is
 * not a state that exists. The discriminator that can actually fire is the
 * COMMIT: `gitHead` on the published version versus the SHA this run is
 * releasing.
 *
 *   - every gitHead present and equal to `releaseSha`: the same release,
 *     resumed. Proceed.
 *   - any gitHead present and different: some other run, or a force-moved tag,
 *     published this version from another commit. Hard refuse, naming the
 *     package and both SHAs, because finishing the remaining packages would
 *     ship a version assembled from two different trees.
 *   - gitHead absent: npm records it only when it can read a git repo from the
 *     directory it packs, and this release publishes from a staged copy in a
 *     temp directory, so absence is the EXPECTED reading here rather than a
 *     red flag. Warn loudly, naming the packages, and treat it as a resume:
 *     a check that cannot see the commit must not manufacture a refusal, which
 *     would restore exactly the wedge this function exists to remove.
 *   - `releaseSha` unknown (a local run with no SHA in the environment): same
 *     posture as an absent gitHead, warn and resume.
 *
 * Pure so the decision is testable without a registry; the caller supplies the
 * observed state and the SHA being released.
 */
export function classifyPrepublishRegistryState(
  states: readonly PublishedState[],
  version: string,
  registry: string,
  releaseSha: string | null,
): PrepublishDecision {
  const published = states.filter((state) => state.publishedVersion === version);
  if (published.length === 0) {
    return {
      kind: 'empty',
      message: `prepublish registry state OK for ${registry}: empty for ${version}`,
      warnings: [],
    };
  }

  if (releaseSha) {
    const mismatched = published.filter((state) => state.gitHead !== null && state.gitHead !== releaseSha);
    if (mismatched.length > 0) {
      return {
        kind: 'refuse',
        message:
          `${version} is already published in ${registry} from a DIFFERENT commit.\n`
          + mismatched
            .map((state) => `  ${state.packageName}@${version}: published from ${state.gitHead}, this run is releasing ${releaseSha}`)
            .join('\n')
          + `\nFinishing the remaining packages would ship ${version} assembled from two different trees.\n`
          + 'Another release run, or a force-moved tag, owns this version. Cut a new version instead.',
        warnings: [],
      };
    }
  }

  const warnings: string[] = [];
  const headless = published.filter((state) => state.gitHead === null);
  if (!releaseSha) {
    warnings.push(
      `No release SHA available (set GOODVIBES_RELEASE_SHA or GITHUB_SHA), so the already-published ${version} package(s) `
      + 'could not be confirmed to come from this commit. Proceeding on the version match alone.',
    );
  } else if (headless.length > 0) {
    warnings.push(
      `The registry carries no gitHead for ${headless.map((state) => `${state.packageName}@${version}`).join(', ')}, `
      + `so they could not be confirmed to come from ${releaseSha}. npm omits gitHead when the packed directory is not a `
      + 'git checkout, which is the normal case for this release (it publishes from a staged temp copy). Proceeding.',
    );
  }

  if (published.length === states.length) {
    return {
      kind: 'complete',
      message: `prepublish registry state OK for ${registry}: complete for ${version}`,
      warnings,
    };
  }

  const remaining = states.filter((state) => state.publishedVersion !== version);
  return {
    kind: 'resume',
    message:
      `prepublish registry state is a RESUMABLE partial for ${version} in ${registry}.\n`
      + `Already published (the publish loop will skip these): ${published.map((state) => `${state.packageName}@${version}`).join(', ')}\n`
      + `Still to publish: ${remaining.map((state) => `${state.packageName}@${version}`).join(', ')}\n`
      + 'Nothing published at this version came from another commit, so this is a resumed run of the same release; proceeding.',
    warnings,
  };
}

/** The commit this run is releasing, for the gitHead comparison. */
function readReleaseSha(): string | null {
  const sha = process.env['GOODVIBES_RELEASE_SHA'] || process.env['GITHUB_SHA'];
  return sha ? sha.trim() : null;
}

function checkPrepublishRegistryState(options: VerifyPublishedOptions): void {
  const decision = classifyPrepublishRegistryState(
    getPublishedState(options),
    options.version,
    options.registry,
    readReleaseSha(),
  );
  for (const warning of decision.warnings) {
    console.warn(`[prepublish] WARNING: ${warning}`);
  }
  if (decision.kind === 'refuse') {
    throw new Error(decision.message);
  }
  console.log(decision.message);
}

async function verifyPublishedVersion(packageName: string, options: VerifyPublishedOptions) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const publishedVersion = readPublishedVersion(packageName, options);
      if (publishedVersion !== options.version) {
        throw new Error(`Expected ${packageName}@${options.version} in ${options.registry}, got ${publishedVersion || 'missing'}`);
      }
      console.log(`registry verification passed for ${packageName}@${options.version} in ${options.registry}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === options.maxAttempts) {
        break;
      }
      console.warn(
        `registry verification not ready for ${packageName}@${options.version} in ${options.registry} `
        + `(attempt ${attempt}/${options.maxAttempts}); retrying in ${options.retryDelayMs}ms`,
      );
      await sleep(options.retryDelayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to verify ${packageName}@${options.version} in ${options.registry}`);
}

export async function verifyPublishedPackages(options = readVerifyPublishedOptions()): Promise<void> {
  for (const dir of publicPackageDirs) {
    await verifyPublishedVersion(packageNameForDir(dir), options);
  }
}

if (import.meta.main) {
  const options = readVerifyPublishedOptions();
  // `--prepublish-empty-or-complete` is the pre-resume spelling, still accepted
  // so an older workflow revision keeps working.
  if (
    process.argv.includes('--prepublish-registry-state')
    || process.argv.includes('--prepublish-empty-or-complete')
  ) {
    checkPrepublishRegistryState(options);
  } else {
    await verifyPublishedPackages(options);
  }
}
