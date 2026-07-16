#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadToolchainConfig } from '../lib/load-config.js';
import { realExec, consoleLogger } from '../lib/effects.js';
import { resolveTargets, runBuildBinaries } from '../lib/build-binaries.js';
import type { BinaryTarget, BuildConfig } from '../config.js';

const root = process.cwd();
const config = loadToolchainConfig(root);
if (!config.build) {
  consoleLogger.error('build-binaries: no `build` section in toolchain.config.json');
  process.exit(1);
}
const build: BuildConfig = config.build;

const nativeKey = `${process.platform === 'darwin' ? 'darwin' : process.platform}-${process.arch}`;

/** Copy the native addon beside the binary; same-host miss is fatal, cross-target miss fetches via npm pack + tar. */
function provideAddon(target: BinaryTarget, sameHost: boolean): boolean {
  if (!target.nativeAddonPackage || !target.nativeAddonFile) return true;
  const destDir = resolve(root, build.addonOutDir, target.nativeAddonPackage);
  const dest = join(destDir, target.nativeAddonFile);
  const source = resolve(root, 'node_modules', target.nativeAddonPackage, target.nativeAddonFile);
  mkdirSync(destDir, { recursive: true });
  if (existsSync(source)) {
    copyFileSync(source, dest);
    return true;
  }
  if (sameHost) {
    consoleLogger.error(`[build-binaries] native addon missing for host target ${target.key}; run install`);
    return false;
  }
  const versionPkg = resolve(root, 'node_modules', 'sqlite-vec', 'package.json');
  if (!existsSync(versionPkg)) return false;
  const version = (JSON.parse(readFileSync(versionPkg, 'utf8')) as { version: string }).version;
  const tmp = mkdtempSync(join(tmpdir(), 'gv-addon-'));
  try {
    const pack = realExec('npm', ['pack', `${target.nativeAddonPackage}@${version}`, '--pack-destination', tmp]);
    if (pack.status !== 0) return false;
    const tarball = pack.stdout.trim().split('\n').pop();
    if (!tarball) return false;
    const untar = realExec('tar', ['-xzf', join(tmp, tarball), '-C', tmp]);
    if (untar.status !== 0) return false;
    const extracted = join(tmp, 'package', target.nativeAddonFile);
    if (!existsSync(extracted)) return false;
    copyFileSync(extracted, dest);
    return true;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  const selection = resolveTargets(process.argv.slice(2), build, nativeKey);
  const outcomes = runBuildBinaries({ cwd: root, config: build, selection, nativeKey, provideAddon, logger: consoleLogger });
  const failed = outcomes.filter((o) => !o.ok);
  consoleLogger.info(`build-binaries: ${outcomes.length - failed.length}/${outcomes.length} target(s) built`);
  process.exit(failed.length > 0 ? 1 : 0);
} catch (error) {
  consoleLogger.error(`build-binaries: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
