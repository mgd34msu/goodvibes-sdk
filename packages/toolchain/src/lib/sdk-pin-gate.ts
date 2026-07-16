/**
 * sdk-pin-gate — verifies a consumer repo pins the SDK correctly.
 *
 * Absorbs three parallel copies: tui/scripts/publish-check.ts (pin in
 * `dependencies`), agent/scripts/sdk-release-gates.ts (pin in
 * `devDependencies`), and webui/scripts/release-gate.ts (adds the exports-map
 * import sweep). The tri-agreement (pin ⇄ lockfile ⇄ installed) catches the
 * "pin bumped but lockfile lagged, ships old SDK silently" failure class.
 */

import type { FsReader } from './effects.js';
import { type SdkPinConfig, resolveSdkPinConfig } from '../config.js';

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

/** One gate outcome; ok=false carries a human-readable reason. */
export interface GateResult {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface Manifest {
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
  readonly exports?: unknown;
}

function readManifest(fs: FsReader, path: string): Manifest {
  return JSON.parse(fs.readText(path)) as Manifest;
}

/** Read the SDK pin from the configured manifest group. */
export function readSdkPin(fs: FsReader, config: SdkPinConfig): string | null {
  const manifest = readManifest(fs, 'package.json');
  const group = config.pinSource === 'devDependencies' ? manifest.devDependencies : manifest.dependencies;
  const pin = group?.[config.sdkPackage];
  return typeof pin === 'string' ? pin : null;
}

function collectImportSpecifiers(fs: FsReader, roots: readonly string[], sdkPackage: string): string[] {
  const pattern = /(?:from\s+|require\(|import\()\s*['"]([^'"]*goodvibes-sdk[^'"]*)['"]/g;
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: readonly string[];
    try {
      entries = fs.readDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry}`;
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        const text = fs.readText(path);
        for (const match of text.matchAll(pattern)) {
          if (match[1]) found.push(match[1]);
        }
      } else if (!entry.includes('.')) {
        // No extension → treat as a subdirectory to recurse into.
        walk(path);
      }
    }
  };
  for (const root of roots) walk(root);
  return found;
}

/** Build the set of allowed import specifiers from the installed SDK's exports map. */
function allowedExportSpecifiers(fs: FsReader, sdkPackage: string): Set<string> | null {
  const installed = `node_modules/${sdkPackage}/package.json`;
  if (!fs.exists(installed)) return null;
  const manifest = readManifest(fs, installed);
  if (!manifest.exports || typeof manifest.exports !== 'object') return new Set([sdkPackage]);
  const allow = new Set<string>();
  for (const key of Object.keys(manifest.exports as Record<string, unknown>)) {
    if (key === '.') allow.add(sdkPackage);
    else if (key.startsWith('./')) allow.add(`${sdkPackage}/${key.slice(2)}`);
  }
  allow.add(sdkPackage);
  return allow;
}

/**
 * Run every sdk-pin gate and return one result per gate. Pure over the injected
 * FsReader — no process exit, no console. The bin maps results to exit codes.
 */
export function runSdkPinGate(fs: FsReader, partial: Partial<SdkPinConfig> | undefined): GateResult[] {
  const config = resolveSdkPinConfig(partial);
  const results: GateResult[] = [];

  const overlayPresent = fs.exists(config.overlayMarker);
  results.push({
    id: 'local-sdk-overlay-absent',
    ok: !overlayPresent,
    detail: overlayPresent
      ? `dev-link overlay marker present at ${config.overlayMarker} — restore the published SDK before cutting`
      : 'no dev-link overlay marker',
  });

  const pin = readSdkPin(fs, config);
  const pinExact = pin !== null && EXACT_SEMVER.test(pin);
  results.push({
    id: 'sdk-pin-exact-semver',
    ok: pinExact,
    detail: pinExact
      ? `${config.sdkPackage} pinned to ${pin}`
      : `${config.sdkPackage} pin in ${config.pinSource} must be exact X.Y.Z (found: ${pin ?? 'missing'})`,
  });

  if (pinExact && pin) {
    const installedPath = `node_modules/${config.sdkPackage}/package.json`;
    const installedVersion = fs.exists(installedPath)
      ? (readManifest(fs, installedPath) as { version?: string }).version ?? null
      : null;
    results.push({
      id: 'installed-matches-pin',
      ok: installedVersion === pin,
      detail: installedVersion === pin
        ? `installed ${config.sdkPackage}@${installedVersion} matches pin`
        : `installed ${config.sdkPackage}@${installedVersion ?? 'missing'} != pin ${pin} (run install)`,
    });

    const lockPresent = fs.exists(config.lockfile);
    const lockResolves = lockPresent && fs.readText(config.lockfile).includes(`${config.sdkPackage}@${pin}`);
    results.push({
      id: 'lockfile-resolves-pin',
      ok: lockResolves,
      detail: lockResolves
        ? `${config.lockfile} resolves ${config.sdkPackage}@${pin}`
        : `${config.lockfile} does not resolve ${config.sdkPackage}@${pin} — lockfile lagged the pin bump`,
    });
  }

  const specifiers = collectImportSpecifiers(fs, config.sourceRoots, config.sdkPackage);
  const nonNpm = specifiers.filter((s) => !s.startsWith(config.sdkPackage));
  results.push({
    id: 'npm-specifier-only-imports',
    ok: nonNpm.length === 0,
    detail: nonNpm.length === 0
      ? 'all SDK imports use the npm specifier'
      : `non-npm SDK import(s): ${[...new Set(nonNpm)].join(', ')}`,
  });

  if (config.enforceExportsMap) {
    const allow = allowedExportSpecifiers(fs, config.sdkPackage);
    if (allow === null) {
      results.push({
        id: 'exports-map-only-imports',
        ok: true,
        detail: 'installed SDK package.json absent — exports-map check skipped',
      });
    } else {
      const offenders = specifiers.filter((s) => s.startsWith(config.sdkPackage) && !allow.has(s));
      results.push({
        id: 'exports-map-only-imports',
        ok: offenders.length === 0,
        detail: offenders.length === 0
          ? 'all SDK subpath imports resolve to a published exports key'
          : `SDK import(s) not in the published exports map: ${[...new Set(offenders)].join(', ')}`,
      });
    }
  }

  return results;
}
