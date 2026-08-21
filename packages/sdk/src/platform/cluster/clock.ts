/**
 * clock.ts, the real clock, and a deterministic one for tests.
 *
 * The two sources are kept separate on purpose. `now()` is the wall clock,
 * which is what a replay cursor has to be expressed in because that is what a
 * message provider understands. `monotonicNow()` is a monotonic source that
 * does not move while the host is suspended, which is what makes uptime
 * ranking honest and what lets a woken node discover it was asleep: the gap
 * between the two IS the sleep.
 */
import type { ClusterClock } from './types.js';

/** The clock a running daemon uses. */
export function createSystemClusterClock(): ClusterClock {
  return {
    now: () => Date.now(),
    monotonicNow: () => Math.round(performance.now()),
    setTimer: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      // Never hold the process open for a heartbeat.
      (handle as unknown as { unref?: () => void }).unref?.();
      return () => clearTimeout(handle);
    },
  };
}

interface ScheduledTask {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

/**
 * A clock that only moves when a test tells it to.
 *
 * `advance` fires due timers in time order and re-checks after each one, so a
 * timer that schedules another timer inside the same advance window still
 * runs. Wall and monotonic time advance together unless `advanceWallOnly` is
 * used, which is how a host suspend is simulated: the wall clock jumps, the
 * monotonic clock does not, and no timer fires during the gap.
 */
export class FakeClusterClock implements ClusterClock {
  private wall: number;
  private mono: number;
  private nextId = 1;
  private tasks: ScheduledTask[] = [];

  constructor(startWallMs = 1_700_000_000_000, startMonotonicMs = 0) {
    this.wall = startWallMs;
    this.mono = startMonotonicMs;
  }

  now(): number {
    return this.wall;
  }

  monotonicNow(): number {
    return this.mono;
  }

  setTimer(fn: () => void, ms: number): () => void {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.push({ id, at: this.mono + Math.max(0, ms), fn });
    return () => {
      this.tasks = this.tasks.filter((task) => task.id !== id);
    };
  }

  /** Move both clocks forward, running every timer that comes due. */
  advance(ms: number): void {
    const target = this.mono + ms;
    for (;;) {
      const due = this.tasks
        .filter((task) => task.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.tasks = this.tasks.filter((task) => task.id !== due.id);
      this.wall += due.at - this.mono;
      this.mono = due.at;
      due.fn();
    }
    this.wall += target - this.mono;
    this.mono = target;
  }

  /**
   * Simulate a host suspend: wall time passes, monotonic time does not, and no
   * timer fires. The next `advance` is what delivers the late tick.
   */
  advanceWallOnly(ms: number): void {
    this.wall += ms;
  }

  /** Pending timer count, a test's check that nothing was left armed. */
  get pendingTimers(): number {
    return this.tasks.length;
  }
}
