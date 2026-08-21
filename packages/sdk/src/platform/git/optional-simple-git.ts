/**
 * optional-simple-git.ts, the one place `simple-git` is reached.
 *
 * The package is declared under `optionalDependencies` in
 * packages/sdk/package.json, and three modules imported it statically:
 * git/service.ts and workspace/checkpoint/side-git.ts each built their client
 * in a CONSTRUCTOR, and agents/worktree.ts called `simpleGit(...)` inline in
 * its async methods. All three are on the daemon's graph, so an install
 * without the package did not lose git integration, it lost the daemon at
 * module init, before anything could report why (see
 * utils/optional-dependency.ts for the measured failure).
 *
 * The specifier below is written out literally so a bundler still sees it and
 * bundles the package when it IS installed; only the moment of evaluation
 * moves from module init to the first git call.
 */

import type { SimpleGit, SimpleGitOptions } from 'simple-git';
import { loadOptionalDependency } from '../utils/optional-dependency.js';

/**
 * Build a `simple-git` instance, or throw an error whose message states that
 * the package is missing and that it is an optional dependency of the SDK.
 * Every caller is inside an async method, so the throw reaches the caller's
 * existing error path rather than a constructor nobody can catch around.
 */
export async function createSimpleGit(
  options?: string | Partial<SimpleGitOptions>,
): Promise<SimpleGit> {
  const loaded = await loadOptionalDependency('simple-git', () => import('simple-git'));
  if (!loaded.available) throw new Error(loaded.reason);
  return loaded.module.simpleGit(options);
}

/** Whether git integration can run in this installation, and why not. */
export interface SimpleGitAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

/**
 * Report whether `simple-git` is installed without building a client. The
 * outcome is cached per process by utils/optional-dependency.ts, so this costs
 * one resolution attempt.
 */
export async function describeSimpleGitAvailability(): Promise<SimpleGitAvailability> {
  const loaded = await loadOptionalDependency('simple-git', () => import('simple-git'));
  return loaded.available ? { available: true } : { available: false, reason: loaded.reason };
}
