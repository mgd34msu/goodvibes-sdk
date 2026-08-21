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
import {
  AGENT_DELIVERY_STRATEGY_ID,
  AgentDeliveryRegistry,
  createAgentDeliveryStrategy,
} from './delivery/strategies-agent.js';
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
export { CHANNEL_DELIVERY_SURFACE_KINDS } from './delivery/types.js';

export {
  AGENT_DELIVERY_STRATEGY_ID,
  AgentDeliveryRegistry,
  createAgentDeliveryStrategy,
} from './delivery/strategies-agent.js';
export type {
  AgentConversationMessage,
  AgentConversationSender,
} from './delivery/strategies-agent.js';

export { resolveChannelDeliverySurfaceKind } from './delivery/shared.js';

/**
 * `secretsManager` is REQUIRED, not optional, and that is the whole point.
 *
 * Half the surfaces here read their credential from a `goodvibes://secrets/...`
 * reference, which only resolves when a local secret resolver is supplied.
 * While this parameter was optional, a composition root that forgot it still
 * type-checked, still constructed, still delivered on every surface whose
 * credential happens to live in config or the environment, and failed ONLY on
 * the surfaces that use a secret reference, at send time, as
 * "Missing Telegram bot token". Two shipped composition roots (goodvibes-tui
 * and goodvibes-agent) drifted into exactly that state while the SDK's own
 * composition passed it, so the defect was invisible from inside the SDK and
 * its tests. Required here means a fork that forgets fails to compile instead
 * of failing to answer someone.
 */
export function createDefaultChannelDeliveryStrategies(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  getControlPlaneGateway: () => ControlPlaneGateway | null,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
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

  /**
   * Where the agent product plugs its conversation sender in.
   *
   * Router-owned rather than a constructor argument, so the destination exists
   * from the moment the router does and the agent can register whenever it
   * starts. The strategy that reads it is appended to EVERY strategy list,
   * including an explicitly supplied one: `agent` being deliverable is a
   * property of the router, and an embed that hand-picks its transports has no
   * reason to lose the one surface that is not a transport.
   */
  readonly agentDelivery = new AgentDeliveryRegistry();

  constructor(config: ChannelDeliveryRouterConfig = {}) {
    this.controlPlaneGateway = config.controlPlaneGateway ?? null;
    if (config.strategies) {
      this.strategies = [...config.strategies];
      this.ensureAgentStrategy();
      return;
    }
    if (!config.configManager || !config.serviceRegistry || !config.artifactStore || !config.secretsManager) {
      throw new Error(
        'ChannelDeliveryRouter requires configManager, serviceRegistry, artifactStore, and secretsManager '
        + 'when using builtin delivery strategies. Without secretsManager every surface whose credential is a '
        + 'goodvibes://secrets/... reference silently fails to send.',
      );
    }
    this.strategies = createDefaultChannelDeliveryStrategies(
      config.configManager,
      config.serviceRegistry,
      config.artifactStore,
      () => this.controlPlaneGateway,
      config.secretsManager,
    );
    this.ensureAgentStrategy();
  }

  /** Append the agent strategy unless the caller already supplied one. */
  private ensureAgentStrategy(): void {
    if (this.strategies.some((entry) => entry.id === AGENT_DELIVERY_STRATEGY_ID)) return;
    this.strategies.push(createAgentDeliveryStrategy(this.agentDelivery));
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
      logger.error('Channel delivery could not resolve a strategy, the reply was dropped', {
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
      // wearing a different hat, it is normally caught and dropped upstream.
      // Name it here, where the binding is still in hand, then rethrow.
      logger.error('Channel delivery failed, the reply did not reach its conversation', {
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
