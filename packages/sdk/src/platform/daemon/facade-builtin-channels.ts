/**
 * facade-builtin-channels.ts — the builtin channel runtime and the inbound
 * surfaces it owns.
 *
 * Split out of `facade-composition.ts` because it is one subsystem's wiring —
 * every builtin channel's delivery callback, the Telegram poll cursor's
 * surface-scoped path, and now the inbound-mail supervisor — and because that
 * file sits exactly on the repository's per-file line cap, where an addition
 * this size cannot land without pushing something else out.
 *
 * Nothing about the construction changed in the move. The one thing worth
 * reading is the inbound-mail composition below it.
 */

import { BuiltinChannelRuntime } from '../channels/index.js';
import { composeInboundMail } from './facade-inbound-mail.js';
import type { ChannelProviderRuntimeManager } from '../channels/index.js';
import type { DaemonSurfaceActionHelper } from './surface-actions.js';
import type { DaemonSurfaceDeliveryHelper } from './surface-delivery.js';
import type {
  CreateDaemonFacadeCollaboratorsOptions,
  ResolvedDaemonFacadeRuntime,
} from './facade-types.js';
import type { PendingSurfaceReply } from './types.js';

export interface BuiltinChannelRuntimeCompositionInput {
  readonly runtime: ResolvedDaemonFacadeRuntime;
  readonly options: CreateDaemonFacadeCollaboratorsOptions;
  readonly providerRuntime: ChannelProviderRuntimeManager;
  readonly surfaceActionHelper: DaemonSurfaceActionHelper;
  readonly surfaceDeliveryHelper: DaemonSurfaceDeliveryHelper;
}

/**
 * Build the builtin channel runtime, with its plugins registered.
 *
 * Inbound mail is composed first and handed in: the three persisted stores,
 * the expectation book with its real authority probe, the source factory and
 * the supervisor — plus the three expectation verbs and the status verb, which
 * were cataloged with no production call site until this call existed. It is
 * `null` when this composition watches no mailbox, in which case
 * `BuiltinChannelRuntime` reports that at ERROR if the surface is enabled and
 * the cluster registration declines to contest a surface this node cannot
 * serve — a node that won that election would stand every other node down and
 * then read nothing.
 */
export function createBuiltinChannelRuntime(
  input: BuiltinChannelRuntimeCompositionInput,
): BuiltinChannelRuntime {
  const { runtime, options, providerRuntime, surfaceActionHelper, surfaceDeliveryHelper } = input;
  const inboundMail = composeInboundMail({
    configManager: runtime.configManager,
    secretsManager: runtime.runtimeServices.secretsManager,
    shellPaths: runtime.runtimeServices.shellPaths,
    routeBindings: runtime.routeBindings,
    gatewayMethods: runtime.gatewayMethods,
    deliverSurfaceNotice: (binding, text) => surfaceDeliveryHelper.deliverSurfaceNotice(binding, text),
  });
  const builtinChannels = new BuiltinChannelRuntime({
    configManager: runtime.configManager,
    secretsManager: runtime.runtimeServices.secretsManager,
    serviceRegistry: runtime.serviceRegistry,
    routeBindings: runtime.routeBindings,
    ...(inboundMail === null ? {} : { inboundMail }),
    channelPolicy: runtime.channelPolicy,
    channelPlugins: runtime.channelPlugins,
    providerRuntime,
    deliveryRouter: runtime.deliveryManager.getDeliveryRouter(),
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
    // Surface-scoped, alongside the channel policy store: the Telegram poll
    // cursor is per-surface state and must not leak across surface roots.
    telegramOffsetPath: runtime.runtimeServices.shellPaths.resolveProjectPath(
      'goodvibes', 'channels', 'telegram-offset.json',
    ),
    buildSurfaceAdapterContext: () => surfaceActionHelper.buildSurfaceAdapterContext(),
    buildGenericWebhookAdapterContext: () => surfaceActionHelper.buildGenericWebhookAdapterContext(),
    deliverSurfaceProgress: (pending, progress) => surfaceDeliveryHelper.deliverSurfaceProgress(pending as PendingSurfaceReply, progress),
    deliverSlackAgentReply: (pending, message) => surfaceDeliveryHelper.deliverSlackAgentReply(pending as PendingSurfaceReply, message),
    deliverDiscordAgentReply: (pending, message) => surfaceDeliveryHelper.deliverDiscordAgentReply(pending as PendingSurfaceReply, message),
    deliverNtfyAgentReply: (pending, message) => surfaceDeliveryHelper.deliverNtfyAgentReply(pending as PendingSurfaceReply, message),
    deliverWebhookAgentReply: (pending, message) => surfaceDeliveryHelper.deliverWebhookAgentReply(pending as PendingSurfaceReply, message),
    deliverSlackApprovalUpdate: (approval, binding) => surfaceDeliveryHelper.deliverSlackApprovalUpdate(approval, binding),
    deliverDiscordApprovalUpdate: (approval, binding) => surfaceDeliveryHelper.deliverDiscordApprovalUpdate(approval, binding),
    deliverNtfyApprovalUpdate: (approval, binding) => surfaceDeliveryHelper.deliverNtfyApprovalUpdate(approval, binding),
    deliverWebhookApprovalUpdate: (approval, binding) => surfaceDeliveryHelper.deliverWebhookApprovalUpdate(approval, binding),
  });
  builtinChannels.registerPlugins();
  return builtinChannels;
}
