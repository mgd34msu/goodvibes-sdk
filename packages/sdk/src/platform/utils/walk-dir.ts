/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { logger } from './logger.js';
import { summarizeError } from './error-display.js';

/**
 * Directories that are always skipped during recursive directory walks.
 * Covers version-control, package manager output, and build artefacts.
 */
export const WALK_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
]);

/**
 * Files larger than this threshold are skipped to avoid loading huge binaries
 * or generated assets into memory (1 MB).
 */
export const WALK_MAX_FILE_SIZE = 1024 * 1024; // 1 MB

/**
 * Recursively walk a directory tree, yielding all file paths whose size does
 * not exceed {@link WALK_MAX_FILE_SIZE}. Hidden entries and entries in
 * {@link WALK_SKIP_DIRS} are skipped. Unreadable directories and files are
 * logged as warnings and skipped so one permission or stat error never
 * aborts the whole walk.
 */
export async function* walkDir(dirPath: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    logger.warn('walkDir skipped unreadable directory', {
      path: dirPath,
      error: summarizeError(err),
    });
    return;
  }

  for (const entry of entries) {
    // Skip hidden entries and known heavy directories
    if (entry.name.startsWith('.') || WALK_SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile()) {
      try {
        const info = await stat(fullPath);
        if (info.size > WALK_MAX_FILE_SIZE) continue;
      } catch (err) {
        logger.warn('walkDir skipped unreadable file', {
          path: fullPath,
          error: summarizeError(err),
        });
        continue;
      }
      yield fullPath;
    }
  }
}
