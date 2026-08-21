#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { loadToolchainConfig } from '../lib/load-config.js';
import { realExec, realFsReader, consoleLogger } from '../lib/effects.js';
import { resolveTargets, runBuildBinaries } from '../lib/build-binaries.js';
import { readDependencyManifest, type DependencyManifest } from '../lib/optional-externals.js';
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

/**
 * The manifests whose optionalDependencies may be externalised: this repo's
 * own, plus the SDK it bundles. The SDK's are the ones that matter, it is
 * where the thirty optional packages are declared and where the dynamic
 * imports that make them genuinely optional live.
 */
function dependencyManifests(): DependencyManifest[] {
  const fs = realFsReader(root);
  const found: DependencyManifest[] = [];
  const own = readDependencyManifest(fs, 'package.json', 'this package');
  if (own) found.push(own);
  const sdkPackage = config.sdkPin?.sdkPackage ?? '@pellux/goodvibes-sdk';
  const sdk = readDependencyManifest(fs, join('node_modules', sdkPackage, 'package.json'), sdkPackage);
  if (sdk) found.push(sdk);
  return found;
}

/**
 * Resolution from the build root, which is the same question bun's bundler
 * asks. `createRequire().resolve` answers it for a package that exists but has
 * no importable entry too, so a half-installed package is treated as present
 * exactly as bun would treat it.
 */
const requireFromRoot = createRequire(join(root, 'package.json'));
function isPackageInstalled(packageName: string): boolean {
  try {
    requireFromRoot.resolve(packageName);
    return true;
  } catch {
    // A package whose main entry does not resolve may still resolve a subpath
    // (several optional packages are reached only through one). Its manifest
    // being present is what "installed" means here.
    try {
      requireFromRoot.resolve(`${packageName}/package.json`);
      return true;
    } catch {
      return false;
    }
  }
}

try {
  const selection = resolveTargets(process.argv.slice(2), build, nativeKey);
  const outcomes = runBuildBinaries({
    cwd: root, config: build, selection, nativeKey, provideAddon, logger: consoleLogger,
    dependencyManifests: dependencyManifests(),
    isPackageInstalled,
  });
  const failed = outcomes.filter((o) => !o.ok);
  consoleLogger.info(`build-binaries: ${outcomes.length - failed.length}/${outcomes.length} target(s) built`);
  process.exit(failed.length > 0 ? 1 : 0);
} catch (error) {
  consoleLogger.error(`build-binaries: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
