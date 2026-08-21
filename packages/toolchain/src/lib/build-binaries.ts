/**
 * build-binaries, compiles standalone binaries for the configured matrix.
 *
 * Absorbs tui/build.ts and agent/build.ts. The TUI's daemon leg (a second
 * `bun build --compile` of a daemon entrypoint per target) is config-driven:
 * a target/build with a `daemonEntrypoint` + `daemonArtifact` builds two
 * binaries, one without builds one. Native addons (sqlite-vec) stay `--external`
 * and are copied beside the binary; a same-platform miss is fatal, a
 * cross-target miss triggers an `npm pack` + `tar` fetch.
 */

import type { Exec, Logger } from './effects.js';
import { realExec, consoleLogger } from './effects.js';
import type { BinaryTarget, BuildConfig } from '../config.js';
import { describeMissingRequired, resolveOptionalExternals, type DependencyManifest } from './optional-externals.js';

/** Resolve which targets to build and whether the daemon leg is forced off/only. */
export interface TargetSelection {
  readonly targets: readonly BinaryTarget[];
  readonly daemonOnly: boolean;
}

/**
 * Resolve the target selection from argv against the matrix.
 * - `--all` → every target.
 * - `--target <key>` → that target; a `daemon-<key>` alias forces daemon-only.
 * - `--daemon-only` → daemon leg only.
 * - none → the native `${platform}-${arch}` row.
 */
export function resolveTargets(argv: readonly string[], config: BuildConfig, nativeKey: string): TargetSelection {
  const byKey = new Map(config.targets.map((t) => [t.key, t]));
  let daemonOnly = argv.includes('--daemon-only');

  if (argv.includes('--all')) {
    return { targets: config.targets, daemonOnly };
  }

  const targetIdx = argv.indexOf('--target');
  if (targetIdx !== -1) {
    let name = argv[targetIdx + 1];
    if (!name) throw new Error('--target requires a value');
    if (name.startsWith('daemon-')) {
      daemonOnly = true;
      name = name.slice('daemon-'.length).replace(/^macos-/, 'darwin-');
    }
    const target = byKey.get(name);
    if (!target) throw new Error(`Unknown target: ${name}`);
    return { targets: [target], daemonOnly };
  }

  const native = byKey.get(nativeKey);
  if (!native) throw new Error(`Unsupported host target: ${nativeKey}`);
  return { targets: [native], daemonOnly };
}

/** Construct the `bun build --compile` argv for one entrypoint. */
export function buildCompileArgs(entrypoint: string, bunTarget: string, outfile: string, externals: readonly string[]): string[] {
  const args = ['build', entrypoint, '--compile', `--target=${bunTarget}`, '--outfile', outfile];
  for (const ext of externals) args.push('--external', ext);
  return args;
}

export interface BuildOutcome {
  readonly key: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface RunBuildOptions {
  readonly cwd: string;
  readonly config: BuildConfig;
  readonly selection: TargetSelection;
  readonly nativeKey: string;
  /** Copies a resolved native addon into place; returns false if it could not be provided. Injected so the real fs copy stays out of the policy. */
  readonly provideAddon?: (target: BinaryTarget, sameHost: boolean) => boolean;
  /**
   * Manifests whose `optionalDependencies` may be externalised and whose
   * `dependencies` must be present. Omit both this and `isPackageInstalled`
   * and the screen does not run at all, which is what every existing caller
   * gets.
   */
  readonly dependencyManifests?: readonly DependencyManifest[];
  /** True when the package resolves from the build root. */
  readonly isPackageInstalled?: (packageName: string) => boolean;
  readonly exec?: Exec;
  readonly logger?: Logger;
}

/** Compile the selected targets. Returns one outcome per target. */
export function runBuildBinaries(options: RunBuildOptions): BuildOutcome[] {
  const exec = options.exec ?? realExec;
  const logger = options.logger ?? consoleLogger;
  const { config, selection, cwd } = options;

  for (const cmd of config.prebuild) {
    const [bin, ...args] = cmd;
    if (!bin) continue;
    const res = exec(bin, args, { cwd });
    if (res.status !== 0) throw new Error(`prebuild failed: ${cmd.join(' ')}\n${res.stderr}`);
  }

  // An optionalDependency that is not installed becomes `--external`, so bun
  // leaves the specifier for runtime and the SDK's own unavailability report
  // governs instead of the bundle failing to resolve. A missing REQUIRED
  // package fails here instead, loudly and by name, see optional-externals.ts
  // for why that asymmetry is the whole point.
  let optionalExternals: readonly string[] = [];
  if (options.dependencyManifests && options.isPackageInstalled) {
    const screened = resolveOptionalExternals({
      manifests: options.dependencyManifests,
      isInstalled: options.isPackageInstalled,
    });
    if (screened.missingRequired.length > 0) throw new Error(describeMissingRequired(screened.missingRequired));
    optionalExternals = screened.externals;
    if (optionalExternals.length > 0) {
      logger.info(
        `[build-binaries] ${optionalExternals.length} optional package(s) not installed, left external, `
        + `the feature reports itself unavailable at runtime: ${optionalExternals.join(', ')}`,
      );
    }
  }

  const outcomes: BuildOutcome[] = [];
  for (const target of selection.targets) {
    const externals = [
      ...(target.nativeAddonPackage ? [target.nativeAddonPackage] : []),
      ...optionalExternals,
    ];
    let ok = true;
    let detail = '';

    if (!selection.daemonOnly) {
      const outfile = `${config.outDir}/${target.appArtifact}`;
      const args = buildCompileArgs(config.appEntrypoint, target.bunTarget, outfile, externals);
      const res = exec('bun', args, { cwd });
      if (res.status !== 0) { ok = false; detail = `app compile failed (${res.status})`; }
    }

    if (ok && config.daemonEntrypoint && target.daemonArtifact) {
      const outfile = `${config.outDir}/${target.daemonArtifact}`;
      const args = buildCompileArgs(config.daemonEntrypoint, target.bunTarget, outfile, externals);
      const res = exec('bun', args, { cwd });
      if (res.status !== 0) { ok = false; detail = `daemon compile failed (${res.status})`; }
    }

    if (ok && target.nativeAddonPackage && target.nativeAddonFile && options.provideAddon) {
      const provided = options.provideAddon(target, target.key === options.nativeKey);
      if (!provided) { ok = false; detail = `native addon ${target.nativeAddonPackage}/${target.nativeAddonFile} unavailable`; }
    }

    outcomes.push({ key: target.key, ok, detail: ok ? 'built' : detail });
    logger.info(`[build-binaries] ${target.key}: ${ok ? 'OK' : `FAILED, ${detail}`}`);
  }
  return outcomes;
}
