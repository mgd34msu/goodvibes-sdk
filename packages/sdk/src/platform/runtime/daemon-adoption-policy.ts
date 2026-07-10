/**
 * daemon-adoption-policy.ts — the SHARED adopt-or-spawn DECISION policy.
 *
 * Find an already-running compatible daemon and attach to it, else spawn one (or,
 * under an adopt-only policy, run without one). The probing/spawn I/O lives in
 * bootstrap-services.ts behind injectable seams; THIS module is the pure decision
 * every consumer routes through, so the ruling is identical everywhere and unit
 * testable without real sockets or child processes.
 *
 * HOIST CONTEXT. The TUI already drives the full spawn-or-adopt path through the
 * SDK. The agent bypassed it with a stub that hard-declared `external` and never
 * probed, never version-checked, and never spawned. Two of those divergences are
 * risks, not choices, and this policy removes them:
 *   - A compatible-daemon check is ALWAYS applied before adopting (the agent
 *     skipped it and would adopt a wire-incompatible daemon).
 *   - A probe is always the source of truth for "is a daemon there and mine"
 *     (no pid/lockfile is trusted; that is the caller's discovery hint only).
 * The one genuine choice — own the daemon lifecycle (spawn) vs never own it
 * (adopt-only) — is expressed as the `adoptOnly` flag rather than a wholesale
 * function override.
 */

/** Result of probing the occupant of the configured daemon host/port. */
export interface DaemonIdentityProbeResult {
  readonly kind: 'goodvibes' | 'unauthorized' | 'unknown';
  readonly status?: string | undefined;
  readonly version?: string | undefined;
  readonly reason?: string | undefined;
}

/** How a probed occupant is classified against this surface. */
export type DaemonProbeClassification = 'adopt' | 'incompatible' | 'blocked';

export interface DaemonProbeClassificationInput {
  readonly identity: DaemonIdentityProbeResult;
  /** This surface's own version. */
  readonly localVersion: string;
  /** Version band predicate (defaults to the shared band policy at the call site). */
  readonly versionCompatible: (localVersion: string, remoteVersion: string | undefined) => boolean;
}

/**
 * Classify the occupant of the configured port:
 *   - a verified GoodVibes daemon on a compatible version band → `adopt`;
 *   - a verified GoodVibes daemon on an INCOMPATIBLE band → `incompatible`
 *     (never adopt, never start a competitor);
 *   - anything unverified (unauthorized/unknown) → `blocked`.
 *
 * The version band-check is UNCONDITIONAL here: `goodvibes` proves it is a
 * GoodVibes daemon, not that it speaks a wire version this surface can adopt.
 */
export function classifyDaemonProbe(input: DaemonProbeClassificationInput): DaemonProbeClassification {
  if (input.identity.kind !== 'goodvibes') return 'blocked';
  return input.versionCompatible(input.localVersion, input.identity.version) ? 'adopt' : 'incompatible';
}

/** The action the adopt-or-spawn policy selects. */
export type DaemonAdoptionAction =
  | 'disabled'      // daemon.enabled is false
  | 'adopt'         // a compatible GoodVibes daemon is already running — attach
  | 'incompatible'  // a GoodVibes daemon is running on an incompatible band — refuse both adopt and spawn
  | 'blocked'       // the port is occupied by an unverified process — continue without a daemon
  | 'spawn'         // port free — spawn a detached daemon (default lifecycle ownership)
  | 'embed'         // port free — host the daemon in this process (embedInProcess opt-in)
  | 'adopt-only-idle'; // port free + adopt-only policy — do not spawn; run without a local daemon

export interface DaemonAdoptionDecision {
  readonly action: DaemonAdoptionAction;
  /** Honest, human-readable reason for the chosen action. */
  readonly reason: string;
  /** The probe result, when the port was occupied. */
  readonly identity?: DaemonIdentityProbeResult | undefined;
}

export interface DaemonAdoptionPolicyInput {
  /** Whether the daemon is enabled for this surface (daemon.enabled). */
  readonly enabled: boolean;
  /** Whether the configured host/port is currently accepting connections. */
  readonly portInUse: boolean;
  /** The identity probe of the occupant — required when `portInUse`, ignored otherwise. */
  readonly identity: DaemonIdentityProbeResult | null;
  readonly localVersion: string;
  readonly versionCompatible: (localVersion: string, remoteVersion: string | undefined) => boolean;
  /** Host the daemon in-process when the port is free (Layer 3 opt-in). Ignored under adopt-only. */
  readonly embedInProcess: boolean;
  /**
   * Adopt-only policy: attach to a compatible running daemon but NEVER spawn or
   * embed one. This surface does not own the daemon lifecycle. Default false.
   */
  readonly adoptOnly: boolean;
}

/**
 * Decide adopt-or-spawn from probe results + config. Pure. The caller maps the
 * returned action onto its I/O (adopt = keep external status, spawn = detached
 * spawn, embed = in-process, etc.) and supplies the surface-specific status
 * strings — this function owns only the ruling, so it is identical for every
 * consumer.
 */
export function decideDaemonAdoption(input: DaemonAdoptionPolicyInput): DaemonAdoptionDecision {
  if (!input.enabled) {
    return { action: 'disabled', reason: 'daemon.enabled is false' };
  }

  if (input.portInUse) {
    const identity = input.identity ?? { kind: 'unknown', reason: 'Configured daemon port is occupied by an unverified process' };
    const classification = classifyDaemonProbe({
      identity,
      localVersion: input.localVersion,
      versionCompatible: input.versionCompatible,
    });
    if (classification === 'adopt') {
      return { action: 'adopt', identity, reason: 'A compatible GoodVibes daemon is already running on the configured host/port' };
    }
    if (classification === 'incompatible') {
      return { action: 'incompatible', identity, reason: 'A GoodVibes daemon is running on an incompatible version band; refusing to adopt or start a competing daemon' };
    }
    return { action: 'blocked', identity, reason: identity.reason ?? 'Configured daemon port is occupied by an unverified process' };
  }

  // Port is free.
  if (input.adoptOnly) {
    return { action: 'adopt-only-idle', reason: 'adopt-only policy: no compatible daemon on the configured host/port, and this surface does not spawn one' };
  }
  if (input.embedInProcess) {
    return { action: 'embed', reason: 'Embedded daemon started in this host instance (daemon.embedInProcess opt-in)' };
  }
  return { action: 'spawn', reason: 'No daemon on the configured host/port; spawning a detached daemon for this session' };
}
