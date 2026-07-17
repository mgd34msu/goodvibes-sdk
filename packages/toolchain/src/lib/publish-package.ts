/**
 * publish-package — idempotent npm publish + post-publish propagation poll.
 *
 * One implementation of the publish concern with a single set of constants.
 * Idempotency: if the exact name@version is already on the registry, skip
 * (re-runs are safe). Propagation poll: after publish, wait until the registry
 * actually serves the new version before downstream jobs depend on it.
 */

import { existsSync } from 'node:fs';
import type { Exec, Logger, Sleep } from './effects.js';
import { realExec, consoleLogger, realSleep } from './effects.js';
import { DEFAULT_REGISTRY } from '../config.js';

/** Query the published version of name@version; null when absent (or on error). */
export function getPublishedVersion(exec: Exec, name: string, version: string, registry: string): string | null {
  const res = exec('npm', ['view', `${name}@${version}`, 'version', '--registry', registry]);
  if (res.status !== 0) return null;
  const out = res.stdout.trim();
  return out.length > 0 ? out : null;
}

export interface PublishOptions {
  readonly cwd: string;
  readonly name: string;
  readonly version: string;
  readonly registry?: string;
  readonly dryRun?: boolean;
  /**
   * When set, publish this prebuilt tarball (`npm publish <tarballPath>`)
   * instead of packing and publishing `cwd`. Used by repos whose npm bytes are
   * produced by a separate pack job (e.g. the agent bundles a runtime before
   * `bun pm pack`), so the publish must ship the staged .tgz rather than a bare
   * checkout. The path must exist and be a readable `.tgz`.
   */
  readonly tarballPath?: string;
  readonly exec?: Exec;
  /** File-existence seam (defaults to node `existsSync`) so tarball validation is testable. */
  readonly fileExists?: (path: string) => boolean;
  readonly logger?: Logger;
}

export interface PublishResult {
  readonly ok: boolean;
  readonly skipped: boolean;
  readonly detail: string;
}

/** Publish the package in `cwd`, skipping if already published. */
export function runPublishPackage(options: PublishOptions): PublishResult {
  const exec = options.exec ?? realExec;
  const logger = options.logger ?? consoleLogger;
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const fileExists = options.fileExists ?? existsSync;
  const tarball = options.tarballPath;

  if (tarball !== undefined) {
    // Tarball mode: publish a prebuilt .tgz. Validate the flag value — the file
    // must exist and be a `.tgz` — before doing anything with it. `npm pack
    // --dry-run` is meaningless here (there is nothing to pack), so a dry run
    // just confirms the staged tarball is present and readable.
    if (!tarball.endsWith('.tgz') || !fileExists(tarball)) {
      return { ok: false, skipped: false, detail: `tarball not found or not a .tgz: ${tarball}` };
    }
    if (options.dryRun) {
      return { ok: true, skipped: false, detail: `dry-run: tarball present (${tarball})` };
    }
    const alreadyTarball = getPublishedVersion(exec, options.name, options.version, registry);
    if (alreadyTarball === options.version) {
      logger.info(`[publish-package] ${options.name}@${options.version} already published — skipping`);
      return { ok: true, skipped: true, detail: 'already published' };
    }
    const res = exec('npm', ['publish', tarball, '--access', 'public', '--registry', registry], { cwd: options.cwd });
    if (res.status !== 0) {
      return { ok: false, skipped: false, detail: `npm publish failed: ${res.stderr.trim().slice(0, 400)}` };
    }
    logger.info(`[publish-package] published ${options.name}@${options.version} from ${tarball}`);
    return { ok: true, skipped: false, detail: 'published' };
  }

  if (options.dryRun) {
    const res = exec('npm', ['pack', '--json'], { cwd: options.cwd });
    return { ok: res.status === 0, skipped: false, detail: res.status === 0 ? 'dry-run pack ok' : `dry-run pack failed: ${res.stderr.trim()}` };
  }

  const already = getPublishedVersion(exec, options.name, options.version, registry);
  if (already === options.version) {
    logger.info(`[publish-package] ${options.name}@${options.version} already published — skipping`);
    return { ok: true, skipped: true, detail: 'already published' };
  }

  const res = exec('npm', ['publish', '--access', 'public', '--registry', registry], { cwd: options.cwd });
  if (res.status !== 0) {
    return { ok: false, skipped: false, detail: `npm publish failed: ${res.stderr.trim().slice(0, 400)}` };
  }
  logger.info(`[publish-package] published ${options.name}@${options.version}`);
  return { ok: true, skipped: false, detail: 'published' };
}

export interface PropagationOptions {
  readonly name: string;
  readonly version: string;
  readonly registry?: string;
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly exec?: Exec;
  readonly sleep?: Sleep;
  readonly logger?: Logger;
}

export interface PropagationResult {
  readonly ok: boolean;
  readonly attempts: number;
  readonly detail: string;
}

/** Poll the registry until name@version resolves, or attempts are exhausted. */
export async function pollPropagation(options: PropagationOptions): Promise<PropagationResult> {
  const exec = options.exec ?? realExec;
  const sleep = options.sleep ?? realSleep;
  const logger = options.logger ?? consoleLogger;
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const attempts = options.attempts ?? 48;
  const delayMs = options.delayMs ?? 5000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const published = getPublishedVersion(exec, options.name, options.version, registry);
    if (published === options.version) {
      return { ok: true, attempts: attempt, detail: `${options.name}@${options.version} resolvable after ${attempt} attempt(s)` };
    }
    logger.info(`[publish-package] propagation ${attempt}/${attempts}: ${options.name}@${options.version} not yet resolvable`);
    if (attempt < attempts) await sleep(delayMs);
  }
  return { ok: false, attempts, detail: `${options.name}@${options.version} did not propagate within ${attempts} attempt(s)` };
}
