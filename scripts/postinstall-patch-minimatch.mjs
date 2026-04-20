#!/usr/bin/env node
/**
 * postinstall-patch-minimatch.mjs
 *
 * Upgrades vulnerable minimatch transitive installs in consumer node_modules.
 *
 * VULNERABILITY CONTEXT
 * ---------------------
 * bash-language-server@5.6.0 hard-pins editorconfig@2.0.1, which hard-pins
 * minimatch@10.0.1. npm and bun both ignore `overrides` fields that appear in
 * published packages (they only honour overrides in the root package.json of
 * the consumer project). This means the root `overrides: { minimatch: ^10.2.5 }`
 * in this SDK's package.json cannot fix downstream consumer trees where
 * bash-language-server is a dependency.
 *
 * ADVISORIES ADDRESSED
 * --------------------
 *   GHSA-3ppc-4f35-3m26 — Regular expression denial of service in minimatch
 *   GHSA-7r86-cg39-jmmj — Regular expression denial of service in minimatch
 *   GHSA-23c5-xmqv-rm74 — Regular expression denial of service in minimatch
 *
 * All three affect minimatch >=10.0.0 <10.2.3. This patcher upgrades any such
 * instance to the vendored 10.2.5 payload checked into this repository.
 *
 * WHY OVERRIDES ALONE DON'T SUFFICE
 * ----------------------------------
 * Per npm/bun specifications, `overrides` and `resolutions` in a published
 * package are IGNORED by consuming project package managers. They are only
 * honoured in the root package.json of the end-consumer project. Since
 * bash-language-server is a production dependency of this SDK (required for
 * its LSP "bash" language feature), consumers install it transitively and
 * receive the pinned vulnerable minimatch without any override applying.
 *
 * SUPPLY-CHAIN SAFETY
 * -------------------
 * This script makes NO network calls. The replacement minimatch is vendored
 * at scripts/vendor/minimatch/ (git-checked-in). This eliminates any
 * registry-substitution / MITM / offline risk that a tarball fetch would
 * introduce. The vendored directory is the exact contents of the
 * minimatch@10.2.5 npm tarball (sha512 integrity:
 *   sha512-MULkVLfKGYDFYejP07QOurDLLQpcjk7Fw+7jXS2R2czRQzR56yHRveU5NDJEOviH
 *         +hETZKSkIk5c+T23GjFUMg==
 * verified at time of vendoring, 2026-04-20).
 *
 * IDEMPOTENCY
 * -----------
 * Safe to run multiple times. Already-patched paths are detected by reading
 * the version field; if it is already >=10.2.3, patching is skipped.
 *
 * Node stdlib only. No third-party dependencies. Requires Node 18+.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATCH_VERSION = '10.2.5';

/** Absolute path to the vendored minimatch payload (relative to this script). */
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'minimatch');

/**
 * Parse semver string into major/minor/patch integers.
 * @param {string} v
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
  };
}

/**
 * Returns true if version is in the vulnerable range: >=10.0.0 <10.2.3
 * @param {string} v
 * @returns {boolean}
 */
function isVulnerable(v) {
  const p = parseVersion(v);
  if (!p) return false;
  if (p.major !== 10) return false;
  if (p.minor < 2) return true;
  if (p.minor === 2 && p.patch < 3) return true;
  return false;
}

/**
 * Walk node_modules and return paths to every minimatch/package.json found.
 * Covers three layouts:
 *   - flat:   node_modules/minimatch/package.json
 *   - nested: node_modules/foo/node_modules/minimatch/package.json
 *   - pnpm:   node_modules/.pnpm/minimatch@X/node_modules/minimatch/package.json
 *
 * @param {string} nodeModules - absolute path to the node_modules root
 * @returns {string[]}
 */
function findMinimatchPaths(nodeModules) {
  /** @type {string[]} */
  const results = [];

  /** @param {string} dir */
  function scan(dir) {
    /** @type {string[]} */
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip hidden dirs except .pnpm (pnpm virtual store).
      if (entry.startsWith('.') && entry !== '.pnpm') continue;

      const full = join(dir, entry);

      if (entry === 'minimatch') {
        const pkgJson = join(full, 'package.json');
        if (existsSync(pkgJson)) results.push(pkgJson);
        // Don't recurse into minimatch's own directory.
        continue;
      }

      if (entry === '.pnpm') {
        // pnpm isolated installs: .pnpm/<name@version>/node_modules/<name>
        /** @type {string[]} */
        let pnpmEntries;
        try {
          pnpmEntries = readdirSync(full);
        } catch {
          continue;
        }
        for (const pnpmEntry of pnpmEntries) {
          // Check for minimatch directly in this pnpm store entry.
          const pnpmMinimatch = join(full, pnpmEntry, 'node_modules', 'minimatch');
          const pkgJson = join(pnpmMinimatch, 'package.json');
          if (existsSync(pkgJson)) results.push(pkgJson);
          // Also scan nested node_modules inside pnpm store entries.
          const nested = join(full, pnpmEntry, 'node_modules');
          if (existsSync(nested)) scan(nested);
        }
        continue;
      }

      // Scoped namespace (@scope) — recurse one level.
      if (entry.startsWith('@')) {
        scan(full);
        continue;
      }

      // Regular package — check for nested node_modules.
      const nested = join(full, 'node_modules');
      if (existsSync(nested)) scan(nested);
    }
  }

  scan(nodeModules);
  return results;
}

function main() {
  // Validate the vendored payload is present before doing anything else.
  if (!existsSync(VENDOR_DIR) || !existsSync(join(VENDOR_DIR, 'package.json'))) {
    console.warn(
      '[postinstall] warning: vendored minimatch not found at scripts/vendor/minimatch/ — skipping patch.\n'
      + '  This is unexpected. Please report to the goodvibes-sdk maintainers.',
    );
    process.exit(0);
  }

  // npm sets INIT_CWD to the consumer project root during postinstall.
  // Fallback to process.cwd() which is the package root during npm install.
  const consumerRoot = process.env.INIT_CWD ?? process.cwd();
  const nodeModules = join(consumerRoot, 'node_modules');

  if (!existsSync(nodeModules)) {
    console.log('[postinstall] node_modules not found, skipping minimatch patch');
    process.exit(0);
  }

  /** @type {string[]} */
  let pkgJsonPaths;
  try {
    pkgJsonPaths = findMinimatchPaths(nodeModules);
  } catch (err) {
    console.warn(
      `[postinstall] warning: failed to scan node_modules: ${/** @type {Error} */ (err)?.message ?? err}`,
    );
    process.exit(0);
  }

  /** @type {Array<{ pkgJsonPath: string, version: string, dir: string }>} */
  const vulnerable = [];

  for (const pkgJsonPath of pkgJsonPaths) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      const ver = /** @type {string} */ (pkg.version ?? '');
      if (isVulnerable(ver)) {
        vulnerable.push({ pkgJsonPath, version: ver, dir: dirname(pkgJsonPath) });
      }
    } catch {
      // Unreadable package.json — skip silently.
    }
  }

  if (vulnerable.length === 0) {
    console.log('[postinstall] no vulnerable minimatch detected, skipping patch');
    process.exit(0);
  }

  for (const { pkgJsonPath, version, dir } of vulnerable) {
    const rel = relative(consumerRoot, pkgJsonPath);
    try {
      console.log(`[postinstall] patching minimatch at ${rel}`);
      // cpSync with recursive:true copies the vendored payload over the target.
      // force:true allows overwriting existing files.
      cpSync(VENDOR_DIR, dir, { recursive: true, force: true });
      console.log(`[postinstall] minimatch patched to v${PATCH_VERSION} from vendored payload (was ${version})`);
    } catch (err) {
      // Never fail the consumer's install — log and continue.
      console.warn(
        `[postinstall] warning: failed to patch ${rel}: ${/** @type {Error} */ (err)?.message ?? err}`,
      );
    }
  }
}

try {
  main();
} catch (err) {
  // Belt-and-suspenders: catch any top-level error and warn,
  // never propagate — postinstall must never break a consumer install.
  console.warn(
    `[postinstall] warning: postinstall patcher encountered an error: ${/** @type {Error} */ (err)?.message ?? err}`,
  );
  process.exit(0);
}
