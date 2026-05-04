import type { ConfigKey } from '../config/schema.js';
import { summarizeError } from '../utils/error-display.js';
import {
  CLOUDFLARE_ACCESS_SERVICE_TOKEN_KEY,
  CLOUDFLARE_TUNNEL_TOKEN_KEY,
} from './constants.js';
import type {
  CloudflareAccessApplicationLike,
  CloudflareAccessServiceTokenLike,
  CloudflareApiClient,
  CloudflareConsumerLike,
  CloudflareControlPlaneConfig,
  CloudflareDnsRecordLike,
  CloudflareDurableObjectNamespaceLike,
  CloudflareKvNamespaceLike,
  CloudflareProvisionStep,
  CloudflareQueueLike,
  CloudflareR2BucketLike,
  CloudflareSecretsStoreLike,
  CloudflareTunnelLike,
  CloudflareZoneLike,
} from './types.js';
import { CloudflareControlPlaneError } from './types.js';
import { clean, collectAsync, hostnameBelongsToZone, hostnameFromUrl, isPlaceholderHostname } from './utils.js';

export interface CloudflareProvisioningContext {
  readonly readConfig: () => CloudflareControlPlaneConfig;
  readonly setConfig: (key: ConfigKey, value: unknown, persist: boolean) => void;
  readonly storeSecret: (key: string, value: string) => Promise<void>;
}

export async function ensureQueue(
  client: CloudflareApiClient,
  accountId: string,
  queueName: string,
  steps: CloudflareProvisionStep[],
  stepName: string,
): Promise<CloudflareQueueLike> {
  const existing = await findQueueByName(client, accountId, queueName);
  if (existing) {
    steps.push({ name: stepName, status: 'ok', message: `Using existing Cloudflare Queue ${queueName}.`, resourceId: existing.queue_id });
    return existing;
  }
  try {
    const created = await client.queues.create({ account_id: accountId, queue_name: queueName });
    steps.push({ name: stepName, status: 'ok', message: `Created Cloudflare Queue ${queueName}.`, resourceId: created.queue_id });
    return created;
  } catch (error: unknown) {
    const recovered = await findQueueByName(client, accountId, queueName);
    if (recovered) {
      steps.push({ name: stepName, status: 'ok', message: `Using existing Cloudflare Queue ${queueName} after create retry: ${summarizeError(error)}`, resourceId: recovered.queue_id });
      return recovered;
    }
    throw error;
  }
}

export async function ensureKvNamespace(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  accountId: string,
  namespaceName: string,
  configuredNamespaceId: string,
  persist: boolean,
  steps: CloudflareProvisionStep[],
): Promise<CloudflareKvNamespaceLike> {
  if (!client.kv) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose KV namespace APIs.', 'CLOUDFLARE_KV_API_UNAVAILABLE', 500);
  }
  const existing = await findKvNamespace(client, accountId, namespaceName, configuredNamespaceId);
  if (existing) {
    persistKvNamespace(context, existing, namespaceName, persist);
    steps.push({ name: 'kv-namespace', status: 'ok', message: `Using existing KV namespace ${namespaceName}.`, resourceId: existing.id });
    return existing;
  }
  if (configuredNamespaceId) {
    const configured = { id: configuredNamespaceId, title: namespaceName };
    persistKvNamespace(context, configured, namespaceName, persist);
    steps.push({ name: 'kv-namespace', status: 'ok', message: `Using configured KV namespace ${namespaceName}.`, resourceId: configuredNamespaceId });
    return configured;
  }
  try {
    const created = await client.kv.namespaces.create({ account_id: accountId, title: namespaceName });
    persistKvNamespace(context, created, namespaceName, persist);
    steps.push({ name: 'kv-namespace', status: 'ok', message: `Created KV namespace ${namespaceName}.`, resourceId: created.id });
    return created;
  } catch (error: unknown) {
    const recovered = await findKvNamespace(client, accountId, namespaceName, configuredNamespaceId);
    if (recovered) {
      persistKvNamespace(context, recovered, namespaceName, persist);
      steps.push({ name: 'kv-namespace', status: 'ok', message: `Using existing KV namespace ${namespaceName} after create retry: ${summarizeError(error)}`, resourceId: recovered.id });
      return recovered;
    }
    throw error;
  }
}

export async function ensureR2Bucket(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  accountId: string,
  bucketName: string,
  persist: boolean,
  steps: CloudflareProvisionStep[],
): Promise<CloudflareR2BucketLike> {
  if (!client.r2) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose R2 bucket APIs.', 'CLOUDFLARE_R2_API_UNAVAILABLE', 500);
  }
  const existing = await findR2BucketByName(client, accountId, bucketName);
  if (existing) {
    context.setConfig('cloudflare.r2BucketName', bucketName, persist);
    steps.push({ name: 'r2-bucket', status: 'ok', message: `Using existing R2 Standard bucket ${bucketName}.`, resourceId: bucketName });
    return existing;
  }
  try {
    const created = await client.r2.buckets.create({ account_id: accountId, name: bucketName, storageClass: 'Standard' });
    context.setConfig('cloudflare.r2BucketName', bucketName, persist);
    steps.push({ name: 'r2-bucket', status: 'ok', message: `Created R2 Standard bucket ${bucketName}.`, resourceId: bucketName });
    return created.name ? created : { ...created, name: bucketName, storage_class: 'Standard' };
  } catch (error: unknown) {
    const recovered = await findR2BucketByName(client, accountId, bucketName);
    if (recovered) {
      context.setConfig('cloudflare.r2BucketName', bucketName, persist);
      steps.push({ name: 'r2-bucket', status: 'ok', message: `Using existing R2 bucket ${bucketName} after create retry: ${summarizeError(error)}`, resourceId: bucketName });
      return recovered;
    }
    throw error;
  }
}

export async function ensureSecretsStore(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  accountId: string,
  storeName: string,
  configuredStoreId: string,
  persist: boolean,
  steps: CloudflareProvisionStep[],
): Promise<CloudflareSecretsStoreLike> {
  if (!client.secretsStore) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose Secrets Store APIs.', 'CLOUDFLARE_SECRETS_STORE_API_UNAVAILABLE', 500);
  }
  const existing = await findSecretsStore(client, accountId, storeName, configuredStoreId);
  if (existing) {
    persistSecretsStore(context, existing, persist);
    steps.push({ name: 'secrets-store', status: 'ok', message: `Using existing Cloudflare Secrets Store ${existing.name}.`, resourceId: existing.id });
    return existing;
  }
  if (configuredStoreId) {
    const configured = { id: configuredStoreId, name: storeName };
    persistSecretsStore(context, configured, persist);
    steps.push({ name: 'secrets-store', status: 'warning', message: `Using configured Cloudflare Secrets Store id ${configuredStoreId}; it was not visible during discovery.`, resourceId: configuredStoreId });
    return configured;
  }
  try {
    for await (const created of client.secretsStore.stores.create({ account_id: accountId, body: [{ name: storeName }] })) {
      persistSecretsStore(context, created, persist);
      steps.push({ name: 'secrets-store', status: 'ok', message: `Created Cloudflare Secrets Store ${storeName}.`, resourceId: created.id });
      return created;
    }
  } catch (error: unknown) {
    const recovered = await findRecoverableSecretsStore(client, accountId, storeName, configuredStoreId, error);
    if (recovered) {
      persistSecretsStore(context, recovered, persist);
      steps.push({ name: 'secrets-store', status: recovered.name === storeName ? 'ok' : 'warning', message: `Using existing Cloudflare Secrets Store ${recovered.name} after create retry: ${summarizeError(error)}`, resourceId: recovered.id });
      return recovered;
    }
    throw error;
  }
  throw new CloudflareControlPlaneError(`Cloudflare Secrets Store '${storeName}' did not return a created store.`, 'CLOUDFLARE_SECRETS_STORE_CREATE_FAILED', 502);
}

export async function ensureTunnel(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly tunnelName: string;
    readonly tunnelId: string;
    readonly daemonHostname: string;
    readonly tunnelServiceUrl: string;
    readonly persist: boolean;
    readonly returnGeneratedSecrets: boolean;
    readonly steps: CloudflareProvisionStep[];
  },
): Promise<{ readonly id: string; readonly name: string; readonly token?: string; readonly tokenRef?: string }> {
  const api = client.zeroTrust?.tunnels?.cloudflared;
  if (!api) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose Zero Trust Tunnel APIs.', 'CLOUDFLARE_TUNNEL_API_UNAVAILABLE', 500);
  }
  let tunnel: CloudflareTunnelLike | undefined;
  if (input.tunnelId) {
    tunnel = { id: input.tunnelId, name: input.tunnelName };
  } else {
    for await (const existing of api.list({ account_id: input.accountId, name: input.tunnelName, is_deleted: false })) {
      if (existing.name === input.tunnelName) {
        tunnel = existing;
        break;
      }
    }
    if (!tunnel) {
      try {
        tunnel = await api.create({ account_id: input.accountId, name: input.tunnelName, config_src: 'cloudflare' });
        input.steps.push({ name: 'zero-trust-tunnel', status: 'ok', message: `Created Zero Trust Tunnel ${input.tunnelName}.`, resourceId: tunnel.id });
      } catch (error: unknown) {
        tunnel = await findTunnelByName(client, input.accountId, input.tunnelName);
        if (!tunnel) throw error;
        input.steps.push({ name: 'zero-trust-tunnel', status: 'ok', message: `Using existing Zero Trust Tunnel ${input.tunnelName} after create retry: ${summarizeError(error)}`, resourceId: tunnel.id });
      }
    } else {
      input.steps.push({ name: 'zero-trust-tunnel', status: 'ok', message: `Using existing Zero Trust Tunnel ${input.tunnelName}.`, resourceId: tunnel.id });
    }
  }
  if (!tunnel.id) {
    throw new CloudflareControlPlaneError(`Zero Trust Tunnel '${input.tunnelName}' did not include an id.`, 'CLOUDFLARE_TUNNEL_ID_MISSING', 502);
  }
  if (input.daemonHostname && input.tunnelServiceUrl) {
    await api.configurations.update(tunnel.id, {
      account_id: input.accountId,
      config: {
        ingress: [
          { hostname: input.daemonHostname, service: input.tunnelServiceUrl },
          { service: 'http_status:404' },
        ],
      },
    });
    input.steps.push({ name: 'zero-trust-tunnel-config', status: 'ok', message: `Configured Tunnel ingress for ${input.daemonHostname}.` });
  } else {
    input.steps.push({ name: 'zero-trust-tunnel-config', status: 'warning', message: 'Tunnel was created but no daemonHostname/tunnelServiceUrl was available for ingress configuration.' });
  }
  const token = await api.token.get(tunnel.id, { account_id: input.accountId });
  await context.storeSecret(CLOUDFLARE_TUNNEL_TOKEN_KEY, token);
  const tokenRef = `goodvibes://secrets/goodvibes/${CLOUDFLARE_TUNNEL_TOKEN_KEY}`;
  context.setConfig('cloudflare.tunnelName', input.tunnelName, input.persist);
  context.setConfig('cloudflare.tunnelId', tunnel.id, input.persist);
  context.setConfig('cloudflare.tunnelTokenRef', tokenRef, input.persist);
  input.steps.push({ name: 'zero-trust-tunnel-token', status: 'ok', message: 'Stored Tunnel token in the GoodVibes secret store.' });
  return { id: tunnel.id, name: tunnel.name ?? input.tunnelName, ...(input.returnGeneratedSecrets ? { token } : {}), tokenRef };
}

export async function ensureAccess(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly daemonHostname: string;
    readonly accessAppId: string;
    readonly accessServiceTokenId: string;
    readonly accessServiceTokenRef: string;
    readonly zone?: CloudflareZoneLike | undefined;
    readonly persist: boolean;
    readonly returnGeneratedSecrets: boolean;
    readonly steps: CloudflareProvisionStep[];
  },
): Promise<{ readonly appId?: string; readonly serviceTokenId?: string; readonly serviceTokenRef?: string; readonly clientId?: string; readonly clientSecret?: string }> {
  const api = client.zeroTrust?.access;
  if (!api) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose Zero Trust Access APIs.', 'CLOUDFLARE_ACCESS_API_UNAVAILABLE', 500);
  }
  let serviceToken: CloudflareAccessServiceTokenLike | undefined = input.accessServiceTokenId ? { id: input.accessServiceTokenId } : undefined;
  if (!serviceToken) {
    for await (const existing of api.serviceTokens.list({ account_id: input.accountId, name: 'GoodVibes Daemon' })) {
      if (existing.name === 'GoodVibes Daemon') {
        serviceToken = existing;
        break;
      }
    }
  }
  if (!serviceToken) {
    try {
      serviceToken = await api.serviceTokens.create({ account_id: input.accountId, name: 'GoodVibes Daemon', duration: '8760h' });
      input.steps.push({ name: 'zero-trust-access-service-token', status: 'ok', message: 'Created Zero Trust Access service token.', resourceId: serviceToken.id });
    } catch (error: unknown) {
      serviceToken = await findAccessServiceTokenByName(api, input.accountId, 'GoodVibes Daemon');
      if (!serviceToken) throw error;
      input.steps.push({ name: 'zero-trust-access-service-token', status: 'ok', message: `Using existing Zero Trust Access service token after create retry: ${summarizeError(error)}`, resourceId: serviceToken.id });
    }
  } else {
    input.steps.push({ name: 'zero-trust-access-service-token', status: 'ok', message: 'Using existing Zero Trust Access service token.', resourceId: serviceToken.id });
  }
  let serviceTokenRef: string | undefined = input.accessServiceTokenRef || undefined;
  if (serviceToken.client_id && serviceToken.client_secret) {
    await context.storeSecret(CLOUDFLARE_ACCESS_SERVICE_TOKEN_KEY, JSON.stringify({
      clientId: serviceToken.client_id,
      clientSecret: serviceToken.client_secret,
    }));
    serviceTokenRef = `goodvibes://secrets/goodvibes/${CLOUDFLARE_ACCESS_SERVICE_TOKEN_KEY}`;
    context.setConfig('cloudflare.accessServiceTokenRef', serviceTokenRef, input.persist);
    input.steps.push({ name: 'zero-trust-access-service-token-secret', status: 'ok', message: 'Stored Access service token credentials in the GoodVibes secret store.' });
  } else if (serviceTokenRef) {
    context.setConfig('cloudflare.accessServiceTokenRef', serviceTokenRef, input.persist);
    input.steps.push({ name: 'zero-trust-access-service-token-secret', status: 'ok', message: 'Using configured Access service token secret reference.' });
  }
  if (serviceToken.id) context.setConfig('cloudflare.accessServiceTokenId', serviceToken.id, input.persist);

  if (!input.daemonHostname || !serviceToken.id) {
    input.steps.push({ name: 'zero-trust-access-app', status: 'warning', message: 'Access application was skipped because daemonHostname or service token id is missing.' });
    return {
      ...(serviceToken.id ? { serviceTokenId: serviceToken.id } : {}),
      ...(serviceTokenRef ? { serviceTokenRef } : {}),
      ...(serviceToken.client_id && input.returnGeneratedSecrets ? { clientId: serviceToken.client_id } : {}),
      ...(serviceToken.client_secret && input.returnGeneratedSecrets ? { clientSecret: serviceToken.client_secret } : {}),
    };
  }
  if (!input.zone && isPlaceholderHostname(input.daemonHostname)) {
    input.steps.push({ name: 'zero-trust-access-app', status: 'warning', message: `Access application was skipped because daemonHostname ${input.daemonHostname} is a placeholder hostname.` });
    return {
      ...(serviceToken.id ? { serviceTokenId: serviceToken.id } : {}),
      ...(serviceTokenRef ? { serviceTokenRef } : {}),
      ...(serviceToken.client_id && input.returnGeneratedSecrets ? { clientId: serviceToken.client_id } : {}),
      ...(serviceToken.client_secret && input.returnGeneratedSecrets ? { clientSecret: serviceToken.client_secret } : {}),
    };
  }
  if (input.zone && !hostnameBelongsToZone(input.daemonHostname, input.zone.name)) {
    input.steps.push({ name: 'zero-trust-access-app', status: 'warning', message: `Access application was skipped because daemonHostname ${input.daemonHostname} does not belong to selected zone ${input.zone.name}.` });
    return {
      ...(serviceToken.id ? { serviceTokenId: serviceToken.id } : {}),
      ...(serviceTokenRef ? { serviceTokenRef } : {}),
      ...(serviceToken.client_id && input.returnGeneratedSecrets ? { clientId: serviceToken.client_id } : {}),
      ...(serviceToken.client_secret && input.returnGeneratedSecrets ? { clientSecret: serviceToken.client_secret } : {}),
    };
  }

  let app: CloudflareAccessApplicationLike | undefined = input.accessAppId ? { id: input.accessAppId } : undefined;
  if (!app) {
    for await (const existing of api.applications.list({ account_id: input.accountId, domain: input.daemonHostname, exact: true })) {
      if (existing.domain === input.daemonHostname) {
        app = existing;
        break;
      }
    }
  }
  const accessAppParams = {
    account_id: input.accountId,
    domain: input.daemonHostname,
    type: 'self_hosted',
    name: 'GoodVibes Daemon',
    session_duration: '24h',
    service_auth_401_redirect: true,
    policies: [
      {
        name: 'GoodVibes service token',
        decision: 'non_identity',
        include: [{ service_token: { token_id: serviceToken.id } }],
      },
    ],
  };
  if (app?.id) {
    app = await api.applications.update(app.id, accessAppParams);
  } else {
    try {
      app = await api.applications.create(accessAppParams);
    } catch (error: unknown) {
      const recovered = await findAccessApplicationByDomain(api, input.accountId, input.daemonHostname);
      if (!recovered?.id) throw error;
      app = await api.applications.update(recovered.id, accessAppParams);
    }
  }
  if (app.id) context.setConfig('cloudflare.accessAppId', app.id, input.persist);
  input.steps.push({ name: 'zero-trust-access-app', status: 'ok', message: `Configured Zero Trust Access application for ${input.daemonHostname}.`, resourceId: app.id });
  return {
    ...(app.id ? { appId: app.id } : {}),
    ...(serviceToken.id ? { serviceTokenId: serviceToken.id } : {}),
    ...(serviceTokenRef ? { serviceTokenRef } : {}),
    ...(serviceToken.client_id && input.returnGeneratedSecrets ? { clientId: serviceToken.client_id } : {}),
    ...(serviceToken.client_secret && input.returnGeneratedSecrets ? { clientSecret: serviceToken.client_secret } : {}),
  };
}

export async function configureDns(
  client: CloudflareApiClient,
  input: {
    readonly enabled: boolean;
    readonly zone?: CloudflareZoneLike | undefined;
    readonly daemonHostname: string;
    readonly tunnelId: string;
    readonly workerHostname: string;
    readonly workerBaseUrl: string;
    readonly steps: CloudflareProvisionStep[];
  },
): Promise<readonly CloudflareDnsRecordLike[]> {
  if (!input.enabled) return [];
  if (!client.dns) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose DNS record APIs.', 'CLOUDFLARE_DNS_API_UNAVAILABLE', 500);
  }
  if (!input.zone) {
    input.steps.push({ name: 'dns', status: 'warning', message: 'DNS automation skipped because no Cloudflare zone was selected.' });
    return [];
  }
  const records: CloudflareDnsRecordLike[] = [];
  if (input.daemonHostname && input.tunnelId) {
    if (hostnameBelongsToZone(input.daemonHostname, input.zone.name)) {
      records.push(await ensureCnameRecord(client, input.zone.id, input.daemonHostname, `${input.tunnelId}.cfargotunnel.com`, input.steps, 'dns-daemon-hostname'));
    } else {
      input.steps.push({ name: 'dns-daemon-hostname', status: 'warning', message: `Skipped daemon DNS record because ${input.daemonHostname} does not belong to selected zone ${input.zone.name}.` });
    }
  }
  const workerTarget = hostnameFromUrl(input.workerBaseUrl);
  if (input.workerHostname && workerTarget) {
    if (hostnameBelongsToZone(input.workerHostname, input.zone.name)) {
      records.push(await ensureCnameRecord(client, input.zone.id, input.workerHostname, workerTarget, input.steps, 'dns-worker-hostname'));
    } else {
      input.steps.push({ name: 'dns-worker-hostname', status: 'warning', message: `Skipped Worker DNS record because ${input.workerHostname} does not belong to selected zone ${input.zone.name}.` });
    }
  }
  if (records.length === 0) input.steps.push({ name: 'dns', status: 'skipped', message: 'No daemonHostname/tunnelId or workerHostname/workerBaseUrl pair was available for DNS automation.' });
  return records;
}

export async function findDurableObjectNamespace(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  accountId: string,
  namespaceName: string,
  persist: boolean,
  steps: CloudflareProvisionStep[],
): Promise<CloudflareDurableObjectNamespaceLike | undefined> {
  if (!client.durableObjects) {
    steps.push({ name: 'durable-object-namespace', status: 'warning', message: 'Durable Object namespace binding was installed on the Worker, but the client cannot list namespaces for confirmation.' });
    return { name: namespaceName };
  }
  for await (const namespace of client.durableObjects.namespaces.list({ account_id: accountId })) {
    if (namespace.name === namespaceName || namespace.class === namespaceName) {
      context.setConfig('cloudflare.durableObjectNamespaceName', namespaceName, persist);
      if (namespace.id) context.setConfig('cloudflare.durableObjectNamespaceId', namespace.id, persist);
      steps.push({ name: 'durable-object-namespace', status: 'ok', message: `Confirmed Durable Object namespace ${namespaceName}.`, resourceId: namespace.id });
      return namespace;
    }
  }
  steps.push({ name: 'durable-object-namespace', status: 'warning', message: 'Durable Object migration was included, but the namespace was not visible yet during confirmation.' });
  return { name: namespaceName };
}

export async function ensureQueueConsumer(
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly queueId: string;
    readonly workerName: string;
    readonly deadLetterQueueName: string;
    readonly steps: CloudflareProvisionStep[];
  },
): Promise<CloudflareConsumerLike> {
  const settings = {
    batch_size: 10,
    max_retries: 3,
    max_wait_time_ms: 5000,
    retry_delay: 60,
  };
  for await (const consumer of client.queues.consumers.list(input.queueId, { account_id: input.accountId })) {
    if (consumer.type === 'worker' && consumer.script === input.workerName && consumer.consumer_id) {
      const updated = await client.queues.consumers.update(input.queueId, consumer.consumer_id, {
        account_id: input.accountId,
        type: 'worker',
        script_name: input.workerName,
        dead_letter_queue: input.deadLetterQueueName,
        settings,
      });
      input.steps.push({ name: 'queue-consumer', status: 'ok', message: `Updated Queue consumer for ${input.workerName}.`, resourceId: updated.consumer_id });
      return updated;
    }
  }
  try {
    const created = await client.queues.consumers.create(input.queueId, {
      account_id: input.accountId,
      type: 'worker',
      script_name: input.workerName,
      dead_letter_queue: input.deadLetterQueueName,
      settings,
    });
    input.steps.push({ name: 'queue-consumer', status: 'ok', message: `Created Queue consumer for ${input.workerName}.`, resourceId: created.consumer_id });
    return created;
  } catch (error: unknown) {
    const recovered = await findQueueConsumer(client, input.accountId, input.queueId, input.workerName);
    if (!recovered?.consumer_id) throw error;
    const updated = await client.queues.consumers.update(input.queueId, recovered.consumer_id, {
      account_id: input.accountId,
      type: 'worker',
      script_name: input.workerName,
      dead_letter_queue: input.deadLetterQueueName,
      settings,
    });
    input.steps.push({ name: 'queue-consumer', status: 'ok', message: `Updated existing Queue consumer for ${input.workerName} after create retry: ${summarizeError(error)}`, resourceId: updated.consumer_id });
    return updated;
  }
}

async function ensureCnameRecord(
  client: CloudflareApiClient,
  zoneId: string,
  hostname: string,
  target: string,
  steps: CloudflareProvisionStep[],
  stepName: string,
): Promise<CloudflareDnsRecordLike> {
  const existing = await collectAsync(client.dns!.records.list({ zone_id: zoneId, type: 'CNAME', name: { exact: hostname } }));
  const match = existing.find((record) => record.name === hostname && record.type === 'CNAME');
  const params = {
    zone_id: zoneId,
    type: 'CNAME' as const,
    name: hostname,
    content: target,
    proxied: true,
    ttl: 1,
    comment: 'Managed by GoodVibes SDK Cloudflare provisioning',
  };
  if (match?.id) {
    const updated = await client.dns!.records.update(match.id, params);
    steps.push({ name: stepName, status: 'ok', message: `Updated CNAME ${hostname} -> ${target}.`, resourceId: updated.id });
    return updated;
  }
  try {
    const created = await client.dns!.records.create(params);
    steps.push({ name: stepName, status: 'ok', message: `Created CNAME ${hostname} -> ${target}.`, resourceId: created.id });
    return created;
  } catch (error: unknown) {
    const recovered = await findCnameRecord(client, zoneId, hostname);
    if (!recovered?.id) throw error;
    const updated = await client.dns!.records.update(recovered.id, params);
    steps.push({ name: stepName, status: 'ok', message: `Updated existing CNAME ${hostname} -> ${target} after create retry: ${summarizeError(error)}`, resourceId: updated.id });
    return updated;
  }
}

async function findQueueByName(
  client: CloudflareApiClient,
  accountId: string,
  queueName: string,
): Promise<CloudflareQueueLike | undefined> {
  for await (const queue of client.queues.list({ account_id: accountId })) {
    if (queue.queue_name === queueName) return queue;
  }
  return undefined;
}

async function findKvNamespace(
  client: CloudflareApiClient,
  accountId: string,
  namespaceName: string,
  namespaceId: string,
): Promise<CloudflareKvNamespaceLike | undefined> {
  for await (const namespace of client.kv!.namespaces.list({ account_id: accountId })) {
    if (namespace.title === namespaceName || (namespaceId && namespace.id === namespaceId)) return namespace;
  }
  return undefined;
}

function persistKvNamespace(
  context: CloudflareProvisioningContext,
  namespace: CloudflareKvNamespaceLike,
  namespaceName: string,
  persist: boolean,
): void {
  context.setConfig('cloudflare.kvNamespaceName', namespace.title ?? namespaceName, persist);
  if (namespace.id) context.setConfig('cloudflare.kvNamespaceId', namespace.id, persist);
}

async function findR2BucketByName(
  client: CloudflareApiClient,
  accountId: string,
  bucketName: string,
): Promise<CloudflareR2BucketLike | undefined> {
  const listed = (await client.r2!.buckets.list({ account_id: accountId })).buckets?.find((bucket) => bucket.name === bucketName);
  if (listed) return listed;
  if (!client.r2!.buckets.get) return undefined;
  try {
    const bucket = await client.r2!.buckets.get(bucketName, { account_id: accountId });
    return bucket.name ? bucket : { ...bucket, name: bucketName };
  } catch {
    return undefined;
  }
}

async function findSecretsStore(
  client: CloudflareApiClient,
  accountId: string,
  storeName: string,
  storeId: string,
): Promise<CloudflareSecretsStoreLike | undefined> {
  for await (const store of client.secretsStore!.stores.list({ account_id: accountId })) {
    if (store.name === storeName || (storeId && store.id === storeId)) return store;
  }
  return undefined;
}

async function findRecoverableSecretsStore(
  client: CloudflareApiClient,
  accountId: string,
  storeName: string,
  storeId: string,
  error: unknown,
): Promise<CloudflareSecretsStoreLike | undefined> {
  const stores = await collectAsync(client.secretsStore!.stores.list({ account_id: accountId }));
  const exact = stores.find((store) => store.name === storeName || (storeId && store.id === storeId));
  if (exact) return exact;
  if (isMaximumStoresExceeded(error) && stores.length === 1) return stores[0];
  return undefined;
}

function persistSecretsStore(
  context: CloudflareProvisioningContext,
  store: CloudflareSecretsStoreLike,
  persist: boolean,
): void {
  context.setConfig('cloudflare.secretsStoreName', store.name, persist);
  context.setConfig('cloudflare.secretsStoreId', store.id, persist);
}

function isMaximumStoresExceeded(error: unknown): boolean {
  return summarizeError(error).toLowerCase().includes('maximum_stores_exceeded');
}

async function findTunnelByName(
  client: CloudflareApiClient,
  accountId: string,
  tunnelName: string,
): Promise<CloudflareTunnelLike | undefined> {
  const api = client.zeroTrust!.tunnels!.cloudflared;
  for await (const tunnel of api.list({ account_id: accountId, name: tunnelName, is_deleted: false })) {
    if (tunnel.name === tunnelName) return tunnel;
  }
  return undefined;
}

type CloudflareAccessApi = NonNullable<NonNullable<CloudflareApiClient['zeroTrust']>['access']>;

async function findAccessServiceTokenByName(
  api: CloudflareAccessApi,
  accountId: string,
  name: string,
): Promise<CloudflareAccessServiceTokenLike | undefined> {
  for await (const token of api.serviceTokens.list({ account_id: accountId, name })) {
    if (token.name === name) return token;
  }
  return undefined;
}

async function findAccessApplicationByDomain(
  api: CloudflareAccessApi,
  accountId: string,
  domain: string,
): Promise<CloudflareAccessApplicationLike | undefined> {
  for await (const app of api.applications.list({ account_id: accountId, domain, exact: true })) {
    if (app.domain === domain) return app;
  }
  return undefined;
}

async function findQueueConsumer(
  client: CloudflareApiClient,
  accountId: string,
  queueId: string,
  workerName: string,
): Promise<CloudflareConsumerLike | undefined> {
  for await (const consumer of client.queues.consumers.list(queueId, { account_id: accountId })) {
    if (consumer.type === 'worker' && consumer.script === workerName) return consumer;
  }
  return undefined;
}

async function findCnameRecord(
  client: CloudflareApiClient,
  zoneId: string,
  hostname: string,
): Promise<CloudflareDnsRecordLike | undefined> {
  const existing = await collectAsync(client.dns!.records.list({ zone_id: zoneId, type: 'CNAME', name: { exact: hostname } }));
  return existing.find((record) => record.name === hostname && record.type === 'CNAME');
}
