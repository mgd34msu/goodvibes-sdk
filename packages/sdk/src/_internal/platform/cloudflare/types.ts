import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';

export type CloudflareProvisionStepStatus = 'ok' | 'skipped' | 'warning';

export interface CloudflareProvisionStep {
  readonly name: string;
  readonly status: CloudflareProvisionStepStatus;
  readonly message?: string;
  readonly resourceId?: string;
}

export interface CloudflareControlPlaneConfig {
  readonly enabled: boolean;
  readonly freeTierMode: boolean;
  readonly accountId: string;
  readonly apiTokenRef: string;
  readonly workerName: string;
  readonly workerSubdomain: string;
  readonly workerBaseUrl: string;
  readonly daemonBaseUrl: string;
  readonly workerTokenRef: string;
  readonly workerClientTokenRef: string;
  readonly workerCron: string;
  readonly queueName: string;
  readonly deadLetterQueueName: string;
  readonly maxQueueOpsPerDay: number;
}

export interface CloudflareControlPlaneStatus {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly configured: {
    readonly accountId: boolean;
    readonly apiToken: boolean;
    readonly workerName: boolean;
    readonly daemonBaseUrl: boolean;
    readonly workerBaseUrl: boolean;
    readonly queueName: boolean;
    readonly deadLetterQueueName: boolean;
    readonly workerToken: boolean;
    readonly workerClientToken: boolean;
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
  readonly workerName?: string;
  readonly workerSubdomain?: string;
  readonly workerBaseUrl?: string;
  readonly daemonBaseUrl?: string;
  readonly queueName?: string;
  readonly deadLetterQueueName?: string;
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
  readonly queues: {
    readonly queueName: string;
    readonly queueId: string;
    readonly deadLetterQueueName: string;
    readonly deadLetterQueueId: string;
    readonly consumerId?: string;
  };
  readonly worker: {
    readonly name: string;
    readonly baseUrl?: string;
    readonly subdomain?: string;
    readonly cron?: string;
  };
  readonly verification?: CloudflareVerifyResult;
  readonly generatedSecrets?: {
    readonly workerClientToken?: string;
  };
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

export interface CloudflareApiClient {
  readonly accounts: {
    get(params: { readonly account_id: string }): Promise<CloudflareAccountLike>;
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
