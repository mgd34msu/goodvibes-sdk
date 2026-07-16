#!/usr/bin/env node
import { loadToolchainConfig } from '../lib/load-config.js';
import { realExec, consoleLogger } from '../lib/effects.js';
import { evaluateCoverageGate } from '../lib/coverage-gate.js';

const root = process.cwd();
const config = loadToolchainConfig(root);
if (!config.coverage) {
  consoleLogger.error('coverage-gate: no `coverage` section in toolchain.config.json');
  process.exit(1);
}
const [bin, ...args] = config.coverage.command;
if (!bin) {
  consoleLogger.error('coverage-gate: coverage.command is empty');
  process.exit(1);
}
const run = realExec(bin, args, { cwd: root });
const result = evaluateCoverageGate(`${run.stdout}\n${run.stderr}`, config.coverage);
consoleLogger.info(`coverage-gate: ${result.detail}`);
process.exit(result.ok ? 0 : 1);
