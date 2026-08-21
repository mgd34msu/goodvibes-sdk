#!/usr/bin/env node
/**
 * goodvibes-train-status, read-only release-train cycle table across the
 * family's local checkouts. Never mutates anything: no pushes, no tags, no
 * installs, no writes outside stdout.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { consoleLogger } from '../lib/effects.js';
import { parseTrainStatusManifest, gatherTrainStatus, renderTrainStatusTable, renderTrainStatusJson } from '../lib/train-status.js';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const root = process.cwd();
const manifestPath = argValue('--manifest');
if (!manifestPath) {
  consoleLogger.error('train-status: --manifest <path> is required');
  process.exit(2);
}

let manifest;
try {
  manifest = parseTrainStatusManifest(readFileSync(resolve(root, manifestPath), 'utf8'));
} catch (error) {
  consoleLogger.error(`train-status: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const result = gatherTrainStatus(manifest);
const json = process.argv.includes('--json');
consoleLogger.info(json ? renderTrainStatusJson(result) : renderTrainStatusTable(result.rows));

const hasGatherErrors = result.rows.some((row) => row.error);
process.exit(hasGatherErrors ? 1 : 0);
