import { ArtifactStore } from '../artifacts/index.js';
import { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { ServiceRegistry } from '../config/service-registry.js';
import type { ControlPlaneGateway } from '../control-plane/gateway.js';
import {
  createDiscordDeliveryStrategy,
  createGoogleChatDeliveryStrategy,
  createHomeAssistantDeliveryStrategy,
  createNtfyDeliveryStrategy,
  createSlackDeliveryStrategy,
  createTelegramDeliveryStrategy,
  createWebControlPlaneDeliveryStrategy,
  createWebhookDeliveryStrategy,
} from './delivery/strategies-core.js';
import {
  createBlueBubblesDeliveryStrategy,
  createIMessageDeliveryStrategy,
  createSignalDeliveryStrategy,
  createTelephonyDeliveryStrategy,
  createWhatsAppDeliveryStrategy,
} from './delivery/strategies-bridge.js';
import {
  createMSTeamsDeliveryStrategy,
  createMattermostDeliveryStrategy,
  createMatrixDeliveryStrategy,
} from './delivery/strategies-enterprise.js';
import { resolveChannelDeliverySurfaceKind } from './delivery/shared.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type {
  ChannelDeliveryRequest,
  ChannelDeliveryRouterConfig,
  ChannelDeliveryStrategy,
} from './delivery/types.js';

export type {
  ChannelDeliveryResult,
  ChannelDeliveryRouteBinding,
  ChannelDeliveryRouterConfig,
  ChannelDeliveryStrategy,
  ChannelDeliverySurfaceKind,
  ChannelDeliveryTarget,
  ChannelDeliveryTargetKind,
} from './delivery/types.js';

export { resolveChannelDeliverySurfaceKind } from './delivery/shared.js';

export function createDefaultChannelDeliveryStrategies(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  getControlPlaneGateway: () => ControlPlaneGateway | null,
  secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy[] {
  return [
    createWebhookDeliveryStrategy(configManager, artifactStore),
    createSlackDeliveryStrategy(serviceRegistry, configManager, artifactStore, secretsManager),
    createDiscordDeliveryStrategy(serviceRegistry, configManager, artifactStore, secretsManager),
    createNtfyDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createWebControlPlaneDeliveryStrategy(configManager, artifactStore, getControlPlaneGateway),
    createHomeAssistantDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createTelegramDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createGoogleChatDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createSignalDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createWhatsAppDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createTelephonyDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createIMessageDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createMSTeamsDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createBlueBubblesDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createMattermostDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createMatrixDeliveryStrategy(configManager, serviceRegistry, artifactStore),
  ];
}

export class ChannelDeliveryRouter {
  private readonly strategies: ChannelDeliveryStrategy[];
  private controlPlaneGateway: ControlPlaneGateway | null;

  constructor(config: ChannelDeliveryRouterConfig = {}) {
    this.controlPlaneGateway = config.controlPlaneGateway ?? null;
    if (config.strategies) {
      this.strategies = [...config.strategies];
      return;
    }
    if (!config.configManager || !config.serviceRegistry || !config.artifactStore) {
      throw new Error(
        'ChannelDeliveryRouter requires configManager, serviceRegistry, and artifactStore when using builtin delivery strategies.',
      );
    }
    this.strategies = createDefaultChannelDeliveryStrategies(
      config.configManager,
      config.serviceRegistry,
      config.artifactStore,
      () => this.controlPlaneGateway,
      config.secretsManager,
    );
  }

  setControlPlaneGateway(gateway: ControlPlaneGateway | null): void {
    this.controlPlaneGateway = gateway;
  }

  listStrategies(): readonly ChannelDeliveryStrategy[] {
    return [...this.strategies];
  }

  registerStrategy(strategy: ChannelDeliveryStrategy, options: { readonly replace?: boolean } = {}): void {
    const existingIndex = this.strategies.findIndex((entry) => entry.id === strategy.id);
    if (existingIndex >= 0) {
      if (!options.replace) {
        throw new Error(`Channel delivery strategy already registered: ${strategy.id}`);
      }
      this.strategies.splice(existingIndex, 1, strategy);
      return;
    }
    this.strategies.push(strategy);
  }

  unregisterStrategy(strategyId: string): boolean {
    const existingIndex = this.strategies.findIndex((entry) => entry.id === strategyId);
    if (existingIndex < 0) return false;
    this.strategies.splice(existingIndex, 1);
    return true;
  }

  async deliver(request: ChannelDeliveryRequest): Promise<string | undefined> {
    const surfaceKind = resolveChannelDeliverySurfaceKind(request.target);
    const strategy = this.strategies.find((entry) => entry.canHandle(request));
    if (!strategy) {
      // Silence is the worst failure mode a reply can have: the owner sends a
      // message, the agent answers, and nothing arrives with no trace anywhere.
      // Every unroutable delivery says which surface, which binding, and why.
      logger.error('Channel delivery could not resolve a strategy — the reply was dropped', {
        surface: surfaceKind ?? 'unknown',
        targetKind: request.target.kind,
        bindingId: request.binding?.id ?? null,
        channelId: request.binding?.channelId ?? request.binding?.externalId ?? null,
        reason: 'no-strategy-handles-this-target',
      });
      throw new Error(`Unsupported channel delivery target: ${request.target.kind}:${surfaceKind ?? 'unknown'}`);
    }
    try {
      const result = await strategy.deliver(request);
      return result.responseId;
    } catch (error) {
      // A strategy throwing "Missing <surface> chat id" is the same silence
      // wearing a different hat — it is normally caught and dropped upstream.
      // Name it here, where the binding is still in hand, then rethrow.
      logger.error('Channel delivery failed — the reply did not reach its conversation', {
        surface: surfaceKind ?? 'unknown',
        strategy: strategy.id,
        bindingId: request.binding?.id ?? null,
        channelId: request.binding?.channelId ?? request.binding?.externalId ?? null,
        address: request.target.address ?? null,
        reason: summarizeError(error),
      });
      throw error;
    }
  }
}
