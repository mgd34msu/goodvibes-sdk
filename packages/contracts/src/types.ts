import type { RuntimeEventDomain } from './generated/runtime-event-domains.js';
export type JsonSchema = Record<string, unknown>;
export type GatewayMethodTransport = 'http' | 'ws' | 'internal';
export type GatewayMethodSource = 'builtin' | 'plugin';
export type GatewayMethodAccess = 'public' | 'authenticated' | 'admin' | 'remote-peer';
export type GatewayEventTransport = 'sse' | 'ws' | 'internal';
export type { RuntimeEventDomain } from './generated/runtime-event-domains.js';
export type DistributedPeerKind = 'node' | 'device';
const DISTRIBUTED_WORK_TYPES = [
  'invoke',
  'status.request',
  'location.request',
  'session.message',
  'automation.run',
] as const;
export type DistributedWorkType = (typeof DISTRIBUTED_WORK_TYPES)[number];
export type DistributedWorkStatus = 'queued' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface ContractHttpDefinition {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
}

export interface OperatorMethodContract {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly access: GatewayMethodAccess;
  readonly transport: readonly GatewayMethodTransport[];
  readonly scopes: readonly string[];
  readonly http?: ContractHttpDefinition | undefined;
  readonly events?: readonly string[] | undefined;
  readonly inputSchema?: JsonSchema | undefined;
  readonly outputSchema?: JsonSchema | undefined;
  readonly pluginId?: string | undefined;
  readonly dangerous?: boolean | undefined;
  readonly invokable?: boolean | undefined;
  /** Whether this method is idempotent. When true, safe to retry on 5xx + network errors. */
  readonly idempotent?: boolean | undefined;
  /**
   * MIN-3: Intentionally open bag for generator-supplied extension fields (e.g.
   * plugin manifests, analytics tags, UI hints). Consumers must not rely on any
   * specific key being present — treat as advisory display metadata only.
   * Narrowing this type would require a versioned generator ABI bump.
   */
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface OperatorEventContract {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly transport: readonly GatewayEventTransport[];
  readonly scopes: readonly string[];
  readonly domains?: readonly RuntimeEventDomain[] | undefined;
  readonly wireEvents?: readonly string[] | undefined;
  readonly payloadSchema?: JsonSchema | undefined;
  readonly outputSchema?: JsonSchema | undefined;
  readonly pluginId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface OperatorSchemaCoverageContract {
  readonly methods: number;
  readonly typedInputs: number;
  readonly genericInputs: number;
  readonly typedOutputs: number;
  readonly genericOutputs: number;
}

export interface OperatorEventCoverageContract {
  readonly events: number;
  readonly withDomains: number;
  readonly withWireEvents: number;
}

export interface OperatorContractManifest {
  readonly version: number;
  readonly product: {
    readonly id: string;
    readonly surface: string;
    readonly version: string;
  };
  readonly auth: {
    readonly modes: readonly string[];
    readonly login: {
      readonly method: string;
      readonly path: string;
      readonly requestSchema: JsonSchema;
      readonly responseSchema: JsonSchema;
    };
    readonly current: {
      readonly method: string;
      readonly path: string;
      readonly aliasPaths?: readonly string[] | undefined;
      readonly responseSchema: JsonSchema;
    };
    readonly sessionCookie: {
      readonly name: string;
      readonly httpOnly: boolean;
      readonly sameSite: string;
      readonly path: string;
    };
    readonly bearer: {
      readonly header: string;
      readonly queryParameters: readonly string[];
    };
  };
  readonly transports: {
    readonly http: {
      readonly statusPath: string;
      readonly methodsPath: string;
      readonly eventsCatalogPath: string;
    };
    readonly sse: {
      readonly path: string;
      readonly query: {
        readonly domains: string;
      };
    };
    readonly websocket: {
      readonly path: string;
      readonly clientFrames: readonly {
        readonly type: string;
        readonly fields?: readonly string[] | undefined;
      }[];
      readonly serverFrames: readonly {
        readonly type: string;
        readonly fields?: readonly string[] | undefined;
      }[];
    };
  };
  readonly operator: {
    readonly methods: readonly OperatorMethodContract[];
    readonly events: readonly OperatorEventContract[];
    readonly schemaCoverage: OperatorSchemaCoverageContract;
    readonly eventCoverage: OperatorEventCoverageContract;
  };
  readonly peer: {
    readonly contractPath: string;
    readonly relationship: string;
  };
}

export interface PeerEndpointContract {
  readonly id: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly auth: 'none' | 'bearer-peer-token' | 'bearer-operator-token';
  readonly requiredScope?: string | undefined;
  readonly description: string;
  readonly inputSchema?: JsonSchema | undefined;
  readonly outputSchema?: JsonSchema | undefined;
  /** Whether this endpoint is idempotent. When true, safe to retry on 5xx + network errors. */
  readonly idempotent?: boolean | undefined;
}

export interface PeerContractManifest {
  readonly schemaVersion: 1;
  readonly transport: 'http-json';
  readonly basePath: '/api/remote';
  readonly peerKinds: readonly DistributedPeerKind[];
  readonly workTypes: readonly DistributedWorkType[];
  readonly scopes: readonly string[];
  readonly recommendedHeartbeatMs: number;
  readonly recommendedWorkPullMs: number;
  readonly endpoints: readonly PeerEndpointContract[];
  readonly workCompletionStatuses: readonly DistributedWorkStatus[];
  readonly metadata: Record<string, unknown>;
}
