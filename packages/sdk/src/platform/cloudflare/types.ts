import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';

export type CloudflareProvisionStepStatus = 'ok' | 'skipped' | 'warning';

export interface CloudflareProvisionStep {
  readonly name: string;
  readonly status: CloudflareProvisionStepStatus;
  readonly message?: string | undefined;
  readonly resourceId?: string | undefined;
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
  readonly accountId?: string | undefined;
  readonly apiToken?: string | undefined;
  readonly apiTokenRef?: string | undefined;
}

export interface CloudflareValidateResult {
  readonly ok: boolean;
  readonly account?: {
    readonly id: string;
    readonly name: string;
    readonly type?: string | undefined;
  };
  readonly tokenSource: CloudflareSecretSource;
}

export interface CloudflareProvisionInput extends CloudflareValidateInput {
  readonly components?: CloudflareComponentSelection | undefined;
  readonly workerName?: string | undefined;
  readonly workerSubdomain?: string | undefined;
  readonly workerHostname?: string | undefined;
  readonly workerBaseUrl?: string | undefined;
  readonly daemonBaseUrl?: string | undefined;
  readonly daemonHostname?: string | undefined;
  readonly zoneId?: string | undefined;
  readonly zoneName?: string | undefined;
  readonly queueName?: string | undefined;
  readonly deadLetterQueueName?: string | undefined;
  readonly tunnelName?: string | undefined;
  readonly tunnelId?: string | undefined;
  readonly tunnelServiceUrl?: string | undefined;
  readonly tunnelTokenRef?: string | undefined;
  readonly accessAppId?: string | undefined;
  readonly accessServiceTokenId?: string | undefined;
  readonly accessServiceTokenRef?: string | undefined;
  readonly kvNamespaceName?: string | undefined;
  readonly kvNamespaceId?: string | undefined;
  readonly durableObjectNamespaceName?: string | undefined;
  readonly durableObjectNamespaceId?: string | undefined;
  readonly r2BucketName?: string | undefined;
  readonly secretsStoreName?: string | undefined;
  readonly secretsStoreId?: string | undefined;
  readonly workerCron?: string | undefined;
  readonly operatorToken?: string | undefined;
  readonly operatorTokenRef?: string | undefined;
  readonly workerClientToken?: string | undefined;
  readonly workerClientTokenRef?: string | undefined;
  readonly storeApiToken?: boolean | undefined;
  readonly storeOperatorToken?: boolean | undefined;
  readonly storeWorkerClientToken?: boolean | undefined;
  readonly returnGeneratedSecrets?: boolean | undefined;
  readonly enableWorkersDev?: boolean | undefined;
  readonly queueJobPayloads?: boolean | undefined;
  readonly verify?: boolean | undefined;
  readonly persistConfig?: boolean | undefined;
  readonly batchMode?: 'off' | 'explicit' | 'eligible-by-default' | undefined;
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
    readonly consumerId?: string | undefined;
  };
  readonly worker?: {
    readonly name: string;
    readonly baseUrl?: string | undefined;
    readonly subdomain?: string | undefined;
    readonly hostname?: string | undefined;
    readonly cron?: string | undefined;
  };
  readonly tunnel?: {
    readonly id: string;
    readonly name: string;
    readonly hostname?: string | undefined;
    readonly tokenRef?: string | undefined;
  };
  readonly access?: {
    readonly appId?: string | undefined;
    readonly serviceTokenId?: string | undefined;
    readonly serviceTokenRef?: string | undefined;
  };
  readonly dns?: {
    readonly zoneId: string;
    readonly zoneName?: string | undefined;
    readonly records: readonly CloudflareDnsRecordLike[];
  };
  readonly kv?: {
    readonly namespaceName: string;
    readonly namespaceId: string;
  };
  readonly durableObjects?: {
    readonly namespaceName: string;
    readonly namespaceId?: string | undefined;
  };
  readonly r2?: {
    readonly bucketName: string;
    readonly storageClass: 'Standard';
  };
  readonly secretsStore?: {
    readonly storeName: string;
    readonly storeId: string;
  };
  readonly verification?: CloudflareVerifyResult | undefined;
  readonly generatedSecrets?: {
    readonly workerClientToken?: string | undefined;
    readonly tunnelToken?: string | undefined;
    readonly accessServiceTokenClientId?: string | undefined;
    readonly accessServiceTokenClientSecret?: string | undefined;
  };
}

export interface CloudflareTokenRequirementsInput {
  readonly components?: CloudflareComponentSelection | undefined;
  readonly includeBootstrap?: boolean | undefined;
}

export interface CloudflareTokenPermissionRequirement {
  readonly component: CloudflareComponent | 'bootstrap';
  readonly scope: 'account' | 'zone' | 'user';
  readonly scopeAlternatives?: readonly string[] | undefined;
  readonly permission: string;
  readonly alternatives?: readonly string[] | undefined;
  readonly reason: string;
}

export interface CloudflareResolvedPermissionGroup {
  readonly id: string;
  readonly requirement: CloudflareTokenPermissionRequirement;
  readonly cloudflareScope: string;
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
  readonly accountId?: string | undefined;
  readonly zoneId?: string | undefined;
  readonly zoneName?: string | undefined;
  readonly bootstrapToken?: string | undefined;
  readonly tokenName?: string | undefined;
  readonly expiresOn?: string | undefined;
  readonly persistConfig?: boolean | undefined;
  readonly storeApiToken?: boolean | undefined;
  readonly returnGeneratedToken?: boolean | undefined;
}

export interface CloudflareOperationalTokenResult {
  readonly ok: true;
  readonly tokenId?: string | undefined;
  readonly tokenName: string;
  readonly tokenSource: 'bootstrap';
  readonly apiTokenRef?: string | undefined;
  readonly generatedToken?: string | undefined;
  readonly accountId: string;
  readonly zoneId?: string | undefined;
  readonly permissions: readonly CloudflareTokenPermissionRequirement[];
}

export interface CloudflareDiscoverInput extends CloudflareValidateInput {
  readonly components?: CloudflareComponentSelection | undefined;
  readonly zoneId?: string | undefined;
  readonly zoneName?: string | undefined;
  readonly includeResources?: boolean | undefined;
}

export interface CloudflareDiscoverResult {
  readonly ok: true;
  readonly tokenSource: CloudflareSecretSource;
  readonly accounts: readonly CloudflareAccountLike[];
  readonly selectedAccount?: CloudflareAccountLike | undefined;
  readonly zones: readonly CloudflareZoneLike[];
  readonly selectedZone?: CloudflareZoneLike | undefined;
  readonly workerSubdomain?: string | undefined;
  readonly queues?: readonly CloudflareQueueLike[] | undefined;
  readonly kvNamespaces?: readonly CloudflareKvNamespaceLike[] | undefined;
  readonly durableObjectNamespaces?: readonly CloudflareDurableObjectNamespaceLike[] | undefined;
  readonly r2Buckets?: readonly CloudflareR2BucketLike[] | undefined;
  readonly secretsStores?: readonly CloudflareSecretsStoreLike[] | undefined;
  readonly tunnels?: readonly CloudflareTunnelLike[] | undefined;
  readonly accessApplications?: readonly CloudflareAccessApplicationLike[] | undefined;
  readonly warnings: readonly string[];
}

export interface CloudflareVerifyInput {
  readonly workerBaseUrl?: string | undefined;
  readonly workerClientToken?: string | undefined;
  readonly workerClientTokenRef?: string | undefined;
}

export interface CloudflareVerifyResult {
  readonly ok: boolean;
  readonly workerHealth: {
    readonly ok: boolean;
    readonly status: number;
    readonly error?: string | undefined;
  };
  readonly daemonBatchProxy?: {
    readonly ok: boolean;
    readonly status: number;
    readonly error?: string | undefined;
  };
}

export interface CloudflareDisableInput {
  readonly accountId?: string | undefined;
  readonly apiToken?: string | undefined;
  readonly apiTokenRef?: string | undefined;
  readonly workerName?: string | undefined;
  readonly disableWorkerSubdomain?: boolean | undefined;
  readonly disableCron?: boolean | undefined;
  readonly persistConfig?: boolean | undefined;
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
  readonly queue_id?: string | undefined;
  readonly queue_name?: string | undefined;
}

export interface CloudflareConsumerLike {
  readonly consumer_id?: string | undefined;
  readonly script?: string | undefined;
  readonly type?: string | undefined;
}

export interface CloudflareAccountLike {
  readonly id: string;
  readonly name: string;
  readonly type?: string | undefined;
}

export interface CloudflareZoneLike {
  readonly id: string;
  readonly name: string;
  readonly status?: string | undefined;
  readonly type?: string | undefined;
}

export interface CloudflareDnsRecordLike {
  readonly id?: string | undefined;
  readonly name: string;
  readonly type: string;
  readonly content: string;
  readonly proxied?: boolean | undefined;
  readonly ttl?: number | undefined;
}

export interface CloudflareKvNamespaceLike {
  readonly id?: string | undefined;
  readonly title?: string | undefined;
}

export interface CloudflareDurableObjectNamespaceLike {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly class?: string | undefined;
  readonly script?: string | undefined;
  readonly use_sqlite?: boolean | undefined;
}

export interface CloudflareWorkerScriptLike {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly migration_tag?: string | undefined;
}

export interface CloudflareR2BucketLike {
  readonly name?: string | undefined;
  readonly storage_class?: 'Standard' | 'InfrequentAccess' | undefined;
}

export interface CloudflareSecretsStoreLike {
  readonly id: string;
  readonly name: string;
}

export interface CloudflareTunnelLike {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly status?: string | undefined;
}

export interface CloudflareAccessServiceTokenLike {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly client_id?: string | undefined;
  readonly client_secret?: string | undefined;
}

export interface CloudflareAccessApplicationLike {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly domain?: string | undefined;
  readonly type?: string | undefined;
}

export interface CloudflarePermissionGroupLike {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
}

export type CloudflareTokenResourceMap = Record<string, string | Record<string, string>>;

export interface CloudflareTokenPolicyParam {
  readonly effect: 'allow' | 'deny';
  readonly permission_groups: readonly { readonly id: string }[];
  readonly resources: CloudflareTokenResourceMap;
}

export interface CloudflareTokenCreateResponseLike {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly policies?: readonly CloudflareTokenPolicyParam[] | undefined;
  readonly value?: string | undefined;
}

export interface CloudflareTokenVerifyResponseLike {
  readonly id?: string | undefined;
  readonly status?: string | undefined;
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
        readonly expires_on?: string | undefined;
      }): Promise<CloudflareTokenCreateResponseLike>;
      get?(tokenId: string, params: { readonly account_id: string }): Promise<CloudflareTokenCreateResponseLike>;
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
        readonly expires_on?: string | undefined;
      }): Promise<CloudflareTokenCreateResponseLike>;
      get?(tokenId: string): Promise<CloudflareTokenCreateResponseLike>;
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
        readonly proxied?: boolean | undefined;
        readonly ttl?: number | undefined;
        readonly comment?: string | undefined;
      }): Promise<CloudflareDnsRecordLike>;
      update(
        dnsRecordId: string,
        params: {
          readonly zone_id: string;
          readonly type: 'CNAME' | 'TXT' | 'A' | 'AAAA';
          readonly name: string;
          readonly content: string;
          readonly proxied?: boolean | undefined;
          readonly ttl?: number | undefined;
          readonly comment?: string | undefined;
        },
      ): Promise<CloudflareDnsRecordLike>;
      list(params: {
        readonly zone_id: string;
        readonly type?: string | undefined;
        readonly name?: { readonly exact?: string } | string | undefined;
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
          readonly dead_letter_queue?: string | undefined;
          readonly settings?: {
            readonly batch_size?: number | undefined;
            readonly max_retries?: number | undefined;
            readonly max_wait_time_ms?: number | undefined;
            readonly retry_delay?: number | undefined;
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
          readonly dead_letter_queue?: string | undefined;
          readonly settings?: {
            readonly batch_size?: number | undefined;
            readonly max_retries?: number | undefined;
            readonly max_wait_time_ms?: number | undefined;
            readonly retry_delay?: number | undefined;
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
      get?(scriptName: string, params: { readonly account_id: string }): Promise<CloudflareWorkerScriptLike>;
      list?(params: { readonly account_id: string }): AsyncIterable<CloudflareWorkerScriptLike>;
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
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'set' | 'getGlobalHome'> | null | undefined;
  readonly authToken?: (() => string | null) | undefined | undefined;
  readonly createClient?: ((apiToken: string) => Promise<CloudflareApiClient>) | undefined | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined | undefined;
  readonly randomUUID?: (() => string) | undefined | undefined;
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
