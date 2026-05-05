/**
 * Stale-dist mtime sentinel.
 *
 * Walks each compiled package's src/ tree and compares the newest mtime found
 * there against the newest mtime in the corresponding dist/ tree. Exits
 * non-zero if any src file is newer than every dist file — indicating the
 * package has not been rebuilt since the last source change.
 *
 * Usage:
 *   bun scripts/check-dist-freshness.ts          # check all built packages
 *   bun scripts/check-dist-freshness.ts sdk       # check a single package by name
 *
 * Exits 0 when all dist trees are fresh, 1 when any are stale.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageDirs } from './release-shared.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

const BUILT_PACKAGES = packageDirs.map((dir) => dir.replace(/^packages\//, ''));

const filter = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const targetPackages = filter.length > 0
  ? BUILT_PACKAGES.filter((p) => filter.includes(p))
  : BUILT_PACKAGES;

if (targetPackages.length === 0) {
  console.error(`check-dist-freshness: no matching packages for filter ${JSON.stringify(filter)}`);
  process.exit(1);
}

/**
 * Walk a directory recursively and return the maximum mtime (ms) of all files.
 * Returns 0 if the directory does not exist or contains no files.
 */
function newestMtime(dir: string): number {
  let max = 0;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      max = Math.max(max, newestMtime(full));
    } else if (entry.isFile()) {
      try {
        max = Math.max(max, statSync(full).mtimeMs);
      } catch {
        // ignore unreadable files
      }
    }
  }
  return max;
}

const stale: string[] = [];
const missing: string[] = [];
const fresh: string[] = [];

for (const pkg of targetPackages) {
  const srcDir = join(SDK_ROOT, 'packages', pkg, 'src');
  const distDir = join(SDK_ROOT, 'packages', pkg, 'dist');

  const srcMtime = newestMtime(srcDir);
  const distMtime = newestMtime(distDir);

  if (distMtime === 0) {
    missing.push(pkg);
    continue;
  }

  if (srcMtime > distMtime) {
    stale.push(pkg);
    const srcDate = new Date(srcMtime).toISOString();
    const distDate = new Date(distMtime).toISOString();
    console.error(
      `check-dist-freshness: STALE  ${pkg}  (newest src: ${srcDate} > newest dist: ${distDate})`,
    );
  } else {
    fresh.push(pkg);
  }
}

if (missing.length > 0) {
  for (const pkg of missing) {
    console.error(`check-dist-freshness: MISSING dist for ${pkg} — run \`bun run build\``);
  }
}

if (stale.length > 0 || missing.length > 0) {
  console.error(
    `\ncheck-dist-freshness: ${stale.length + missing.length} package(s) need rebuild.`,
    `Run \`bun run build\` then re-run this check.`,
  );
  process.exit(1);
}

console.log(`check-dist-freshness: all ${fresh.length} package dist trees are fresh.`);
