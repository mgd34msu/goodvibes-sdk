/**
 * post-build-smoke — proves a freshly compiled binary boots.
 *
 * Runs `<binary> --version`, asserts the expected banner prefix, and rejects
 * output containing packaging-failure sentinels (e.g. `sqlite-vec`,
 * `$bunfs/root`) that mean a native addon or module failed to bundle.
 *
 * Also scans the artifact itself for top-level eager namespace-object reads
 * (`var X = exports_Y.Z;` at column 0 of the embedded bundle). Bun's bundler
 * emits module bodies in a nondeterministic order build-to-build; an eager
 * module-scope read off a lazy namespace object can therefore land before the
 * module that defines the binding, and the binary dies at load with a
 * ReferenceError — on SOME builds and not others. A binary that boots once is
 * safe forever (the order is baked at build time), but the pattern itself is a
 * per-build lottery, so its presence fails the smoke even when this particular
 * build happened to boot.
 */

import { readFileSync } from 'node:fs';
import type { Exec, ExecResult, Logger } from './effects.js';
import { realExec, consoleLogger } from './effects.js';
import type { SmokeConfig } from '../config.js';

/**
 * Top-level (column-0) eager read off a bundler lazy-namespace object. Reads
 * nested inside `__esm` init closures are indented and therefore not matched:
 * those run after the graph settles and are safe.
 */
const EAGER_NAMESPACE_READ = /(?:^|\n)var ([A-Za-z_$][\w$]*) = (exports_[A-Za-z_$][\w$]*)\.([\w$]+)/g;

/**
 * Scan bundler output (a plain bundle or the JS embedded in a compiled
 * binary) for top-level eager namespace reads. Returns one human-readable
 * description per offending read, capped at `limit`. Pure.
 */
export function scanArtifactForEagerNamespaceReads(artifactText: string, limit = 8): string[] {
  const hits: string[] = [];
  for (const match of artifactText.matchAll(EAGER_NAMESPACE_READ)) {
    hits.push(`var ${match[1]} = ${match[2]}.${match[3]}`);
    if (hits.length >= limit) break;
  }
  return hits;
}

export interface SmokeResult {
  readonly ok: boolean;
  readonly detail: string;
}

/** Evaluate a captured `--version` run against the smoke policy. Pure. */
export function evaluateSmokeOutput(result: ExecResult, config: Pick<SmokeConfig, 'bannerPrefix' | 'forbiddenStrings'>): SmokeResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) {
    return { ok: false, detail: `binary exited ${result.status}: ${combined.trim().slice(0, 400)}` };
  }
  const forbidden = config.forbiddenStrings.find((s) => combined.includes(s));
  if (forbidden) {
    return { ok: false, detail: `output contains packaging-failure sentinel "${forbidden}"` };
  }
  if (!result.stdout.trimStart().startsWith(config.bannerPrefix)) {
    return { ok: false, detail: `version banner does not start with "${config.bannerPrefix}": ${result.stdout.trim().slice(0, 200)}` };
  }
  return { ok: true, detail: `version banner OK: ${result.stdout.trim().slice(0, 120)}` };
}

export interface RunSmokeOptions {
  readonly binary: string;
  readonly config: SmokeConfig;
  readonly exec?: Exec;
  readonly logger?: Logger;
  /** Reads the artifact bytes for the eager-namespace-read scan. Injectable for tests. */
  readonly readArtifact?: (path: string) => string;
}

/** Run the version smoke against a binary path. */
export function runPostBuildSmoke(options: RunSmokeOptions): SmokeResult {
  const exec = options.exec ?? realExec;
  const logger = options.logger ?? consoleLogger;
  const readArtifact = options.readArtifact ?? ((path: string) => readFileSync(path, 'latin1'));
  logger.info(`[post-build-smoke] ${options.binary} --version`);
  const result = exec(options.binary, ['--version']);
  const evaluated = evaluateSmokeOutput(result, options.config);
  if (!evaluated.ok) {
    logger.error(`[post-build-smoke] ${evaluated.detail}`);
    return evaluated;
  }
  let eagerReads: string[];
  try {
    eagerReads = scanArtifactForEagerNamespaceReads(readArtifact(options.binary));
  } catch (error) {
    const failed: SmokeResult = { ok: false, detail: `artifact scan could not read ${options.binary}: ${error instanceof Error ? error.message : String(error)}` };
    logger.error(`[post-build-smoke] ${failed.detail}`);
    return failed;
  }
  if (eagerReads.length > 0) {
    const failed: SmokeResult = {
      ok: false,
      detail: `artifact contains ${eagerReads.length}${eagerReads.length >= 8 ? '+' : ''} top-level eager namespace read(s) — a build-order lottery that can die at load on the next rebuild: ${eagerReads.slice(0, 3).join('; ')}`,
    };
    logger.error(`[post-build-smoke] ${failed.detail}`);
    return failed;
  }
  logger.info(`[post-build-smoke] ${evaluated.detail}`);
  return evaluated;
}
