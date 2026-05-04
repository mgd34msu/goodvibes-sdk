import {
  getPublicPackageNameOverride,
  getPublishRegistryOverride,
  publicPackageDirs,
  getRootVersion,
  readPackage,
  run,
} from './release-shared.ts';

const version = process.argv[2] || getRootVersion();
const registry = getPublishRegistryOverride() || 'https://registry.npmjs.org';
const _rawAttempts = process.env.GOODVIBES_VERIFY_ATTEMPTS || '48';
const _rawDelay = process.env.GOODVIBES_VERIFY_DELAY_MS || '5000';
if (!/^\d+$/.test(_rawAttempts.trim())) {
  throw new Error(`GOODVIBES_VERIFY_ATTEMPTS must be a positive integer, got: ${_rawAttempts}`);
}
if (!/^\d+$/.test(_rawDelay.trim())) {
  throw new Error(`GOODVIBES_VERIFY_DELAY_MS must be a positive integer, got: ${_rawDelay}`);
}
const MAX_ATTEMPTS = Number.parseInt(_rawAttempts, 10);
const RETRY_DELAY_MS = Number.parseInt(_rawDelay, 10);
if (!Number.isInteger(MAX_ATTEMPTS) || MAX_ATTEMPTS <= 0) {
  throw new Error(`GOODVIBES_VERIFY_ATTEMPTS must be a positive integer, got: ${_rawAttempts}`);
}
if (!Number.isInteger(RETRY_DELAY_MS) || RETRY_DELAY_MS <= 0) {
  throw new Error(`GOODVIBES_VERIFY_DELAY_MS must be a positive integer, got: ${_rawDelay}`);
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
