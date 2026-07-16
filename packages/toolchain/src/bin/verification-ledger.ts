#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { consoleLogger } from '../lib/effects.js';
import { renderLedgerJson, renderLedgerMarkdown, type LedgerArea } from '../lib/verification-ledger.js';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const root = process.cwd();
const areasPath = argValue('--areas');
if (!areasPath) {
  consoleLogger.error('verification-ledger: --areas <file.json> is required (the repo-collected area inventory)');
  process.exit(1);
}
const areas = JSON.parse(readFileSync(resolve(root, areasPath), 'utf8')) as LedgerArea[];
const json = process.argv.includes('--json');
const rendered = json ? renderLedgerJson(areas) : renderLedgerMarkdown(areas);
const outDir = argValue('--out');
if (outDir) {
  writeFileSync(resolve(root, outDir, 'verification-ledger.json'), renderLedgerJson(areas));
  writeFileSync(resolve(root, outDir, 'verification-ledger.md'), renderLedgerMarkdown(areas));
  consoleLogger.info(`verification-ledger: wrote verification-ledger.{json,md} to ${outDir}`);
} else {
  consoleLogger.info(rendered);
}
process.exit(0);
