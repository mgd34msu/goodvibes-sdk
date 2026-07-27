/**
 * Channel-surface config interfaces (one per adapter) and the SurfacesConfig
 * aggregate. Split out of schema-types.ts so that file stays under its
 * grandfathered line ceiling; re-exported from schema-types.ts so import
 * sites are unchanged.
 */
export interface SlackSurfaceConfig {
  enabled: boolean;
  signingSecret: string;
  botToken: string;
  appToken: string;
  defaultChannel: string;
  workspaceId: string;
  setupVersion: number;
}

export interface DiscordSurfaceConfig {
  enabled: boolean;
  publicKey: string;
  botToken: string;
  applicationId: string;
  defaultChannelId: string;
  guildId: string;
  setupVersion: number;
}

export interface NtfySurfaceConfig {
  enabled: boolean;
  baseUrl: string;
  topic: string;
  chatTopic: string;
  agentTopic: string;
  remoteTopic: string;
  token: string;
  defaultPriority: number;
  setupVersion: number;
}

export interface WebhookSurfaceConfig {
  enabled: boolean;
  defaultTarget: string;
  timeoutMs: number;
  secret: string;
  setupVersion: number;
}

export interface HomeAssistantSurfaceConfig {
  enabled: boolean;
  instanceUrl: string;
  accessToken: string;
  webhookSecret: string;
  defaultConversationId: string;
  deviceId: string;
  deviceName: string;
  eventType: string;
  remoteSessionTtlMs: number;
  setupVersion: number;
}

export interface TelegramSurfaceConfig {
  enabled: boolean;
  botToken: string;
  webhookSecret: string;
  defaultChatId: string;
  botUsername: string;
  mode: 'webhook' | 'polling';
  setupVersion: number;
}

export interface GoogleChatSurfaceConfig {
  enabled: boolean;
  webhookUrl: string;
  verificationToken: string;
  appId: string;
  spaceId: string;
  setupVersion: number;
}

export interface SignalSurfaceConfig {
  enabled: boolean;
  bridgeUrl: string;
  account: string;
  token: string;
  defaultRecipient: string;
  setupVersion: number;
}

export interface WhatsAppSurfaceConfig {
  enabled: boolean;
  provider: 'meta-cloud' | 'bridge';
  accessToken: string;
  verifyToken: string;
  signingSecret: string;
  phoneNumberId: string;
  businessAccountId: string;
  defaultRecipient: string;
  setupVersion: number;
}

export interface TelephonySurfaceConfig {
  enabled: boolean;
  provider: 'twilio' | 'bridge';
  mode: 'sms' | 'voice' | 'bridge';
  bridgeUrl: string;
  token: string;
  accountSid: string;
  authToken: string;
  fromNumber: string;
  defaultRecipient: string;
  webhookSecret: string;
  voiceLanguage: string;
  setupVersion: number;
}

export interface IMessageSurfaceConfig {
  enabled: boolean;
  bridgeUrl: string;
  account: string;
  token: string;
  defaultChatId: string;
  setupVersion: number;
}

export interface MSTeamsSurfaceConfig {
  enabled: boolean;
  appId: string;
  appPassword: string;
  tenantId: string;
  serviceUrl: string;
  botId: string;
  defaultConversationId: string;
  defaultChannelId: string;
  setupVersion: number;
}

export interface BlueBubblesSurfaceConfig {
  enabled: boolean;
  serverUrl: string;
  password: string;
  account: string;
  defaultChatGuid: string;
  setupVersion: number;
}

export interface MattermostSurfaceConfig {
  enabled: boolean;
  baseUrl: string;
  botToken: string;
  teamId: string;
  defaultChannelId: string;
  setupVersion: number;
}

export interface MatrixSurfaceConfig {
  enabled: boolean;
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  defaultRoomId: string;
  setupVersion: number;
}

/**
 * The daemon's own mailbox — the account it reads and sends AS, rather than a
 * chat service it talks TO. Both key spellings are declared because both are
 * genuinely read; see schema-domain-daemon-mailbox.ts for which reader uses
 * which, and why declaring one would strand the other.
 */
export interface DaemonMailboxConfig {
  /** Host used for both IMAP and SMTP unless the per-protocol section overrides it. */
  host: string;
  user: string;
  /** Read when `user` is unset. */
  username: string;
  /** From address on outbound mail; falls back to the account name. */
  from: string;
  /** Held in the daemon secret tier, never written to a settings file. */
  password: string;
  /** Flat spelling, read by the inbox provider. */
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassword: string;
  /** Nested spelling, read by the triage tagger and the settings resolver. */
  imap: {
    host: string;
    port: number;
    user: string;
    password: string;
    secure: boolean;
    mailbox: string;
    draftsMailbox: string;
  };
  smtp: {
    host: string;
    port: number;
    password: string;
    secure: boolean;
  };
}

/** The daemon's own calendar, reached over CalDAV. */
export interface DaemonCalendarConfig {
  caldavUrl: string;
  caldavUser: string;
  /** Held in the daemon secret tier, never written to a settings file. */
  caldavPassword: string;
  defaultCalendarId: string;
  /** Comma-separated calendar ids the daemon may read. */
  calendars: string;
}

export interface SurfacesConfig {
  slack: SlackSurfaceConfig;
  discord: DiscordSurfaceConfig;
  ntfy: NtfySurfaceConfig;
  webhook: WebhookSurfaceConfig;
  homeassistant: HomeAssistantSurfaceConfig;
  telegram: TelegramSurfaceConfig;
  googleChat: GoogleChatSurfaceConfig;
  signal: SignalSurfaceConfig;
  whatsapp: WhatsAppSurfaceConfig;
  telephony: TelephonySurfaceConfig;
  imessage: IMessageSurfaceConfig;
  msteams: MSTeamsSurfaceConfig;
  bluebubbles: BlueBubblesSurfaceConfig;
  mattermost: MattermostSurfaceConfig;
  matrix: MatrixSurfaceConfig;
  /**
   * Not chat adapters. These two are the daemon's OWN mail account and
   * calendar, which sit under `surfaces.` so they inherit the domain's
   * daemon-ownership rule — the daemon is the process that acts on them, so
   * the daemon tier is their only home.
   */
  email: DaemonMailboxConfig;
  calendar: DaemonCalendarConfig;
}
