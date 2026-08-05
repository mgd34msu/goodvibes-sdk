/**
 * schema-types-connectors.ts — the `email.*` / `calendar.*` / `google.*`
 * connector domains' types.
 *
 * Split out the same way schema-types-owner-profile.ts and
 * schema-types-occasions.ts were: the shape, the key union and the key->value
 * map live beside each other here, and schema-types.ts folds them into
 * `ConfigKey` and `ConfigValue` with one arm each (`| ConnectorsConfigKey`,
 * `K extends ConnectorsConfigKey ? ConnectorsConfigValue<K> :`).
 *
 * Types only. The defaults, the descriptions and the editable settings rows
 * are in schema-domain-connectors.ts, which is also where the `declare
 * module` merge into `GoodVibesConfig` lives — co-located with the defaults,
 * as every other domain does it.
 */

/** IMAP connection security for the mail connector. No 'auto': the operator either asked for TLS or asked not to have it. */
export type EmailConnectorImapSecurity = 'tls' | 'plaintext';

/** SMTP connection security for the mail connector. 'auto' picks TLS on 465 and STARTTLS elsewhere. */
export type EmailConnectorSmtpSecurity = 'tls' | 'starttls' | 'auto';

/** The mail connector's account (`email.*`): what the daemon composes, sends and lists mail through. */
export interface EmailConnectorConfig {
  enabled: boolean;
  imapHost: string;
  imapPort: number;
  imapSecurity: EmailConnectorImapSecurity;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: EmailConnectorSmtpSecurity;
  username: string;
  passwordRef: string;
  smtpPasswordRef: string;
  fromAddress: string;
  mailbox: string;
  draftsMailbox: string;
}

/** One OAuth calendar provider's registered app (`calendar.<provider>.*`). */
export interface CalendarConnectorProviderConfig {
  clientId: string;
  clientSecretRef: string;
}

/** The `calendar` connector section: one entry per OAuth calendar provider. */
export interface CalendarConnectorConfig {
  google: CalendarConnectorProviderConfig & { icsUrl: string };
  microsoft: CalendarConnectorProviderConfig;
}

/** The `google` connector section: the Cloud project and the OAuth app's state. */
export interface GoogleConnectorConfig {
  oauth: {
    projectId: string;
    publishingStatus: string;
    refreshToken: string;
  };
  credentials: {
    migratedFrom: string;
  };
}

/** Dot-path keys for the `email.*` / `calendar.*` / `google.*` connector domains. */
export type ConnectorsConfigKey =
  | 'email.enabled'
  | 'email.imapHost'
  | 'email.imapPort'
  | 'email.imapSecurity'
  | 'email.smtpHost'
  | 'email.smtpPort'
  | 'email.smtpSecurity'
  | 'email.username'
  | 'email.passwordRef'
  | 'email.smtpPasswordRef'
  | 'email.fromAddress'
  | 'email.mailbox'
  | 'email.draftsMailbox'
  | 'calendar.google.clientId'
  | 'calendar.google.clientSecretRef'
  | 'calendar.google.icsUrl'
  | 'calendar.microsoft.clientId'
  | 'calendar.microsoft.clientSecretRef'
  | 'google.oauth.projectId'
  | 'google.oauth.publishingStatus'
  | 'google.oauth.refreshToken'
  | 'google.credentials.migratedFrom';

/**
 * Maps a connector key to its value type.
 *
 * Every key is written out, terminating in `never`, rather than collapsing
 * the repeated strings into a default arm — the completeness gate
 * (test/config-key-union-completeness.test.ts) reads these clauses out of
 * the source to prove no schema key is missing a typed accessor, and a
 * default arm would make most of them invisible to it.
 */
export type ConnectorsConfigValue<K extends ConnectorsConfigKey> =
  K extends 'email.enabled' ? boolean :
  K extends 'email.imapHost' ? string :
  K extends 'email.imapPort' ? number :
  K extends 'email.imapSecurity' ? EmailConnectorImapSecurity :
  K extends 'email.smtpHost' ? string :
  K extends 'email.smtpPort' ? number :
  K extends 'email.smtpSecurity' ? EmailConnectorSmtpSecurity :
  K extends 'email.username' ? string :
  K extends 'email.passwordRef' ? string :
  K extends 'email.smtpPasswordRef' ? string :
  K extends 'email.fromAddress' ? string :
  K extends 'email.mailbox' ? string :
  K extends 'email.draftsMailbox' ? string :
  K extends 'calendar.google.clientId' ? string :
  K extends 'calendar.google.clientSecretRef' ? string :
  K extends 'calendar.google.icsUrl' ? string :
  K extends 'calendar.microsoft.clientId' ? string :
  K extends 'calendar.microsoft.clientSecretRef' ? string :
  K extends 'google.oauth.projectId' ? string :
  K extends 'google.oauth.publishingStatus' ? string :
  K extends 'google.oauth.refreshToken' ? string :
  K extends 'google.credentials.migratedFrom' ? string :
  never;
