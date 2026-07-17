#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadToolchainConfig } from '../lib/load-config.js';
import { consoleLogger } from '../lib/effects.js';
import { runPublishPackage, pollPropagation } from '../lib/publish-package.js';

/** Read the value that follows a `--flag <value>` argument, or undefined when absent. */
function flagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

const root = process.cwd();
const config = loadToolchainConfig(root);
if (!config.publish) {
  consoleLogger.error('publish-package: no `publish` section in toolchain.config.json');
  process.exit(1);
}
const version = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version;
const dryRun = process.argv.includes('--dry-run');
const registry = process.env.GOODVIBES_PUBLISH_REGISTRY ?? config.publish.defaultRegistry;

// --tarball <path>: publish a prebuilt .tgz instead of packing cwd. Validate the
// flag value up front — a missing/empty path is a caller error (exit 2), kept
// distinct from a publish failure (exit 1) so a broken pack→publish handoff is
// unambiguous in CI logs.
const tarballPath = flagValue('--tarball');
if (process.argv.includes('--tarball') && (tarballPath === undefined || tarballPath.length === 0)) {
  consoleLogger.error('publish-package: --tarball requires a file path');
  process.exit(2);
}
if (tarballPath !== undefined && !existsSync(resolve(root, tarballPath))) {
  consoleLogger.error(`publish-package: --tarball path does not exist: ${tarballPath}`);
  process.exit(2);
}

const result = runPublishPackage({
  cwd: root,
  name: config.publish.packageName,
  version,
  registry,
  dryRun,
  ...(tarballPath !== undefined ? { tarballPath } : {}),
  logger: consoleLogger,
});
consoleLogger.info(`publish-package: ${result.detail}`);
if (!result.ok) process.exit(1);

if (!dryRun && !result.skipped && process.argv.includes('--poll')) {
  const prop = await pollPropagation({ name: config.publish.packageName, version, registry, logger: consoleLogger });
  consoleLogger.info(`publish-package: ${prop.detail}`);
  process.exit(prop.ok ? 0 : 1);
}
process.exit(0);
