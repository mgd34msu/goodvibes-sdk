import type { JsonRecord } from './route-helpers.js';

export type {
  ChannelAccountRegistryLike,
  DaemonIntegrationRouteContext,
  IntegrationHelperServiceLike,
  MemoryEmbeddingRegistryLike,
  MemoryRegistryLike,
  ProviderRuntimeSnapshotServiceLike,
  UserAuthManagerLike,
} from '../../../daemon.js';
export type { DaemonRuntimeEventDomain as RuntimeEventDomain } from '../../../daemon.js';

export interface IntegrationRuntimeStoreLike {
  getState(): {
    readonly deliveries: {
      readonly deliveryAttempts: Map<string, unknown>;
    };
  };
}
