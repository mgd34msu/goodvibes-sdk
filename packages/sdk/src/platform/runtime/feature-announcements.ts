/**
 * feature-announcements.ts — announce-once receipts for default-on features.
 *
 * Nothing default-on requires a setup step to function; instead, each
 * newly-default-on capability announces itself exactly once, usably:
 * - the web surface exposes its URL for daemon-start/footer display,
 * - automation exposes a how-to-create-your-first-routine empty state while
 *   it has no routines,
 * - the exec sandbox's first auto-allowed contained run yields a one-time
 *   "commands now run contained; escalations will ask" line.
 *
 * The SDK provides these as state the surfaces render: a persisted
 * announce-once store (so "once" survives restarts), a startup collector, a
 * pure empty-state builder, and a first-contained-run announcer callback.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveWebBinding } from '../daemon/host-resolver.js';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { ConfigManager } from '../config/manager.js';

/** One announce-once line a surface renders verbatim. */
export interface FeatureAnnouncement {
  readonly id: string;
  readonly text: string;
}

/** A fired announcement awaiting delivery to a rendering surface. */
export interface PendingFeatureAnnouncement {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

interface AnnouncementFileState {
  announced: Record<string, number>;
  pending: PendingFeatureAnnouncement[];
}

/**
 * Persisted announce-once bookkeeping under the control-plane config
 * directory, so an announcement made by any process of this install is made
 * exactly once — PLUS a pending-delivery queue: an announcement recorded with
 * text waits here until a rendering surface drains it (the daemon folds the
 * queue into the explicitly-consuming /status receipts read), so
 * announce-once lines reach surfaces instead of dead-ending in the log.
 *
 * File format: `{ announced: { id -> timestamp }, pending: [{id,text,at}] }`.
 * The legacy format (a plain id->timestamp map) reads as announced-with-
 * nothing-pending — old installs never re-announce.
 */
export class FeatureAnnouncementStore {
  constructor(private readonly path: string) {}

  private read(): AnnouncementFileState {
    try {
      if (!existsSync(this.path)) return { announced: {}, pending: [] };
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { announced: {}, pending: [] };
      }
      const record = parsed as Record<string, unknown>;
      if (record.announced !== null && typeof record.announced === 'object' && !Array.isArray(record.announced)) {
        return {
          announced: record.announced as Record<string, number>,
          pending: Array.isArray(record.pending)
            ? (record.pending as PendingFeatureAnnouncement[]).filter(
                (entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.text === 'string' && typeof entry.at === 'number',
              )
            : [],
        };
      }
      // Legacy format: a plain id -> timestamp map. Announced, nothing pending.
      return { announced: record as Record<string, number>, pending: [] };
    } catch {
      return { announced: {}, pending: [] };
    }
  }

  private persist(state: AnnouncementFileState, context: string): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    } catch (err) {
      // An unwritable store must never block the feature; the announcement
      // may repeat on the next start, which is noisy but honest.
      logger.warn('[announcements] could not persist announce-once state', {
        context,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  has(id: string): boolean {
    return id in this.read().announced;
  }

  /**
   * Record an announcement; returns true only on the FIRST record (the caller
   * announces), false when it was already made (the caller stays silent).
   * With `text`, the first record also enqueues the line for surface delivery
   * (see drainPending) — so the announcement reaches a rendering surface, not
   * only the log.
   */
  record(id: string, text?: string): boolean {
    const state = this.read();
    if (id in state.announced) return false;
    const at = Date.now();
    state.announced[id] = at;
    if (typeof text === 'string' && text.length > 0) {
      state.pending.push({ id, text, at });
    }
    this.persist(state, id);
    return true;
  }

  /**
   * The fired-but-undelivered announcements, cleared on read: exactly-once
   * delivery to the first draining reader (the daemon's explicitly-consuming
   * /status receipts read), mirroring the daemon receipt contract.
   */
  drainPending(): PendingFeatureAnnouncement[] {
    const state = this.read();
    if (state.pending.length === 0) return [];
    const pending = state.pending;
    this.persist({ announced: state.announced, pending: [] }, 'drain');
    return pending;
  }
}

/** The store file location for an install (control-plane config directory). */
export function featureAnnouncementsPath(
  configManager: Pick<ConfigManager, 'getControlPlaneConfigDir'>,
): string {
  return join(configManager.getControlPlaneConfigDir(), 'control-plane', 'feature-announcements.json');
}

/** The web surface's reachable URL from its settings. */
export function resolveWebSurfaceUrl(configManager: Pick<ConfigManager, 'get'>): string {
  const publicBaseUrl = configManager.get('web.publicBaseUrl');
  if (publicBaseUrl.trim().length > 0) return publicBaseUrl;
  // Anchored to the web binding resolver so the announced URL always carries a
  // validated port and the mode-resolved host (never a raw 0/NaN/typo value).
  const binding = resolveWebBinding({ hostMode: configManager.get('web.hostMode'), host: configManager.get('web.host'), port: configManager.get('web.port') });
  return `http://${binding.host}:${binding.port}`;
}

export const WEB_SURFACE_ANNOUNCEMENT_ID = 'web-surface-url';
export const SANDBOX_CONTAINED_ANNOUNCEMENT_ID = 'exec-sandbox-contained';

/** The one-time contained-exec line, verbatim. */
export const SANDBOX_CONTAINED_ANNOUNCEMENT_TEXT =
  'commands now run contained; escalations will ask';

/**
 * Collect the announce-once lines due at daemon start. Each returned line is
 * recorded in the store as announced — the caller renders every returned
 * line (daemon-start log, footer, ...), exactly once per install.
 */
export function collectStartupAnnouncements(deps: {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly store: Pick<FeatureAnnouncementStore, 'record'>;
}): FeatureAnnouncement[] {
  const lines: FeatureAnnouncement[] = [];
  if (deps.configManager.get('web.enabled')) {
    const hostMode = deps.configManager.get('web.hostMode');
    const scope = hostMode === 'local' ? ' — serving this machine only until web.hostMode is widened' : '';
    const text = `Web surface ready: ${resolveWebSurfaceUrl(deps.configManager)}${scope}`;
    // Recording WITH text also enqueues the line for surface delivery.
    if (deps.store.record(WEB_SURFACE_ANNOUNCEMENT_ID, text)) {
      lines.push({ id: WEB_SURFACE_ANNOUNCEMENT_ID, text });
    }
  }
  return lines;
}

/** The automation empty state a surface renders while no routines exist. */
export interface AutomationEmptyState {
  readonly title: string;
  readonly body: string;
}

/**
 * Automation's how-to-create-your-first-routine empty state: present while
 * automation is enabled and has zero routines, absent otherwise. Persistent
 * state (not once-only) — it disappears by itself when the first routine
 * exists, so nothing default-on ever needs a setup step to be honest.
 */
export function buildAutomationEmptyState(input: {
  readonly enabled: boolean;
  readonly routineCount: number;
}): AutomationEmptyState | null {
  if (!input.enabled || input.routineCount > 0) return null;
  return {
    title: 'No routines yet',
    body:
      'Automation is on and idle. Create your first routine with /automation create '
      + '(name, schedule, prompt) or the schedule verb — it runs on its cadence with '
      + 'durable run history, retries, and delivery receipts.',
  };
}

/**
 * The exec sandbox's first-contained-run announcer: call it on every
 * sandboxed command execution; the FIRST call per install announces once via
 * `onAnnounce` and every later call is silent.
 */
export function createSandboxContainmentAnnouncer(
  store: Pick<FeatureAnnouncementStore, 'record'>,
  onAnnounce: (announcement: FeatureAnnouncement) => void,
): () => void {
  return () => {
    // Recording WITH text also enqueues the line for surface delivery.
    if (store.record(SANDBOX_CONTAINED_ANNOUNCEMENT_ID, SANDBOX_CONTAINED_ANNOUNCEMENT_TEXT)) {
      onAnnounce({
        id: SANDBOX_CONTAINED_ANNOUNCEMENT_ID,
        text: SANDBOX_CONTAINED_ANNOUNCEMENT_TEXT,
      });
    }
  };
}
