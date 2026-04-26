import { createDomainDispatch } from '../runtime/store/index.js';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.js';
import type { SurfaceRecord } from '../runtime/store/domains/surfaces.js';
import { ConfigManager } from '../config/manager.js';
import type { ChannelPluginRegistry } from './plugin-registry.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isSurfaceFeatureGateEnabled } from '../runtime/feature-flags/index.js';

function now(): number {
  return Date.now();
}

export class SurfaceRegistry {
  private readonly configManager: ConfigManager;
  private readonly featureFlags: FeatureFlagReader;
  private readonly surfaces = new Map<string, SurfaceRecord>();
  private runtimeDispatch: DomainDispatch | null = null;
  private pluginRegistry: ChannelPluginRegistry | null = null;

  constructor(configManager: ConfigManager, runtimeStore?: RuntimeStore, featureFlags?: FeatureFlagReader) {
    this.configManager = configManager;
    this.featureFlags = featureFlags ?? null;
    if (runtimeStore) this.runtimeDispatch = createDomainDispatch(runtimeStore);
  }

  attachRuntime(runtimeStore: RuntimeStore): void {
    this.runtimeDispatch = createDomainDispatch(runtimeStore);
    for (const surface of this.surfaces.values()) {
      this.runtimeDispatch.syncSurface(surface, 'surfaces.attach');
    }
  }

  attachPluginRegistry(pluginRegistry: ChannelPluginRegistry): void {
    this.pluginRegistry = pluginRegistry;
  }

  syncConfiguredSurfaces(): SurfaceRecord[] {
    const configuredAt = now();
    const pluginDescriptors = this.pluginRegistry?.listDescriptors() ?? [];
    const enabledForSurface = (surface: string): boolean => {
      if (!isSurfaceFeatureGateEnabled(this.featureFlags, surface)) return false;
      if (surface === 'tui') return (this.configManager.getCategory('surfaces') as Record<string, { enabled?: boolean } | undefined>).tui?.enabled !== false;
      if (surface === 'web') return Boolean(this.configManager.get('web.enabled') || this.configManager.get('controlPlane.enabled'));
      if (surface === 'slack') return Boolean(this.configManager.get('surfaces.slack.enabled'));
      if (surface === 'discord') return Boolean(this.configManager.get('surfaces.discord.enabled'));
      if (surface === 'ntfy') return Boolean(this.configManager.get('surfaces.ntfy.enabled'));
      if (surface === 'webhook') {
        return Boolean(
          this.configManager.get('surfaces.webhook.enabled')
          || this.configManager.get('surfaces.webhook.defaultTarget')
          || this.configManager.get('surfaces.webhook.secret'),
        );
      }
      const surfaces = this.configManager.getCategory('surfaces');
      if (surface === 'telegram') return Boolean(surfaces.telegram.enabled || surfaces.telegram.botToken || surfaces.telegram.defaultChatId);
      if (surface === 'homeassistant') return Boolean(surfaces.homeassistant.enabled || surfaces.homeassistant.instanceUrl || surfaces.homeassistant.webhookSecret);
      if (surface === 'google-chat') return Boolean(surfaces.googleChat.enabled || surfaces.googleChat.webhookUrl || surfaces.googleChat.spaceId);
      if (surface === 'signal') return Boolean(surfaces.signal.enabled || surfaces.signal.bridgeUrl || surfaces.signal.account);
      if (surface === 'whatsapp') return Boolean(surfaces.whatsapp.enabled || surfaces.whatsapp.accessToken || surfaces.whatsapp.phoneNumberId);
      if (surface === 'imessage') return Boolean(surfaces.imessage.enabled || surfaces.imessage.bridgeUrl || surfaces.imessage.account);
      if (surface === 'msteams') return Boolean(surfaces.msteams.enabled || surfaces.msteams.appId || surfaces.msteams.defaultConversationId);
      if (surface === 'bluebubbles') return Boolean(surfaces.bluebubbles.enabled || surfaces.bluebubbles.serverUrl || surfaces.bluebubbles.defaultChatGuid);
      if (surface === 'mattermost') return Boolean(surfaces.mattermost.enabled || surfaces.mattermost.baseUrl || surfaces.mattermost.defaultChannelId);
      if (surface === 'matrix') return Boolean(surfaces.matrix.enabled || surfaces.matrix.homeserverUrl || surfaces.matrix.defaultRoomId);
      return false;
    };
    const accountIdForSurface = (surface: string): string | undefined => {
      const surfaces = this.configManager.getCategory('surfaces');
      if (surface === 'slack') return String(this.configManager.get('surfaces.slack.workspaceId') || '') || undefined;
      if (surface === 'discord') return String(this.configManager.get('surfaces.discord.applicationId') || '') || undefined;
      if (surface === 'telegram') return surfaces.telegram.botUsername || surfaces.telegram.defaultChatId || undefined;
      if (surface === 'homeassistant') return surfaces.homeassistant.deviceId || surfaces.homeassistant.defaultConversationId || undefined;
      if (surface === 'google-chat') return surfaces.googleChat.appId || surfaces.googleChat.spaceId || undefined;
      if (surface === 'signal') return surfaces.signal.account || surfaces.signal.defaultRecipient || undefined;
      if (surface === 'whatsapp') return surfaces.whatsapp.phoneNumberId || surfaces.whatsapp.defaultRecipient || undefined;
      if (surface === 'imessage') return surfaces.imessage.account || surfaces.imessage.defaultChatId || undefined;
      if (surface === 'msteams') return surfaces.msteams.botId || surfaces.msteams.defaultConversationId || undefined;
      if (surface === 'bluebubbles') return surfaces.bluebubbles.account || surfaces.bluebubbles.defaultChatGuid || undefined;
      if (surface === 'mattermost') return surfaces.mattermost.teamId || surfaces.mattermost.defaultChannelId || undefined;
      if (surface === 'matrix') return surfaces.matrix.userId || surfaces.matrix.defaultRoomId || undefined;
      return undefined;
    };
    const records: SurfaceRecord[] = pluginDescriptors.length > 0 ? pluginDescriptors.map((descriptor) => ({
      id: `surface:${descriptor.surface}`,
      kind: descriptor.surface,
      label: descriptor.displayName,
      enabled: enabledForSurface(descriptor.surface),
      state: enabledForSurface(descriptor.surface) ? 'healthy' : 'disabled',
      configuredAt,
      lastSeenAt: configuredAt,
      ...(accountIdForSurface(descriptor.surface) ? { accountId: accountIdForSurface(descriptor.surface) } : {}),
      capabilities: [...descriptor.capabilities],
      metadata: {},
    })) : [
      {
        id: 'surface:tui',
        kind: 'tui',
        label: 'Terminal UI',
        enabled: enabledForSurface('tui'),
        state: enabledForSurface('tui') ? 'healthy' : 'disabled',
        configuredAt,
        lastSeenAt: configuredAt,
        capabilities: ['ingress', 'egress', 'session_binding'],
        metadata: {},
      },
      {
        id: 'surface:web',
        kind: 'web',
        label: 'Web control plane',
        enabled: enabledForSurface('web'),
        state: enabledForSurface('web') ? 'healthy' : 'disabled',
        configuredAt,
        capabilities: ['ingress', 'egress', 'threaded_reply'],
        metadata: {
          port: this.configManager.get('web.port'),
          baseUrl: this.configManager.get('web.publicBaseUrl'),
        },
      },
      {
        id: 'surface:slack',
        kind: 'slack',
        label: 'Slack',
        enabled: enabledForSurface('slack'),
        state: enabledForSurface('slack') ? 'healthy' : 'disabled',
        configuredAt,
        accountId: String(this.configManager.get('surfaces.slack.workspaceId') || ''),
        capabilities: ['ingress', 'egress', 'threaded_reply', 'interactive_actions'],
        metadata: {
          defaultChannel: this.configManager.get('surfaces.slack.defaultChannel'),
        },
      },
      {
        id: 'surface:discord',
        kind: 'discord',
        label: 'Discord',
        enabled: enabledForSurface('discord'),
        state: enabledForSurface('discord') ? 'healthy' : 'disabled',
        configuredAt,
        accountId: String(this.configManager.get('surfaces.discord.applicationId') || ''),
        capabilities: ['ingress', 'egress', 'interactive_actions'],
        metadata: {
          defaultChannelId: this.configManager.get('surfaces.discord.defaultChannelId'),
          guildId: this.configManager.get('surfaces.discord.guildId'),
        },
      },
      {
        id: 'surface:ntfy',
        kind: 'ntfy',
        label: 'ntfy',
        enabled: enabledForSurface('ntfy'),
        state: enabledForSurface('ntfy') ? 'healthy' : 'disabled',
        configuredAt,
        capabilities: ['ingress', 'egress', 'delivery_only'],
        metadata: {
          baseUrl: this.configManager.get('surfaces.ntfy.baseUrl'),
          topic: this.configManager.get('surfaces.ntfy.topic'),
          chatTopic: this.configManager.get('surfaces.ntfy.chatTopic'),
          agentTopic: this.configManager.get('surfaces.ntfy.agentTopic'),
          remoteTopic: this.configManager.get('surfaces.ntfy.remoteTopic'),
        },
      },
      {
        id: 'surface:webhook',
        kind: 'webhook',
        label: 'Generic webhook',
        enabled: enabledForSurface('webhook'),
        state: enabledForSurface('webhook') ? 'healthy' : 'disabled',
        configuredAt,
        capabilities: ['ingress', 'egress', 'delivery_only'],
        metadata: {
          defaultTarget: this.configManager.get('surfaces.webhook.defaultTarget'),
          timeoutMs: this.configManager.get('surfaces.webhook.timeoutMs'),
        },
      },
    ];

    this.surfaces.clear();
    for (const record of records) {
      this.surfaces.set(record.id, record);
      this.runtimeDispatch?.syncSurface(record, 'surfaces.sync');
    }
    return records;
  }

  list(): SurfaceRecord[] {
    return [...this.surfaces.values()].sort((a, b) => a.label.localeCompare(b.label));
  }
}
