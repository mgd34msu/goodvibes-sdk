/**
 * package-install-check — static verification of a package as it would install.
 *
 * Inspects the `npm pack --json --dry-run` tarball for required and forbidden
 * paths and a size cap, and verifies each bin shim exists, is executable, and
 * carries the expected shebang. Static — the actual install-into-temp smoke is
 * a separate tool/CI job.
 */

import type { Exec, FsReader, Logger } from './effects.js';
import { realExec, realFsReader, consoleLogger } from './effects.js';
import type { PublishPackageConfig } from '../config.js';

export interface PathPolicyResult {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly forbidden: readonly string[];
  readonly oversize: boolean;
}

/** Check a packed file list + unpacked size against the tarball policy. Pure. */
export function evaluateTarballPaths(
  files: readonly string[],
  unpackedBytes: number,
  config: Pick<PublishPackageConfig, 'requiredTarballPaths' | 'forbiddenTarballPrefixes' | 'maxTarballBytes'>,
): PathPolicyResult {
  const present = new Set(files);
  const missing = config.requiredTarballPaths.filter((p) => !present.has(p));
  const forbidden = files.filter((f) => config.forbiddenTarballPrefixes.some((prefix) => f.startsWith(prefix)));
  const oversize = unpackedBytes > config.maxTarballBytes;
  return { ok: missing.length === 0 && forbidden.length === 0 && !oversize, missing, forbidden, oversize };
}

export interface BinCheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/** Verify one bin shim: present, executable, and has the expected shebang. */
export function evaluateBinShim(fs: FsReader, path: string, name: string, shebang: string): BinCheckResult {
  const issues: string[] = [];
  if (!fs.exists(path)) {
    return { name, ok: false, issues: [`bin ${name} missing at ${path}`] };
  }
  if (!fs.isExecutable(path)) issues.push(`bin ${name} is not executable`);
  const text = fs.readText(path);
  if (!text.startsWith(shebang)) issues.push(`bin ${name} does not start with "${shebang}"`);
  return { name, ok: issues.length === 0, issues };
}

interface NpmPackResult {
  readonly files?: readonly { readonly path: string }[];
  readonly size?: number;
  readonly unpackedSize?: number;
}

/** Parse `npm pack --json` output into a file list and unpacked size. */
export function parseNpmPack(output: string): { files: string[]; unpackedBytes: number } {
  const parsed = JSON.parse(output) as readonly NpmPackResult[];
  const first = parsed[0];
  return {
    files: (first?.files ?? []).map((f) => f.path),
    unpackedBytes: first?.unpackedSize ?? first?.size ?? 0,
  };
}

export interface InstallCheckOptions {
  readonly cwd: string;
  readonly config: PublishPackageConfig;
  readonly bins?: readonly { readonly name: string; readonly path: string; readonly shebang: string }[];
  readonly exec?: Exec;
  readonly fs?: FsReader;
  readonly logger?: Logger;
}

export interface InstallCheckResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/** Run the full static install check. */
export function runPackageInstallCheck(options: InstallCheckOptions): InstallCheckResult {
  const exec = options.exec ?? realExec;
  const fs = options.fs ?? realFsReader(options.cwd);
  const logger = options.logger ?? consoleLogger;
  const issues: string[] = [];

  for (const bin of options.bins ?? []) {
    const result = evaluateBinShim(fs, bin.path, bin.name, bin.shebang);
    issues.push(...result.issues);
  }

  const pack = exec('npm', ['pack', '--json', '--dry-run'], { cwd: options.cwd });
  if (pack.status !== 0) {
    issues.push(`npm pack --dry-run failed: ${pack.stderr.trim().slice(0, 300)}`);
    return { ok: false, issues };
  }
  const { files, unpackedBytes } = parseNpmPack(pack.stdout);
  const policy = evaluateTarballPaths(files, unpackedBytes, options.config);
  if (policy.missing.length > 0) issues.push(`missing required tarball path(s): ${policy.missing.join(', ')}`);
  if (policy.forbidden.length > 0) issues.push(`forbidden tarball path(s): ${policy.forbidden.slice(0, 5).join(', ')}`);
  if (policy.oversize) issues.push(`tarball exceeds ${options.config.maxTarballBytes} bytes`);

  const ok = issues.length === 0;
  logger.info(ok ? `[package-install-check] OK (${files.length} files)` : `[package-install-check] ${issues.length} issue(s)`);
  return { ok, issues };
}
