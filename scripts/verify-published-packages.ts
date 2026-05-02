import {
  getPublicPackageNameOverride,
  getPublishRegistryOverride,
  getRootVersion,
  readPackage,
  run,
} from './release-shared.ts';

const version = process.argv[2] || getRootVersion();
const pkg = readPackage('packages/sdk');
const packageName = getPublicPackageNameOverride() || pkg.name;
const registry = getPublishRegistryOverride() || 'https://registry.npmjs.org';
const MAX_ATTEMPTS = Number.parseInt(process.env.GOODVIBES_VERIFY_ATTEMPTS || '24', 10);
const RETRY_DELAY_MS = Number.parseInt(process.env.GOODVIBES_VERIFY_DELAY_MS || '5000', 10);

function sleep(ms: number) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function verifyPublishedVersion() {
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

await verifyPublishedVersion();
