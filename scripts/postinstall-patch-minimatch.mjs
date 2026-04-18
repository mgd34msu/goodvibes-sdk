#!/usr/bin/env node
/**
 * postinstall-patch-minimatch.mjs
 *
 * Upgrades vulnerable minimatch transitive installs in consumer node_modules.
 *
 * Context: bash-language-server@5.6.0 hard-pins editorconfig@2.0.1, which
 * hard-pins minimatch@10.0.1. npm/bun ignore overrides fields in published
 * packages, so the root overrides in this SDK cannot fix consumer trees.
 * This postinstall patcher reaches into the consumer's node_modules and
 * upgrades any minimatch in the vulnerable range >=10.0.0 <10.2.3 in place.
 *
 * Advisory IDs addressed:
 *   GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74
 *
 * Node stdlib only. No third-party dependencies. Requires Node 18+.
 */

import { createGunzip } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

const PATCH_VERSION = '10.2.5';
const REGISTRY_URL = `https://registry.npmjs.org/minimatch/-/minimatch-${PATCH_VERSION}.tgz`;

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
 * Minimal synchronous tar extractor. Handles ustar-compatible archives.
 * Supports regular files and directories. Strips the leading "package/"
 * prefix that npm tarballs use.
 *
 * @param {Buffer} tarball - raw (already gunzip-decoded) tar data
 * @param {string} destDir - destination directory (the minimatch package root)
 */
function extractTar(tarball, destDir) {
  const BLOCK = 512;
  let offset = 0;

  while (offset + BLOCK <= tarball.length) {
    const header = tarball.subarray(offset, offset + BLOCK);
    offset += BLOCK;

    // End-of-archive: two consecutive zero blocks.
    if (header.every((b) => b === 0)) break;

    const nameRaw = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!nameRaw) break;

    const prefixRaw = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw;

    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;

    const typeFlag = String.fromCharCode(header[156]);
    const isDir = typeFlag === '5';
    const isFile = typeFlag === '0' || typeFlag === '\0';

    const blocks = Math.ceil(size / BLOCK);
    const fileData = isFile ? tarball.subarray(offset, offset + size) : null;
    offset += blocks * BLOCK;

    // Strip leading "package/" prefix (npm tarballs use "package/" as root).
    let relPath = fullName;
    if (relPath.startsWith('package/')) {
      relPath = relPath.slice('package/'.length);
    } else if (relPath === 'package') {
      continue;
    }

    // Safety: reject absolute paths and path traversal.
    if (!relPath || relPath.startsWith('/') || relPath.includes('..')) continue;

    const destPath = join(destDir, relPath);

    if (isDir || relPath.endsWith('/')) {
      mkdirSync(destPath, { recursive: true });
    } else if (isFile && fileData !== null) {
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, fileData);
    }
  }
}

/**
 * Download and gunzip the minimatch tgz from npm registry.
 * Returns the raw tar buffer (decompressed).
 * @returns {Promise<Buffer>}
 */
async function fetchTarball() {
  const resp = await fetch(REGISTRY_URL);
  if (!resp.ok) {
    throw new Error(`fetch ${REGISTRY_URL} → ${resp.status} ${resp.statusText}`);
  }
  const compressed = Buffer.from(await resp.arrayBuffer());

  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    /** @type {Buffer[]} */
    const chunks = [];
    gunzip.on('data', (chunk) => chunks.push(/** @type {Buffer} */ (chunk)));
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', reject);
    gunzip.end(compressed);
  });
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

async function main() {
  // npm sets INIT_CWD to the consumer project root during postinstall.
  // Fallback to process.cwd() which is the package root during npm install.
  const consumerRoot = process.env.INIT_CWD ?? process.cwd();
  const nodeModules = join(consumerRoot, 'node_modules');

  if (!existsSync(nodeModules)) {
    console.log('[pellux-patch] node_modules not found, skipping minimatch patch');
    process.exit(0);
  }

  /** @type {string[]} */
  let pkgJsonPaths;
  try {
    pkgJsonPaths = findMinimatchPaths(nodeModules);
  } catch (err) {
    console.warn(
      `[pellux-patch] warning: failed to scan node_modules: ${/** @type {Error} */ (err)?.message ?? err}`,
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
    console.log('[pellux-patch] no vulnerable minimatch detected');
    process.exit(0);
  }

  /** @type {Buffer | null} */
  let tarball = null;

  for (const { pkgJsonPath, version, dir } of vulnerable) {
    const rel = relative(consumerRoot, pkgJsonPath);
    try {
      if (tarball === null) {
        tarball = await fetchTarball();
      }
      extractTar(tarball, dir);
      console.log(`[pellux-patch] upgraded minimatch at ${rel}: ${version} → ${PATCH_VERSION}`);
    } catch (err) {
      // Never fail the consumer's install — log and continue.
      console.warn(
        `[pellux-patch] warning: failed to patch ${rel}: ${/** @type {Error} */ (err)?.message ?? err}`,
      );
    }
  }
}

main().catch((err) => {
  // Belt-and-suspenders: catch any top-level unhandled rejection and warn,
  // never propagate — postinstall must never break a consumer install.
  console.warn(
    `[pellux-patch] warning: postinstall patcher encountered an error: ${/** @type {Error} */ (err)?.message ?? err}`,
  );
  process.exit(0);
});
