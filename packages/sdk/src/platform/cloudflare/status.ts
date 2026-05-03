import type {
  CloudflareControlPlaneConfig,
  CloudflareControlPlaneStatus,
  CloudflareResolvedSecret,
} from './types.js';

export interface BuildCloudflareStatusInput {
  readonly config: CloudflareControlPlaneConfig;
  readonly apiToken: CloudflareResolvedSecret;
  readonly workerToken: CloudflareResolvedSecret;
  readonly workerClientToken: CloudflareResolvedSecret;
}

export function buildCloudflareControlPlaneStatus(input: BuildCloudflareStatusInput): CloudflareControlPlaneStatus {
  const configured = {
    accountId: input.config.accountId.length > 0,
    apiToken: input.apiToken.value !== null,
    zone: input.config.zoneId.length > 0 || input.config.zoneName.length > 0,
    workerName: input.config.workerName.length > 0,
    daemonBaseUrl: input.config.daemonBaseUrl.length > 0,
    daemonHostname: input.config.daemonHostname.length > 0,
    workerBaseUrl: input.config.workerBaseUrl.length > 0,
    workerHostname: input.config.workerHostname.length > 0,
    queueName: input.config.queueName.length > 0,
    deadLetterQueueName: input.config.deadLetterQueueName.length > 0,
    workerToken: input.workerToken.value !== null,
    workerClientToken: input.workerClientToken.value !== null,
    tunnel: input.config.tunnelId.length > 0 || input.config.tunnelName.length > 0,
    access: input.config.accessAppId.length > 0 ||
      input.config.accessServiceTokenId.length > 0 ||
      input.config.accessServiceTokenRef.length > 0,
    kv: input.config.kvNamespaceId.length > 0 || input.config.kvNamespaceName.length > 0,
    durableObjects: input.config.durableObjectNamespaceId.length > 0 ||
      input.config.durableObjectNamespaceName.length > 0,
    r2: input.config.r2BucketName.length > 0,
    secretsStore: input.config.secretsStoreId.length > 0 || input.config.secretsStoreName.length > 0,
  };
  const warnings: string[] = [];
  if (input.config.enabled && !configured.apiToken) warnings.push('Cloudflare is enabled but no API token is configured.');
  if (input.config.enabled && !configured.daemonBaseUrl) warnings.push('Cloudflare is enabled but no daemonBaseUrl is configured for Worker-to-daemon calls.');
  if (input.config.enabled && !configured.workerToken) warnings.push('Cloudflare is enabled but no Worker-to-daemon operator token is configured.');
  if (input.config.enabled && !configured.workerClientToken) warnings.push('Cloudflare Worker client auth is not configured; provisioning will generate one.');
  const ready = input.config.enabled &&
    configured.accountId &&
    configured.apiToken &&
    configured.workerName &&
    configured.daemonBaseUrl &&
    configured.workerBaseUrl &&
    configured.queueName &&
    configured.deadLetterQueueName &&
    configured.workerToken;
  return { enabled: input.config.enabled, ready, configured, config: input.config, warnings };
}
