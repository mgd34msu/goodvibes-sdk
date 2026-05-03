/**
 * create-release-tag.ts
 *
 * Creates an annotated git tag for the current SDK version.
 * Usage: bun scripts/create-release-tag.ts [--push]
 *
 * See docs/release-and-publishing.md for the full release workflow.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const sdkPkg = JSON.parse(readFileSync(resolve(SDK_ROOT, 'packages/sdk/package.json'), 'utf8'));
const version: string = sdkPkg.version;
const tag = `v${version}`;
const PUSH = process.argv.includes('--push');

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd: SDK_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
}

// Verify working tree is clean
try {
  const status = run('git', ['status', '--porcelain']);
  if (status.trim()) {
    console.error(`[release:tag] ERROR: Working tree is not clean. Commit or stash changes before tagging.`);
    console.error(status);
    process.exit(1);
  }
} catch (e) {
  console.error(`[release:tag] ERROR: Could not read git status. (${e instanceof Error ? e.message : String(e)})`);
  process.exit(1);
}

// Check tag does not already exist
try {
  const existing = run('git', ['tag', '-l', tag]).trim();
  if (existing === tag) {
    console.error(`[release:tag] ERROR: Tag ${tag} already exists. Delete it first if you need to re-tag.`);
    process.exit(1);
  }
} catch {
  // ignore
}

console.log(`[release:tag] Creating annotated tag ${tag} for v${version} …`);

try {
  run('git', ['tag', '-a', tag, '-m', `release ${version}`]);
  console.log(`[release:tag] Tag ${tag} created successfully.`);
} catch (e) {
  console.error(`[release:tag] ERROR: Failed to create tag ${tag}. (${e instanceof Error ? e.message : String(e)})`);
  process.exit(1);
}

if (PUSH) {
  console.log(`[release:tag] Pushing ${tag} to origin …`);
  run('git', ['push', 'origin', tag]);
  console.log(`[release:tag] Pushed. This will trigger the Release workflow.`);
} else {
  console.log(`[release:tag] Tag created locally. To push and trigger release:`);
  console.log(`  git push origin ${tag}`);
}
