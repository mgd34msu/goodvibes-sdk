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

interface PublishedState {
  readonly packageName: string;
  readonly version: string;
  readonly published: boolean;
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

function getPublishedState(options: VerifyPublishedOptions): PublishedState[] {
  return publicPackageDirs.map((dir) => {
    const packageName = packageNameForDir(dir);
    return {
      packageName,
      version: options.version,
      published: readPublishedVersion(packageName, options) === options.version,
    };
  });
}

function assertRegistryEmptyOrComplete(options: VerifyPublishedOptions): void {
  const states = getPublishedState(options);
  const published = states.filter((state) => state.published);
  if (published.length === 0 || published.length === states.length) {
    const label = published.length === 0 ? 'empty' : 'complete';
    console.log(`prepublish registry state OK for ${options.registry}: ${label} for ${options.version}`);
    return;
  }

  const missing = states.filter((state) => !state.published);
  throw new Error(
    `Prepublish registry state is partial for ${options.version} in ${options.registry}.\n`
    + `Already published: ${published.map((state) => `${state.packageName}@${state.version}`).join(', ')}\n`
    + `Missing: ${missing.map((state) => `${state.packageName}@${state.version}`).join(', ')}\n`
    + 'Refusing to publish into a partial monorepo split release state.',
  );
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
  if (process.argv.includes('--prepublish-empty-or-complete')) {
    assertRegistryEmptyOrComplete(options);
  } else {
    await verifyPublishedPackages(options);
  }
}
