/**
 * connector-config-sections.ts — the app-layer config sections the mail and
 * calendar connector lives in, seeded in one call for every product.
 *
 * `email`, `calendar` and `google` are not CONFIG_SCHEMA categories. They are
 * app-layer sections, and `ConfigManager.resolvePath` throws
 * "Invalid config path: section 'calendar' does not exist" for a section that
 * is not on the live config object — so every product has to seed them before
 * the connector reads or writes anything.
 *
 * The defect this exists to fix. The three seeders were in three different
 * places, and one of them was not in the SDK at all:
 *
 *   - `ensureEmailConfigDefaults`  — SDK, platform/email
 *   - `ensureGoogleConfigDefaults` — SDK, platform/google
 *   - `ensureCalendarConfigDefaults` — **goodvibes-agent only**
 *
 * The SDK's own connector writes `calendar.google.clientId` and
 * `calendar.google.clientSecretRef` (see `adoptExistingGoogleCredentials`). So
 * the connector could only run inside the one product that happened to carry
 * the third seeder. Anywhere else — the daemon, the TUI, the web UI, a fresh
 * node that took over after a handover — the first write threw, and a reader
 * asking whether an account was connected could not even reach the key to find
 * out. That is the same shape as the storage-tier defect it sits next to: a
 * connection that exists in one surface and does not exist anywhere else.
 *
 * The owner's rule is that a capability configured on any surface is the
 * daemon's to use afterwards. A seeder only one surface has makes that
 * impossible before scope routing is even consulted, so it lives here, beside
 * the ownership rules, and one call seeds all three.
 */

/** The `calendar` section: one entry per OAuth calendar provider. */
const CALENDAR_CONFIG_DEFAULTS = {
  google: { clientId: '', clientSecretRef: '' },
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
