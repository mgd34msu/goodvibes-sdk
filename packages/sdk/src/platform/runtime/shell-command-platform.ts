import type { DeterministicReplayEngine } from '../core/deterministic-replay.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { SecretsManager } from '../config/secrets.js';
import type { SubscriptionManager } from '../config/subscriptions.js';
import type { UserAuthManager } from '../security/user-auth.js';
import type { ApiTokenAuditor } from '../security/token-audit.js';
import type { WebhookNotifier } from '../integrations/webhooks.js';
import type { UiReadModels } from './ui-read-models.js';

export interface CommandPlatformShellServices {
  readonly readModels?: UiReadModels;
  readonly serviceRegistry?: ServiceRegistry;
  readonly subscriptionManager?: SubscriptionManager;
  readonly secretsManager?: SecretsManager;
  readonly localUserAuthManager?: UserAuthManager;
  readonly tokenAuditor?: ApiTokenAuditor;
  readonly replayEngine?: DeterministicReplayEngine;
  readonly webhookNotifier?: WebhookNotifier;
}

export interface CreateShellPlatformServicesOptions extends CommandPlatformShellServices {}

export function createShellPlatformServices(
  options: CreateShellPlatformServicesOptions,
): CommandPlatformShellServices {
  const {
    readModels,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
    localUserAuthManager,
    tokenAuditor,
    replayEngine,
    webhookNotifier,
  } = options;

  return {
    readModels,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
    localUserAuthManager,
    tokenAuditor,
    replayEngine,
    webhookNotifier,
  };
}
