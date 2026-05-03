import sdkPackage from '../packages/sdk/package.json' with { type: 'json' };

// Workspace package versions are kept equal by version-consistency-check and
// sync:version, so the public SDK package version is the release tag source.
const tagName = process.env.GITHUB_REF_NAME;
if (!tagName) {
  console.error('ERROR: GITHUB_REF_NAME is required for release tag verification.');
  process.exit(1);
}

const expectedTag = `v${sdkPackage.version}`;
if (tagName !== expectedTag) {
  console.error(`ERROR: Git tag '${tagName}' does not match package.json version '${sdkPackage.version}' (expected tag: '${expectedTag}').`);
  process.exit(1);
}

console.log(`Tag verification OK: ${tagName} == ${expectedTag}`);
