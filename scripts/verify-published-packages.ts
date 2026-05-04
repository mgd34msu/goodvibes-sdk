import {
  getPublicPackageNameOverride,
  getPublishRegistryOverride,
  publicPackageDirs,
  getRootVersion,
  readPackage,
  run,
} from './release-shared.ts';

// Env-var validation runs only when this script is the entry point so that
// test discovery or type-checking tools importing the module do not throw.
if (!import.meta.main) {
  throw new Error('verify-published-packages.ts must be run as a script, not imported as a module.');
}

const version = process.argv[2] || getRootVersion();
const registry = getPublishRegistryOverride() || 'https://registry.npmjs.org';
const rawAttempts = process.env.GOODVIBES_VERIFY_ATTEMPTS || '48';
const rawDelay = process.env.GOODVIBES_VERIFY_DELAY_MS || '5000';
if (!/^\d+$/.test(rawAttempts.trim())) {
  throw new Error(`GOODVIBES_VERIFY_ATTEMPTS must be a positive integer, got: ${rawAttempts}`);
}
if (!/^\d+$/.test(rawDelay.trim())) {
  throw new Error(`GOODVIBES_VERIFY_DELAY_MS must be a positive integer, got: ${rawDelay}`);
}
const MAX_ATTEMPTS = Number.parseInt(rawAttempts, 10);
const RETRY_DELAY_MS = Number.parseInt(rawDelay, 10);
if (!Number.isInteger(MAX_ATTEMPTS) || MAX_ATTEMPTS <= 0) {
  throw new Error(`GOODVIBES_VERIFY_ATTEMPTS must be a positive integer, got: ${rawAttempts}`);
}
if (!Number.isInteger(RETRY_DELAY_MS) || RETRY_DELAY_MS <= 0) {
  throw new Error(`GOODVIBES_VERIFY_DELAY_MS must be a positive integer, got: ${rawDelay}`);
}

function packageNameForDir(dir: string): string {
  const pkg = readPackage(dir);
  const name = dir === 'packages/sdk' ? getPublicPackageNameOverride() || pkg.name : pkg.name;
  if (typeof name !== 'string' || !name) throw new Error(`Package ${dir} is missing a string name.`);
  return name;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function verifyPublishedVersion(packageName: string) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const publishedVersion = run(
        'npm',
        ['view', `${packageName}@${version}`, 'version', '--registry', registry],
        process.cwd(),
        {
          auth: true,
          registry,
          packageName,
          stdio: 'pipe',
        },
      ).trim();

      if (publishedVersion !== version) {
        throw new Error(`Expected ${packageName}@${version} in ${registry}, got ${publishedVersion || 'missing'}`);
      }

      console.log(`registry verification passed for ${packageName}@${version} in ${registry}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) {
        break;
      }
      console.warn(
        `registry verification not ready for ${packageName}@${version} in ${registry} `
        + `(attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${RETRY_DELAY_MS}ms`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to verify ${packageName}@${version} in ${registry}`);
}

for (const dir of publicPackageDirs) {
  await verifyPublishedVersion(packageNameForDir(dir));
}
