#!/usr/bin/env node
/**
 * Rewrites `@pellux/goodvibes-sdk/platform/...` self-imports in _internal/**
 * to relative paths pointing at _internal/platform/... siblings.
 *
 * Algorithm:
 *   from '@pellux/goodvibes-sdk/platform/X/Y/Z'
 *   ->  from '../../../platform/X/Y/Z.js'  (relative from importing file's dir)
 *
 * Always appends .js to the relative path (required by moduleResolution: node16/nodenext).
 * If the original subpath already ends in .js, it is preserved (not doubled).
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, dirname, relative, join } from 'path';

const INTERNAL_ROOT = resolve('/home/buzzkill/Projects/goodvibes-sdk/packages/sdk/src/_internal');
const PLATFORM_INTERNAL = resolve('/home/buzzkill/Projects/goodvibes-sdk/packages/sdk/src/_internal/platform');

// Match: from '@pellux/goodvibes-sdk/platform/...' or from "@pellux/goodvibes-sdk/platform/..."
const IMPORT_RE = /(from\s*)(["'])@pellux\/goodvibes-sdk\/platform\/([^"']+)\2/g;

function getAllTs(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTs(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

function computeRelative(fromFile, subpath) {
  // subpath is like 'runtime/transports/http' or 'runtime/transports/http.js'
  // Strip .js if present (we'll re-add it after computing the path)
  const hasJs = subpath.endsWith('.js');
  const cleanSubpath = hasJs ? subpath.slice(0, -3) : subpath;
  const targetPath = join(PLATFORM_INTERNAL, cleanSubpath);
  let rel = relative(dirname(fromFile), targetPath);
  // Ensure it starts with ./ or ../
  if (!rel.startsWith('.')) rel = './' + rel;
  // Always append .js for node16/nodenext moduleResolution
  return rel + '.js';
}

let filesChanged = 0;
let importsRewrote = 0;

const allFiles = getAllTs(INTERNAL_ROOT);
console.log(`Found ${allFiles.length} .ts files in _internal`);

for (const file of allFiles) {
  const original = readFileSync(file, 'utf8');
  let changed = false;
  const rewritten = original.replace(IMPORT_RE, (match, fromKw, quote, subpath) => {
    const rel = computeRelative(file, subpath);
    importsRewrote++;
    changed = true;
    return `${fromKw}${quote}${rel}${quote}`;
  });
  if (changed) {
    writeFileSync(file, rewritten, 'utf8');
    filesChanged++;
  }
}

console.log(`Done. Files changed: ${filesChanged}, imports rewritten: ${importsRewrote}`);
