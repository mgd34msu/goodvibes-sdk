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
}
