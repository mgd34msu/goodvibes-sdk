/**
 * connector-config-sections.ts — seeders for the mail and calendar
 * connector's config sections, kept as a backstop now that the sections are
 * schema-registered.
 *
 * `email`, `calendar` and `google` are real CONFIG_SCHEMA categories now
 * (schema-domain-connectors.ts), with real defaults in `DEFAULT_CONFIG` — the
 * defect this file used to exist to fix (a settings surface answering
 * "Unknown setting calendar.google.clientId" for a key the daemon genuinely
 * reads and writes, because the section lived nowhere CONFIG_SCHEMA could see
 * it) is fixed there instead. `seedSection`'s own `if (section in config)
 * return` therefore makes every seeder below a no-op against a ConfigManager
 * built from `DEFAULT_CONFIG`, which every product-composed ConfigManager is.
 *
 * The functions stay because products still call them, and removing them is
 * out of scope for the schema migration. What they are FOR now is a config
 * object assembled some other way than through `DEFAULT_CONFIG` — a hand-built
 * test fixture, an older cached snapshot from before this migration shipped —
 * where `email`/`calendar`/`google` might still be genuinely absent. For that
 * narrow case they still do what they always did: seed the section once,
 * quietly, so `ConfigManager.resolvePath` does not throw "Invalid config path:
 * section 'calendar' does not exist" on the connector's first read or write.
 *
 * Originally three separate seeders in three different places — one of them
 * (`ensureCalendarConfigDefaults`) not in the SDK at all, only in
 * goodvibes-agent — folded into the one call here so a capability configured
 * from any surface stays usable everywhere the daemon runs, not just the one
 * product that happened to carry the third seeder.
 */

/** The `calendar` section: one entry per OAuth calendar provider. */
const CALENDAR_CONFIG_DEFAULTS = {
  google: { clientId: '', clientSecretRef: '', icsUrl: '' },
  microsoft: { clientId: '', clientSecretRef: '' },
} as const;

/** The `google` section: the Cloud project and the OAuth app's state. */
const GOOGLE_CONFIG_DEFAULTS = {
  oauth: { projectId: '', publishingStatus: '', refreshToken: '' },
  credentials: { migratedFrom: '' },
} as const;

/** The `email` section: an IMAP/SMTP mailbox and where its password is kept. */
const EMAIL_CONFIG_DEFAULTS = {
  enabled: false,
  imapHost: '',
  imapPort: 993,
  imapSecurity: 'tls' as const,
  smtpHost: '',
  smtpPort: 587,
  smtpSecurity: 'auto' as const,
  username: '',
  passwordRef: '',
  smtpPasswordRef: '',
  fromAddress: '',
  mailbox: '',
  draftsMailbox: '',
} as const;

/**
 * The live config object behind a ConfigManager.
 *
 * Reached by cast, which is the sanctioned extension pattern for a category
 * absent from the built-in schema — the same one the three original seeders
 * used. Structural rather than a nominal ConfigManager import so this module
 * stays free of the manager's dependency graph.
 */
function liveConfig(configManager: object): Record<string, unknown> | null {
  const cm = configManager as { config?: Record<string, unknown> };
  return cm.config ?? null;
}

function seedSection(configManager: object, section: string, defaults: object): void {
  const config = liveConfig(configManager);
  if (config === null || section in config) return;
  config[section] = structuredClone(defaults);
}

/** Seed the `calendar` section if absent. Safe to call repeatedly. */
export function ensureCalendarConfigDefaults(configManager: object): void {
  seedSection(configManager, 'calendar', CALENDAR_CONFIG_DEFAULTS);
}

/** Seed the `google` section if absent. Safe to call repeatedly. */
export function ensureGoogleOAuthConfigDefaults(configManager: object): void {
  seedSection(configManager, 'google', GOOGLE_CONFIG_DEFAULTS);
}

/** Seed the `email` section if absent. Safe to call repeatedly. */
export function ensureMailboxConfigDefaults(configManager: object): void {
  seedSection(configManager, 'email', EMAIL_CONFIG_DEFAULTS);
}

/**
 * Seed every section the mail and calendar connector touches.
 *
 * This is what a product should call. Seeding a subset is how the connector
 * came to work in one surface and throw in the others: the flow spans all three
 * sections, and which ones a given caller happened to seed was an accident of
 * which imports it already had.
 */
export function ensureConnectorConfigSections(configManager: object): void {
  ensureGoogleOAuthConfigDefaults(configManager);
  ensureCalendarConfigDefaults(configManager);
  ensureMailboxConfigDefaults(configManager);
}
