/**
 * config-ownership.ts — which runtime OWNS a config key.
 *
 * Ownership follows the runtime that ACTS on a setting, not the client that
 * happens to edit it. Before this module existed, every product wrote every key
 * into its own surface silo (`~/.goodvibes/agent/settings.json`,
 * `~/.goodvibes/tui/settings.json`, ...). The daemon reads exactly one of those
 * files, so a Telegram bot username set from the agent reported success, landed
 * in the agent's file, and configured nothing: Telegram runs in the daemon.
 *
 * Three scopes:
 *
 * - `daemon` — the daemon executes it unattended, so it has exactly one home:
 *   the daemon tier (`~/.goodvibes/daemon/settings.json`). Chat surfaces,
 *   control-plane binding, watchers and triggers, device pairing and grants,
 *   local voice provisioning, delivery, at-rest retention.
 *
 * - `client` — presentation and per-installation lifecycle. Genuinely local and
 *   genuinely different between the TUI, the agent and the web UI: rendering,
 *   theme, transcript display, keybindings, and the "do I run/embed a daemon at
 *   all" switches (`daemon.*`, `service.*`) which are a property of THIS
 *   installation, not of the daemon's behavior. This is the DEFAULT scope — a
 *   key is client-owned unless it is listed below, so adding a schema key never
 *   silently relocates a user's existing value.
 *
 * - `user` — cross-client defaults that ride the surface-root-independent
 *   shared tier (`~/.goodvibes/shared/settings.json`).
 *
 * Two user-level precedences exist and the difference is deliberate:
 *   - `shared-wins` (the voice/tts keys, unchanged since the shared tier
 *     shipped): the shared value overlays the surface value, so every surface
 *     speaks with one voice.
 *   - `local-override` (model / reasoning effort): the shared value is a
 *     DEFAULT that applies only where the surface has not set the key itself,
 *     which is what "a client may override locally" means.
 */

import type { ConfigKey } from './schema.js';
import { CONFIG_SCHEMA } from './schema.js';

/** Which runtime owns — and therefore writes — a config key. */
export type ConfigScope = 'daemon' | 'client' | 'user';

/**
 * Whole config domains the daemon executes unattended. A key is daemon-owned
 * when it starts with one of these prefixes.
 *
 * Deliberately NOT here, and why:
 *   - `daemon.*`   — "does THIS installation run/embed a daemon"; the agent
 *                    answers no and the TUI answers yes, and neither answer is
 *                    the daemon's to give. Making it daemon-owned would make
 *                    the agent start a daemon because the TUI runs one.
 *   - `service.*`  — same shape: per-installation platform-service lifecycle.
 *   - `voice.wake.*` — the wake word listens inside each client process.
 */
export const DAEMON_OWNED_CONFIG_PREFIXES: readonly string[] = [
  'surfaces.',
  'controlPlane.',
  'httpListener.',
  'web.',
  'relay.',
  'watchers.',
  'device.',
  'automation.',
  'checkin.',
  'integrations.',
  'atRest.',
  'voice.local.',
  // The daemon is the process that receives inbound channel messages, so it is
  // the process that decides whether one becomes a conversation or a
  // workstream. Left client-owned, the setting lived in whichever client the
  // operator happened to edit and the daemon never read it: a `mode` set from
  // the TUI or the agent reported success, landed in that client's file, and
  // changed nothing about what an inbound Telegram or ntfy message did.
  'conversationGate.',
  // Leader election decides which node CONSUMES inbound channel messages, and
  // the daemon is the process that does that consuming. Left client-owned, the
  // group, port and shared phrase would live in whichever client the operator
  // happened to edit, while the daemon kept coordinating on the defaults —
  // producing the exact failure the election exists to prevent (two nodes each
  // certain they are alone) with a settings file that reads as if it were
  // configured.
  'cluster.',
];

/** Individual daemon-owned keys that do not sit under a daemon-owned domain. */
export const DAEMON_OWNED_CONFIG_KEYS: readonly string[] = [
  'danger.httpListener',
];

/**
 * Daemon-owned config paths that are NOT scalar schema keys.
 *
 * `listDaemonOwnedConfigKeys()` is derived from CONFIG_SCHEMA, and CONFIG_SCHEMA
 * only describes scalars. An array-valued daemon setting therefore has real
 * ownership (`isDaemonOwnedConfigKey` matches it by prefix, so `set` routes it
 * to the daemon store) but was invisible to everything that WALKS the owned set:
 * the migration never moved it, the daemon-tier overlay never read it back, and
 * a whole-config save never stripped it from the surface file. The result is a
 * value that looks daemon-owned, is written to the daemon store when set through
 * the API, and is silently ignored when it already exists in a client silo.
 *
 * `conversationGate.gatedSurfaces` is the live case: `conversationGate.mode`
 * migrated and this list did not, so a machine could have the gate's mode in the
 * daemon store and its surface list stranded in `~/.goodvibes/tui/settings.json`.
 *
 * Adding a path here grows the covered set, which is what makes the migration
 * re-run on the next start and pick the stranded value up.
 */
export const DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS = [
  'conversationGate.gatedSurfaces',
  // Same shape as gatedSurfaces: an array-valued daemon setting that the
  // prefix match already routes to the daemon store, but that every owned-set
  // WALK would miss without an entry here — so a static peer list set before
  // this shipped would strand in a client silo and the daemon would keep
  // coordinating over multicast alone on a network that drops it.
  'cluster.peers',
  // The group's key material. Daemon-owned for the same reason the rest of the
  // cluster's settings are: the daemon is the only thing that reads it, and a
  // client silo can only hold a stale copy of it.
  //
  // Being daemon-owned does NOT make it replicate — `cluster.` is ruled
  // node-local in config-replication-policy.ts, and for this key that ruling is
  // load-bearing rather than incidental. See the note there.
  'cluster.groupMaterial',
  // The credentials the daemon needs to keep mail and calendar working.
  //
  // These are app-layer paths rather than CONFIG_SCHEMA keys, which is exactly
  // why they need naming here: the derivation walks daemon-owned paths, and a
  // path nothing declares is a credential nothing files in the daemon tier.
  //
  // Without this, a node that wins a handover comes up with no way to read or
  // send mail, because the credential stayed in the silo of whichever client
  // the operator happened to paste it into. The symptom is email going quiet
  // after a failover with nothing in the logs to explain it.
  'email.passwordRef',
  'calendar.google.clientSecretRef',
  'calendar.microsoft.clientSecretRef',
  'google.oauth.refreshToken',
  // The private calendar feed address. A URL rather than a password, but it
  // grants read access to the operator's calendar to anyone holding it, so it
  // is treated as a credential and follows the same handover rules.
  'calendar.google.icsUrl',
  // The rest of the mail and calendar connection — everything that is not
  // itself a credential.
  //
  // The credentials above were daemon-owned before these were, and that split
  // does not survive contact with how the connector actually works. Resolving
  // a Google credential needs the client id as well as the client secret: with
  // the refresh token filed in the daemon tier and the client id stranded in
  // whichever surface the operator happened to run setup from, the daemon
  // holds half a credential and reports "no Google account connected" the
  // moment that surface is closed. Same for mail: the app password is useless
  // without the host, port and username that say where to send it.
  //
  // So the whole connection is daemon-owned. Setup performed in any surface
  // writes here, the daemon keeps working with no surface process running, and
  // every surface reads the same answer back.
  'email.enabled',
  'email.imapHost',
  'email.imapPort',
  'email.smtpHost',
  'email.smtpPort',
  'email.smtpSecurity',
  'email.username',
  'email.fromAddress',
  'calendar.google.clientId',
  'google.oauth.projectId',
  'google.oauth.publishingStatus',
  'google.credentials.migratedFrom',
] as const;

/** A daemon-owned path that has no scalar CONFIG_SCHEMA entry. */
export type DaemonOwnedNonSchemaConfigPath = (typeof DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS)[number];

/** Any path the daemon owns: a schema key, or a non-scalar path listed above. */
export type DaemonOwnedConfigPath = ConfigKey | DaemonOwnedNonSchemaConfigPath;

/**
 * User-level keys whose shared value OVERLAYS the surface value. This is the
 * original shared tier (see shared-config-tier.ts) and its behavior is
 * unchanged: one voice on every surface.
 */
export const USER_SHARED_WINS_CONFIG_KEYS: readonly string[] = [
  'tts.provider',
  'tts.voice',
  'tts.speed',
  'tts.llmProvider',
  'tts.llmModel',
];

/**
 * User-level keys whose shared value is only a DEFAULT: a surface that carries
 * its own explicit value keeps it. Set through `ConfigManager.setUserDefault`;
 * an ordinary `set` on one of these writes the surface-local override, which is
 * the behavior every existing installation already has.
 */
export const USER_LOCAL_OVERRIDE_CONFIG_KEYS: readonly string[] = [
  'provider.model',
  'provider.reasoningEffort',
];

const DAEMON_KEY_SET = new Set<string>(DAEMON_OWNED_CONFIG_KEYS);
const DAEMON_NON_SCHEMA_PATH_SET = new Set<string>(DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS);
const USER_SHARED_WINS_SET = new Set<string>(USER_SHARED_WINS_CONFIG_KEYS);
const USER_LOCAL_OVERRIDE_SET = new Set<string>(USER_LOCAL_OVERRIDE_CONFIG_KEYS);

/**
 * True when the daemon is the single writer and reader-of-record for `key`.
 *
 * The non-schema list is consulted HERE and not only by the owned-set walk.
 * When that list held nothing but `conversationGate.gatedSurfaces` and
 * `cluster.peers` the distinction did not matter: both sit under a daemon-owned
 * PREFIX, so this predicate already answered yes and the list existed purely so
 * a walk over owned paths would not miss a non-scalar. Credential paths added
 * since — `email.passwordRef`, the calendar client secrets, the Google refresh
 * token — have no such prefix, and for those the two answers disagreed: the
 * walk called them daemon-owned while this predicate called them client-owned.
 *
 * A key nobody claims is not stored twice, it is stored NOWHERE. The manager
 * routes daemon-owned keys to the daemon tier and everything else to the
 * surface tier, and a dynamic key that failed both tests was accepted, reported
 * as saved, and written to neither file. That is the exact silence config
 * ownership exists to prevent, applied to a password reference.
 */
export function isDaemonOwnedConfigKey(key: string): boolean {
  if (DAEMON_KEY_SET.has(key)) return true;
  if (DAEMON_NON_SCHEMA_PATH_SET.has(key)) return true;
  return DAEMON_OWNED_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** True when `key` rides the cross-client user tier (either precedence). */
export function isUserLevelConfigKey(key: string): boolean {
  return USER_SHARED_WINS_SET.has(key) || USER_LOCAL_OVERRIDE_SET.has(key);
}

/** True when a user-level key's shared value overlays the surface value. */
export function userTierOverlaysSurface(key: string): boolean {
  return USER_SHARED_WINS_SET.has(key);
}

/** True when `key` is presentation/per-installation state owned by each client. */
export function isClientOwnedConfigKey(key: string): boolean {
  return configKeyScope(key) === 'client';
}

/**
 * The owning runtime for `key`. `client` is the default, so an unclassified or
 * brand-new key keeps writing to the surface silo it already writes to.
 */
export function configKeyScope(key: string): ConfigScope {
  if (isDaemonOwnedConfigKey(key)) return 'daemon';
  if (isUserLevelConfigKey(key)) return 'user';
  return 'client';
}

let daemonOwnedKeyCache: readonly ConfigKey[] | null = null;

/**
 * Every schema key the daemon owns, in schema order. Memoized: the load and
 * migration paths walk this list per settings file, and CONFIG_SCHEMA is a
 * frozen module constant.
 */
export function listDaemonOwnedConfigKeys(): readonly ConfigKey[] {
  daemonOwnedKeyCache ??= CONFIG_SCHEMA
    .map((setting) => setting.key)
    .filter((key) => isDaemonOwnedConfigKey(key));
  return daemonOwnedKeyCache;
}

let daemonOwnedPathCache: readonly DaemonOwnedConfigPath[] | null = null;

/**
 * Every path the daemon owns — schema keys PLUS the non-scalar paths above.
 *
 * This is the list every owned-set walk should use: migration, the daemon-tier
 * overlay, whole-config strip, and reset. `listDaemonOwnedConfigKeys` remains
 * for callers that genuinely need schema keys only (typed `get`/`set` surfaces).
 */
export function listDaemonOwnedConfigPaths(): readonly DaemonOwnedConfigPath[] {
  daemonOwnedPathCache ??= [
    ...listDaemonOwnedConfigKeys(),
    ...DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS,
  ];
  return daemonOwnedPathCache;
}

/**
 * Human-readable reason a client may not be the writer for `key` — used by the
 * routing layer's failure text so "this went somewhere else" is never silent.
 */
export function describeConfigOwnership(key: string): string {
  switch (configKeyScope(key)) {
    case 'daemon':
      return `${key} is daemon-owned: the daemon executes it, so the daemon's config is its only home.`;
    case 'user':
      return `${key} is a user-level default shared across clients.`;
    default:
      return `${key} is client-owned and stays in this client's own settings.`;
  }
}
