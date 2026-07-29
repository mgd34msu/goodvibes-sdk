import type { GenericWebhookAdapterContext, SurfaceAdapterContext } from '../../adapters/index.js';
import type { AutomationRouteBinding } from '../../automation/routes.js';
import type { ConfigManager } from '../../config/manager.js';
import type { SurfacesConfig } from '../../config/schema.js';
import type { SecretsManager } from '../../config/secrets.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import type { SharedApprovalRecord } from '../../control-plane/index.js';
import type { ChannelDeliveryRouter } from '../delivery-router.js';
import type { ChannelPolicyManager } from '../policy-manager.js';
import type { ChannelPluginRegistry } from '../plugin-registry.js';
import type { ChannelProviderRuntimeManager } from '../provider-runtime.js';
import type { RouteBindingManager } from '../route-manager.js';
import type { ChannelIngressAlarm } from '../ingress-alarm.js';
import type { InboundMailSupervisor } from '../../email/inbound/supervisor.js';

/**
 * What the channel runtime needs from the inbound-mail supervisor, projected
 * off the real class rather than restated (docs/inbound-email.md §7.3).
 *
 * `health` and `recheckNow` are methods on the supervisor; picking them keeps
 * the shape and the semantics tied to one declaration, so a change to what
 * `stop()` promises cannot silently fail to reach this seam.
 *
 * `status` is deliberately gone. `BuiltinChannelRuntime.inboundMailStatus()`
 * was its only reader and had no readers of its own, and every field it
 * returned — `mode`, `reason`, `running` — is already on the health entry that
 * `/api/channels/status` serves (`health.ts`: `mode` and `reason` are named
 * fields, `running` is `metadata.running`). Keeping the member so a second
 * accessor could answer the same question from the same object is how the two
 * answers start to disagree.
 */
export type InboundMailRuntimeSupervisor = Pick<
  InboundMailSupervisor,
  'start' | 'stop' | 'health' | 'describeStatus' | 'recheckNow'
>;

export type ManagedSurface =
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'webhook'
  | 'homeassistant'
  | 'telegram'
  | 'google-chat'
  | 'signal'
  | 'whatsapp'
  | 'telephony'
  | 'imessage'
  | 'msteams'
  | 'bluebubbles'
  | 'mattermost'
  | 'matrix';

export interface BuiltinChannelRuntimeDeps {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly routeBindings: RouteBindingManager;
  readonly channelPolicy: ChannelPolicyManager;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly providerRuntime?: ChannelProviderRuntimeManager | undefined;
  readonly deliveryRouter: ChannelDeliveryRouter;
  readonly surfaceDeliveryEnabled: (surface: ManagedSurface) => boolean;
  /**
   * Where the Telegram getUpdates cursor is persisted. Supplied by the
   * composition root so it lands inside the host's surface-scoped storage
   * rather than being guessed here. Omitted by embedders that do not run
   * Telegram polling; the supervisor then reports why it cannot start.
   */
  readonly telegramOffsetPath?: string | undefined;
  /**
   * Telegram answered getUpdates with a 409 naming another consumer. Reported
   * up to the composition root so leadership can stand down; see
   * TelegramIngressDeps.onConcurrentConsumerConflict.
   */
  readonly onTelegramConsumerConflict?: ((detail: string) => void) | undefined;
  /**
   * Turns an inbound message this node failed to process into something the
   * owner hears about, instead of a log line in a debug file. Handed to the
   * Telegram ingress supervisor, which is the one built-in surface holding a
   * durable read cursor and therefore the one that skips a message for good.
   * Omitted by embedders with no way to reach the owner.
   */
  readonly ingressAlarm?: ChannelIngressAlarm | undefined;
  /**
   * The inbound-mail supervisor, when the composition built one.
   *
   * Owned here for the same reason the Telegram ingress supervisor is
   * (docs/inbound-email.md §3.5): inbound mail is a poll/socket lifecycle that
   * must be armed at boot and torn down with the daemon, not a webhook that
   * arrives on its own. Absent in embedders that watch no mailbox — the
   * cluster registration then reports why nothing is watched rather than
   * electing a node for a surface it cannot serve.
   *
   * Note what this is NOT: email does not join `ManagedSurface`. That union
   * means a channel the daemon talks TO — accounts, delivery, ingress
   * authorization, conversation routing — and §2.1 removes those from inbound
   * mail structurally. Widening it to fit email in would hand every one of
   * them back by inheritance.
   */
  readonly inboundMail?: InboundMailRuntimeSupervisor | undefined;
  readonly buildSurfaceAdapterContext: () => SurfaceAdapterContext;
  readonly buildGenericWebhookAdapterContext: () => GenericWebhookAdapterContext;
  readonly deliverSurfaceProgress: (pending: unknown, progress: string) => Promise<void>;
  readonly deliverSlackAgentReply: (pending: unknown, message: string) => Promise<void>;
  readonly deliverDiscordAgentReply: (pending: unknown, message: string) => Promise<void>;
  readonly deliverNtfyAgentReply: (pending: unknown, message: string) => Promise<void>;
  readonly deliverWebhookAgentReply: (pending: unknown, message: string) => Promise<void>;
  readonly deliverSlackApprovalUpdate: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
  readonly deliverDiscordApprovalUpdate: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
  readonly deliverNtfyApprovalUpdate: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
  readonly deliverWebhookApprovalUpdate: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
}

/**
 * The `surfaces.*` sections that are CHANNEL ADAPTERS.
 *
 * Not every section under `surfaces.` is one. `surfaces.email` and
 * `surfaces.calendar` are the daemon's own mailbox and calendar — the account
 * it acts AS rather than a service it talks TO — and they live under the same
 * prefix because they share its daemon-ownership rule, not because they are
 * adapters. Plain `keyof SurfacesConfig` swept them in, and the first thing
 * that broke was `getConfiguredSetupVersion` reading `.setupVersion` off a
 * section that has no setup version.
 *
 * Derived from the shape rather than by excluding names, so the next non-adapter
 * section under this prefix is excluded automatically instead of the day it
 * breaks a member read.
 */
type SurfaceConfigSection = {
  [K in keyof SurfacesConfig]: SurfacesConfig[K] extends { setupVersion: number } ? K : never;
}[keyof SurfacesConfig];

export const CHANNEL_SETUP_VERSION = 1;
export const DEFAULT_SECRET_BACKENDS = [
  'env',
  'goodvibes',
  'service-registry',
  '1password',
  'bitwarden',
  'vaultwarden',
  'bitwarden-secrets-manager',
  'bws',
  'manual',
] as const;

export function configSectionForSurface(surface: ManagedSurface): SurfaceConfigSection {
  switch (surface) {
    case 'slack':
      return 'slack';
    case 'discord':
      return 'discord';
    case 'ntfy':
      return 'ntfy';
    case 'webhook':
      return 'webhook';
    case 'homeassistant':
      return 'homeassistant';
    case 'telegram':
      return 'telegram';
    case 'google-chat':
      return 'googleChat';
    case 'signal':
      return 'signal';
    case 'whatsapp':
      return 'whatsapp';
    case 'telephony':
      return 'telephony';
    case 'imessage':
      return 'imessage';
    case 'msteams':
      return 'msteams';
    case 'bluebubbles':
      return 'bluebubbles';
    case 'mattermost':
      return 'mattermost';
    case 'matrix':
      return 'matrix';
  }
}
