#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadToolchainConfig } from '../lib/load-config.js';
import { consoleLogger } from '../lib/effects.js';
import { runPublishPackage, pollPropagation } from '../lib/publish-package.js';

const root = process.cwd();
const config = loadToolchainConfig(root);
if (!config.publish) {
  consoleLogger.error('publish-package: no `publish` section in toolchain.config.json');
  process.exit(1);
}
const version = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version;
const dryRun = process.argv.includes('--dry-run');
const registry = process.env.GOODVIBES_PUBLISH_REGISTRY ?? config.publish.defaultRegistry;

const result = runPublishPackage({ cwd: root, name: config.publish.packageName, version, registry, dryRun, logger: consoleLogger });
consoleLogger.info(`publish-package: ${result.detail}`);
if (!result.ok) process.exit(1);

if (!dryRun && !result.skipped && process.argv.includes('--poll')) {
  const prop = await pollPropagation({ name: config.publish.packageName, version, registry, logger: consoleLogger });
  consoleLogger.info(`publish-package: ${prop.detail}`);
  process.exit(prop.ok ? 0 : 1);
}
process.exit(0);
