/**
 * optional-dependency.ts — loading a package the SDK declares it can live
 * without, and saying so when it is not there.
 *
 * ── The failure this exists to close ──────────────────────────────────────
 *
 * `packages/sdk/package.json` declares thirty packages under
 * `optionalDependencies`. That declaration is a promise: an install that
 * skipped them, or one where a native build failed, still produces a working
 * SDK — the features that need them report themselves unavailable and
 * everything else runs.
 *
 * A STATIC `import … from 'jsdom'` breaks that promise in the only two shapes
 * that ship. Measured in this repository, with `packages/sdk/node_modules/jsdom`
 * removed:
 *
 *   - `bun build packages/sdk/src/platform/daemon/cli.ts --compile` fails with
 *     `error: Could not resolve: "jsdom"`. There is no daemon binary at all.
 *   - Running the same graph from source dies at MODULE INIT with
 *     `Cannot find package 'jsdom'` — before `main()` is entered, before the
 *     activity logger has a destination, and before the fatal-boot handler in
 *     daemon/cli.ts exists to report anything. The daemon is simply gone.
 *
 * The second shape is the same failure mode daemon/fatal-boot-report.ts was
 * written for, one step earlier in boot: a process that stops with nothing
 * useful said. An import that a feature needs must not be able to take the
 * host down before the host can speak.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * A package under `optionalDependencies` is reached through a DYNAMIC import,
 * at the point the feature that needs it is actually used, and a failure to
 * load it becomes an unavailability report rather than a thrown boot error.
 * The result is cached — including the failure — so a missing package costs one
 * resolution attempt per process and not one per call.
 *
 * A dynamic import also keeps a compiled build honest: `bun build --compile`
 * bundles the package when it IS installed, and when it is not, the build
 * still produces a binary that boots and reports the feature missing.
 */

import { summarizeError } from './error-display.js';

/** What happened when the SDK tried to reach an optional package. */
export type OptionalDependencyLoad<T> =
  | { readonly available: true; readonly module: T }
  | { readonly available: false; readonly reason: string };

/** A stable, operator-readable statement of why a feature is unavailable. */
export function optionalDependencyUnavailable(name: string, error: unknown): string {
  return (
    `${name} is not installed, so the feature that needs it is unavailable: ${summarizeError(error)}. `
    + `It is an optional dependency of @pellux/goodvibes-sdk — install it to enable this feature.`
  );
}

const cache = new Map<string, Promise<OptionalDependencyLoad<unknown>>>();

/**
 * Load an optional package once per process and remember the outcome.
 *
 * `name` is the package as declared in `optionalDependencies` and is what the
 * unavailability message names; `load` is the dynamic import itself, written
 * out at the call site so a bundler can still see and bundle the specifier.
 */
export function loadOptionalDependency<T>(
  name: string,
  load: () => Promise<T>,
): Promise<OptionalDependencyLoad<T>> {
  const cached = cache.get(name);
  if (cached) return cached as Promise<OptionalDependencyLoad<T>>;
  const attempt = load().then(
    (module): OptionalDependencyLoad<T> => ({ available: true, module }),
    (error: unknown): OptionalDependencyLoad<T> => ({
      available: false,
      reason: optionalDependencyUnavailable(name, error),
    }),
  );
  cache.set(name, attempt as Promise<OptionalDependencyLoad<unknown>>);
  return attempt;
}

/**
 * Forget every cached outcome. For tests that install or hide a package
 * between cases; nothing in the running platform calls this.
 */
export function resetOptionalDependencyCache(): void {
  cache.clear();
}
