/**
 * config-ownership.ts, which runtime OWNS a config key.
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
 * - `daemon`, the daemon executes it unattended, so it has exactly one home:
 *   the daemon tier (`~/.goodvibes/daemon/settings.json`). Chat surfaces,
 *   control-plane binding, watchers and triggers, device pairing and grants,
 *   local voice provisioning, delivery, at-rest retention.
 *
 * - `client`, presentation and per-installation lifecycle. Genuinely local and
 *   genuinely different between the TUI, the agent and the web UI: rendering,
 *   theme, transcript display, keybindings, and the "do I run/embed a daemon at
 *   all" switches (`daemon.*`, `service.*`) which are a property of THIS
 *   installation, not of the daemon's behavior. This is the DEFAULT scope, a
 *   key is client-owned unless it is listed below, so adding a schema key never
 *   silently relocates a user's existing value.
 *
 * - `user`, cross-client defaults that ride the surface-root-independent
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

/** Which runtime owns, and therefore writes, a config key. */
export type ConfigScope = 'daemon' | 'client' | 'user';

/**
 * Whole config domains the daemon executes unattended. A key is daemon-owned
 * when it starts with one of these prefixes.
 *
 * Deliberately NOT here, and why:
 *   - `daemon.*`  , "does THIS installation run/embed a daemon"; the agent
 *                    answers no and the TUI answers yes, and neither answer is
 *                    the daemon's to give. Making it daemon-owned would make
 *                    the agent start a daemon because the TUI runs one.
 *   - `service.*` , same shape: per-installation platform-service lifecycle.
 *   - `voice.wake.*`, the wake word listens inside each client process.
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
  // The daemon is the process that holds the card and charges it, with every
  // surface closed and across restarts. Card material and budgets left
  // client-owned would live in whichever surface happened to enter them and the
  // daemon would charge against defaults, the failure mode the budget exists to
  // prevent. See docs/payments.md §3.
  'payments.',
  'voice.local.',
  // The daemon is the process that receives inbound channel messages, so it is
  // the process that decides whether one becomes a conversation or a
  // workstream. Left client-owned, the setting lived in whichever client the
  // operator happened to edit and the daemon never read it: a `mode` set from
  // the TUI or the agent reported success, landed in that client's file, and
  // changed nothing about what an inbound Telegram or ntfy message did.
  'conversationGate.',
  // Hosted sessions run IN the daemon, so the process that reads the detach
  // policy, enforces the session cap and bounds the persisted transcript is the
  // daemon. Left client-owned, a detach policy flipped to `survive` from the
  // terminal would land in the terminal's silo while the daemon, the process
  // that actually decides whether a session outlives its client, kept reading
  // the default, and the setting would report success and change nothing.
  'hostedSessions.',
  // Leader election decides which node CONSUMES inbound channel messages, and
  // the daemon is the process that does that consuming. Left client-owned, the
  // group, port and shared phrase would live in whichever client the operator
  // happened to edit, while the daemon kept coordinating on the defaults,
  // producing the exact failure the election exists to prevent (two nodes each
  // certain they are alone) with a settings file that reads as if it were
  // configured.
  'cluster.',
  // The owner profile is one file at daemon scope with the daemon as its single
  // writer, so the policy governing it has to resolve from the daemon store as
  // well. Left client-owned, `profile.autonomousWrites` turned off from the TUI
  // would land in the TUI's silo while the daemon, the process that loads the
  // file, serves the profile.* verbs and decides whether a fact gets recorded,
  // kept reading the default. That is the reported-success-configured-nothing
  // failure the daemon tier exists for, and this instance would be a bad one:
  // the operator would believe they had stopped autonomous recording.
  'profile.',
  // The occasions sweep runs IN the daemon, on a timer, with every surface
  // closed. Its lead time, its quiet window, its cadence and its delivery
  // channel are read there and nowhere else, so a value set from a surface and
  // left in that surface's silo would configure nothing while reporting
  // success, the same failure `profile.` is here for, one feature along.
  'occasions.',
  // The mail and calendar connector: the account the daemon composes, sends
  // and lists mail through, and the calendar client it authenticates with,
  // set up once from any surface and used by the daemon with every surface
  // closed. There are no other `email.`, `calendar.` or `google.` schema
  // keys, so the prefix is safe: it cannot silently pick up an unrelated key
  // added under one of these names later without a schema row of its own
  // making it visible here first. Left client-owned, a Gmail app password
  // reference or an OAuth client id set from one surface would strand in
  // that surface's silo and the daemon, the process that actually reads
  // mail and refreshes the calendar unattended, would keep reporting "not
  // connected", the exact failure this migration exists to end. See
  // schema-domain-connectors.ts for what changed and why.
  'email.',
  'calendar.',
  'google.',
];

/** Individual daemon-owned keys that do not sit under a daemon-owned domain. */
export const DAEMON_OWNED_CONFIG_KEYS: readonly string[] = [
  'danger.httpListener',
  // The one `daemon.*` key that is NOT a per-installation switch.
  //
  // The rest of that prefix answers "does THIS machine run or embed a daemon",
  // which is rightly client-owned. `daemon.timezone` answers something else
  // entirely: where the daemon thinks it IS. Anything that resets on a calendar
  // day reads it, starting with the payment capability's daily budgets.
  //
  // Left client-owned it would land in whichever surface the operator happened
  // to set it from, and the daemon, the process that actually rolls the budget
  // over at midnight, would never see it and would keep resetting in UTC. The
  // operator would have picked a zone, been shown that zone, and had their
  // money reset in a different one.
  'daemon.timezone',
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
  // WALK would miss without an entry here, so a static peer list set before
  // this shipped would strand in a client silo and the daemon would keep
  // coordinating over multicast alone on a network that drops it.
  'cluster.peers',
  // The group's key material. Daemon-owned for the same reason the rest of the
  // cluster's settings are: the daemon is the only thing that reads it, and a
  // client silo can only hold a stale copy of it.
  //
  // Being daemon-owned does NOT make it replicate, `cluster.` is ruled
  // node-local in config-replication-policy.ts, and for this key that ruling is
  // load-bearing rather than incidental. See the note there.
  'cluster.groupMaterial',
  // NOTE: the mail and calendar connector's `email.*`, `calendar.google.*`,
  // `calendar.microsoft.*` and `google.*` keys, nineteen of them, were
  // listed here for a while, for the same reason `surfaces.email.*` and
  // `surfaces.calendar.*` were listed above this note before they moved:
  // they were app-layer paths seeded onto the live config object by a
  // structural cast (`connector-config-sections.ts`), not CONFIG_SCHEMA
  // keys, and the derivation below walks the ENUMERATED daemon-owned paths
  // rather than matching an `email.`/`calendar.`/`google.` prefix that did
  // not exist yet, so nothing enumerating them meant no daemon-owned
  // credential name was derived from them, and a stored app password or
  // OAuth client secret went to whichever client silo the operator happened
  // to be in.
  //
  // They are gone from this list because they are now real CONFIG_SCHEMA
  // entries (schema-domain-connectors.ts), which is the better home: it
  // makes them daemon-owned AND renders them in the settings modal, so an
  // operator can actually see and edit the connection the daemon is using.
  // This list is for paths that are NOT scalar schema keys, and keeping them
  // here as well would double-count them in every owned-set walk, the same
  // reason the `surfaces.` pair is not repeated here either.
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
 * a walk over owned paths would not miss a non-scalar. `email.passwordRef`, the
 * calendar client secrets and the Google refresh token went through exactly
 * that gap for a while: they were on this list before `email.`/`calendar.`/
 * `google.` were daemon-owned prefixes, so the two answers disagreed, the
 * walk called them daemon-owned while this predicate called them client-owned.
 * They are schema keys under those prefixes now (schema-domain-connectors.ts),
 * so the prefix match alone answers yes for all of them.
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
 * Every path the daemon owns, schema keys PLUS the non-scalar paths above.
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
 * Human-readable reason a client may not be the writer for `key`, used by the
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
