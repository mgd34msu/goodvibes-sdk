/**
 * A channel that dies has to REACH the owner, not sit in a field.
 *
 * Making the reported state honest fixes the answer to a question, but nobody
 * asks that question. The lived failure was not "the status endpoint said the
 * wrong thing" — it was that the owner sent a Telegram message, got nothing
 * back, and had no way to find out why without going and looking. A truthful
 * `dead` that nothing reads is the same silence with better bookkeeping.
 *
 * So this sweeps the registry, notices the transitions, and hands each one to
 * an announcer. Three properties it is built around:
 *
 * 1. It never announces over the channel that died. The dead surface is named
 *    in the alert so the announcer can exclude it; announcing a dead Telegram
 *    over Telegram is how this class of bug hides.
 * 2. It announces recoveries too. An owner who was told a channel was dead is
 *    owed the other half of that sentence, or the next alert is one he has
 *    learned to ignore.
 * 3. It repeats while a channel stays dead, on a long interval. A one-shot
 *    alert that arrives while nobody is looking has not told anyone anything.
 */
import type { ChannelHealthState, ChannelStatusSnapshot, ChannelSurface } from './types.js';
import { isChannelFailing } from './health.js';
import { logger } from '../utils/logger.js';

/** What the owner is told, and enough structure to route it sensibly. */
export interface ChannelHealthAlert {
  readonly kind: 'failed' | 'recovered' | 'still-failing';
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly state: ChannelHealthState;
  readonly previousState: ChannelHealthState | null;
  /** Why, in the surface's own words — the supervisor's named reason. */
  readonly reason: string;
  /** A complete sentence fit to send as-is. */
  readonly message: string;
  /** How long it has been in this state, when known. */
  readonly failingSinceMs?: number | undefined;
}

export interface ChannelHealthWatcherDeps {
  /** The registry sweep; the same snapshots every other surface reads. */
  readonly listStatus: () => Promise<readonly ChannelStatusSnapshot[]>;
  /**
   * Deliver the alert to the owner over some channel OTHER than
   * `alert.surface`. Absent means nothing is wired, which this class refuses to
   * treat as normal — see `start()`.
   */
  readonly announce?: ((alert: ChannelHealthAlert) => Promise<void> | void) | undefined;
  /** How often to sweep. */
  readonly intervalMs?: number | undefined;
  /** How long a channel must stay failing before it is announced again. */
  readonly repeatMs?: number | undefined;
  /** Test seam. */
  readonly now?: (() => number) | undefined;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_REPEAT_MS = 6 * 60 * 60 * 1000;

interface TrackedState {
  readonly state: ChannelHealthState;
  readonly since: number;
  readonly lastAnnouncedAt: number | null;
}

export class ChannelHealthWatcher {
  private readonly tracked = new Map<ChannelSurface, TrackedState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(private readonly deps: ChannelHealthWatcherDeps) {}

  /**
   * Begin sweeping.
   *
   * A watcher with no announcer says so at WARN and keeps running: the state it
   * records is still worth having, but an embedder must not be able to believe
   * the owner is being told when nothing is wired to tell him. That belief is
   * precisely what shipped.
   */
  start(): void {
    if (this.timer) return;
    if (!this.deps.announce) {
      logger.warn('Channel health is being watched but no announcer is wired', {
        detail: 'a channel that dies will be recorded and logged, but nothing will reach the owner',
        action: 'pass `announce` to ChannelHealthWatcher so a dead channel is delivered over a surviving surface',
      });
    }
    const interval = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => { void this.sweep(); }, interval);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Public so a caller can force a check without waiting a cycle. */
  async sweep(): Promise<readonly ChannelHealthAlert[]> {
    // Overlap protection: a slow sweep must not stack, or a surface that is
    // slow to answer produces duplicate alerts about itself.
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      return await this.sweepOnce();
    } catch (error) {
      logger.warn('Channel health sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOnce(): Promise<readonly ChannelHealthAlert[]> {
    const now = this.deps.now?.() ?? Date.now();
    const repeatMs = this.deps.repeatMs ?? DEFAULT_REPEAT_MS;
    const snapshots = await this.deps.listStatus();
    const alerts: ChannelHealthAlert[] = [];

    for (const snapshot of snapshots) {
      const previous = this.tracked.get(snapshot.surface) ?? null;
      const failing = isChannelFailing(snapshot.state);
      const changed = previous === null || previous.state !== snapshot.state;
      const since = changed ? now : previous.since;

      const alert = this.decide(snapshot, previous, failing, changed, now, since, repeatMs);
      this.tracked.set(snapshot.surface, {
        state: snapshot.state,
        since,
        lastAnnouncedAt: alert ? now : (changed ? null : previous?.lastAnnouncedAt ?? null),
      });
      if (alert) alerts.push(alert);
    }

    for (const alert of alerts) await this.emit(alert);
    return alerts;
  }

  private decide(
    snapshot: ChannelStatusSnapshot,
    previous: TrackedState | null,
    failing: boolean,
    changed: boolean,
    now: number,
    since: number,
    repeatMs: number,
  ): ChannelHealthAlert | null {
    const reason = snapshot.runtime?.reason ?? 'no reason was reported by this surface';
    const base = {
      surface: snapshot.surface,
      label: snapshot.label,
      state: snapshot.state,
      previousState: previous?.state ?? null,
      reason,
    } as const;

    if (failing && changed) {
      return {
        ...base,
        kind: 'failed',
        message: `${snapshot.label} is not working: ${reason}`,
      };
    }
    if (failing && !changed && (now - (previous?.lastAnnouncedAt ?? since)) >= repeatMs) {
      return {
        ...base,
        kind: 'still-failing',
        message: `${snapshot.label} is still not working after ${describeDuration(now - since)}: ${reason}`,
        failingSinceMs: now - since,
      };
    }
    // Only a channel the owner was TOLD about is owed a recovery notice.
    if (!failing && previous && isChannelFailing(previous.state) && previous.lastAnnouncedAt !== null) {
      return {
        ...base,
        kind: 'recovered',
        message: `${snapshot.label} is working again: ${reason}`,
      };
    }
    return null;
  }

  private async emit(alert: ChannelHealthAlert): Promise<void> {
    // Logged at ERROR regardless of whether an announcer exists, because the
    // daemon log is the one place this is guaranteed to be recoverable after
    // the fact — and a channel going dead is the most expensive state the
    // system can be in without saying anything.
    if (alert.kind === 'recovered') {
      logger.info('Channel recovered', { surface: alert.surface, detail: alert.message });
    } else {
      logger.error('Channel is not working', {
        surface: alert.surface,
        state: alert.state,
        detail: alert.message,
        reason: alert.reason,
      });
    }
    if (!this.deps.announce) return;
    try {
      await this.deps.announce(alert);
    } catch (error) {
      // The announcement failing is itself news: it means the owner was NOT
      // told, and the log line above is now the only record.
      logger.error('Could not tell the owner that a channel changed state', {
        surface: alert.surface,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function describeDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
