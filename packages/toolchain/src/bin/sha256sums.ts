#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { consoleLogger } from '../lib/effects.js';
import { generateSha256Sums, verifySha256Sums, type ReadBytes, type HashBytes } from '../lib/sha256sums.js';

// Manifest convention: a SHA256SUMS file records BARE BASENAMES and is consumed
// from a directory holding the assets it covers, so `sha256sum -c SHA256SUMS.txt`
// in a download directory just works (a GitHub release flattens paths, so
// generating from `dist/goodvibes-*` and verifying beside the downloads is the
// same name set). Both halves of this bin obey that: --out records basenames,
// and --verify resolves every recorded name against the MANIFEST'S OWN
// directory. --verify used to resolve against the process cwd, which made a
// manifest sitting next to its assets unverifiable from anywhere else.

const root = process.cwd();
const hashBytes: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readBytesFrom = (base: string): ReadBytes => (path) => {
  const full = resolve(base, path);
  return existsSync(full) ? new Uint8Array(readFileSync(full)) : null;
};

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const verifyPath = argValue('--verify');
if (verifyPath) {
  const manifestPath = resolve(root, verifyPath);
  const manifestDir = dirname(manifestPath);
  const result = verifySha256Sums(readFileSync(manifestPath, 'utf8'), readBytesFrom(manifestDir), hashBytes);
  if (!result.ok) {
    consoleLogger.error(`sha256sums: verifying ${verifyPath} against ${manifestDir}`);
    if (result.missing.length > 0) consoleLogger.error(`sha256sums: missing ${result.missing.join(', ')}`);
    if (result.mismatched.length > 0) consoleLogger.error(`sha256sums: mismatched ${result.mismatched.join(', ')}`);
    process.exit(1);
  }
  consoleLogger.info('sha256sums: all assets verified');
  process.exit(0);
}

const outPath = argValue('--out') ?? 'SHA256SUMS.txt';
const assets = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== outPath && a !== verifyPath);
const entries = assets.map((path) => ({ name: basename(path), path }));

// Two assets sharing a basename would write two same-named lines, and neither
// this bin nor `sha256sum -c` could say which file either line meant.
const byName = new Map<string, string>();
const collisions: string[] = [];
for (const entry of entries) {
  const seen = byName.get(entry.name);
  if (seen !== undefined && seen !== entry.path) collisions.push(`${entry.name} (${seen}, ${entry.path})`);
  else byName.set(entry.name, entry.path);
}
if (collisions.length > 0) {
  consoleLogger.error(`sha256sums: refusing to write, distinct assets share a basename: ${collisions.join('; ')}`);
  process.exit(1);
}

const result = generateSha256Sums(entries, readBytesFrom(root), hashBytes);
if (!result.ok) {
  consoleLogger.error(`sha256sums: refusing to write, missing asset(s): ${result.missing.join(', ')}`);
  process.exit(1);
}
writeFileSync(resolve(root, outPath), result.manifest);
consoleLogger.info(`sha256sums: wrote ${entries.length} checksum(s) to ${outPath}`);
process.exit(0);
