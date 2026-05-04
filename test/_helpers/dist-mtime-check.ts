/**
 * M1 (seventh-review): dist/ staleness sentinel.
 *
 * Import this helper in any test that loads packages from dist/ to get a loud
 * failure when the compiled output is older than the TypeScript source.
 *
 * Usage:
 *   import './helpers/dist-mtime-check.js';
 *
 * The check runs once at import time and throws if any monitored dist/index.js
 * is older than its corresponding src/index.ts.
 *
 * CI note: `bun run build` must be run before tests that import dist/. This
 * sentinel makes the failure immediately visible rather than surfacing as
 * confusing type errors or missing exports.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

/** Packages whose dist/index.js should be newer than src/index.ts. */
const MONITORED_PACKAGES = [
  'packages/sdk',
  'packages/errors',
  'packages/contracts',
  'packages/transport-core',
  'packages/transport-http',
  'packages/transport-realtime',
  'packages/operator-sdk',
  'packages/peer-sdk',
  'packages/daemon-sdk',
];

const stalePackages: string[] = [];

for (const pkg of MONITORED_PACKAGES) {
  const distPath = resolve(ROOT, pkg, 'dist/index.js');
  const srcPath = resolve(ROOT, pkg, 'src/index.ts');
  try {
    const distMtime = statSync(distPath).mtimeMs;
    const srcMtime = statSync(srcPath).mtimeMs;
    if (distMtime < srcMtime) {
      stalePackages.push(`${pkg}: dist/index.js (${new Date(distMtime).toISOString()}) is older than src/index.ts (${new Date(srcMtime).toISOString()})`);
    }
  } catch (e) {
    // MAJ-11 (eighth-review): dist/ absent is strictly worse than stale — fail loudly
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      stalePackages.push(`${pkg}: dist/index.js is MISSING — run \`bun run build\``);
    } else {
      stalePackages.push(`${pkg}: stat error — ${(e as Error).message}`);
    }
  }
}

if (stalePackages.length > 0) {
  throw new Error(
    `[dist-mtime-check] Stale dist/ detected — run \`bun run build\` before running these tests:\n` +
    stalePackages.map((p) => `  ${p}`).join('\n'),
  );
}
