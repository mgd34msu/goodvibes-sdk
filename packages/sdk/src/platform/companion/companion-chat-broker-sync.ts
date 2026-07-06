/**
 * companion-chat-broker-sync.ts
 *
 * Owns the live mirror of companion sessions into the shared
 * `SharedSessionBroker` store (S1 item D: companion registers into the
 * broker at write time), chaining register/close/delete ops per session so
 * they never race (order = call order), and exposing `flush()` so the
 * companion HTTP routes can await in-flight ops before responding
 * (deterministic for tests).
 *
 * Split out of CompanionChatManager (W5-S1) to stay under the repo's
 * grandfathered line-cap ceiling (see scripts/check-line-cap.ts) — a pure
 * file-organization move, not a behavior change: same chaining, same
 * best-effort swallow-and-log-on-failure semantics.
 */
import type { CompanionChatSession } from './companion-chat-types.js';
import type { CompanionSessionBrokerBridge } from './companion-chat-broker-bridge.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

export class CompanionBrokerSync {
  private readonly broker: CompanionSessionBrokerBridge | null;
  private readonly pendingOps = new Map<string, Promise<void>>();

  constructor(broker: CompanionSessionBrokerBridge | null) {
    this.broker = broker;
  }

  /**
   * Await all in-flight best-effort broker-sync operations. The daemon's
   * companion HTTP routes call this before responding so `/api/sessions`
   * reflects the change synchronously; tests use it to make the mirror
   * deterministic. A no-op when no broker bridge is configured.
   */
  async flush(): Promise<void> {
    await Promise.all([...this.pendingOps.values()]);
  }

  /** Chain a broker op AFTER any prior op for the same session so register and
   * close/delete never race (order = call order). Best-effort; errors are
   * swallowed (logged, never thrown into the caller's write path). */
  track(sessionId: string, run: () => Promise<void>): void {
    if (!this.broker) return;
    const prior = this.pendingOps.get(sessionId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(run).catch(() => {});
    this.pendingOps.set(sessionId, next.finally(() => {
      if (this.pendingOps.get(sessionId) === next) this.pendingOps.delete(sessionId);
    }));
  }

  async registerSession(meta: CompanionChatSession): Promise<void> {
    const broker = this.broker;
    if (!broker) return;
    try {
      await broker.register({
        sessionId: meta.id,
        kind: 'companion-chat',
        project: 'unknown',
        title: meta.title,
        participant: { surfaceKind: 'companion', surfaceId: meta.id, lastSeenAt: Date.now() },
      });
    } catch (error) {
      logger.warn('[companion-chat] broker registration failed', {
        sessionId: meta.id,
        error: summarizeError(error),
      });
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const broker = this.broker;
    if (!broker) return;
    try {
      await broker.closeSession(sessionId);
    } catch (error) {
      logger.warn('[companion-chat] broker close failed', {
        sessionId,
        error: summarizeError(error),
      });
    }
  }

  /** Hard-remove the mirrored shared-session record (W5-S1: companion delete is a real removal). */
  async deleteSession(sessionId: string): Promise<void> {
    const broker = this.broker;
    if (!broker) return;
    try {
      await broker.deleteSession(sessionId);
    } catch (error) {
      logger.warn('[companion-chat] broker delete failed', {
        sessionId,
        error: summarizeError(error),
      });
    }
  }
}
