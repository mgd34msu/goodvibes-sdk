#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { consoleLogger } from '../lib/effects.js';
import { generateSha256Sums, verifySha256Sums, type ReadBytes, type HashBytes } from '../lib/sha256sums.js';

const root = process.cwd();
const readBytes: ReadBytes = (path) => (existsSync(resolve(root, path)) ? new Uint8Array(readFileSync(resolve(root, path))) : null);
const hashBytes: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const verifyPath = argValue('--verify');
if (verifyPath) {
  const result = verifySha256Sums(readFileSync(resolve(root, verifyPath), 'utf8'), readBytes, hashBytes);
  if (!result.ok) {
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
const result = generateSha256Sums(entries, readBytes, hashBytes);
if (!result.ok) {
  consoleLogger.error(`sha256sums: refusing to write — missing asset(s): ${result.missing.join(', ')}`);
  process.exit(1);
}
writeFileSync(resolve(root, outPath), result.manifest);
consoleLogger.info(`sha256sums: wrote ${entries.length} checksum(s) to ${outPath}`);
process.exit(0);
