/**
 * post-build-smoke — proves a freshly compiled binary boots.
 *
 * Runs `<binary> --version`, asserts the expected banner prefix, and rejects
 * output containing packaging-failure sentinels (e.g. `sqlite-vec`,
 * `$bunfs/root`) that mean a native addon or module failed to bundle.
 */

import type { Exec, ExecResult, Logger } from './effects.js';
import { realExec, consoleLogger } from './effects.js';
import type { SmokeConfig } from '../config.js';

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
}

/** Run the version smoke against a binary path. */
export function runPostBuildSmoke(options: RunSmokeOptions): SmokeResult {
  const exec = options.exec ?? realExec;
  const logger = options.logger ?? consoleLogger;
  logger.info(`[post-build-smoke] ${options.binary} --version`);
  const result = exec(options.binary, ['--version']);
  const evaluated = evaluateSmokeOutput(result, options.config);
  (evaluated.ok ? logger.info : logger.error)(`[post-build-smoke] ${evaluated.detail}`);
  return evaluated;
}
