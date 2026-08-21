/**
 * supervisor.ts, the restart policy for a wake-word detector process.
 *
 * The detector holds a microphone open for as long as the user has it on, so
 * the failure that matters is not one crash, it is a crash LOOP. A process
 * that dies on startup and is restarted immediately becomes a storm that pins a
 * core, spams the log, and repeatedly grabs and releases the capture device.
 *
 * The policy is the one already used for MCP clients, expressed as pure state
 * so it can be tested without spawning anything:
 *
 *  - restart after `restartBackoffMs * attempt` (linear, so 2 s, 4 s, 6 s),
 *  - allow at most `maxRestarts` restarts within a rolling
 *    `crashWindowSeconds` window,
 *  - exceeding that LATCHES the supervisor off with a stated reason, rather
 *    than continuing to try, so the user sees a detector that stopped and why
 *    instead of one that thrashes silently,
 *  - a crash older than the window is forgotten, so a process that runs for an
 *    hour and then dies gets its full restart budget again.
 *
 * Time is injected. Nothing here reads a clock, spawns a process, or sleeps.
 */

/** Supervisor tuning, mirroring the `voice.wake.*` rows that drive it. */
export interface WakeSupervisorPolicy {
  /** Restarts allowed inside the crash window. 0 means any crash is terminal. */
  readonly maxRestarts: number;
  /** Base delay before a restart, multiplied by the attempt number. */
  readonly restartBackoffMs: number;
  /** Rolling window, in seconds, over which crashes are counted. */
  readonly crashWindowSeconds: number;
}

/** Defaults matching the shipped `voice.wake.*` rows. */
export const WAKE_SUPERVISOR_DEFAULTS: WakeSupervisorPolicy = {
  maxRestarts: 3,
  restartBackoffMs: 2000,
  crashWindowSeconds: 60,
};

/** What the supervisor decided to do about a crash. */
export type WakeRestartDecision =
  /** Restart after `delayMs`; this is attempt `attempt` inside the window. */
  | { readonly kind: 'restart'; readonly delayMs: number; readonly attempt: number }
  /** Give up. `reason` is written for a user to read, not only a log. */
  | { readonly kind: 'latched'; readonly reason: string; readonly crashes: number };

/** Current supervisor state, for a status surface. */
export interface WakeSupervisorState {
  readonly running: boolean;
  readonly latched: boolean;
  readonly latchReason: string | null;
  /** Crashes still inside the rolling window. */
  readonly recentCrashes: number;
  /** Total crashes since the supervisor was created or cleared. */
  readonly totalCrashes: number;
  /** Total restarts issued since the supervisor was created or cleared. */
  readonly totalRestarts: number;
}

/**
 * Crash accounting for one supervised detector. Holds no process handle: the
 * caller owns spawning and killing, and asks this object what to do.
 */
export class WakeSupervisor {
  readonly #policy: WakeSupervisorPolicy;
  #crashTimes: number[] = [];
  #running = false;
  #latchReason: string | null = null;
  #totalCrashes = 0;
  #totalRestarts = 0;

  constructor(policy: Partial<WakeSupervisorPolicy> = {}) {
    const merged: WakeSupervisorPolicy = { ...WAKE_SUPERVISOR_DEFAULTS, ...policy };
    if (merged.maxRestarts < 0) {
      throw new Error(`[wake] maxRestarts cannot be negative, got ${merged.maxRestarts}`);
    }
    if (merged.crashWindowSeconds <= 0) {
      throw new Error(`[wake] crashWindowSeconds must be positive, got ${merged.crashWindowSeconds}`);
    }
    this.#policy = merged;
  }

  /** The policy in force, after defaults were merged in. */
  get policy(): WakeSupervisorPolicy {
    return this.#policy;
  }

  /** True once the supervisor has given up and will not restart again. */
  get latched(): boolean {
    return this.#latchReason !== null;
  }

  /** Why the supervisor gave up, or null while it has not. */
  get latchReason(): string | null {
    return this.#latchReason;
  }

  /** Snapshot for a status surface. `now` prunes the rolling window first. */
  state(now: number): WakeSupervisorState {
    this.#prune(now);
    return {
      running: this.#running,
      latched: this.latched,
      latchReason: this.#latchReason,
      recentCrashes: this.#crashTimes.length,
      totalCrashes: this.#totalCrashes,
      totalRestarts: this.#totalRestarts,
    };
  }

  /**
   * Record that the process started successfully. Does NOT clear the crash
   * window: a process that starts and immediately dies would otherwise reset
   * its own budget on every attempt and loop forever.
   */
  noteStarted(): void {
    this.#running = true;
  }

  /**
   * Record a crash and decide what to do. Returns `latched` once the budget is
   * spent, and keeps returning it, the decision is sticky until
   * {@link clearLatch}.
   */
  noteCrashed(now: number): WakeRestartDecision {
    this.#running = false;
    this.#totalCrashes += 1;
    if (this.#latchReason !== null) {
      return { kind: 'latched', reason: this.#latchReason, crashes: this.#crashTimes.length };
    }
    this.#crashTimes.push(now);
    this.#prune(now);
    const attempt = this.#crashTimes.length;
    if (attempt > this.#policy.maxRestarts) {
      this.#latchReason =
        `the wake-word detector crashed ${attempt} times within ${this.#policy.crashWindowSeconds}s `
        + `(limit ${this.#policy.maxRestarts}); it will not be restarted until it is turned off and on again`;
      return { kind: 'latched', reason: this.#latchReason, crashes: attempt };
    }
    this.#totalRestarts += 1;
    return { kind: 'restart', delayMs: this.#policy.restartBackoffMs * attempt, attempt };
  }

  /**
   * Record a deliberate stop, the user turned the feature off, or the process
   * was replaced. A clean stop is not a crash and consumes no budget.
   */
  noteStopped(): void {
    this.#running = false;
  }

  /**
   * Clear the latch and the crash window, so the detector may run again. Called
   * when the user explicitly re-enables the feature, which is the deliberate
   * act the latch was waiting for.
   */
  clearLatch(): void {
    this.#latchReason = null;
    this.#crashTimes = [];
  }

  /** Drop crashes that have aged out of the rolling window. */
  #prune(now: number): void {
    const cutoff = now - this.#policy.crashWindowSeconds * 1000;
    this.#crashTimes = this.#crashTimes.filter((at) => at > cutoff);
  }
}
