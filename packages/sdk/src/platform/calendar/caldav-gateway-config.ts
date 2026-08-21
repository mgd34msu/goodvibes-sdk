/**
 * caldav-gateway-config.ts, where the daemon's CalDAV connection comes from,
 * and how a logical calendar id becomes a collection URL.
 *
 * Config keys (all daemon-owned, all real `CONFIG_SCHEMA` entries, all
 * rendered in the settings modal):
 *
 *   surfaces.calendar.caldavUrl          the collection or server URL
 *   surfaces.calendar.caldavUser         account name
 *   surfaces.calendar.caldavPassword     a secret REFERENCE, never a password
 *   surfaces.calendar.defaultCalendarId  used when a request names no calendar
 *   surfaces.calendar.calendars          logical id -> collection path, as JSON
 *
 * The operator-facing errors name those keys verbatim, because an error that
 * says what to set is the difference between a two-minute fix and a support
 * thread.
 *
 * Two properties this module keeps:
 *
 *  - **The password never comes from config.** `caldavPassword` holds either a
 *    `goodvibes://secrets/...` reference or a bare secret-store key; either way
 *    the value is fetched from the secret store. A raw password pasted into
 *    config resolves to nothing rather than being used, which is deliberate: a
 *    credential in a settings file is a credential in every backup of it.
 *  - **The authenticated URL never leaves.** `calendarId` is a LOGICAL id.
 *    Everything here maps it inward to a URL; `toRelativeHref` maps server
 *    answers back outward to host-relative paths, so no response carries the
 *    scheme+host a credential is scoped to.
 */

import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import { daemonSecretKeyFor } from '../config/daemon-secret-keys.js';

export const CALDAV_URL_KEY = 'surfaces.calendar.caldavUrl';
export const CALDAV_USER_KEY = 'surfaces.calendar.caldavUser';
export const CALDAV_PASSWORD_KEY = 'surfaces.calendar.caldavPassword';
export const CALDAV_DEFAULT_CALENDAR_KEY = 'surfaces.calendar.defaultCalendarId';
export const CALDAV_CALENDARS_KEY = 'surfaces.calendar.calendars';

/** Reads settings. Narrow on purpose: a string key in, an unknown value out. */
export interface CalDavConfigPort {
  get(key: string): unknown;
}

/** Resolves credentials. Mirrors the daemon credential store's two questions. */
export interface CalDavSecretPort {
  /** A `goodvibes://secrets/...` reference, or a bare secret-store key. */
  resolveRef(ref: string): Promise<string | null>;
  /** The secret a config key implies (`daemonSecretKeyFor`). */
  resolveConfigSecret(configKey: string): Promise<string | null>;
}

export interface CalDavGatewayConfig {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly defaultCalendarId: string;
  /** Logical calendarId -> collection path (host-absolute, or relative to the base URL). */
  readonly collectionMap: Readonly<Record<string, string>>;
}

/**
 * A secret port over a plain `secretsManager.get`, using the platform-wide
 * name derivation. Built here rather than in the composition root so the
 * derivation cannot drift from the one `setup-plan.ts` writes with.
 */
export function createCalDavSecretPort(
  secretsManager: { get(key: string): Promise<string | null> },
): CalDavSecretPort {
  return {
    async resolveRef(ref: string): Promise<string | null> {
      const normalized = ref.trim();
      // `goodvibes://secrets/<provider>/<key>`, the key is the last segment,
      // percent-decoded, exactly as `buildGoodVibesSecretRef` wrote it. Any
      // other string is taken as a bare store key.
      const key = normalized.startsWith('goodvibes://secrets/')
        ? decodeURIComponent(normalized.split('/').pop() ?? '')
        : normalized;
      if (key.length === 0) return null;
      return secretsManager.get(key);
    },
    async resolveConfigSecret(configKey: string): Promise<string | null> {
      return secretsManager.get(daemonSecretKeyFor(configKey));
    },
  };
}

/**
 * One config value as a trimmed, non-empty string.
 *
 * Reads through a guard: `ConfigManager.get` throws for a section that does not
 * exist, and on a machine where nobody has run calendar setup that is the
 * normal state, not a fault. An unreachable key reads as unset, so the caller
 * answers "CalDAV is not configured" instead of surfacing `Invalid config path`
 * as a 500.
 */
function readConfigString(config: CalDavConfigPort, key: string): string | undefined {
  let value: unknown;
  try {
    value = config.get(key);
  } catch {
    return undefined;
  }
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * `surfaces.calendar.calendars` as a logical id -> collection path map.
 *
 * Malformed JSON, a JSON array, or a non-string entry is ignored rather than
 * refused: the fallback is default-calendar-only behaviour, which still works,
 * where a thrown error would take the whole calendar surface down over a typo
 * in an optional setting.
 */
export function parseCollectionMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const map: Record<string, string> = {};
      for (const [id, path] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof path === 'string' && path.length > 0) map[id] = path;
      }
      return map;
    }
  } catch {
    // Ignore malformed config; fall back to default-calendar-only behaviour.
  }
  return {};
}

/**
 * Resolve the whole CalDAV connection: settings from the config port, password
 * from the secret port. Throws `GatewayVerbError` naming the exact key to set
 * when the surface is not configured. The password is held in memory for the
 * life of the returned object and never returned to a caller.
 */
export async function resolveCalDavGatewayConfig(
  config: CalDavConfigPort,
  secrets: CalDavSecretPort,
): Promise<CalDavGatewayConfig> {
  const baseUrl = readConfigString(config, CALDAV_URL_KEY);
  const username = readConfigString(config, CALDAV_USER_KEY);
  if (!baseUrl || !username) {
    throw new GatewayVerbError(
      `CalDAV is not configured. Set ${CALDAV_URL_KEY} and ${CALDAV_USER_KEY}.`,
      'CALENDAR_NOT_CONFIGURED',
      412,
    );
  }

  const passwordConfig = readConfigString(config, CALDAV_PASSWORD_KEY);
  let password: string | null = null;
  if (passwordConfig) {
    password = await secrets.resolveRef(passwordConfig);
  }
  if (!password) {
    // Fall back to the config-key-derived secret, which is where setup stores
    // it when the operator typed a password rather than pasting a reference.
    password = await secrets.resolveConfigSecret(CALDAV_PASSWORD_KEY);
  }
  if (!password) {
    throw new GatewayVerbError(
      'CalDAV password is not available in the credential store.',
      'CALENDAR_CREDENTIALS_MISSING',
      412,
    );
  }

  return {
    baseUrl,
    username,
    password,
    defaultCalendarId: readConfigString(config, CALDAV_DEFAULT_CALENDAR_KEY) ?? 'default',
    collectionMap: parseCollectionMap(readConfigString(config, CALDAV_CALENDARS_KEY)),
  };
}

// ---------------------------------------------------------------------------
// URL mapping (logical id <-> collection path; never expose absolute URLs)
// ---------------------------------------------------------------------------

export function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function joinUrl(base: string, segment: string): string {
  const cleanBase = stripTrailingSlash(base);
  const cleanSegment = segment.startsWith('/') ? segment : `/${segment}`;
  return `${cleanBase}${cleanSegment}`;
}

/** The scheme+host origin of an absolute URL, without a trailing slash. */
export function originOf(url: string): string {
  const match = /^(https?:\/\/[^/]+)/i.exec(url.trim());
  return match?.[1] ?? stripTrailingSlash(url);
}

/**
 * Resolve a configured collection path. A host-absolute path (starting with
 * '/') resolves against the origin of the base URL; anything else is a child
 * segment of the base URL.
 */
export function resolveCollectionUrl(baseUrl: string, path: string): string {
  if (path.startsWith('/')) {
    return `${originOf(baseUrl)}${stripTrailingSlash(path)}`;
  }
  return joinUrl(baseUrl, stripTrailingSlash(path));
}

/**
 * An absolute or host-relative href from the server, as an opaque host-relative
 * identifier. Strips scheme + host so an authenticated URL never reaches a
 * caller.
 */
export function toRelativeHref(href: string): string {
  const trimmed = href.trim();
  const schemeMatch = /^https?:\/\/[^/]+(\/.*)$/i.exec(trimmed);
  if (schemeMatch?.[1]) return schemeMatch[1];
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Does an event identifier look like a resource href rather than a bare
 * iCalendar UID? Hrefs contain a path separator or end in `.ics`; UIDs are
 * opaque tokens (often `uuid@host`) with no path component.
 */
export function isHrefLike(eventId: string): boolean {
  return eventId.includes('/') || /\.ics$/i.test(eventId);
}

/**
 * An href-like identifier as an absolute, authenticated resource URL for a
 * direct GET. A host-absolute href resolves against the base URL's origin;
 * anything else is a resource name inside the target collection.
 */
export function resolveResourceUrl(collectionUrl: string, baseUrl: string, eventId: string): string {
  const trimmed = eventId.trim();
  if (trimmed.startsWith('/')) {
    return `${originOf(baseUrl)}${trimmed}`;
  }
  return joinUrl(collectionUrl, trimmed);
}

/** The host-relative collection path implied by an absolute collection URL. */
export function collectionPathOrRoot(collectionUrl: string, baseUrl: string): string {
  const rel = toRelativeHref(collectionUrl);
  if (rel.length > 0) return rel;
  return toRelativeHref(baseUrl);
}

/** The collection path a logical calendar id maps to (empty = the base URL itself). */
export function collectionPathFor(
  config: CalDavGatewayConfig,
  calendarId: string | undefined,
): string {
  const id = calendarId && calendarId.length > 0 ? calendarId : config.defaultCalendarId;
  const mapped = config.collectionMap[id];
  if (mapped) return mapped;
  if (id === config.defaultCalendarId) return '';
  // Unknown logical id with no mapping: treat the id as a child collection name.
  return `/${encodeURIComponent(id)}/`;
}

/** The absolute collection URL a logical calendar id maps to. */
export function collectionUrlFor(
  config: CalDavGatewayConfig,
  calendarId: string | undefined,
): string {
  const path = collectionPathFor(config, calendarId);
  return path.length > 0 ? resolveCollectionUrl(config.baseUrl, path) : stripTrailingSlash(config.baseUrl);
}
