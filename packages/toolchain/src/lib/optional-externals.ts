/**
 * optional-externals, a compiled build must survive a package the manifest
 * says is optional, and must not survive one it says is required.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * `@pellux/goodvibes-sdk` declares thirty packages under
 * `optionalDependencies`. The SDK now reaches every one of them through a
 * dynamic import, so a RUNNING process without them reports the affected
 * feature unavailable and carries on. Measured against the real daemon binary
 * with `jsdom` and `@mozilla/readability` unresolvable at runtime: exit 1 with
 * 896 bytes on stderr naming the operator's actual problem, where the static
 * shape had died at module init with 109 bytes saying only
 * `Cannot find module '@mozilla/readability'`.
 *
 * The BUILD did not get the same treatment, because bun resolves a dynamic
 * `import('pkg')` at bundle time exactly as it resolves a static one. Measured
 * with the package absent:
 *
 *   bun build …/daemon/cli.ts --compile
 *     → error: Could not resolve: "jsdom"
 *
 * So an install that legitimately skipped an optional package could not
 * produce a binary at all, and the lazy runtime resolution the SDK had just
 * gained never got the chance to govern. The declaration only becomes true
 * when the compile honours it too.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * For every package a manifest declares OPTIONAL and that is not installed,
 * the compile passes `--external <pkg>`: bun leaves the specifier for runtime,
 * the binary is produced, and the SDK's own unavailability report is what the
 * operator sees. An optional package that IS installed is left alone and gets
 * bundled, which is what makes a normal build byte-for-byte what it was.
 *
 * For every package a manifest declares REQUIRED and that is not installed,
 * the build FAILS, by name and by manifest. Externalising that one would trade
 * a loud build failure for a binary that dies in the field, the exact trade
 * this whole line of work exists to undo.
 */

import type { FsReader } from './effects.js';

/** One manifest's dependency declarations, as the compile path needs them. */
export interface DependencyManifest {
  /** Package the declarations came from, e.g. `@pellux/goodvibes-sdk`. */
  readonly name: string;
  /** Where it was read from, quoted in failure messages so the fix is locatable. */
  readonly path: string;
  /** Declared as needed: `dependencies`. */
  readonly required: readonly string[];
  /** Declared as skippable: `optionalDependencies`. */
  readonly optional: readonly string[];
}

/** A required package that is not installed, and who asked for it. */
export interface MissingRequired {
  readonly packageName: string;
  readonly declaredBy: string;
  readonly manifestPath: string;
}

export interface OptionalExternalsResult {
  /** `--external` arguments for optional packages that are absent. */
  readonly externals: readonly string[];
  /** Required packages that are absent. A non-empty list must fail the build. */
  readonly missingRequired: readonly MissingRequired[];
}

export interface OptionalExternalsInput {
  readonly manifests: readonly DependencyManifest[];
  /** True when the package can be resolved from the build root. */
  readonly isInstalled: (packageName: string) => boolean;
}

/**
 * Split every declared dependency into "externalise it" and "fail the build".
 *
 * A package declared optional by one manifest and required by another is
 * treated as REQUIRED: the stricter declaration wins, because the manifest
 * that needs it is the one that breaks without it.
 */
export function resolveOptionalExternals(input: OptionalExternalsInput): OptionalExternalsResult {
  const required = new Set<string>();
  for (const manifest of input.manifests) {
    for (const name of manifest.required) required.add(name);
  }

  const installed = new Map<string, boolean>();
  const resolveOnce = (name: string): boolean => {
    const cached = installed.get(name);
    if (cached !== undefined) return cached;
    const present = input.isInstalled(name);
    installed.set(name, present);
    return present;
  };

  const externals: string[] = [];
  const seenExternal = new Set<string>();
  for (const manifest of input.manifests) {
    for (const name of manifest.optional) {
      if (required.has(name) || seenExternal.has(name)) continue;
      if (resolveOnce(name)) continue;
      seenExternal.add(name);
      externals.push(name);
    }
  }

  const missingRequired: MissingRequired[] = [];
  const seenMissing = new Set<string>();
  for (const manifest of input.manifests) {
    for (const name of manifest.required) {
      if (seenMissing.has(name) || resolveOnce(name)) continue;
      seenMissing.add(name);
      missingRequired.push({ packageName: name, declaredBy: manifest.name, manifestPath: manifest.path });
    }
  }

  return { externals: externals.sort(), missingRequired };
}

/** The message a build failure prints. Named packages, named manifests, one instruction. */
export function describeMissingRequired(missing: readonly MissingRequired[]): string {
  const lines = missing.map((m) => `  ${m.packageName}, required by ${m.declaredBy} (${m.manifestPath})`);
  return [
    `build-binaries: ${missing.length} required package(s) are not installed:`,
    ...lines,
    '  These are declared as dependencies, not optionalDependencies, so they are NOT externalised:',
    '  a binary built without them would fail in the field instead of here. Run the install and rebuild.',
  ].join('\n');
}

/** Parse one package.json into the declarations the compile path reads. */
export function readDependencyManifest(fs: FsReader, path: string, fallbackName: string): DependencyManifest | null {
  if (!fs.exists(path)) return null;
  let parsed: { name?: unknown; dependencies?: unknown; optionalDependencies?: unknown };
  try {
    parsed = JSON.parse(fs.readText(path)) as typeof parsed;
  } catch {
    // An unreadable manifest is not a silent pass: the caller gets nothing to
    // externalise from it, so the compile behaves exactly as it did before this
    // existed rather than pretending it screened something.
    return null;
  }
  const names = (value: unknown): string[] => (
    value !== null && typeof value === 'object' ? Object.keys(value as Record<string, unknown>) : []
  );
  return {
    name: typeof parsed.name === 'string' ? parsed.name : fallbackName,
    path,
    // Workspace and file protocols are local links, not registry installs; a
    // build root that resolves them at all resolves them the same way it always
    // did, and screening them here would only produce false failures in a
    // monorepo checkout.
    required: names(parsed.dependencies).filter((name) => !name.startsWith('@pellux/')),
    optional: names(parsed.optionalDependencies),
  };
}
