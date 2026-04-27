import type { ConfigKey } from '../config/schema.js';
import { summarizeError } from '../utils/error-display.js';
import {
  CLOUDFLARE_ACCESS_SERVICE_TOKEN_KEY,
  CLOUDFLARE_TUNNEL_TOKEN_KEY,
  DEFAULT_DO_NAMESPACE_NAME,
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
import { clean, collectAsync, hostnameFromUrl } from './utils.js';
import { GOODVIBES_CLOUDFLARE_WORKER_MODULE } from './worker-source.js';

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
  for await (const queue of client.queues.list({ account_id: accountId })) {
    if (queue.queue_name === queueName) {
      steps.push({ name: stepName, status: 'ok', message: `Using existing Cloudflare Queue ${queueName}.`, resourceId: queue.queue_id });
      return queue;
    }
  }
  const created = await client.queues.create({ account_id: accountId, queue_name: queueName });
  steps.push({ name: stepName, status: 'ok', message: `Created Cloudflare Queue ${queueName}.`, resourceId: created.queue_id });
  return created;
}

export async function ensureKvNamespace(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  accountId: string,
  namespaceName: string,
  persist: boolean,
  steps: CloudflareProvisionStep[],
): Promise<CloudflareKvNamespaceLike> {
  if (!client.kv) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose KV namespace APIs.', 'CLOUDFLARE_KV_API_UNAVAILABLE', 500);
  }
  for await (const namespace of client.kv.namespaces.list({ account_id: accountId })) {
    if (namespace.title === namespaceName) {
      context.setConfig('cloudflare.kvNamespaceName', namespaceName, persist);
      if (namespace.id) context.setConfig('cloudflare.kvNamespaceId', namespace.id, persist);
      steps.push({ name: 'kv-namespace', status: 'ok', message: `Using existing KV namespace ${namespaceName}.`, resourceId: namespace.id });
      return namespace;
    }
  }
  const created = await client.kv.namespaces.create({ account_id: accountId, title: namespaceName });
  context.setConfig('cloudflare.kvNamespaceName', namespaceName, persist);
  if (created.id) context.setConfig('cloudflare.kvNamespaceId', created.id, persist);
  steps.push({ name: 'kv-namespace', status: 'ok', message: `Created KV namespace ${namespaceName}.`, resourceId: created.id });
  return created;
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
  const existing = (await client.r2.buckets.list({ account_id: accountId })).buckets?.find((bucket) => bucket.name === bucketName);
  if (existing) {
    context.setConfig('cloudflare.r2BucketName', bucketName, persist);
    steps.push({ name: 'r2-bucket', status: 'ok', message: `Using existing R2 Standard bucket ${bucketName}.`, resourceId: bucketName });
    return existing;
  }
  const created = await client.r2.buckets.create({ account_id: accountId, name: bucketName, storageClass: 'Standard' });
  context.setConfig('cloudflare.r2BucketName', bucketName, persist);
  steps.push({ name: 'r2-bucket', status: 'ok', message: `Created R2 Standard bucket ${bucketName}.`, resourceId: bucketName });
  return created.name ? created : { ...created, name: bucketName, storage_class: 'Standard' };
}

export async function ensureSecretsStore(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  accountId: string,
  storeName: string,
  persist: boolean,
  steps: CloudflareProvisionStep[],
): Promise<CloudflareSecretsStoreLike> {
  if (!client.secretsStore) {
    throw new CloudflareControlPlaneError('The Cloudflare client does not expose Secrets Store APIs.', 'CLOUDFLARE_SECRETS_STORE_API_UNAVAILABLE', 500);
  }
  for await (const store of client.secretsStore.stores.list({ account_id: accountId })) {
    if (store.name === storeName) {
      context.setConfig('cloudflare.secretsStoreName', storeName, persist);
      context.setConfig('cloudflare.secretsStoreId', store.id, persist);
      steps.push({ name: 'secrets-store', status: 'ok', message: `Using existing Cloudflare Secrets Store ${storeName}.`, resourceId: store.id });
      return store;
    }
  }
  for await (const created of client.secretsStore.stores.create({ account_id: accountId, body: [{ name: storeName }] })) {
    context.setConfig('cloudflare.secretsStoreName', storeName, persist);
    context.setConfig('cloudflare.secretsStoreId', created.id, persist);
    steps.push({ name: 'secrets-store', status: 'ok', message: `Created Cloudflare Secrets Store ${storeName}.`, resourceId: created.id });
    return created;
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
      tunnel = await api.create({ account_id: input.accountId, name: input.tunnelName, config_src: 'cloudflare' });
      input.steps.push({ name: 'zero-trust-tunnel', status: 'ok', message: `Created Zero Trust Tunnel ${input.tunnelName}.`, resourceId: tunnel.id });
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
    serviceToken = await api.serviceTokens.create({ account_id: input.accountId, name: 'GoodVibes Daemon', duration: '8760h' });
    input.steps.push({ name: 'zero-trust-access-service-token', status: 'ok', message: 'Created Zero Trust Access service token.', resourceId: serviceToken.id });
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
  app = app?.id
    ? await api.applications.update(app.id, accessAppParams)
    : await api.applications.create(accessAppParams);
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
    readonly zone?: CloudflareZoneLike;
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
    records.push(await ensureCnameRecord(client, input.zone.id, input.daemonHostname, `${input.tunnelId}.cfargotunnel.com`, input.steps, 'dns-daemon-hostname'));
  }
  const workerTarget = hostnameFromUrl(input.workerBaseUrl);
  if (input.workerHostname && workerTarget) {
    records.push(await ensureCnameRecord(client, input.zone.id, input.workerHostname, workerTarget, input.steps, 'dns-worker-hostname'));
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

export async function uploadWorker(
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly workerName: string;
    readonly queueName: string;
    readonly daemonBaseUrl: string;
    readonly queueJobPayloads: boolean;
    readonly kvNamespaceId: string;
    readonly r2BucketName: string;
    readonly durableObject: boolean;
  },
): Promise<void> {
  const file = new File(
    [GOODVIBES_CLOUDFLARE_WORKER_MODULE],
    'goodvibes-cloudflare-worker.mjs',
    { type: 'application/javascript+module' },
  );
  const bindings: Record<string, unknown>[] = [
    ...(input.queueName ? [{ type: 'queue', name: 'GOODVIBES_BATCH_QUEUE', queue_name: input.queueName }] : []),
    { type: 'plain_text', name: 'GOODVIBES_DAEMON_URL', text: input.daemonBaseUrl },
    { type: 'plain_text', name: 'GOODVIBES_QUEUE_JOB_PAYLOADS', text: input.queueJobPayloads ? 'true' : 'false' },
    ...(input.kvNamespaceId ? [{ type: 'kv_namespace', name: 'GOODVIBES_KV', namespace_id: input.kvNamespaceId }] : []),
    ...(input.r2BucketName ? [{ type: 'r2_bucket', name: 'GOODVIBES_ARTIFACTS', bucket_name: input.r2BucketName }] : []),
    ...(input.durableObject ? [{ type: 'durable_object_namespace', name: 'GOODVIBES_COORDINATOR', class_name: DEFAULT_DO_NAMESPACE_NAME }] : []),
  ];
  await client.workers.scripts.update(input.workerName, {
    account_id: input.accountId,
    metadata: {
      main_module: 'goodvibes-cloudflare-worker.mjs',
      compatibility_date: '2026-04-25',
      bindings,
      ...(input.durableObject ? { migrations: { tag: 'goodvibes-coordinator-v1', new_sqlite_classes: [DEFAULT_DO_NAMESPACE_NAME] } } : {}),
      keep_bindings: ['secret_text'],
    },
    files: [file],
  });
}

export async function configureWorkerSubdomain(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly workerName: string;
    readonly requestedSubdomain?: string;
    readonly enableWorkersDev: boolean;
    readonly steps: CloudflareProvisionStep[];
    readonly persist: boolean;
  },
): Promise<string> {
  if (!input.enableWorkersDev) {
    input.steps.push({ name: 'worker-subdomain', status: 'skipped', message: 'workers.dev subdomain enablement was skipped.' });
    return clean(input.requestedSubdomain) || context.readConfig().workerSubdomain;
  }

  let accountSubdomain = clean(input.requestedSubdomain) || context.readConfig().workerSubdomain;
  if (accountSubdomain) {
    const updated = await client.workers.subdomains.update({ account_id: input.accountId, subdomain: accountSubdomain });
    accountSubdomain = updated.subdomain;
    context.setConfig('cloudflare.workerSubdomain', accountSubdomain, input.persist);
    input.steps.push({ name: 'account-worker-subdomain', status: 'ok', message: `Configured account workers.dev subdomain ${accountSubdomain}.` });
  } else {
    try {
      const existing = await client.workers.subdomains.get({ account_id: input.accountId });
      accountSubdomain = existing.subdomain;
      context.setConfig('cloudflare.workerSubdomain', accountSubdomain, input.persist);
      input.steps.push({ name: 'account-worker-subdomain', status: 'ok', message: `Using account workers.dev subdomain ${accountSubdomain}.` });
    } catch (error: unknown) {
      input.steps.push({
        name: 'account-worker-subdomain',
        status: 'warning',
        message: `Could not read account workers.dev subdomain: ${summarizeError(error)}`,
      });
    }
  }

  await client.workers.scripts.subdomain.create(input.workerName, {
    account_id: input.accountId,
    enabled: true,
    previews_enabled: false,
  });
  input.steps.push({ name: 'worker-subdomain', status: 'ok', message: `Enabled workers.dev route for ${input.workerName}.` });
  return accountSubdomain;
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
  const created = await client.queues.consumers.create(input.queueId, {
    account_id: input.accountId,
    type: 'worker',
    script_name: input.workerName,
    dead_letter_queue: input.deadLetterQueueName,
    settings,
  });
  input.steps.push({ name: 'queue-consumer', status: 'ok', message: `Created Queue consumer for ${input.workerName}.`, resourceId: created.consumer_id });
  return created;
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
  const created = await client.dns!.records.create(params);
  steps.push({ name: stepName, status: 'ok', message: `Created CNAME ${hostname} -> ${target}.`, resourceId: created.id });
  return created;
}
