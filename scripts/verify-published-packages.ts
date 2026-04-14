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
