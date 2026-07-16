#!/usr/bin/env node
import { loadToolchainConfig } from '../lib/load-config.js';
import { realFsReader, consoleLogger } from '../lib/effects.js';
import { runSdkPinGate } from '../lib/sdk-pin-gate.js';

const root = process.cwd();
const config = loadToolchainConfig(root);
const results = runSdkPinGate(realFsReader(root), config.sdkPin);
let failed = 0;
for (const result of results) {
  consoleLogger.info(`${result.ok ? 'PASS' : 'FAIL'}  ${result.id} — ${result.detail}`);
  if (!result.ok) failed += 1;
}
consoleLogger.info(`sdk-pin-gate: ${results.length - failed}/${results.length} gates passed`);
process.exit(failed > 0 ? 1 : 0);
