/**
 * credential-scope-registry.ts — every credential this platform stores, and
 * whether the daemon needs it.
 *
 * The rule, in one sentence, and it is the owner's:
 *
 *   Anything configured on one surface is available to the daemon, even after
 *   that surface has closed. So any credential a daemon-side capability needs
 *   in order to function is written at DAEMON scope, no matter which surface
 *   captured it.
 *
 * What went wrong without this. `daemon-secret-keys.ts` already derives daemon
 * ownership from daemon-owned CONFIG paths, and that works — for credentials a
 * config path names. It cannot see the others. `SLACK_BOT_TOKEN`,
 * `CLOUDFLARE_API_TOKEN`, `GOODVIBES_CALENDAR_GOOGLE_TOKENS`, the relay identity
 * keypair, the per-subscription calendar feed keys: bare names an operator or a
 * subsystem invented, that nothing derives, so nothing filed them in the daemon
 * tier. Each went to whichever silo the capturing surface happened to use, and
 * the daemon — the process that actually sends the Slack message, opens the
 * tunnel, reads the calendar — could not read any of them. The symptom is always
 * the same and always looks like something else: a capability that reports
 * itself unconfigured while working credentials sit on the same disk.
 *
 * It appeared once with Google mail (`/google adopt` succeeded in the agent, and
 * the daemon answering Telegram said no email integration was available), once
 * with payment card fields (the settings modal wrote at user scope while the
 * command wrote at daemon scope), and once with the Telegram bot username. Three
 * incidents, one defect.
 *
 * ── How this file makes the wrong thing hard ────────────────────────────────
 *
 * 1. Every credential key is DECLARED here with a typed scope and a reason.
 *    `daemon-needed` or `surface-local` — there is no third answer and no
 *    default, so "which is it" is a question someone answered on purpose.
 *
 * 2. `isDaemonNeededSecretKey` consults this registry, and `SecretsManager.set`
 *    consults that. A `daemon-needed` key requested at any other scope is
 *    RELOCATED to the daemon tier and the relocation is logged. The write is
 *    never dropped: refusing it would put a wall in front of the credentials
 *    people most need to set, and the caller's scope argument is nearly always
 *    a default it never thought about rather than an intent.
 *
 * 3. `scripts/check-credential-scope.ts` walks every `secrets.set(...)` call
 *    site in the SDK and fails the build on a credential key that is not
 *    declared here. Adding a credential without classifying it does not compile
 *    past the gate, which is the part that stops this recurring.
 *
 * ── What counts as surface-local ────────────────────────────────────────────
 *
 * A credential is surface-local ONLY when the daemon can never be the thing
 * that uses it. That is a narrow set: state that is meaningless off the machine
 * or the process that made it. It is NOT "the surface captured it", and it is
 * NOT "only that surface has UI for it" — the daemon does the work whichever
 * surface set it up.
 */

import { daemonSecretKeyFor, listDaemonOwnedSecretKeys } from './daemon-secret-keys.js';
import { BUILTIN_PROVIDER_ENV_KEYS } from '../providers/builtin-catalog.js';

/** Whether the daemon is ever the process that uses this credential. */
export type CredentialScopeClass =
  /** The daemon executes with it. Daemon tier, whichever surface captured it. */
  | 'daemon-needed'
  /** Only the capturing process can ever use it. Stays in that surface's store. */
  | 'surface-local';

/** One declared credential. */
export interface CredentialScopeDeclaration {
  /** The secret-store key, or a prefix when the suffix is user-chosen (see `match`). */
  readonly key: string;
  /**
   * `exact` — the key is this literal string.
   * `prefix` — the key starts with this string; the rest is a name a person or
   *            a provider chose (a calendar subscription's name, a provider id).
   */
  readonly match: 'exact' | 'prefix';
  readonly scope: CredentialScopeClass;
  /** Which daemon-side capability needs it, or why the daemon can never want it. */
  readonly why: string;
}

/**
 * The declarations.
 *
 * Grouped by the capability that reads them, because that grouping is the
 * argument: if the daemon performs the capability, the credential is the
 * daemon's, and the group makes it obvious when one member has been left behind.
 */
export const CREDENTIAL_SCOPE_DECLARATIONS: readonly CredentialScopeDeclaration[] = [
  // ── Chat and notification channels ────────────────────────────────────────
  // The daemon is the process that holds the socket, receives the inbound
  // message and sends the reply. A client silo can only hold a stale copy.
  //
  // These are the BARE names the channel account actions store under
  // (channels/builtin/account-actions.ts). Their `surfaces.<channel>.<field>`
  // config twins are already daemon-owned by prefix; the bare names were not,
  // so the same logical token landed in the daemon tier or a project store
  // depending purely on which route an operator took to set it.
  { key: 'SLACK_BOT_TOKEN', match: 'exact', scope: 'daemon-needed', why: 'The daemon runs the Slack surface: it holds the socket and posts the reply.' },
  { key: 'SLACK_SIGNING_SECRET', match: 'exact', scope: 'daemon-needed', why: 'The daemon verifies inbound Slack requests with it.' },
  { key: 'SLACK_APP_TOKEN', match: 'exact', scope: 'daemon-needed', why: 'The daemon opens the Slack socket-mode connection with it.' },
  { key: 'DISCORD_BOT_TOKEN', match: 'exact', scope: 'daemon-needed', why: 'The daemon runs the Discord gateway connection.' },
  { key: 'NTFY_ACCESS_TOKEN', match: 'exact', scope: 'daemon-needed', why: 'The daemon publishes to ntfy, including when no client is running.' },

  // ── Reachability: tunnels, workers, relay ────────────────────────────────
  // All of it exists so the daemon is reachable while nothing else is running.
  // Stored at user scope by the provisioning flow and at project scope by the
  // onboarding wizard, so which one the daemon found depended on its working
  // directory.
  // Names taken from cloudflare/constants.ts rather than retyped: a
  // declaration that names a key nothing writes protects nothing.
  { key: 'CLOUDFLARE_API_TOKEN', match: 'exact', scope: 'daemon-needed', why: 'The daemon provisions and re-provisions its own tunnel and worker with it. Written at user scope by the provisioning flow and at project scope by the onboarding wizard, so which copy the daemon found depended on its working directory.' },
  { key: 'GOODVIBES_CLOUDFLARE_TUNNEL_TOKEN', match: 'exact', scope: 'daemon-needed', why: 'The daemon runs the tunnel that makes it reachable.' },
  { key: 'GOODVIBES_CLOUDFLARE_OPERATOR_TOKEN', match: 'exact', scope: 'daemon-needed', why: 'The daemon authenticates to its own edge worker with it.' },
  { key: 'GOODVIBES_CLOUDFLARE_WORKER_TOKEN', match: 'exact', scope: 'daemon-needed', why: 'Issued by the daemon for clients; the daemon is the authority that mints and checks it.' },
  { key: 'GOODVIBES_CLOUDFLARE_ACCESS_SERVICE_TOKEN', match: 'exact', scope: 'daemon-needed', why: 'The daemon presents it to Cloudflare Access on its own behalf.' },
  { key: 'relay.identity', match: 'exact', scope: 'daemon-needed', why: 'The relay identity IS the daemon\'s identity. Written with no scope, it defaulted to the project tier — so one machine grew a different identity per directory the daemon happened to start in.' },
  { key: 'push.vapid.keypair', match: 'exact', scope: 'daemon-needed', why: 'The daemon signs web-push notifications with it, and every subscription already registered is bound to that one public key — a second keypair in another tier silently invalidates them all.' },

  // ── Calendar ─────────────────────────────────────────────────────────────
  // The daemon answers "what is on my calendar" and creates events on a
  // schedule, with no client running. The connector's own client secret and
  // refresh token were already daemon-owned by config derivation; the OAuth
  // TOKEN STORE that the `/calendar connect` flow writes was not, so the two
  // halves of the same connection lived in different tiers.
  { key: daemonSecretKeyFor('calendar.google.tokens'), match: 'exact', scope: 'daemon-needed', why: 'The daemon reads and writes the Google calendar with this refresh token.' },
  { key: daemonSecretKeyFor('calendar.google.account'), match: 'exact', scope: 'daemon-needed', why: 'Names the account the daemon acts as on the calendar.' },
  { key: daemonSecretKeyFor('calendar.google.status'), match: 'exact', scope: 'daemon-needed', why: 'The connection health the daemon reports and refreshes from.' },
  { key: daemonSecretKeyFor('calendar.microsoft.tokens'), match: 'exact', scope: 'daemon-needed', why: 'The daemon reads and writes the Microsoft calendar with this refresh token.' },
  { key: daemonSecretKeyFor('calendar.microsoft.account'), match: 'exact', scope: 'daemon-needed', why: 'Names the account the daemon acts as on the calendar.' },
  { key: daemonSecretKeyFor('calendar.microsoft.status'), match: 'exact', scope: 'daemon-needed', why: 'The connection health the daemon reports and refreshes from.' },
  {
    key: 'GOODVIBES_CALENDAR_SUBSCRIPTION_',
    match: 'prefix',
    scope: 'daemon-needed',
    why: 'A subscribed feed URL grants read access to a calendar the daemon polls on a schedule; the suffix is the name the person gave the subscription.',
  },

  // Model-provider credentials are DERIVED from the provider catalog below
  // rather than listed here, so a new provider brings its key names along.

  // ── Cluster ──────────────────────────────────────────────────────────────
  { key: daemonSecretKeyFor('cluster.groupMaterial'), match: 'exact', scope: 'daemon-needed', why: 'Daemons authenticate to each other with it; it is meaningless to a client.' },

  // ── Genuinely surface-local ──────────────────────────────────────────────
  // The whole list. Each is state only the process that created it can use,
  // and none is a credential for a capability the daemon performs.
  {
    key: 'relay.stepup.state',
    match: 'exact',
    scope: 'surface-local',
    why: 'In-flight WebAuthn step-up challenge state for ONE verification attempt in ONE process. It expires in seconds and means nothing to another process; sharing it would widen a challenge, not a capability.',
  },
];

/**
 * Model-provider credentials, derived from the provider catalog.
 *
 * The daemon runs the model. Without a provider credential it cannot answer at
 * all — which is why this one stayed hidden: the key usually resolves from the
 * environment, so the STORED copy only matters when it does not, and by then
 * the daemon is the one that needs it and the TUI is the one that has it.
 *
 * Derived rather than hand-listed for the same reason daemon-secret-keys.ts
 * derives: a provider added to the catalog is covered without anyone
 * remembering, and a name here that no provider declares cannot exist.
 *
 * A CUSTOM provider's key name is chosen by the operator and is not in this
 * catalog, so it is not covered. Those call sites pass `scope: 'daemon'`
 * explicitly; see the credential-scope check script, which requires it.
 */
function providerCredentialDeclarations(): readonly CredentialScopeDeclaration[] {
  const seen = new Set<string>();
  const declarations: CredentialScopeDeclaration[] = [];
  for (const [providerId, envVars] of Object.entries(BUILTIN_PROVIDER_ENV_KEYS)) {
    for (const envVar of envVars) {
      if (seen.has(envVar)) continue;
      seen.add(envVar);
      declarations.push({
        key: envVar,
        match: 'exact',
        scope: 'daemon-needed',
        why: `The daemon calls the ${providerId} provider with it; a copy in one client's store is unreadable to the process that runs the model.`,
      });
    }
  }
  return declarations;
}

/** Declarations plus the derived provider set. The registry's real contents. */
function allDeclarations(): readonly CredentialScopeDeclaration[] {
  return [...CREDENTIAL_SCOPE_DECLARATIONS, ...providerCredentialDeclarations()];
}

interface CompiledDeclaration extends CredentialScopeDeclaration {
  readonly test: (key: string) => boolean;
}

let compiled: readonly CompiledDeclaration[] | null = null;

function compile(): readonly CompiledDeclaration[] {
  compiled ??= allDeclarations().map((declaration) => ({
    ...declaration,
    test: declaration.match === 'exact'
      ? (key: string) => key === declaration.key
      : (key: string) => key.startsWith(declaration.key) && key.length > declaration.key.length,
  }));
  return compiled;
}

/** The declaration covering `key`, or null when nothing declares it. */
export function findCredentialScopeDeclaration(key: string): CredentialScopeDeclaration | null {
  return compile().find((declaration) => declaration.test(key)) ?? null;
}

/**
 * True when the daemon is the reader-of-record for this credential.
 *
 * Two sources, deliberately: a credential a daemon-owned CONFIG path names
 * (derived, never hand-maintained — see daemon-secret-keys.ts), and a
 * credential declared above (bare names nothing derives). Either one is
 * sufficient; a key covered by neither keeps the scope its caller asks for.
 */
export function isDaemonNeededSecretKey(key: string): boolean {
  if (listDaemonOwnedSecretKeys().has(key)) return true;
  return findCredentialScopeDeclaration(key)?.scope === 'daemon-needed';
}

/**
 * The plain-language reason a credential is filed where it is. Used by the
 * relocation log line and by surfaces that tell an operator, before asking for
 * a credential, where it is about to go.
 */
export function describeCredentialScope(key: string): string {
  const configPath = listDaemonOwnedSecretKeys().get(key);
  if (configPath !== undefined) {
    return `${key} is daemon-owned because ${configPath} is: the daemon executes that setting, so the credential it names lives in the daemon's own store.`;
  }
  const declaration = findCredentialScopeDeclaration(key);
  if (declaration === null) {
    return `${key} is not a declared platform credential, so it keeps the scope its caller asked for.`;
  }
  return declaration.scope === 'daemon-needed'
    ? `${key} is daemon-needed: ${declaration.why}`
    : `${key} is surface-local: ${declaration.why}`;
}

/** Every declared daemon-needed key that matches exactly. Used by migration. */
export function listExactDaemonNeededKeys(): readonly string[] {
  return [
    ...listDaemonOwnedSecretKeys().keys(),
    ...allDeclarations()
      .filter((declaration) => declaration.scope === 'daemon-needed' && declaration.match === 'exact')
      .map((declaration) => declaration.key),
  ];
}

/** Every declared daemon-needed key PREFIX. Used by migration to sweep families. */
export function listDaemonNeededKeyPrefixes(): readonly string[] {
  return allDeclarations()
    .filter((declaration) => declaration.scope === 'daemon-needed' && declaration.match === 'prefix')
    .map((declaration) => declaration.key);
}
