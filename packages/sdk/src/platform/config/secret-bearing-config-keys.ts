/**
 * secret-bearing-config-keys.ts, the config keys whose VALUE is a credential.
 *
 * Distinct from `credential-scope-registry.ts`, and the two answer different
 * questions. That one asks "does the daemon need this SECRET", and routes it to
 * the right store. This one asks "does this CONFIG KEY hold credential material
 * rather than a setting", and the answer decides three things a config key
 * cannot decide for itself:
 *
 *   - a write goes into the encrypted secret store, with only a
 *     `goodvibes://secrets/…` reference left in the config file;
 *   - a render masks it, at rest AND while it is being typed;
 *   - a diagnostic dump redacts it.
 *
 * ── Why it is here and not in each product ──────────────────────────────────
 *
 * It was in each product. goodvibes-tui and goodvibes-agent each carried a
 * hand-maintained `SECRET_CONFIG_KEYS`, the web UI carried a third list for
 * masking only, and the three had already drifted from each other and from the
 * schema. `surfaces.email.password` and `surfaces.calendar.caldavPassword` were
 * missing from the set that routes a write, so their own schema descriptions,
 * which read "Stored in the daemon secret tier, never in config", were
 * aspirational: the settings modal wrote both as plain strings into a config
 * JSON file, and the generic `/config set` had no detection at all.
 *
 * A product can still add to this, a surface may have a credential the SDK
 * knows nothing about, but the platform's own set lives in one place, next to
 * the ownership rules that decide where the value it points at is filed.
 *
 * ── Why it is a list rather than a name pattern ─────────────────────────────
 *
 * Because a name pattern is a habit, not a rule. Every redactor in this
 * platform matched by trailing word, `…password`, `…token`, `…secret`, and
 * every one of them was blind to a key that did not fit the habit:
 * `surfaces.msteams.appPassword` ends in `Password` and matched;
 * `cardNumber`, `cardExpiry` and `cardholderName` end in none of them and
 * matched nothing at all. A declared list is checkable, reviewable, and wrong
 * only in ways someone can see.
 */

/**
 * Every platform config key whose value is credential material.
 *
 * Grouped by the surface that owns the setting, so a channel added without its
 * credential is visible as a gap in the group rather than invisible in a sorted
 * list.
 */
export const SECRET_BEARING_CONFIG_PATHS: readonly string[] = [
  // The daemon's own mailbox and calendar account.
  'surfaces.email.password',
  'surfaces.email.imapPassword',
  'surfaces.email.imap.password',
  'surfaces.email.smtp.password',
  'surfaces.calendar.caldavPassword',

  // The connector's app-layer mail and calendar connection. These hold a
  // REFERENCE by design (`email.passwordRef`), which is exactly why they belong
  // here: a reference field that has been handed a literal password is the
  // failure this set exists to catch and repair.
  'email.passwordRef',
  'email.smtpPasswordRef',
  'calendar.google.clientSecretRef',
  'calendar.microsoft.clientSecretRef',
  'calendar.google.icsUrl',
  'google.oauth.refreshToken',

  // Chat and notification surfaces, all run by the daemon.
  'surfaces.slack.botToken',
  'surfaces.slack.signingSecret',
  'surfaces.slack.appToken',
  'surfaces.discord.botToken',
  'surfaces.ntfy.token',
  'surfaces.telegram.botToken',
  'surfaces.telegram.webhookSecret',
  'surfaces.googleChat.verificationToken',
  'surfaces.signal.token',
  'surfaces.whatsapp.accessToken',
  'surfaces.whatsapp.verifyToken',
  'surfaces.whatsapp.signingSecret',
  'surfaces.imessage.token',
  'surfaces.msteams.appPassword',
  'surfaces.bluebubbles.password',
  'surfaces.mattermost.botToken',
  'surfaces.matrix.accessToken',
  'surfaces.webhook.secret',
  'surfaces.homeassistant.accessToken',
  'surfaces.homeassistant.webhookSecret',

  // Telephony delivery.
  'surfaces.telephony.authToken',
  'surfaces.telephony.token',
  'surfaces.telephony.webhookSecret',

  // Cluster key material.
  'cluster.groupMaterial',
  // The shared phrase nodes sign coordination messages with. Found by the
  // declaration-coverage check rather than by anyone noticing: it was masked by
  // the name-pattern backstop and declared nowhere, which is exactly the state
  // that backstop exists to make survivable and must never be left in.
  'cluster.secret',
];

const SECRET_BEARING_SET = new Set<string>(SECRET_BEARING_CONFIG_PATHS);

/**
 * A last-resort name pattern, kept ALONGSIDE the list and never instead of it.
 *
 * The list is the rule. This catches a key nobody has declared yet, a new
 * surface's token, a field added in a hurry, so an undeclared credential is
 * masked rather than printed while someone gets around to declaring it. It is
 * additive only: it can never un-mask something the list covers.
 */
const CREDENTIAL_NAME_PATTERN = /(^|\.)[a-z0-9]*(password|passphrase|secret|token|apikey|api_key|credential)$/i;

/** True when this config key's value is credential material. */
export function isSecretBearingConfigKey(key: string): boolean {
  return SECRET_BEARING_SET.has(key) || CREDENTIAL_NAME_PATTERN.test(key);
}

/** True when this key is DECLARED, rather than caught by the name pattern. */
export function isDeclaredSecretBearingConfigKey(key: string): boolean {
  return SECRET_BEARING_SET.has(key);
}

/**
 * A stored config value that is a `goodvibes://` reference rather than a
 * literal. A reference is the correct at-rest shape; a literal is the defect.
 */
export function isSecretReferenceValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith('goodvibes://secrets/');
}
