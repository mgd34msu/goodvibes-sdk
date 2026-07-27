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
 *
 * Two backends can answer, and this is where one is chosen: a CalDAV server
 * when `surfaces.calendar.caldavUrl`/`caldavUser` are set, a connected Google
 * account otherwise. The five verbs behave identically either way — that is the
 * point of the `CalendarGatewayService` slice — so the choice is invisible
 * above this line.
 */
import {
  createGoogleCalendarGatewayService,
  type GoogleCalendarGatewayServiceOptions,
} from '../../google/gateway-calendar-service.js';
import { createFetchCalDavHttpPort, nodeGoogleFilePort } from '../../google/node.js';
import type { CalDavHttpPort } from '../../google/caldav-client.js';
import {
  CALDAV_URL_KEY,
  CALDAV_USER_KEY,
  createCalDavSecretPort,
} from '../../calendar/caldav-gateway-config.js';
import { createCalDavCalendarGatewayService } from '../../calendar/caldav-gateway-service.js';
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
  /** Test seam: overrides the CalDAV transport, so no socket is opened. */
  readonly caldavHttp?: CalDavHttpPort | undefined;
}

/** Read one config value, treating an unreachable section as unset. */
function configString(deps: CalendarCompositionDeps, key: string): string {
  let value: unknown;
  try {
    value = deps.configManager.get(key as never);
  } catch {
    return '';
  }
  return typeof value === 'string' ? value.trim() : '';
}

export function createDaemonCalendarGatewayService(
  deps: CalendarCompositionDeps,
): CalendarGatewayService | null {
  if (deps.calendarGateway) return deps.calendarGateway;

  // A configured CalDAV server wins. It is the more explicit statement of
  // intent — someone typed a server address and an account name into settings
  // — where a Google credential can be present on the machine for any number of
  // other reasons, and answering an operator's own calendar server with
  // somebody's Gmail calendar would be the wrong calendar, silently.
  if (configString(deps, CALDAV_URL_KEY).length > 0 && configString(deps, CALDAV_USER_KEY).length > 0) {
    return createCalDavCalendarGatewayService({
      config: { get: (key) => deps.configManager.get(key as never) },
      secrets: createCalDavSecretPort(deps.secretsManager),
      http: deps.caldavHttp ?? createFetchCalDavHttpPort(),
    });
  }

  if (deps.homeDirectory === undefined) return null;
  return createGoogleCalendarGatewayService({
    sources: {
      files: nodeGoogleFilePort,
      homeDirectory: deps.homeDirectory,
      // `get` throws on a config section that does not exist yet — the mail
      // and calendar sections are app-layer and absent on a machine where
      // nobody has run setup. The connector reads every config value through
      // its own guard (platform/google/config-access.ts), so an absent section
      // reads as "not configured" instead of surfacing Invalid config path as
      // a 500 from a route.
      configGet: (key) => deps.configManager.get(key as never),
      secretGet: (key) => deps.secretsManager.get(key),
    },
    fetch: deps.calendarFetch ?? { fetch: (url, init) => fetch(url, init) },
  });
}
