/**
 * toolchain.config contract.
 *
 * Every GoodVibes repo keeps a small `toolchain.config.json` (or a
 * `toolchain.config.ts` that default-exports a {@link ToolchainConfig}) at its
 * root. The published `@pellux/goodvibes-toolchain` package holds the behavior;
 * the config holds the repo-specific values (package names, binary matrix,
 * coverage floors, publish ordering) so one implementation serves every repo.
 *
 * The full contract and per-repo examples are documented in
 * `docs/release-and-publishing.md` (SDK repo).
 */

import { z } from 'zod/v4';

/** Where the SDK dependency pin lives and how the pin gate is parameterized. */
export interface SdkPinConfig {
  /** npm name of the pinned SDK package, e.g. `@pellux/goodvibes-sdk`. */
  readonly sdkPackage: string;
  /** Manifest group the pin is read from. TUI/webui use `dependencies`; the agent bundles the SDK as a `devDependencies` pin. */
  readonly pinSource: 'dependencies' | 'devDependencies';
  /** Lockfile whose text must resolve the pin, e.g. `bun.lock`. */
  readonly lockfile: string;
  /** Path (relative to repo root) of the dev-link overlay marker whose presence blocks a cut. */
  readonly overlayMarker: string;
  /** Source roots scanned for non-npm SDK imports. */
  readonly sourceRoots: readonly string[];
  /** When true, also assert every SDK subpath import resolves to a key in the installed package's `exports` map (webui browser-bundle gate). */
  readonly enforceExportsMap: boolean;
}

/** One row of the compiled-binary build matrix. */
export interface BinaryTarget {
  /** Canonical key, e.g. `linux-x64`. */
  readonly key: string;
  /** `bun build --compile --target` value, e.g. `bun-linux-x64`. */
  readonly bunTarget: string;
  /** Primary binary output name, e.g. `goodvibes-linux-x64`. */
  readonly appArtifact: string;
  /** Optional second binary (the TUI daemon leg), e.g. `goodvibes-daemon-linux-x64`. */
  readonly daemonArtifact?: string;
  /** Optional native-addon package that stays `--external` and is copied beside the binary, e.g. `sqlite-vec-linux-x64`. */
  readonly nativeAddonPackage?: string;
  /** Native-addon filename, e.g. `vec0.so` / `vec0.dylib`. */
  readonly nativeAddonFile?: string;
}

/** build-binaries parameters. */
export interface BuildConfig {
  /** Primary compile entrypoint, e.g. `src/main.ts`. */
  readonly appEntrypoint: string;
  /** Optional daemon compile entrypoint (present only for repos with a daemon leg), e.g. `src/daemon/cli.ts`. */
  readonly daemonEntrypoint?: string;
  /** Output directory for binaries, e.g. `dist`. */
  readonly outDir: string;
  /** Directory for copied native addons, e.g. `dist/lib`. */
  readonly addonOutDir: string;
  /** The build matrix. */
  readonly targets: readonly BinaryTarget[];
  /** Commands run once before compiling (each a full argv), e.g. `[["bun","run","scripts/prebuild.ts"]]`. */
  readonly prebuild: readonly (readonly string[])[];
}

/** coverage-gate ratchet floors and the coverage command. */
export interface CoverageConfig {
  readonly funcsFloor: number;
  readonly linesFloor: number;
  /** argv that emits Bun's text coverage table, e.g. `["bun","test","--coverage","src"]`. */
  readonly command: readonly string[];
}

/** post-build-smoke parameters. */
export interface SmokeConfig {
  /** Expected `--version` banner prefix, e.g. `goodvibes-agent `. */
  readonly bannerPrefix: string;
  /** Substrings whose presence in output signals a packaging failure, e.g. `["sqlite-vec","$bunfs/root"]`. */
  readonly forbiddenStrings: readonly string[];
  /**
   * Default binary path when `--binary` is not passed. Serves LOCAL CLI runs
   * only, CI matrix legs each build a different suffixed artifact, so the
   * reusable binary-matrix workflow always passes the leg's own `--binary`.
   */
  readonly binaryDefault: string;
}

/** release-cut parameters (prepare/bump/changelog/tag only, never re-runs gates). */
export interface ReleaseCutConfig {
  /** Branch a cut is allowed from, e.g. `main`. */
  readonly branch: string;
  /** Extra `package.json` paths (beyond root) whose version is stamped, e.g. platform-package manifests. */
  readonly versionFiles: readonly string[];
  /** Commands that sync generated version surfaces after the bump, e.g. `[["bun","run","scripts/prebuild.ts"]]`. */
  readonly syncCommands: readonly (readonly string[])[];
  /** Paths staged into the release commit. */
  readonly commitPaths: readonly string[];
  /** `bracket` → `## [x.y.z] - DATE`; `plain` → `## x.y.z - DATE`. */
  readonly changelogHeading: 'bracket' | 'plain';
  /** `first-separator` inserts the new section after the first `---`; `top` prepends above all sections. */
  readonly changelogInsertMarker: 'first-separator' | 'top';
}

/** publish-package parameters. */
export interface PublishPackageConfig {
  readonly packageName: string;
  readonly defaultRegistry: string;
  /** Tarball paths that must be present (all of them). */
  readonly requiredTarballPaths: readonly string[];
  /** Tarball path prefixes that must be absent. */
  readonly forbiddenTarballPrefixes: readonly string[];
  /** Hard cap on unpacked tarball size in bytes. */
  readonly maxTarballBytes: number;
}

/** per-job-green parameters. */
export interface PerJobGreenConfig {
  readonly owner: string;
  readonly repo: string;
  /** Workflow file whose run is verified, e.g. `ci.yml`. */
  readonly workflow: string;
  /** Triggering event to match, e.g. `push`. */
  readonly event: string;
  readonly pollIntervalMs: number;
  readonly deadlineMs: number;
  /** Bounded retry attempts applied to EVERY GitHub API call before its status is treated as final. */
  readonly retryAttempts: number;
  /** Sleep between retry attempts. */
  readonly retryDelayMs: number;
}

/** The complete repo config. All sections are optional so a repo declares only the tools it uses. */
export interface ToolchainConfig {
  /** npm name of the repo's primary package, e.g. `@pellux/goodvibes-tui`. */
  readonly packageName: string;
  readonly sdkPin?: SdkPinConfig;
  readonly build?: BuildConfig;
  readonly coverage?: CoverageConfig;
  readonly smoke?: SmokeConfig;
  readonly releaseCut?: ReleaseCutConfig;
  readonly publish?: PublishPackageConfig;
  readonly perJobGreen?: PerJobGreenConfig;
}

export const DEFAULT_SDK_PACKAGE = '@pellux/goodvibes-sdk';
export const DEFAULT_LOCKFILE = 'bun.lock';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const DEFAULT_POLL_INTERVAL_MS = 20_000;
export const DEFAULT_DEADLINE_MS = 1_800_000;
// Default transient-error posture: the GitHub API's observed flaky mode makes
// single-shot calls fail a meaningful fraction of the time, so every call gets
// ~8 bounded attempts with sleeps in the 5-10s band before its status is final.
export const DEFAULT_RETRY_ATTEMPTS = 8;
export const DEFAULT_RETRY_DELAY_MS = 7_000;

/** Fill an SdkPinConfig with the conventional defaults for any missing field. */
export function resolveSdkPinConfig(partial: Partial<SdkPinConfig> | undefined): SdkPinConfig {
  const sdkPackage = partial?.sdkPackage ?? DEFAULT_SDK_PACKAGE;
  return {
    sdkPackage,
    pinSource: partial?.pinSource ?? 'dependencies',
    lockfile: partial?.lockfile ?? DEFAULT_LOCKFILE,
    overlayMarker: partial?.overlayMarker ?? `node_modules/${sdkPackage}/.local-sdk-overlay.json`,
    sourceRoots: partial?.sourceRoots ?? ['src'],
    enforceExportsMap: partial?.enforceExportsMap ?? false,
  };
}

/** Fill a PerJobGreenConfig from a partial plus required identity fields. */
export function resolvePerJobGreenConfig(partial: Partial<PerJobGreenConfig> & Pick<PerJobGreenConfig, 'owner' | 'repo'>): PerJobGreenConfig {
  return {
    owner: partial.owner,
    repo: partial.repo,
    workflow: partial.workflow ?? 'ci.yml',
    event: partial.event ?? 'push',
    pollIntervalMs: partial.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    deadlineMs: partial.deadlineMs ?? DEFAULT_DEADLINE_MS,
    retryAttempts: partial.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
    retryDelayMs: partial.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
  };
}

// Schemas below mirror the interfaces above field-for-field and validate the
// TYPE of each field that is present. `.catchall(z.unknown())` at every level
// keeps unrecognized keys in the parsed result, so a valid config still
// carries whatever extra data the raw JSON contained (matching the old
// cast-through behavior for well-formed input); it is this repo's house
// pattern for "keep unknown keys" (see zod-schemas/events.ts's
// RuntimeEventRecordSchema), preferred over the deprecated `.passthrough()`.
//
// sdkPin and perJobGreen are the two sections with a `resolve*Config`
// function that fills every field from a `Partial<...>` plus defaults, so
// requiredness for those two lives in the resolver, not here: every field
// below is optional and the resolver decides what is missing. The other
// sections (build, coverage, smoke, releaseCut, publish) have no resolver,
// their consumers read the parsed fields directly, so their required fields
// stay required here.
const SdkPinConfigSchema = z.object({
  sdkPackage: z.string().optional(),
  pinSource: z.enum(['dependencies', 'devDependencies']).optional(),
  lockfile: z.string().optional(),
  overlayMarker: z.string().optional(),
  sourceRoots: z.array(z.string()).optional(),
  enforceExportsMap: z.boolean().optional(),
}).catchall(z.unknown());

const BinaryTargetSchema = z.object({
  key: z.string(),
  bunTarget: z.string(),
  appArtifact: z.string(),
  daemonArtifact: z.string().optional(),
  nativeAddonPackage: z.string().optional(),
  nativeAddonFile: z.string().optional(),
}).catchall(z.unknown());

const BuildConfigSchema = z.object({
  appEntrypoint: z.string(),
  daemonEntrypoint: z.string().optional(),
  outDir: z.string(),
  addonOutDir: z.string(),
  targets: z.array(BinaryTargetSchema),
  prebuild: z.array(z.array(z.string())),
}).catchall(z.unknown());

const CoverageConfigSchema = z.object({
  funcsFloor: z.number(),
  linesFloor: z.number(),
  command: z.array(z.string()),
}).catchall(z.unknown());

const SmokeConfigSchema = z.object({
  bannerPrefix: z.string(),
  forbiddenStrings: z.array(z.string()),
  binaryDefault: z.string(),
}).catchall(z.unknown());

const ReleaseCutConfigSchema = z.object({
  branch: z.string(),
  versionFiles: z.array(z.string()),
  syncCommands: z.array(z.array(z.string())),
  commitPaths: z.array(z.string()),
  changelogHeading: z.enum(['bracket', 'plain']),
  changelogInsertMarker: z.enum(['first-separator', 'top']),
}).catchall(z.unknown());

const PublishPackageConfigSchema = z.object({
  packageName: z.string(),
  defaultRegistry: z.string(),
  requiredTarballPaths: z.array(z.string()),
  forbiddenTarballPrefixes: z.array(z.string()),
  maxTarballBytes: z.number(),
}).catchall(z.unknown());

const PerJobGreenConfigSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  workflow: z.string().optional(),
  event: z.string().optional(),
  pollIntervalMs: z.number().optional(),
  deadlineMs: z.number().optional(),
  retryAttempts: z.number().optional(),
  retryDelayMs: z.number().optional(),
}).catchall(z.unknown());

const ToolchainConfigSchema = z.object({
  packageName: z.string().min(1, 'must be a non-empty string'),
  sdkPin: SdkPinConfigSchema.optional(),
  build: BuildConfigSchema.optional(),
  coverage: CoverageConfigSchema.optional(),
  smoke: SmokeConfigSchema.optional(),
  releaseCut: ReleaseCutConfigSchema.optional(),
  publish: PublishPackageConfigSchema.optional(),
  perJobGreen: PerJobGreenConfigSchema.optional(),
}).catchall(z.unknown());

/** Render a `ZodError` as one line per bad field, each naming its path. */
function formatToolchainConfigError(error: z.ZodError): string {
  const problems = error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${field}: ${issue.message}`;
  });
  return `toolchain.config is invalid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`;
}

/**
 * Parse a JSON toolchain config. Kept separate from disk I/O so callers can
 * validate a config object from any source (file, env, test fixture).
 */
export function parseToolchainConfig(raw: string): ToolchainConfig {
  const value: unknown = JSON.parse(raw);
  const result = ToolchainConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(formatToolchainConfigError(result.error));
  }
  return result.data as ToolchainConfig;
}
