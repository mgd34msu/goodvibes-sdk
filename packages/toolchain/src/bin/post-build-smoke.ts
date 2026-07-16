#!/usr/bin/env node
import { loadToolchainConfig } from '../lib/load-config.js';
import { consoleLogger } from '../lib/effects.js';
import { runPostBuildSmoke } from '../lib/post-build-smoke.js';

const root = process.cwd();
const config = loadToolchainConfig(root);
if (!config.smoke) {
  consoleLogger.error('post-build-smoke: no `smoke` section in toolchain.config.json');
  process.exit(1);
}
const binaryIdx = process.argv.indexOf('--binary');
const binary = binaryIdx !== -1 ? process.argv[binaryIdx + 1] : undefined;
const result = runPostBuildSmoke({ binary: binary ?? config.smoke.binaryDefault, config: config.smoke, logger: consoleLogger });
process.exit(result.ok ? 0 : 1);
