/**
 * Feature flag and kill switch type definitions for the goodvibes-sdk runtime.
 *
 * These types model the lifecycle of a feature gate from initial declaration
 * through runtime toggling and emergency kill.
 */

/**
 * The three possible states for a feature flag.
 *
 * - `enabled` , the feature is active
 * - `disabled`, the feature is inactive (default for all gates)
 * - `killed`  , the feature has been emergency-killed and cannot be re-enabled
 *                until it is explicitly un-killed
 */
export type FlagState = 'enabled' | 'disabled' | 'killed';

/**
 * Why a REGISTERED capability cannot operate, regardless of how it is
 * configured.
 *
 * - `no-runtime-wiring`, the platform half exists and is tested, but no
 *   surface drives it yet. Typical while an SDK capability lands ahead of the
 *   consumers that will use it, because consumers pin a published SDK version
 *   and cannot compile against it until it publishes.
 * - `missing-host-dependency`, the code is wired, but something the host must
 *   provide (a library, a binary, a device) is absent.
 * - `unsupported-platform`, this operating system or runtime cannot run it.
 */
export type FeatureInoperableReason =
  | 'no-runtime-wiring'
  | 'missing-host-dependency'
  | 'unsupported-platform';

/**
 * A capability that is present in the registry but cannot do anything yet.
 *
 * This exists because the alternative already shipped and reached a user: a
 * settings row that looks like a working switch, flips cleanly, and silently
 * does nothing. A feature carrying this is refused by
 * {@link isFeatureGateEnabled} no matter what its settings key says, so no
 * half-wired path can run, and every surface that renders FEATURE_SETTINGS
 * gets `detail` to show instead of a switch that lies.
 */
export interface FeatureInoperability {
  readonly reason: FeatureInoperableReason;
  /**
   * Written for a user to read in a settings surface, at the moment they try
   * to turn the feature on. States plainly that it is not available and why,
   * never a log line nobody sees.
   */
  readonly detail: string;
}

/**
 * Static declaration of a feature gate.
 *
 * Registered once at startup in `flags.ts`; state transitions are tracked
 * separately by `FeatureFlagManager`.
 */
export interface FeatureFlag {
  /** Unique kebab-case identifier used as the lookup key (e.g. `fetch-sanitization`) */
  id: string;

  /** Human-readable display name */
  name: string;

  /** One-line description of what this gate controls */
  description: string;

  /** Initial state applied on first load when no config override exists */
  defaultState: FlagState;

  /** When killed, this message explains why the flag was killed */
  killReason?: string | undefined;

  /** The implementation tier that introduced this flag (1-based) */
  tier: number;

  /**
   * Whether this flag supports state changes after startup.
   * Set to `false` for gates that can only be configured before the process starts.
   */
  runtimeToggleable: boolean;

  /**
   * Set when the capability cannot operate at all in this build. Absent means
   * it works when enabled, the normal case, so nothing else has to change.
   *
   * Setting this makes the gate refuse the feature regardless of configuration
   * and gives surfaces something honest to render. Remove it in the same
   * change that wires the capability up, never before.
   */
  notOperable?: FeatureInoperability | undefined;
}

/**
 * Persisted flag overrides loaded from the user config file.
 * Overrides are applied on top of each flag's `defaultState`.
 */
export interface FlagConfig {
  /** Map of flag id → desired state; missing keys fall back to `defaultState` */
  flags: Record<string, FlagState>;
}

/**
 * A single state-change record emitted to subscribers and written to the
 * in-memory audit log.
 */
export interface FlagTransition {
  /** The flag that changed */
  flagId: string;

  /** State before the transition */
  previous: FlagState;

  /** State after the transition */
  next: FlagState;

  /** Unix timestamp (ms) when the transition occurred */
  timestamp: number;

  /** Optional reason supplied with a kill operation */
  reason?: string | undefined;
}
