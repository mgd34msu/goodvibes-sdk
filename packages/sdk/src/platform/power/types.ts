/**
 * power/types.ts — the platform sleep-inhibition seam.
 *
 * The SDK had zero power-management integration: scheduling was bare
 * setTimeout, so the host slept mid-work and nothing owned the sleep edge.
 * This seam abstracts the OS inhibitor machinery (Linux logind via
 * systemd-inhibit — an unprivileged logind D-Bus client, never sudo; the
 * macOS IOKit path plugs in behind the same seam) so the PowerManager policy
 * is platform-neutral and fully fixture-testable.
 */

/** The inhibitor classes the platform can request. */
export type PowerInhibitClass = 'idle' | 'sleep' | 'handle-lid-switch';

/** One held OS inhibitor: which requested classes were actually granted. */
export interface PowerInhibitHandle {
  /** The classes the OS genuinely granted (a lid-switch block may be denied). */
  readonly grantedClasses: readonly PowerInhibitClass[];
  /** The requested classes the OS refused (served honestly, never papered over). */
  readonly deniedClasses: readonly PowerInhibitClass[];
  release(): Promise<void>;
}

/** The OS seam. All methods are best-effort; null = nothing could be held. */
export interface PowerPlatformSeam {
  /** Human-readable platform label for state surfaces ("linux-logind", "unavailable"). */
  readonly platform: string;
  /** True when this host can hold inhibitors at all. */
  isAvailable(): Promise<boolean>;
  /**
   * Acquire an inhibitor covering as many of the requested classes as the OS
   * grants. Partial grants return a handle with the honest denied list;
   * a total refusal returns null.
   */
  inhibit(input: {
    readonly classes: readonly PowerInhibitClass[];
    readonly who: string;
    readonly why: string;
  }): Promise<PowerInhibitHandle | null>;
  /**
   * Subscribe to the sleep edge (logind PrepareForSleep). The callback fires
   * with true just before suspend and false on wake. Returns an unsubscribe.
   * Optional: a platform without the signal simply never fires it.
   */
  onPrepareForSleep?(callback: (sleeping: boolean) => void): () => void;
}

/** A no-op seam for platforms without an implementation (honest unavailability). */
export function createUnavailablePowerSeam(reason: string): PowerPlatformSeam {
  return {
    platform: `unavailable (${reason})`,
    isAvailable: async () => false,
    inhibit: async () => null,
  };
}
