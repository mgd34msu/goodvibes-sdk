#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadToolchainConfig } from '../lib/load-config.js';
import { consoleLogger } from '../lib/effects.js';
import { runReleaseCut, type BumpKind } from '../lib/release-cut.js';

const root = process.cwd();
const config = loadToolchainConfig(root);
if (!config.releaseCut) {
  consoleLogger.error('release-cut: no `releaseCut` section in toolchain.config.json');
  process.exit(1);
}
const bump: BumpKind = process.argv.includes('--major') ? 'major' : process.argv.includes('--minor') ? 'minor' : 'patch';
const dryRun = process.argv.includes('--dry-run');
const notesIdx = process.argv.indexOf('--notes-file');
const notes = notesIdx !== -1 && process.argv[notesIdx + 1]
  ? readFileSync(resolve(root, process.argv[notesIdx + 1] as string), 'utf8').split('\n').filter((l) => l.trim().length > 0)
  : [];
try {
  const result = runReleaseCut({ cwd: root, bump, config: config.releaseCut, notes, dryRun, logger: consoleLogger });
  consoleLogger.info(`release-cut: prepared ${result.tag}${result.committed ? ' (committed + tagged)' : ' (dry-run)'}`);
  process.exit(0);
} catch (error) {
  consoleLogger.error(`release-cut: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
