import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const rootPackage = JSON.parse(readFileSync(resolve(SDK_ROOT, 'package.json'), 'utf8'));

const packageDirs = [
  'packages/contracts',
  'packages/errors',
  'packages/daemon-sdk',
  'packages/transport-core',
  'packages/transport-direct',
  'packages/transport-http',
  'packages/transport-realtime',
  'packages/operator-sdk',
  'packages/peer-sdk',
  'packages/sdk',
];

const requiredStringFields = [
  'name',
  'version',
  'description',
  'license',
  'homepage',
];

for (const dir of packageDirs) {
  const pkg = JSON.parse(readFileSync(resolve(SDK_ROOT, dir, 'package.json'), 'utf8'));
  if (pkg.version !== rootPackage.version) {
    throw new Error(`${dir}/package.json version ${pkg.version} does not match root version ${rootPackage.version}`);
  }
  for (const field of requiredStringFields) {
    if (typeof pkg[field] !== 'string' || pkg[field].trim().length === 0) {
      throw new Error(`${dir}/package.json is missing required field: ${field}`);
    }
  }
  if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0) {
    throw new Error(`${dir}/package.json is missing keywords`);
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new Error(`${dir}/package.json is missing files`);
  }
  if (!pkg.repository || typeof pkg.repository.url !== 'string') {
    throw new Error(`${dir}/package.json is missing repository metadata`);
  }
  if (!pkg.repository.url.startsWith('git+https://github.com/')) {
    throw new Error(`${dir}/package.json repository.url must use git+https://github.com/... form`);
  }
  if (!pkg.bugs || typeof pkg.bugs.url !== 'string') {
    throw new Error(`${dir}/package.json is missing bugs metadata`);
  }
  if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') {
    throw new Error(`${dir}/package.json must publish with access=public`);
  }
  if (!pkg.exports || typeof pkg.exports !== 'object') {
    throw new Error(`${dir}/package.json is missing exports`);
  }
  const readmePath = resolve(SDK_ROOT, dir, 'README.md');
  if (!existsSync(readmePath)) {
    throw new Error(`${dir} is missing README.md`);
  }
  const readme = readFileSync(readmePath, 'utf8').trim();
  if (readme.length < 200) {
    throw new Error(`${dir}/README.md is too short to be considered package-level documentation`);
  }
}

console.log('package metadata check passed');
