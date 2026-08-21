/**
 * The cadence half of the platform's one update mechanism: WHEN a
 * long-running process looks for a newer release. (self-update.ts owns WHAT
 * happens when one is found, download, verify, swap, keep previous.)
 *
 * One shared loop, three rules, so every long-running surface behaves the
 * same way:
 *
 *   - the FIRST check runs shortly after start (a boot-settle delay, ~30s by
 *     default), not one full cadence out. A process that was down while three
 *     releases shipped must not stay stale for another hour just because it
 *     restarted; a machine that has only just booted still gets a moment to
 *     bring up its network first.
 *   - after that, checks run on the configured cadence (hourly by default).
 *   - a check that found an update but could not apply it yet, the process is
 *     mid-work and a swap only ever happens at an idle moment, re-tries on a
 *     short retry cadence instead of waiting a full interval.
 *
 * Timers are injectable, so the schedule is provable under test without real
 * time passing, and the timer never keeps the host process alive.
 */

/** What one iteration decided: keep the steady cadence, or come back soon. */
export type PeriodicCheckOutcome = 'settled' | 'deferred';

export const BOOT_SETTLE_CHECK_DELAY_MS = 30_000;
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_UPDATE_BUSY_RETRY_MS = 60 * 1000;

/** Floor for every delay: a runaway config must never turn the loop into a spin. */
const MIN_DELAY_MS = 1_000;

export interface PeriodicUpdateLoopOptions {
  /** Delay before the first check. Default 30s; never longer than one cadence. */
  readonly firstCheckDelayMs?: number | undefined;
  /** Steady-state cadence between checks. Default 1h. */
  readonly checkIntervalMs?: number | undefined;
  /** Cadence used while an update waits for an idle moment. Default 60s. */
  readonly busyRetryMs?: number | undefined;
  /** One iteration: check, and apply if the moment allows. */
  readonly runCheck: () => Promise<PeriodicCheckOutcome>;
  /** Called when an iteration throws; the loop keeps its cadence either way. */
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
  readonly clearTimer?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
}

export class PeriodicUpdateLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;
  private deferred = false;

  constructor(private readonly options: PeriodicUpdateLoopOptions) {}

  get checkIntervalMs(): number {
    return Math.max(MIN_DELAY_MS, this.options.checkIntervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS);
  }

  get busyRetryMs(): number {
    return Math.max(MIN_DELAY_MS, this.options.busyRetryMs ?? DEFAULT_UPDATE_BUSY_RETRY_MS);
  }

  /**
   * The boot-settle delay, capped at one full cadence: a surface configured to
   * check every 30 seconds must not wait longer for its first check than for
   * every check after it.
   */
  get firstCheckDelayMs(): number {
    const requested = Math.max(0, this.options.firstCheckDelayMs ?? BOOT_SETTLE_CHECK_DELAY_MS);
    return Math.min(requested, this.checkIntervalMs);
  }

  /** Begin the loop. The first check runs after the boot-settle delay. */
  start(): void {
    this.stopped = false;
    this.scheduleNext(this.firstCheckDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      (this.options.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  /** One iteration; exposed so tests drive the loop without waiting on real time. */
  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      this.deferred = (await this.options.runCheck()) === 'deferred';
    } catch (error) {
      this.deferred = false;
      this.options.onError?.(error);
    } finally {
      this.running = false;
      this.scheduleNext(this.deferred ? this.busyRetryMs : this.checkIntervalMs);
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    const setTimer = this.options.setTimer ?? setTimeout;
    if (this.timer) (this.options.clearTimer ?? clearTimeout)(this.timer);
    this.timer = setTimer(() => {
      void this.tick();
    }, delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }
}
