import { getRootVersion, packageDirs, readPackage, run } from './release-shared.mjs';

const version = process.argv[2] || getRootVersion();

for (const dir of packageDirs) {
  const pkg = readPackage(dir);
  const publishedVersion = run(
    'npm',
    ['view', `${pkg.name}@${version}`, 'version'],
    process.cwd(),
    {
      auth: true,
      stdio: 'pipe',
    },
  ).trim();
  if (publishedVersion !== version) {
    throw new Error(`Expected ${pkg.name}@${version}, got ${publishedVersion || 'missing'}`);
  }
}

console.log(`registry verification passed for ${version}`);
