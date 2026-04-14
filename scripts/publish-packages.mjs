import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

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

function run(cmd, args, cwd) {
  execFileSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
}

function readPackage(dir) {
  return JSON.parse(readFileSync(resolve(SDK_ROOT, dir, 'package.json'), 'utf8'));
}

function isPublished(name, version) {
  try {
    const output = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      cwd: SDK_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    }).toString('utf8').trim();
    return output === version;
  } catch {
    return false;
  }
}

if (!DRY_RUN && !process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN) {
  throw new Error('NODE_AUTH_TOKEN or NPM_TOKEN is required for publishing.');
}

for (const dir of packageDirs) {
  const pkg = readPackage(dir);
  if (!DRY_RUN && isPublished(pkg.name, pkg.version)) {
    console.log(`Skipping ${pkg.name}@${pkg.version}; already published.`);
    continue;
  }
  const args = ['publish', '--access', 'public', '--provenance'];
  if (DRY_RUN) {
    args.push('--dry-run');
  }
  console.log(`${DRY_RUN ? 'Dry-running' : 'Publishing'} ${pkg.name}@${pkg.version}`);
  run('npm', args, resolve(SDK_ROOT, dir));
}
