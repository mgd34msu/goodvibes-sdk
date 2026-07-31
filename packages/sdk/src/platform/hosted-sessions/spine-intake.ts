/**
 * spine-intake.ts — how a hosted session reaches the SHARED session spine, and
 * how a steer reaches a hosted turn.
 *
 * Two jobs, together because they are the same relationship seen from both
 * ends.
 *
 * REGISTRATION puts a hosted session in `sessions.list` beside every other
 * kind, so a client that lists sessions sees the ones the daemon is running
 * rather than only the ones its own process started.
 *
 * INTAKE is what makes `sessions.steer` and `sessions.followUp` actually drive
 * a hosted turn without a parallel verb family. The broker routes a steer at a
 * session with a live SURFACE participant to that surface to collect; for a
 * hosted session, this engine is the surface. So it collects the queued inputs
 * and hands each to the loop — the same contract `createWireSessionDispatch`
 * implements for a client across the wire, with the one difference that this
 * one shares a process with the broker.
 *
 * The heartbeat is not decoration. A steer goes to a live surface participant
 * when there is one and spawns a background AGENT when there is not, so a
 * hosted session whose participant went stale would quietly stop receiving its
 * own steers and start getting agents instead — the conversation would keep
 * answering, from the wrong thing.
 */

import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { HostedSessionRecord } from './types.js';

/**
 * The narrow view of the shared session broker hosted sessions use.
 *
 * Registration is what puts a hosted session in `sessions.list` beside every
 * other kind. The input methods are what make `sessions.steer` and
 * `sessions.followUp` DRIVE one: a steer at a session with a live surface
 * participant is queued FOR that surface to collect, and for a hosted session
 * this engine is the surface. Collecting and delivering those queued inputs is
 * the same contract `createWireSessionDispatch` implements for a client on the
 * other side of the wire — the difference is only that this one is in the same
 * process as the broker.
 */
export interface HostedSessionSpine {
  register(input: {
    readonly sessionId: string;
    readonly kind: 'hosted';
    readonly project?: string | undefined;
    readonly title?: string | undefined;
    readonly participant: {
      readonly surfaceKind: 'service';
      readonly surfaceId: string;
      readonly lastSeenAt: number;
    };
  }): Promise<unknown>;
  closeSession(sessionId: string): Promise<unknown>;
  /** Inputs waiting for this surface to collect. */
  getInputsSince(
    sessionId: string,
    options: { readonly state?: 'queued' | undefined },
  ): readonly { readonly id: string; readonly body: string }[];
  /** Report one collected (`consumed:false`) or finished (`consumed:true`). */
  markInputDelivered(
    sessionId: string,
    inputId: string,
    options?: { readonly consumed?: boolean | undefined },
  ): Promise<unknown>;
}

/** What the intake needs from the engine that owns the sessions. */
export interface HostedSessionSpineIntakeOptions {
  readonly spine?: HostedSessionSpine | undefined;
  /** Non-terminated hosted sessions, read fresh on every tick. */
  readonly liveSessions: () => readonly HostedSessionRecord[];
  /** Hand one collected input to its session's loop. */
  readonly deliver: (sessionId: string, text: string) => Promise<void>;
  readonly now: () => number;
  /** Tick interval. Default 750ms — the order every inbound-dispatch client here uses. */
  readonly intervalMs?: number | undefined;
}

const DEFAULT_INTAKE_INTERVAL_MS = 750;
const HOSTED_PARTICIPANT_SURFACE_ID = 'daemon:hosted-sessions';

export class HostedSessionSpineIntake {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly options: HostedSessionSpineIntakeOptions) {}

  /** Begin collecting and heartbeating. A no-op without a spine. */
  start(): void {
    if (this.timer || !this.options.spine || this.stopped) return;
    const interval = this.options.intervalMs ?? DEFAULT_INTAKE_INTERVAL_MS;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    // Never hold the process open on account of an idle intake tick.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Put (or refresh) this session on the shared spine. Never throws. */
  async register(record: HostedSessionRecord): Promise<void> {
    if (!this.options.spine) return;
    try {
      await this.options.spine.register({
        sessionId: record.id,
        kind: 'hosted',
        project: record.workspaceRoot,
        title: record.title,
        participant: {
          surfaceKind: 'service',
          surfaceId: HOSTED_PARTICIPANT_SURFACE_ID,
          lastSeenAt: this.options.now(),
        },
      });
    } catch (error) {
      logger.warn('[hosted-sessions] registering a hosted session on the shared spine failed; it runs but is not in the union list', {
        sessionId: record.id,
        error: summarizeError(error),
      });
    }
  }

  /** Close this session's shared-spine record. Never throws. */
  async close(sessionId: string): Promise<void> {
    if (!this.options.spine) return;
    try {
      await this.options.spine.closeSession(sessionId);
    } catch (error) {
      logger.debug('[hosted-sessions] closing a hosted session on the shared spine failed', {
        sessionId,
        error: summarizeError(error),
      });
    }
  }

  /** One pass: heartbeat every live session, then collect and deliver its queued inputs. */
  async tick(): Promise<void> {
    const spine = this.options.spine;
    if (!spine || this.stopped || this.running) return;
    this.running = true;
    try {
      for (const record of this.options.liveSessions()) {
        await this.register(record);
        for (const input of spine.getInputsSince(record.id, { state: 'queued' })) {
          if (!input.body.trim()) continue;
          await spine.markInputDelivered(record.id, input.id).catch(() => undefined);
          try {
            await this.options.deliver(record.id, input.body);
          } catch (error) {
            logger.warn('[hosted-sessions] a queued input could not be delivered to its hosted session', {
              sessionId: record.id,
              inputId: input.id,
              error: summarizeError(error),
            });
          }
          await spine.markInputDelivered(record.id, input.id, { consumed: true }).catch(() => undefined);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
