import type { ConfigKey } from '../config/schema.js';
import {
  DEFAULT_DLQ_NAME,
  DEFAULT_DO_NAMESPACE_NAME,
  DEFAULT_KV_NAMESPACE_NAME,
  DEFAULT_QUEUE_NAME,
  DEFAULT_R2_BUCKET_NAME,
  DEFAULT_SECRETS_STORE_NAME,
  DEFAULT_TUNNEL_NAME,
  DEFAULT_WORKER_CRON,
  DEFAULT_WORKER_NAME,
} from './constants.js';
import type { CloudflareControlPlaneConfig } from './types.js';

interface CloudflareConfigReader {
  get(key: ConfigKey): unknown;
}

export function readCloudflareConfig(configManager: CloudflareConfigReader): CloudflareControlPlaneConfig {
  return {
    enabled: getBooleanConfig(configManager, 'cloudflare.enabled', false),
    freeTierMode: getBooleanConfig(configManager, 'cloudflare.freeTierMode', true),
    accountId: getStringConfig(configManager, 'cloudflare.accountId', ''),
    apiTokenRef: getStringConfig(configManager, 'cloudflare.apiTokenRef', ''),
    zoneId: getStringConfig(configManager, 'cloudflare.zoneId', ''),
    zoneName: getStringConfig(configManager, 'cloudflare.zoneName', ''),
    workerName: getStringConfig(configManager, 'cloudflare.workerName', DEFAULT_WORKER_NAME),
    workerSubdomain: getStringConfig(configManager, 'cloudflare.workerSubdomain', ''),
    workerHostname: getStringConfig(configManager, 'cloudflare.workerHostname', ''),
    workerBaseUrl: getStringConfig(configManager, 'cloudflare.workerBaseUrl', ''),
    daemonBaseUrl: getStringConfig(configManager, 'cloudflare.daemonBaseUrl', ''),
    daemonHostname: getStringConfig(configManager, 'cloudflare.daemonHostname', ''),
    workerTokenRef: getStringConfig(configManager, 'cloudflare.workerTokenRef', ''),
    workerClientTokenRef: getStringConfig(configManager, 'cloudflare.workerClientTokenRef', ''),
    workerCron: getStringConfig(configManager, 'cloudflare.workerCron', DEFAULT_WORKER_CRON),
    queueName: getStringConfig(configManager, 'cloudflare.queueName', DEFAULT_QUEUE_NAME),
    deadLetterQueueName: getStringConfig(configManager, 'cloudflare.deadLetterQueueName', DEFAULT_DLQ_NAME),
    tunnelName: getStringConfig(configManager, 'cloudflare.tunnelName', DEFAULT_TUNNEL_NAME),
    tunnelId: getStringConfig(configManager, 'cloudflare.tunnelId', ''),
    tunnelTokenRef: getStringConfig(configManager, 'cloudflare.tunnelTokenRef', ''),
    accessAppId: getStringConfig(configManager, 'cloudflare.accessAppId', ''),
    accessServiceTokenId: getStringConfig(configManager, 'cloudflare.accessServiceTokenId', ''),
    accessServiceTokenRef: getStringConfig(configManager, 'cloudflare.accessServiceTokenRef', ''),
    kvNamespaceName: getStringConfig(configManager, 'cloudflare.kvNamespaceName', DEFAULT_KV_NAMESPACE_NAME),
    kvNamespaceId: getStringConfig(configManager, 'cloudflare.kvNamespaceId', ''),
    durableObjectNamespaceName: getStringConfig(configManager, 'cloudflare.durableObjectNamespaceName', DEFAULT_DO_NAMESPACE_NAME),
    durableObjectNamespaceId: getStringConfig(configManager, 'cloudflare.durableObjectNamespaceId', ''),
    r2BucketName: getStringConfig(configManager, 'cloudflare.r2BucketName', DEFAULT_R2_BUCKET_NAME),
    secretsStoreName: getStringConfig(configManager, 'cloudflare.secretsStoreName', DEFAULT_SECRETS_STORE_NAME),
    secretsStoreId: getStringConfig(configManager, 'cloudflare.secretsStoreId', ''),
    maxQueueOpsPerDay: getNumberConfig(configManager, 'cloudflare.maxQueueOpsPerDay', 10_000),
  };
}

function getStringConfig(configManager: CloudflareConfigReader, key: ConfigKey, fallback: string): string {
  const value = configManager.get(key);
  return typeof value === 'string' ? value : fallback;
}

function getBooleanConfig(configManager: CloudflareConfigReader, key: ConfigKey, fallback: boolean): boolean {
  const value = configManager.get(key);
  return typeof value === 'boolean' ? value : fallback;
}

function getNumberConfig(configManager: CloudflareConfigReader, key: ConfigKey, fallback: number): number {
  const value = configManager.get(key);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
