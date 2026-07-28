import type { ArtifactReference } from '../../artifacts/index.js';
import type { ConfigManager } from '../../config/manager.js';
import type { SecretsManager } from '../../config/secrets.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import type { ControlPlaneGateway } from '../../control-plane/gateway.js';
import type { RouteSurfaceKind } from '../../../events/routes.js';

export type ChannelDeliverySurfaceKind = RouteSurfaceKind;
export type ChannelDeliveryTargetKind = 'none' | 'webhook' | 'surface' | 'integration' | 'link';

export interface ChannelDeliveryTarget {
  readonly kind: ChannelDeliveryTargetKind;
  readonly surfaceKind?: ChannelDeliverySurfaceKind | undefined;
  readonly address?: string | undefined;
  readonly routeId?: string | undefined;
  readonly label?: string | undefined;
}

export interface ChannelDeliveryRouteBinding {
  readonly id: string;
  readonly surfaceKind: ChannelDeliverySurfaceKind;
  readonly surfaceId: string;
  readonly externalId: string;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly title?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelDeliveryRequest {
  readonly target: ChannelDeliveryTarget;
  readonly body: string;
  readonly title: string;
  readonly jobId: string;
  readonly runId: string;
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly status?: string | undefined;
  readonly includeLinks: boolean;
  readonly attachments?: readonly ArtifactReference[] | undefined;
  readonly binding?: ChannelDeliveryRouteBinding | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ChannelDeliveryResult {
  readonly responseId?: string | undefined;
}

export interface ChannelDeliveryStrategy {
  readonly id: string;
  canHandle(request: ChannelDeliveryRequest): boolean;
  deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult>;
}

export interface ChannelDeliveryRouterConfig {
  readonly configManager?: ConfigManager | undefined;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'> | undefined;
  readonly serviceRegistry?: ServiceRegistry | undefined;
  readonly artifactStore?: ArtifactStore | undefined;
  readonly controlPlaneGateway?: ControlPlaneGateway | null | undefined;
  readonly strategies?: readonly ChannelDeliveryStrategy[] | undefined;
}

/**
 * Parse a `surfaceKind` or `surfaceKind:address` channel string into a target.
 *
 * The one-line form is how a channel is written in configuration — a check-in
 * delivery channel, a CI watch notifier — so this is the seam between "what the
 * operator typed" and the structured target the router takes. It lives beside
 * the type it produces because it was previously written out twice inside one
 * registrar, once as a helper and once inline, which is exactly how the two
 * copies would have drifted.
 */
export function parseChannelDeliveryTarget(channel: string): ChannelDeliveryTarget {
  const separator = channel.indexOf(':');
  const surfaceKind = (separator === -1 ? channel : channel.slice(0, separator)).trim();
  const address = separator === -1 ? '' : channel.slice(separator + 1).trim();
  return {
    kind: 'surface',
    surfaceKind: surfaceKind as ChannelDeliveryTarget['surfaceKind'],
    ...(address ? { address } : {}),
  };
}
