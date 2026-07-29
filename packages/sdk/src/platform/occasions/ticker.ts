/**
 * ticker.ts — something has to run the sweep.
 *
 * A loop that only runs when a verb asks it to is not proactive, and proactive
 * is the whole feature. This is the repeating timer that runs it, with the
 * timer itself injected so its behaviour is testable by advancing a counter
 * rather than by waiting an hour.
 *
 * The ticker is deliberately DUMB, because the sweep is where the judgement is:
 *
 *  - A tick inside quiet hours raises nothing and reaps anyway.
 *  - A tick on a day an occasion has already been raised finds its open item
 *    not yet due and raises nothing.
 *
 * So the interval decides how soon the FIRST nudge lands after a window opens,
 * and nothing else. Shortening it cannot make the system nag.
 *
 * Three properties that are easy to get wrong in a self-rearming timer, all
 * asserted by test:
 *
 *  - **The interval is re-read every tick**, so `occasions.sweepIntervalMinutes`
 *    is a live setting rather than a restart-only one.
 *  - **Passes are strictly serial.** The next tick is armed only once the
 *    current pass has finished, so a slow sweep — delivering over a channel,
 *    say — delays the next pass rather than having one start on top of it. Two
 *    overlapping passes would deliver the same batch twice, and the fix for
 *    that is not to have a second one to skip.
 *  - **A failing sweep re-arms.** One transient error must not stop the loop for
 *    the life of the process, which is what a naive `await` inside the timer
 *    body does.
 */

/** The timer surface this needs, injected so a test can drive it. */
export interface TickerScheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SweepTickerOptions {
  /** One pass. Its own errors are caught here; it never has to be safe. */
  readonly sweep: () => Promise<unknown>;
  /** Read fresh on every tick, so the setting is live. Milliseconds. */
  readonly intervalMs: () => number;
  readonly scheduler?: TickerScheduler | undefined;
  /** Called when a pass throws, so the failure is on the record. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

export interface SweepTicker {
  /** Stop the loop. Safe to call more than once. */
  stop(): void;
  /** True while a pass is in flight. Test seam. */
  readonly running: boolean;
}

/**
 * The default scheduler, which `unref`s so the timer never holds the process
 * open. A daemon that could not exit because a reminder loop was armed would be
 * a worse bug than the reminder being an hour late.
 */
const NODE_SCHEDULER: TickerScheduler = {
  setTimeout: (handler, ms) => {
    const handle = setTimeout(handler, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export function startOccasionSweepTicker(options: SweepTickerOptions): SweepTicker {
  const scheduler = options.scheduler ?? NODE_SCHEDULER;
  let handle: unknown = null;
  let running = false;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    handle = scheduler.setTimeout(() => {
      handle = null;
      void tick();
    }, Math.max(1, Math.round(options.intervalMs())));
  };

  const tick = async (): Promise<void> => {
    running = true;
    try {
      await options.sweep();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
      // Re-armed HERE, in `finally`, and nowhere else. Two things follow, and
      // both are asserted by test: one transient failure cannot end the loop
      // for the life of the process, and nothing is armed while a pass is in
      // flight — so a slow pass delays the next one instead of having one land
      // on top of it.
      arm();
    }
  };

  arm();

  return {
    stop: (): void => {
      stopped = true;
      if (handle !== null) {
        scheduler.clearTimeout(handle);
        handle = null;
      }
    },
    get running(): boolean {
      return running;
    },
  };
}
