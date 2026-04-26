import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';

export type CloudflareProvisionStepStatus = 'ok' | 'skipped' | 'warning';

export interface CloudflareProvisionStep {
  readonly name: string;
  readonly status: CloudflareProvisionStepStatus;
  readonly message?: string;
  readonly resourceId?: string;
}

export type CloudflareComponent =
  | 'workers'
  | 'queues'
  | 'zeroTrustTunnel'
  | 'zeroTrustAccess'
  | 'dns'
  | 'kv'
  | 'durableObjects'
  | 'secretsStore'
  | 'r2';

export type CloudflareComponentSelection = Partial<Record<CloudflareComponent, boolean>>;

export interface CloudflareControlPlaneConfig {
  readonly enabled: boolean;
  readonly freeTierMode: boolean;
  readonly accountId: string;
  readonly apiTokenRef: string;
  readonly zoneId: string;
  readonly zoneName: string;
  readonly workerName: string;
  readonly workerSubdomain: string;
  readonly workerHostname: string;
  readonly workerBaseUrl: string;
  readonly daemonBaseUrl: string;
  readonly daemonHostname: string;
  readonly workerTokenRef: string;
  readonly workerClientTokenRef: string;
  readonly workerCron: string;
  readonly queueName: string;
  readonly deadLetterQueueName: string;
  readonly tunnelName: string;
  readonly tunnelId: string;
  readonly tunnelTokenRef: string;
  readonly accessAppId: string;
  readonly accessServiceTokenId: string;
  readonly accessServiceTokenRef: string;
  readonly kvNamespaceName: string;
  readonly kvNamespaceId: string;
  readonly durableObjectNamespaceName: string;
  readonly durableObjectNamespaceId: string;
  readonly r2BucketName: string;
  readonly secretsStoreName: string;
  readonly secretsStoreId: string;
  readonly maxQueueOpsPerDay: number;
}

export interface CloudflareControlPlaneStatus {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly configured: {
    readonly accountId: boolean;
    readonly apiToken: boolean;
    readonly zone: boolean;
    readonly workerName: boolean;
    readonly daemonBaseUrl: boolean;
    readonly daemonHostname: boolean;
    readonly workerBaseUrl: boolean;
    readonly workerHostname: boolean;
    readonly queueName: boolean;
    readonly deadLetterQueueName: boolean;
    readonly workerToken: boolean;
    readonly workerClientToken: boolean;
    readonly tunnel: boolean;
    readonly access: boolean;
    readonly kv: boolean;
    readonly durableObjects: boolean;
    readonly r2: boolean;
    readonly secretsStore: boolean;
  };
  readonly config: CloudflareControlPlaneConfig;
  readonly warnings: readonly string[];
}

export interface CloudflareValidateInput {
  readonly accountId?: string;
  readonly apiToken?: string;
  readonly apiTokenRef?: string;
}

export interface CloudflareValidateResult {
  readonly ok: boolean;
  readonly account?: {
    readonly id: string;
    readonly name: string;
    readonly type?: string;
  };
  readonly tokenSource: CloudflareSecretSource;
}

export interface CloudflareProvisionInput extends CloudflareValidateInput {
  readonly components?: CloudflareComponentSelection;
  readonly workerName?: string;
  readonly workerSubdomain?: string;
  readonly workerHostname?: string;
  readonly workerBaseUrl?: string;
  readonly daemonBaseUrl?: string;
  readonly daemonHostname?: string;
  readonly zoneId?: string;
  readonly zoneName?: string;
  readonly queueName?: string;
  readonly deadLetterQueueName?: string;
  readonly tunnelName?: string;
  readonly tunnelId?: string;
  readonly tunnelServiceUrl?: string;
  readonly tunnelTokenRef?: string;
  readonly accessAppId?: string;
  readonly accessServiceTokenId?: string;
  readonly accessServiceTokenRef?: string;
  readonly kvNamespaceName?: string;
  readonly kvNamespaceId?: string;
  readonly durableObjectNamespaceName?: string;
  readonly durableObjectNamespaceId?: string;
  readonly r2BucketName?: string;
  readonly secretsStoreName?: string;
  readonly secretsStoreId?: string;
  readonly workerCron?: string;
  readonly operatorToken?: string;
  readonly operatorTokenRef?: string;
  readonly workerClientToken?: string;
  readonly workerClientTokenRef?: string;
  readonly storeApiToken?: boolean;
  readonly storeOperatorToken?: boolean;
  readonly storeWorkerClientToken?: boolean;
  readonly returnGeneratedSecrets?: boolean;
  readonly enableWorkersDev?: boolean;
  readonly queueJobPayloads?: boolean;
  readonly verify?: boolean;
  readonly persistConfig?: boolean;
  readonly batchMode?: 'off' | 'explicit' | 'eligible-by-default';
}

export interface CloudflareProvisionResult {
  readonly ok: boolean;
  readonly dryRun: false;
  readonly steps: readonly CloudflareProvisionStep[];
  readonly account: {
    readonly id: string;
    readonly name: string;
  };
  readonly queues?: {
    readonly queueName: string;
    readonly queueId: string;
    readonly deadLetterQueueName: string;
    readonly deadLetterQueueId: string;
    readonly consumerId?: string;
  };
  readonly worker?: {
    readonly name: string;
    readonly baseUrl?: string;
    readonly subdomain?: string;
    readonly hostname?: string;
    readonly cron?: string;
  };
  readonly tunnel?: {
    readonly id: string;
    readonly name: string;
    readonly hostname?: string;
    readonly tokenRef?: string;
  };
  readonly access?: {
    readonly appId?: string;
    readonly serviceTokenId?: string;
    readonly serviceTokenRef?: string;
  };
  readonly dns?: {
    readonly zoneId: string;
    readonly zoneName?: string;
    readonly records: readonly CloudflareDnsRecordLike[];
  };
  readonly kv?: {
    readonly namespaceName: string;
    readonly namespaceId: string;
  };
  readonly durableObjects?: {
    readonly namespaceName: string;
    readonly namespaceId?: string;
  };
  readonly r2?: {
    readonly bucketName: string;
    readonly storageClass: 'Standard';
  };
  readonly secretsStore?: {
    readonly storeName: string;
    readonly storeId: string;
  };
  readonly verification?: CloudflareVerifyResult;
  readonly generatedSecrets?: {
    readonly workerClientToken?: string;
    readonly tunnelToken?: string;
    readonly accessServiceTokenClientId?: string;
    readonly accessServiceTokenClientSecret?: string;
  };
}

export interface CloudflareTokenRequirementsInput {
  readonly components?: CloudflareComponentSelection;
  readonly includeBootstrap?: boolean;
}

export interface CloudflareTokenPermissionRequirement {
  readonly component: CloudflareComponent | 'bootstrap';
  readonly scope: 'account' | 'zone' | 'user' | 'r2';
  readonly permission: string;
  readonly alternatives?: readonly string[];
  readonly reason: string;
}

export interface CloudflareTokenRequirementsResult {
  readonly ok: true;
  readonly components: Readonly<Record<CloudflareComponent, boolean>>;
  readonly permissions: readonly CloudflareTokenPermissionRequirement[];
  readonly bootstrapToken: {
    readonly requiredForSdkCreation: boolean;
    readonly storeInGoodVibes: false;
    readonly instructions: readonly string[];
  };
}

export interface CloudflareOperationalTokenInput extends CloudflareTokenRequirementsInput {
  readonly accountId?: string;
  readonly zoneId?: string;
  readonly zoneName?: string;
  readonly bootstrapToken?: string;
  readonly tokenName?: string;
  readonly expiresOn?: string;
  readonly persistConfig?: boolean;
  readonly storeApiToken?: boolean;
  readonly returnGeneratedToken?: boolean;
}

export interface CloudflareOperationalTokenResult {
  readonly ok: true;
  readonly tokenId?: string;
  readonly tokenName: string;
  readonly tokenSource: 'bootstrap';
  readonly apiTokenRef?: string;
  readonly generatedToken?: string;
  readonly accountId: string;
  readonly zoneId?: string;
  readonly permissions: readonly CloudflareTokenPermissionRequirement[];
}

export interface CloudflareDiscoverInput extends CloudflareValidateInput {
  readonly components?: CloudflareComponentSelection;
  readonly zoneId?: string;
  readonly zoneName?: string;
  readonly includeResources?: boolean;
}

export interface CloudflareDiscoverResult {
  readonly ok: true;
  readonly tokenSource: CloudflareSecretSource;
  readonly accounts: readonly CloudflareAccountLike[];
  readonly selectedAccount?: CloudflareAccountLike;
  readonly zones: readonly CloudflareZoneLike[];
  readonly selectedZone?: CloudflareZoneLike;
  readonly workerSubdomain?: string;
  readonly queues?: readonly CloudflareQueueLike[];
  readonly kvNamespaces?: readonly CloudflareKvNamespaceLike[];
  readonly durableObjectNamespaces?: readonly CloudflareDurableObjectNamespaceLike[];
  readonly r2Buckets?: readonly CloudflareR2BucketLike[];
  readonly secretsStores?: readonly CloudflareSecretsStoreLike[];
  readonly tunnels?: readonly CloudflareTunnelLike[];
  readonly accessApplications?: readonly CloudflareAccessApplicationLike[];
  readonly warnings: readonly string[];
}

export interface CloudflareVerifyInput {
  readonly workerBaseUrl?: string;
  readonly workerClientToken?: string;
  readonly workerClientTokenRef?: string;
}

export interface CloudflareVerifyResult {
  readonly ok: boolean;
  readonly workerHealth: {
    readonly ok: boolean;
    readonly status: number;
    readonly error?: string;
  };
  readonly daemonBatchProxy?: {
    readonly ok: boolean;
    readonly status: number;
    readonly error?: string;
  };
}

export interface CloudflareDisableInput {
  readonly accountId?: string;
  readonly apiToken?: string;
  readonly apiTokenRef?: string;
  readonly workerName?: string;
  readonly disableWorkerSubdomain?: boolean;
  readonly disableCron?: boolean;
  readonly persistConfig?: boolean;
}

export interface CloudflareDisableResult {
  readonly ok: boolean;
  readonly steps: readonly CloudflareProvisionStep[];
}

export type CloudflareSecretSource = 'body' | 'config-ref' | 'env' | 'goodvibes-secret' | 'auth-token' | 'generated' | 'missing';

export interface CloudflareResolvedSecret {
  readonly value: string | null;
  readonly source: CloudflareSecretSource;
}

export interface CloudflareQueueLike {
  readonly queue_id?: string;
  readonly queue_name?: string;
}

export interface CloudflareConsumerLike {
  readonly consumer_id?: string;
  readonly script?: string;
  readonly type?: string;
}

export interface CloudflareAccountLike {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
}

export interface CloudflareZoneLike {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly type?: string;
}

export interface CloudflareDnsRecordLike {
  readonly id?: string;
  readonly name: string;
  readonly type: string;
  readonly content: string;
  readonly proxied?: boolean;
  readonly ttl?: number;
}

export interface CloudflareKvNamespaceLike {
  readonly id?: string;
  readonly title?: string;
}

export interface CloudflareDurableObjectNamespaceLike {
  readonly id?: string;
  readonly name?: string;
  readonly class?: string;
  readonly script?: string;
  readonly use_sqlite?: boolean;
}

export interface CloudflareR2BucketLike {
  readonly name?: string;
  readonly storage_class?: 'Standard' | 'InfrequentAccess';
}

export interface CloudflareSecretsStoreLike {
  readonly id: string;
  readonly name: string;
}

export interface CloudflareTunnelLike {
  readonly id?: string;
  readonly name?: string;
  readonly status?: string;
}

export interface CloudflareAccessServiceTokenLike {
  readonly id?: string;
  readonly name?: string;
  readonly client_id?: string;
  readonly client_secret?: string;
}

export interface CloudflareAccessApplicationLike {
  readonly id?: string;
  readonly name?: string;
  readonly domain?: string;
  readonly type?: string;
}

export interface CloudflarePermissionGroupLike {
  readonly id?: string;
  readonly name?: string;
  readonly scopes?: readonly string[];
}

export interface CloudflareTokenPolicyParam {
  readonly effect: 'allow' | 'deny';
  readonly permission_groups: readonly { readonly id: string }[];
  readonly resources: Record<string, string>;
}

export interface CloudflareTokenCreateResponseLike {
  readonly id?: string;
  readonly name?: string;
  readonly value?: string;
}

export interface CloudflareTokenVerifyResponseLike {
  readonly id?: string;
  readonly status?: string;
}

export interface CloudflareApiClient {
  readonly accounts: {
    list?(): AsyncIterable<CloudflareAccountLike>;
    get(params: { readonly account_id: string }): Promise<CloudflareAccountLike>;
    readonly tokens?: {
      create(params: {
        readonly account_id: string;
        readonly name: string;
        readonly policies: readonly CloudflareTokenPolicyParam[];
        readonly expires_on?: string;
      }): Promise<CloudflareTokenCreateResponseLike>;
      verify(params: { readonly account_id: string }): Promise<CloudflareTokenVerifyResponseLike>;
      readonly permissionGroups: {
        list(params: { readonly account_id: string; readonly name?: string; readonly scope?: string }): AsyncIterable<CloudflarePermissionGroupLike>;
        get?(params: { readonly account_id: string; readonly name?: string; readonly scope?: string }): Promise<readonly CloudflarePermissionGroupLike[]>;
      };
    };
  };
  readonly user?: {
    readonly tokens: {
      create(params: {
        readonly name: string;
        readonly policies: readonly CloudflareTokenPolicyParam[];
        readonly expires_on?: string;
      }): Promise<CloudflareTokenCreateResponseLike>;
      verify(): Promise<CloudflareTokenVerifyResponseLike>;
      readonly permissionGroups: {
        list(params?: { readonly name?: string; readonly scope?: string }): AsyncIterable<CloudflarePermissionGroupLike>;
      };
    };
  };
  readonly zones?: {
    list(params?: { readonly account?: { readonly id?: string; readonly name?: string }; readonly name?: string }): AsyncIterable<CloudflareZoneLike>;
    get(params: { readonly zone_id: string }): Promise<CloudflareZoneLike>;
  };
  readonly dns?: {
    readonly records: {
      create(params: {
        readonly zone_id: string;
        readonly type: 'CNAME' | 'TXT' | 'A' | 'AAAA';
        readonly name: string;
        readonly content: string;
        readonly proxied?: boolean;
        readonly ttl?: number;
        readonly comment?: string;
      }): Promise<CloudflareDnsRecordLike>;
      update(
        dnsRecordId: string,
        params: {
          readonly zone_id: string;
          readonly type: 'CNAME' | 'TXT' | 'A' | 'AAAA';
          readonly name: string;
          readonly content: string;
          readonly proxied?: boolean;
          readonly ttl?: number;
          readonly comment?: string;
        },
      ): Promise<CloudflareDnsRecordLike>;
      list(params: {
        readonly zone_id: string;
        readonly type?: string;
        readonly name?: { readonly exact?: string } | string;
      }): AsyncIterable<CloudflareDnsRecordLike>;
    };
  };
  readonly queues: {
    create(params: { readonly account_id: string; readonly queue_name: string }): Promise<CloudflareQueueLike>;
    list(params: { readonly account_id: string }): AsyncIterable<CloudflareQueueLike>;
    get(queueId: string, params: { readonly account_id: string }): Promise<CloudflareQueueLike>;
    readonly consumers: {
      create(
        queueId: string,
        params: {
          readonly account_id: string;
          readonly type: 'worker';
          readonly script_name: string;
          readonly dead_letter_queue?: string;
          readonly settings?: {
            readonly batch_size?: number;
            readonly max_retries?: number;
            readonly max_wait_time_ms?: number;
            readonly retry_delay?: number;
          };
        },
      ): Promise<CloudflareConsumerLike>;
      update(
        queueId: string,
        consumerId: string,
        params: {
          readonly account_id: string;
          readonly type: 'worker';
          readonly script_name: string;
          readonly dead_letter_queue?: string;
          readonly settings?: {
            readonly batch_size?: number;
            readonly max_retries?: number;
            readonly max_wait_time_ms?: number;
            readonly retry_delay?: number;
          };
        },
      ): Promise<CloudflareConsumerLike>;
      list(queueId: string, params: { readonly account_id: string }): AsyncIterable<CloudflareConsumerLike>;
    };
  };
  readonly kv?: {
    readonly namespaces: {
      create(params: { readonly account_id: string; readonly title: string }): Promise<CloudflareKvNamespaceLike>;
      list(params: { readonly account_id: string }): AsyncIterable<CloudflareKvNamespaceLike>;
    };
  };
  readonly durableObjects?: {
    readonly namespaces: {
      list(params: { readonly account_id: string }): AsyncIterable<CloudflareDurableObjectNamespaceLike>;
    };
  };
  readonly r2?: {
    readonly buckets: {
      create(params: { readonly account_id: string; readonly name: string; readonly storageClass?: 'Standard' | 'InfrequentAccess'; readonly storage_class?: 'Standard' | 'InfrequentAccess' }): Promise<CloudflareR2BucketLike>;
      list(params: { readonly account_id: string }): Promise<{ readonly buckets?: readonly CloudflareR2BucketLike[] }>;
      get?(bucketName: string, params: { readonly account_id: string }): Promise<CloudflareR2BucketLike>;
    };
  };
  readonly secretsStore?: {
    readonly stores: {
      create(params: { readonly account_id: string; readonly body: readonly { readonly name: string }[] }): AsyncIterable<CloudflareSecretsStoreLike>;
      list(params: { readonly account_id: string }): AsyncIterable<CloudflareSecretsStoreLike>;
    };
  };
  readonly zeroTrust?: {
    readonly tunnels?: {
      readonly cloudflared: {
        create(params: { readonly account_id: string; readonly name: string; readonly config_src?: 'local' | 'cloudflare' }): Promise<CloudflareTunnelLike>;
        list(params: { readonly account_id: string; readonly name?: string; readonly is_deleted?: boolean }): AsyncIterable<CloudflareTunnelLike>;
        readonly configurations: {
          update(tunnelId: string, params: { readonly account_id: string; readonly config: Record<string, unknown> }): Promise<Record<string, unknown>>;
        };
        readonly token: {
          get(tunnelId: string, params: { readonly account_id: string }): Promise<string>;
        };
      };
    };
    readonly access?: {
      readonly serviceTokens: {
        create(params: { readonly account_id?: string; readonly zone_id?: string; readonly name: string; readonly duration?: string }): Promise<CloudflareAccessServiceTokenLike>;
        list(params: { readonly account_id?: string; readonly zone_id?: string; readonly name?: string; readonly search?: string }): AsyncIterable<CloudflareAccessServiceTokenLike>;
      };
      readonly applications: {
        create(params: Record<string, unknown>): Promise<CloudflareAccessApplicationLike>;
        update(appId: string, params: Record<string, unknown>): Promise<CloudflareAccessApplicationLike>;
        list(params: { readonly account_id?: string; readonly zone_id?: string; readonly name?: string; readonly domain?: string; readonly exact?: boolean }): AsyncIterable<CloudflareAccessApplicationLike>;
      };
    };
  };
  readonly workers: {
    readonly subdomains: {
      get(params: { readonly account_id: string }): Promise<{ readonly subdomain: string }>;
      update(params: { readonly account_id: string; readonly subdomain: string }): Promise<{ readonly subdomain: string }>;
    };
    readonly scripts: {
      update(
        scriptName: string,
        params: {
          readonly account_id: string;
          readonly metadata: Record<string, unknown>;
          readonly files: readonly File[];
        },
      ): Promise<{ readonly id?: string }>;
      readonly subdomain: {
        create(
          scriptName: string,
          params: { readonly account_id: string; readonly enabled: boolean; readonly previews_enabled?: boolean },
        ): Promise<{ readonly enabled: boolean }>;
        delete(scriptName: string, params: { readonly account_id: string }): Promise<{ readonly enabled: boolean }>;
        get(scriptName: string, params: { readonly account_id: string }): Promise<{ readonly enabled: boolean }>;
      };
      readonly schedules: {
        update(scriptName: string, params: { readonly account_id: string; readonly body: readonly { readonly cron: string }[] }): Promise<{ readonly schedules: readonly { readonly cron: string }[] }>;
        get(scriptName: string, params: { readonly account_id: string }): Promise<{ readonly schedules: readonly { readonly cron: string }[] }>;
      };
      readonly secrets: {
        update(
          scriptName: string,
          params: { readonly account_id: string; readonly name: string; readonly text: string; readonly type: 'secret_text' },
        ): Promise<{ readonly name: string; readonly type: 'secret_text' }>;
      };
    };
  };
}

export interface CloudflareControlPlaneOptions {
  readonly configManager: Pick<ConfigManager, 'get' | 'set'>;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'set' | 'getGlobalHome'> | null;
  readonly authToken?: () => string | null;
  readonly createClient?: (apiToken: string) => Promise<CloudflareApiClient>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

export class CloudflareControlPlaneError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'CloudflareControlPlaneError';
    this.code = code;
    this.status = status;
  }
}
