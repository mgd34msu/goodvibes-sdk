import sdkPackage from '../packages/sdk/package.json' with { type: 'json' };

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
