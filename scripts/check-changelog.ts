/**
 * Changelog gate: verifies that CHANGELOG.md contains a section header
 * matching the current @pellux/goodvibes-sdk version before release.
 *
 * Usage:
 *   bun scripts/check-changelog.ts
 *
 * Exit 0 when the section is present. Exit 1 with a clear error when missing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const sdkPkgPath = resolve(ROOT, 'packages/sdk/package.json');
const changelogPath = resolve(ROOT, 'CHANGELOG.md');

if (!existsSync(sdkPkgPath)) {
  console.error(`[changelog-check] ERROR: packages/sdk/package.json not found at ${sdkPkgPath}`);
  process.exit(1);
}

if (!existsSync(changelogPath)) {
  console.error(
    `[changelog-check] ERROR: CHANGELOG.md not found at ${changelogPath}\n` +
    `  Create it with a ## [X.Y.Z] section before releasing.`,
  );
  process.exit(1);
}

const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, 'utf8'));
const version: string = sdkPkg.version;

if (!version || typeof version !== 'string') {
  console.error('[changelog-check] ERROR: Could not read version from packages/sdk/package.json');
  process.exit(1);
}

const changelog = readFileSync(changelogPath, 'utf8');

// Match a Keep-a-Changelog section header: ## [X.Y.Z] or ## [X.Y.Z] - YYYY-MM-DD
const headerPattern = new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`, 'm');

if (!headerPattern.test(changelog)) {
  console.error(
    `[changelog-check] RELEASE BLOCKED: CHANGELOG.md is missing a section for v${version}.\n` +
    `\n` +
    `  Add a section before publishing:\n` +
    `\n` +
    `    ## [${version}] - YYYY-MM-DD\n` +
    `    ### Breaking\n` +
    `    ### Added\n` +
    `    ### Fixed\n` +
    `    ### Migration\n` +
    `\n` +
    `  See docs/release-and-publishing.md for the Changelog Gate requirements.`,
  );
  process.exit(1);
}

console.log(`[changelog-check] OK — CHANGELOG.md contains section for v${version}`);
