/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * tool-edit-record.ts, which file contents GoodVibes itself left on disk.
 *
 * Every write and edit tool call (the main session's and every agent's) ends
 * in FileUndoManager.snapshot, which records the file here; so do undo and
 * redo, and a passed WRFC chain when it brings its work into the working copy
 * (wrfc-chain-workspace.ts). Each record is the hash of the file's bytes right
 * after GoodVibes wrote it.
 *
 * A passed chain uses this to tell GoodVibes' own uncommitted work from the
 * user's: an uncommitted file whose current bytes are exactly what GoodVibes
 * left there is GoodVibes' work and is committed with the chain's changes; a
 * file with no record, or edited by hand since GoodVibes wrote it (the bytes
 * no longer match), is the user's and stays out of the commit untouched.
 *
 * The record lives in the process: work from an earlier run of GoodVibes has
 * no record and so counts as the user's.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../utils/logger.js';

/** Paths kept before the oldest record is dropped. */
const MAX_RECORDS = 5000;

const records = new Map<string, string>();

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readBytes(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Record that GoodVibes just wrote `path`. `bytes` is what was written; when
 * omitted the file is read back from disk, so the record is what is really
 * there. A file that cannot be read drops its record.
 */
export function recordToolEdit(path: string, bytes?: Uint8Array | null): void {
  const absolute = resolve(path);
  const content = bytes === undefined ? readBytes(absolute) : bytes;
  records.delete(absolute);
  if (content === null) return;
  records.set(absolute, digest(content));
  logger.debug('tool-edit-record: GoodVibes wrote a file', { path: absolute });
  if (records.size > MAX_RECORDS) {
    const oldest = records.keys().next().value;
    if (oldest !== undefined) records.delete(oldest);
  }
}

/** True when `current` (the file's bytes now) is exactly what GoodVibes last wrote to `path`. */
export function isToolEditedContent(path: string, current: Uint8Array | null): boolean {
  if (current === null) return false;
  const recorded = records.get(resolve(path));
  return recorded !== undefined && recorded === digest(current);
}

/** Forget every record (tests, and a host that resets its session state). */
export function clearToolEditRecords(): void {
  records.clear();
}
