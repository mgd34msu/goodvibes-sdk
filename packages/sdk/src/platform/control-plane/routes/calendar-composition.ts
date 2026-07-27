/**
 * routes/calendar-composition.ts — the daemon's own calendar connection.
 *
 * Assembling it here rather than in the runtime composition root keeps one
 * property visible: the daemon reads the connection from the DAEMON tier and
 * from nowhere else. `configManager.get` and `secretsManager.get` both resolve
 * against the daemon's own stores, and every path and secret name the
 * connector uses is daemon-owned (see `config/config-ownership.ts`), so a
 * setup performed in any surface — the agent, the TUI, the web UI — is
 * readable here the moment it lands, and stays readable after that surface has
 * exited. That is the whole point: the runtime that has to answer mail at 3am
 * is not the one the operator did the setup in.
 *
 * Returns `null` when the composition is too narrow to reach a real store, so
 * the verbs simply stay unregistered rather than half-wired.
 */
import {
  createGoogleCalendarGatewayService,
  type GoogleCalendarGatewayServiceOptions,
} from '../../google/gateway-calendar-service.js';
import { nodeGoogleFilePort } from '../../google/node.js';
import type { CalendarGatewayService } from './calendar.js';

/** The slice of the verb-group deps this composition needs. */
export interface CalendarCompositionDeps {
  readonly configManager: { get(key: never): unknown };
  readonly secretsManager: { get(key: string): Promise<string | null> };
  /** Absent in narrow compositions; the adoption probe needs a real home. */
  readonly homeDirectory?: string | undefined;
  /** Test seam: overrides the whole service, so no real store is touched. */
  readonly calendarGateway?: CalendarGatewayService | undefined;
  /** Test seam: overrides the injected fetch. */
  readonly calendarFetch?: GoogleCalendarGatewayServiceOptions['fetch'] | undefined;
}

export function createDaemonCalendarGatewayService(
  deps: CalendarCompositionDeps,
): CalendarGatewayService | null {
  if (deps.calendarGateway) return deps.calendarGateway;
  if (deps.homeDirectory === undefined) return null;
  return createGoogleCalendarGatewayService({
    sources: {
      files: nodeGoogleFilePort,
      homeDirectory: deps.homeDirectory,
      // `get` throws on a config section that does not exist yet; the
      // connector wraps this call and reads a throw as "not configured",
      // which is the honest answer rather than a broken verb.
      configGet: (key) => deps.configManager.get(key as never),
      secretGet: (key) => deps.secretsManager.get(key),
    },
    fetch: deps.calendarFetch ?? { fetch: (url, init) => fetch(url, init) },
  });
}
