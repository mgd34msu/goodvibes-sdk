import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../packages/sdk/src/_internal/platform/config/manager.js';
import { CloudflareControlPlaneManager } from '../packages/sdk/src/_internal/platform/cloudflare/manager.js';
import type {
  CloudflareApiClient,
  CloudflareConsumerLike,
  CloudflareDnsRecordLike,
  CloudflareDurableObjectNamespaceLike,
  CloudflareKvNamespaceLike,
  CloudflarePermissionGroupLike,
  CloudflareQueueLike,
  CloudflareR2BucketLike,
  CloudflareSecretsStoreLike,
  CloudflareTunnelLike,
  CloudflareTokenPolicyParam,
  CloudflareZoneLike,
} from '../packages/sdk/src/_internal/platform/cloudflare/types.js';

function makeConfigManager(): ConfigManager {
  const configDir = join(tmpdir(), `gv-cloudflare-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(configDir, { recursive: true });
  return new ConfigManager({ configDir });
}

function makeSecrets(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };
  return {
    values,
    async get(key: string): Promise<string | null> {
      return values[key] ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      values[key] = value;
    },
    getGlobalHome(): string {
      return tmpdir();
    },
  };
}

async function* items<T>(entries: readonly T[]): AsyncIterable<T> {
  for (const entry of entries) yield entry;
}

function hasTokenResource(policies: readonly CloudflareTokenPolicyParam[], resource: string): boolean {
  return policies.some((policy) => policy.resources[resource] !== undefined);
}

function tokenPolicyForResource(policies: readonly CloudflareTokenPolicyParam[], resource: string): CloudflareTokenPolicyParam | undefined {
  return policies.find((policy) => policy.resources[resource] !== undefined);
}

function makeCloudflareClient() {
  const queues: CloudflareQueueLike[] = [];
  const consumers: CloudflareConsumerLike[] = [];
  const zones: CloudflareZoneLike[] = [{ id: 'zone-1', name: 'example.com', status: 'active', type: 'full' }];
  const dnsRecords: CloudflareDnsRecordLike[] = [];
  const kvNamespaces: CloudflareKvNamespaceLike[] = [];
  const durableObjectNamespaces: CloudflareDurableObjectNamespaceLike[] = [{ id: 'do-1', name: 'GoodVibesCoordinator', class: 'GoodVibesCoordinator', script: 'goodvibes-batch-worker', use_sqlite: true }];
  const r2Buckets: CloudflareR2BucketLike[] = [];
  const secretsStores: CloudflareSecretsStoreLike[] = [];
  const tunnels: CloudflareTunnelLike[] = [];
  const accessServiceTokens: Array<{ id: string; name: string; client_id?: string; client_secret?: string }> = [];
  const accessApplications: Array<{ id: string; name: string; domain: string; type: string }> = [];
  const enabledScriptSubdomains = new Set<string>();
  let lastTokenPolicies: readonly CloudflareTokenPolicyParam[] = [];
  const calls = {
    tokenCreates: [] as Array<{ readonly name: string; readonly policies: readonly CloudflareTokenPolicyParam[] }>,
    queueCreates: [] as string[],
    kvCreates: [] as string[],
    r2Creates: [] as string[],
    secretsStoreCreates: [] as string[],
    tunnelCreates: [] as string[],
    accessServiceTokenCreates: [] as string[],
    workerUpdates: [] as Array<{ readonly scriptName: string; readonly metadata: Record<string, unknown> }>,
    secretUpdates: [] as Array<{ readonly scriptName: string; readonly name: string; readonly text: string }>,
    scheduleUpdates: [] as Array<{ readonly scriptName: string; readonly crons: readonly string[] }>,
    consumerCreates: [] as Array<{ readonly queueId: string; readonly scriptName: string; readonly deadLetterQueue?: string }>,
    scriptSubdomains: [] as string[],
    dnsCreates: [] as CloudflareDnsRecordLike[],
    tunnelConfigUpdates: [] as Array<{ readonly tunnelId: string; readonly config: Record<string, unknown> }>,
    accessAppCreates: [] as Record<string, unknown>[],
  };

  const client: CloudflareApiClient = {
    accounts: {
      list() {
        return items([{ id: 'acct-1', name: 'GoodVibes Test', type: 'standard' }]);
      },
      async get(params) {
        return { id: params.account_id, name: 'GoodVibes Test', type: 'standard' };
      },
    },
    user: {
      tokens: {
        async create(params) {
          lastTokenPolicies = params.policies;
          calls.tokenCreates.push({ name: params.name, policies: params.policies });
          return { id: 'token-1', name: params.name, value: 'operational-token', policies: params.policies };
        },
        async get(tokenId) {
          return { id: tokenId, name: 'GoodVibes Cloudflare Operational', policies: lastTokenPolicies };
        },
        async verify() {
          return { id: 'user-token', status: 'active' };
        },
        permissionGroups: {
          list() {
            return items([
              { id: 'pg-workers', name: 'Workers Scripts Write', scopes: ['com.cloudflare.api.account'] },
              { id: 'pg-queues', name: 'Queues Write', scopes: ['com.cloudflare.api.account'] },
              { id: 'pg-zone-read', name: 'Zone Read', scopes: ['com.cloudflare.api.account.zone'] },
              { id: 'pg-dns', name: 'DNS Write', scopes: ['com.cloudflare.api.account.zone'] },
              { id: 'pg-kv', name: 'Workers KV Storage Write', scopes: ['com.cloudflare.api.account'] },
              { id: 'pg-r2', name: 'Workers R2 Storage Write', scopes: ['com.cloudflare.api.account'] },
              { id: 'pg-tunnel', name: 'Cloudflare Tunnel Write', scopes: ['com.cloudflare.api.account'] },
              { id: 'pg-access-apps', name: 'Access: Apps and Policies Write', scopes: ['com.cloudflare.api.account'] },
              { id: 'pg-access-tokens', name: 'Access: Service Tokens Write', scopes: ['com.cloudflare.api.account'] },
              { id: 'pg-secrets', name: 'Account Secrets Store Edit', scopes: ['com.cloudflare.api.account'] },
            ]);
          },
        },
      },
    },
    zones: {
      list(params) {
        const filtered = zones.filter((zone) => !params?.name || zone.name === params.name);
        return items(filtered);
      },
      async get(params) {
        const zone = zones.find((entry) => entry.id === params.zone_id);
        if (!zone) throw new Error(`missing zone ${params.zone_id}`);
        return zone;
      },
    },
    dns: {
      records: {
        async create(params) {
          const record = {
            id: `dns-${params.name}`,
            name: params.name,
            type: params.type,
            content: params.content,
            proxied: params.proxied,
            ttl: params.ttl,
          };
          dnsRecords.push(record);
          calls.dnsCreates.push(record);
          return record;
        },
        async update(recordId, params) {
          const record = {
            id: recordId,
            name: params.name,
            type: params.type,
            content: params.content,
            proxied: params.proxied,
            ttl: params.ttl,
          };
          return record;
        },
        list(params) {
          return items(dnsRecords.filter((record) => record.type === params.type));
        },
      },
    },
    queues: {
      async create(params) {
        calls.queueCreates.push(params.queue_name);
        const queue = { queue_id: `queue-${params.queue_name}`, queue_name: params.queue_name };
        queues.push(queue);
        return queue;
      },
      list() {
        return items(queues);
      },
      async get(queueId) {
        const queue = queues.find((entry) => entry.queue_id === queueId);
        if (!queue) throw new Error(`missing queue ${queueId}`);
        return queue;
      },
      consumers: {
        async create(queueId, params) {
          calls.consumerCreates.push({
            queueId,
            scriptName: params.script_name,
            ...(params.dead_letter_queue ? { deadLetterQueue: params.dead_letter_queue } : {}),
          });
          const consumer = { consumer_id: `consumer-${params.script_name}`, script: params.script_name, type: 'worker' };
          consumers.push(consumer);
          return consumer;
        },
        async update(_queueId, consumerId, params) {
          return { consumer_id: consumerId, script: params.script_name, type: 'worker' };
        },
        list() {
          return items(consumers);
        },
      },
    },
    kv: {
      namespaces: {
        async create(params) {
          calls.kvCreates.push(params.title);
          const namespace = { id: `kv-${params.title}`, title: params.title };
          kvNamespaces.push(namespace);
          return namespace;
        },
        list() {
          return items(kvNamespaces);
        },
      },
    },
    durableObjects: {
      namespaces: {
        list() {
          return items(durableObjectNamespaces);
        },
      },
    },
    r2: {
      buckets: {
        async create(params) {
          calls.r2Creates.push(params.name);
          const bucket = { name: params.name, storage_class: params.storageClass ?? 'Standard' };
          r2Buckets.push(bucket);
          return bucket;
        },
        async list() {
          return { buckets: r2Buckets };
        },
      },
    },
    secretsStore: {
      stores: {
        async *create(params) {
          for (const body of params.body) {
            calls.secretsStoreCreates.push(body.name);
            const store = { id: `store-${body.name}`, name: body.name };
            secretsStores.push(store);
            yield store;
          }
        },
        list() {
          return items(secretsStores);
        },
      },
    },
    zeroTrust: {
      tunnels: {
        cloudflared: {
          async create(params) {
            calls.tunnelCreates.push(params.name);
            const tunnel = { id: 'tunnel-1', name: params.name, status: 'inactive' };
            tunnels.push(tunnel);
            return tunnel;
          },
          list(params) {
            return items(tunnels.filter((tunnel) => !params.name || tunnel.name === params.name));
          },
          configurations: {
            async update(tunnelId, params) {
              calls.tunnelConfigUpdates.push({ tunnelId, config: params.config });
              return { ok: true };
            },
          },
          token: {
            async get() {
              return 'tunnel-token';
            },
          },
        },
      },
      access: {
        serviceTokens: {
          async create(params) {
            calls.accessServiceTokenCreates.push(params.name);
            const serviceToken = { id: 'service-token-1', name: params.name, client_id: 'access-client-id', client_secret: 'access-client-secret' };
            accessServiceTokens.push(serviceToken);
            return serviceToken;
          },
          list(params) {
            return items(accessServiceTokens.filter((token) => !params.name || token.name === params.name));
          },
        },
        applications: {
          async create(params) {
            calls.accessAppCreates.push(params);
            const app = { id: 'access-app-1', name: String(params['name'] ?? ''), domain: String(params['domain'] ?? ''), type: String(params['type'] ?? '') };
            accessApplications.push(app);
            return app;
          },
          async update(_appId, params) {
            calls.accessAppCreates.push(params);
            const app = { id: 'access-app-1', name: String(params['name'] ?? ''), domain: String(params['domain'] ?? ''), type: String(params['type'] ?? '') };
            const index = accessApplications.findIndex((entry) => entry.id === app.id);
            if (index >= 0) accessApplications[index] = app;
            else accessApplications.push(app);
            return app;
          },
          list(params) {
            return items(accessApplications.filter((app) =>
              (!params.domain || app.domain === params.domain) &&
              (!params.name || app.name === params.name)
            ));
          },
        },
      },
    },
    workers: {
      subdomains: {
        async get() {
          return { subdomain: 'goodvibes-test' };
        },
        async update(params) {
          return { subdomain: params.subdomain };
        },
      },
      scripts: {
        async update(scriptName, params) {
          calls.workerUpdates.push({ scriptName, metadata: params.metadata });
          return { id: scriptName };
        },
        subdomain: {
          async create(scriptName) {
            calls.scriptSubdomains.push(scriptName);
            enabledScriptSubdomains.add(scriptName);
            return { enabled: true };
          },
          async delete() {
            return { enabled: false };
          },
          async get(scriptName) {
            return { enabled: enabledScriptSubdomains.has(scriptName) };
          },
        },
        schedules: {
          async update(scriptName, params) {
            calls.scheduleUpdates.push({ scriptName, crons: params.body.map((entry) => entry.cron) });
            return { schedules: params.body };
          },
          async get() {
            return { schedules: [] };
          },
        },
        secrets: {
          async update(scriptName, params) {
            calls.secretUpdates.push({ scriptName, name: params.name, text: params.text });
            return { name: params.name, type: 'secret_text' };
          },
        },
      },
    },
  };

  return { client, calls };
}

describe('CloudflareControlPlaneManager', () => {
  test('reports Cloudflare as disabled and unready by default', async () => {
    const manager = new CloudflareControlPlaneManager({
      configManager: makeConfigManager(),
      secretsManager: makeSecrets(),
    });

    const status = await manager.describeStatus();

    expect(status.enabled).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.config.workerName).toBe('goodvibes-batch-worker');
    expect(status.config.workerCron).toBe('*/5 * * * *');
  });

  test('provisions queues, Worker, secrets, consumer, cron, config, and verification', async () => {
    const configManager = makeConfigManager();
    const secrets = makeSecrets();
    const { client, calls } = makeCloudflareClient();
    const verifyRequests: Array<{ readonly url: string; readonly authorization?: string }> = [];
    const manager = new CloudflareControlPlaneManager({
      configManager,
      secretsManager: secrets,
      authToken: () => 'daemon-operator-token',
      randomUUID: () => '11111111-2222-4333-8444-555555555555',
      createClient: async (apiToken) => {
        expect(apiToken).toBe('cf-token');
        return client;
      },
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        verifyRequests.push({
          url: String(url),
          ...(headers.get('authorization') ? { authorization: headers.get('authorization')! } : {}),
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    const result = await manager.provision({
      accountId: 'acct-1',
      apiToken: 'cf-token',
      daemonBaseUrl: 'https://daemon.example.com/',
      returnGeneratedSecrets: true,
      verify: true,
    });

    expect(result.ok).toBe(true);
    expect(result.worker.baseUrl).toBe('https://goodvibes-batch-worker.goodvibes-test.workers.dev');
    expect(result.generatedSecrets?.workerClientToken).toBe('gv-cf-11111111222243338444555555555555');
    expect(result.queues.queueName).toBe('goodvibes-batch');
    expect(result.queues.deadLetterQueueName).toBe('goodvibes-batch-dlq');
    expect(calls.queueCreates).toEqual(['goodvibes-batch-dlq', 'goodvibes-batch']);
    expect(calls.workerUpdates[0]?.scriptName).toBe('goodvibes-batch-worker');
    expect(calls.secretUpdates.map((entry) => entry.name)).toEqual(['GOODVIBES_OPERATOR_TOKEN', 'GOODVIBES_WORKER_TOKEN']);
    expect(calls.secretUpdates.find((entry) => entry.name === 'GOODVIBES_OPERATOR_TOKEN')?.text).toBe('daemon-operator-token');
    expect(calls.consumerCreates[0]).toEqual({
      queueId: 'queue-goodvibes-batch',
      scriptName: 'goodvibes-batch-worker',
      deadLetterQueue: 'goodvibes-batch-dlq',
    });
    expect(calls.scheduleUpdates[0]).toEqual({ scriptName: 'goodvibes-batch-worker', crons: ['*/5 * * * *'] });
    expect(calls.scriptSubdomains).toEqual(['goodvibes-batch-worker']);
    expect(configManager.get('cloudflare.enabled')).toBe(true);
    expect(configManager.get('cloudflare.accountId')).toBe('acct-1');
    expect(configManager.get('cloudflare.daemonBaseUrl')).toBe('https://daemon.example.com');
    expect(configManager.get('cloudflare.workerBaseUrl')).toBe('https://goodvibes-batch-worker.goodvibes-test.workers.dev');
    expect(configManager.get('batch.queueBackend')).toBe('cloudflare');
    expect(secrets.values['GOODVIBES_CLOUDFLARE_WORKER_TOKEN']).toBe('gv-cf-11111111222243338444555555555555');
    expect(verifyRequests).toEqual([
      { url: 'https://goodvibes-batch-worker.goodvibes-test.workers.dev/batch/health' },
      {
        url: 'https://goodvibes-batch-worker.goodvibes-test.workers.dev/api/batch/config',
        authorization: 'Bearer gv-cf-11111111222243338444555555555555',
      },
    ]);
  });

  test('reports Cloudflare token requirements for optional components', () => {
    const manager = new CloudflareControlPlaneManager({
      configManager: makeConfigManager(),
      secretsManager: makeSecrets(),
    });

    const result = manager.tokenRequirements({
      includeBootstrap: true,
      components: {
        dns: true,
        kv: true,
        r2: true,
        zeroTrustTunnel: true,
        zeroTrustAccess: true,
        secretsStore: true,
      },
    });

    expect(result.components.workers).toBe(true);
    expect(result.components.queues).toBe(true);
    expect(result.permissions.map((entry) => entry.permission)).toContain('API Tokens Write');
    expect(result.permissions.map((entry) => entry.permission)).toContain('DNS Write');
    expect(result.permissions.map((entry) => entry.permission)).toContain('Workers KV Storage Write');
    expect(result.permissions.map((entry) => entry.permission)).toContain('Workers R2 Storage Write');
    expect(result.permissions.map((entry) => entry.permission)).toContain('Cloudflare Tunnel Write');
    expect(result.bootstrapToken.storeInGoodVibes).toBe(false);
  });

  test('creates and stores a narrow Cloudflare operational token from a bootstrap token', async () => {
    const configManager = makeConfigManager();
    const secrets = makeSecrets();
    const { client, calls } = makeCloudflareClient();
    const manager = new CloudflareControlPlaneManager({
      configManager,
      secretsManager: secrets,
      createClient: async (apiToken) => {
        expect(apiToken).toBe('bootstrap-token');
        return client;
      },
    });

    const result = await manager.createOperationalToken({
      accountId: 'acct-1',
      zoneName: 'example.com',
      bootstrapToken: 'bootstrap-token',
      components: { dns: true, kv: true, r2: true },
      returnGeneratedToken: true,
    });

    expect(result.ok).toBe(true);
    expect(result.generatedToken).toBe('operational-token');
    expect(result.apiTokenRef).toBe('goodvibes://secrets/goodvibes/CLOUDFLARE_API_TOKEN');
    expect(secrets.values['CLOUDFLARE_API_TOKEN']).toBe('operational-token');
    expect(configManager.get('cloudflare.apiTokenRef')).toBe('goodvibes://secrets/goodvibes/CLOUDFLARE_API_TOKEN');
    const policies = calls.tokenCreates[0]?.policies ?? [];
    expect(hasTokenResource(policies, 'com.cloudflare.api.account.acct-1')).toBe(true);
    expect(hasTokenResource(policies, 'com.cloudflare.api.account.zone.zone-1')).toBe(true);
    expect(hasTokenResource(policies, 'com.cloudflare.edge.r2.bucket.*')).toBe(false);
    expect(tokenPolicyForResource(policies, 'com.cloudflare.api.account.acct-1')?.permission_groups.length).toBeGreaterThan(0);
    expect(tokenPolicyForResource(policies, 'com.cloudflare.api.account.zone.zone-1')?.permission_groups.length).toBeGreaterThan(0);
  });

  test('rejects Cloudflare-created operational tokens when policies are not persisted', async () => {
    const configManager = makeConfigManager();
    const secrets = makeSecrets();
    const { client } = makeCloudflareClient();
    client.user!.tokens.create = async (params) => ({ id: 'token-empty-policy', name: params.name, value: 'bad-token', policies: [] });
    client.user!.tokens.get = async (tokenId) => ({ id: tokenId, name: 'GoodVibes Cloudflare Operational', policies: [] });
    const manager = new CloudflareControlPlaneManager({
      configManager,
      secretsManager: secrets,
      createClient: async () => client,
    });

    await expect(manager.createOperationalToken({
      accountId: 'acct-1',
      bootstrapToken: 'bootstrap-token',
      components: { workers: true, queues: true },
    })).rejects.toThrow('did not persist the expected permission policy');
    expect(secrets.values['CLOUDFLARE_API_TOKEN']).toBeUndefined();
  });

  test('resolves operational token permissions with filtered Cloudflare permission-group lookups', async () => {
    const configManager = makeConfigManager();
    const secrets = makeSecrets();
    const { client, calls } = makeCloudflareClient();
    const queries: Array<{ readonly name?: string; readonly scope?: string } | null> = [];
    const groups: CloudflarePermissionGroupLike[] = [
      { id: 'pg-workers', name: 'Workers Scripts Write', scopes: ['com.cloudflare.api.account'] },
      { id: 'pg-queues', name: 'Queues Write', scopes: ['com.cloudflare.api.account'] },
      { id: 'pg-zone-read', name: 'Zone Read', scopes: ['com.cloudflare.api.account.zone'] },
      { id: 'pg-dns', name: 'DNS Write', scopes: ['com.cloudflare.api.account.zone'] },
      { id: 'pg-kv', name: 'Workers KV Storage Write', scopes: ['com.cloudflare.api.account'] },
      { id: 'pg-r2', name: 'Workers R2 Storage Write', scopes: ['com.cloudflare.api.account'] },
      { id: 'pg-secrets', name: 'Account Secrets Store Edit', scopes: ['com.cloudflare.api.account'] },
    ];
    (client.user!.tokens.permissionGroups as {
      list(params?: { readonly name?: string; readonly scope?: string }): AsyncIterable<CloudflarePermissionGroupLike>;
    }).list = (params?: { readonly name?: string; readonly scope?: string }) => {
      queries.push(params ?? null);
      if (!params) return items([{ id: 'pg-bootstrap', name: 'API Tokens Write', scopes: ['com.cloudflare.api.user'] }]);
      return items(groups.filter((group) =>
        (!params.name || group.name === params.name) &&
        (!params.scope || group.scopes?.includes(params.scope)),
      ));
    };
    const manager = new CloudflareControlPlaneManager({
      configManager,
      secretsManager: secrets,
      createClient: async () => client,
    });

    const result = await manager.createOperationalToken({
      accountId: 'acct-1',
      zoneName: 'example.com',
      bootstrapToken: 'bootstrap-token',
      components: { workers: true, queues: true, dns: true, kv: true, r2: true, secretsStore: true },
    });

    expect(result.ok).toBe(true);
    const policies = calls.tokenCreates[0]?.policies ?? [];
    expect(hasTokenResource(policies, 'com.cloudflare.api.account.acct-1')).toBe(true);
    expect(hasTokenResource(policies, 'com.cloudflare.api.account.zone.zone-1')).toBe(true);
    expect(queries).toContainEqual({ name: 'Workers Scripts Write', scope: 'com.cloudflare.api.account' });
    expect(queries).toContainEqual({ name: 'Queues Write', scope: 'com.cloudflare.api.account' });
    expect(queries).toContainEqual({ name: 'Workers R2 Storage Write', scope: 'com.cloudflare.api.account' });
    expect(queries).toContainEqual({ name: 'Account Secrets Store Edit', scope: 'com.cloudflare.api.account' });
    expect(queries).not.toContain(null);
  });

  test('builds an R2 bucket-scoped policy when Cloudflare exposes R2 at bucket scope', async () => {
    const configManager = makeConfigManager();
    const secrets = makeSecrets();
    const { client, calls } = makeCloudflareClient();
    const queries: Array<{ readonly name?: string; readonly scope?: string } | null> = [];
    const groups: CloudflarePermissionGroupLike[] = [
      { id: 'pg-r2', name: 'Workers R2 Storage Write', scopes: ['com.cloudflare.edge.r2.bucket'] },
    ];
    (client.user!.tokens.permissionGroups as {
      list(params?: { readonly name?: string; readonly scope?: string }): AsyncIterable<CloudflarePermissionGroupLike>;
    }).list = (params?: { readonly name?: string; readonly scope?: string }) => {
      queries.push(params ?? null);
      return items(groups.filter((group) =>
        (!params?.name || group.name === params.name) &&
        (!params?.scope || group.scopes?.includes(params.scope)),
      ));
    };
    const manager = new CloudflareControlPlaneManager({
      configManager,
      secretsManager: secrets,
      createClient: async () => client,
    });

    const result = await manager.createOperationalToken({
      accountId: 'acct-1',
      bootstrapToken: 'bootstrap-token',
      components: { workers: false, queues: false, r2: true },
    });

    expect(result.ok).toBe(true);
    expect(queries).toContainEqual({ name: 'Workers R2 Storage Write', scope: 'com.cloudflare.edge.r2.bucket' });
    expect(hasTokenResource(calls.tokenCreates[0]?.policies ?? [], 'com.cloudflare.edge.r2.bucket.*')).toBe(true);
  });

  test('does not add zone resources for account-scoped Zero Trust Access without DNS automation', async () => {
    const configManager = makeConfigManager();
    const secrets = makeSecrets();
    const { client, calls } = makeCloudflareClient();
    const manager = new CloudflareControlPlaneManager({
      configManager,
      secretsManager: secrets,
      createClient: async () => client,
    });

    const result = await manager.createOperationalToken({
      accountId: 'acct-1',
      bootstrapToken: 'bootstrap-token',
      components: {
        workers: false,
        queues: false,
        zeroTrustTunnel: false,
        zeroTrustAccess: true,
        dns: false,
        kv: false,
        durableObjects: false,
        secretsStore: false,
        r2: false,
      },
    });

    expect(result.ok).toBe(true);
    const policies = calls.tokenCreates[0]?.policies ?? [];
    expect(hasTokenResource(policies, 'com.cloudflare.api.account.acct-1')).toBe(true);
    expect(policies.some((policy) => Object.keys(policy.resources).some((key) => key.includes('.zone.')))).toBe(false);
  });

  test('provisions optional Cloudflare DNS, Tunnel, Access, KV, Durable Objects, Secrets Store, and R2 resources', async () => {
    const configManager = makeConfigManager();
    const secrets = makeSecrets();
    const { client, calls } = makeCloudflareClient();
    const manager = new CloudflareControlPlaneManager({
      configManager,
      secretsManager: secrets,
      authToken: () => 'daemon-operator-token',
      createClient: async () => client,
    });

    const result = await manager.provision({
      accountId: 'acct-1',
      apiToken: 'cf-token',
      daemonBaseUrl: 'http://127.0.0.1:3421',
      daemonHostname: 'daemon.example.com',
      workerHostname: 'worker.example.com',
      zoneName: 'example.com',
      components: {
        dns: true,
        kv: true,
        durableObjects: true,
        secretsStore: true,
        r2: true,
        zeroTrustTunnel: true,
        zeroTrustAccess: true,
      },
      returnGeneratedSecrets: true,
      verify: false,
    });

    expect(result.tunnel?.id).toBe('tunnel-1');
    expect(result.access?.appId).toBe('access-app-1');
    expect(result.kv?.namespaceId).toBe('kv-goodvibes-runtime');
    expect(result.r2?.bucketName).toBe('goodvibes-artifacts');
    expect(result.secretsStore?.storeId).toBe('store-goodvibes');
    expect(result.dns?.records.map((record) => record.name)).toEqual(['daemon.example.com', 'worker.example.com']);
    expect(result.generatedSecrets?.tunnelToken).toBe('tunnel-token');
    expect(result.generatedSecrets?.accessServiceTokenClientSecret).toBe('access-client-secret');
    const bindings = calls.workerUpdates[0]?.metadata['bindings'];
    expect(Array.isArray(bindings)).toBe(true);
    expect(JSON.stringify(bindings)).toContain('GOODVIBES_KV');
    expect(JSON.stringify(bindings)).toContain('GOODVIBES_ARTIFACTS');
    expect(JSON.stringify(bindings)).toContain('GOODVIBES_COORDINATOR');
    expect(calls.tunnelConfigUpdates[0]?.config).toEqual({
      ingress: [
        { hostname: 'daemon.example.com', service: 'http://127.0.0.1:3421' },
        { service: 'http_status:404' },
      ],
    });
    expect(calls.accessAppCreates[0]?.['domain']).toBe('daemon.example.com');
    expect(secrets.values['GOODVIBES_CLOUDFLARE_TUNNEL_TOKEN']).toBe('tunnel-token');
    expect(configManager.get('cloudflare.zoneId')).toBe('zone-1');
    expect(configManager.get('cloudflare.tunnelId')).toBe('tunnel-1');
    expect(configManager.get('cloudflare.accessAppId')).toBe('access-app-1');
  });

  test('reuses existing Cloudflare resources when provisioning is run again', async () => {
    const configManager = makeConfigManager();
    const secrets = makeSecrets();
    const { client, calls } = makeCloudflareClient();
    const manager = new CloudflareControlPlaneManager({
      configManager,
      secretsManager: secrets,
      authToken: () => 'daemon-operator-token',
      createClient: async () => client,
    });
    const input = {
      accountId: 'acct-1',
      apiToken: 'cf-token',
      daemonBaseUrl: 'http://127.0.0.1:3421',
      daemonHostname: 'daemon.example.com',
      workerHostname: 'worker.example.com',
      zoneName: 'example.com',
      components: {
        dns: true,
        kv: true,
        durableObjects: true,
        secretsStore: true,
        r2: true,
        zeroTrustTunnel: true,
        zeroTrustAccess: true,
      },
      verify: false,
    };

    await manager.provision(input);
    const createCounts = {
      queues: calls.queueCreates.length,
      kv: calls.kvCreates.length,
      r2: calls.r2Creates.length,
      secretsStore: calls.secretsStoreCreates.length,
      tunnels: calls.tunnelCreates.length,
      accessServiceTokens: calls.accessServiceTokenCreates.length,
      consumers: calls.consumerCreates.length,
      scriptSubdomains: calls.scriptSubdomains.length,
      dns: calls.dnsCreates.length,
    };

    const second = await manager.provision(input);

    expect(second.ok).toBe(true);
    expect(calls.queueCreates.length).toBe(createCounts.queues);
    expect(calls.kvCreates.length).toBe(createCounts.kv);
    expect(calls.r2Creates.length).toBe(createCounts.r2);
    expect(calls.secretsStoreCreates.length).toBe(createCounts.secretsStore);
    expect(calls.tunnelCreates.length).toBe(createCounts.tunnels);
    expect(calls.accessServiceTokenCreates.length).toBe(createCounts.accessServiceTokens);
    expect(calls.consumerCreates.length).toBe(createCounts.consumers);
    expect(calls.scriptSubdomains.length).toBe(createCounts.scriptSubdomains);
    expect(calls.dnsCreates.length).toBe(createCounts.dns);
    expect(second.steps.map((step) => step.message).join('\n')).toContain('Using existing KV namespace goodvibes-runtime.');
    expect(second.steps.map((step) => step.message).join('\n')).toContain('Using existing R2 Standard bucket goodvibes-artifacts.');
    expect(second.steps.map((step) => step.message).join('\n')).toContain('Using existing Cloudflare Secrets Store goodvibes.');
  });

  test('recovers from Cloudflare Secrets Store maximum_stores_exceeded by reusing a discovered store', async () => {
    const configManager = makeConfigManager();
    const secrets = makeSecrets();
    const { client } = makeCloudflareClient();
    let listCalls = 0;
    client.secretsStore!.stores.list = () => {
      listCalls += 1;
      return items(listCalls === 1 ? [] : [{ id: 'store-goodvibes', name: 'goodvibes' }]);
    };
    client.secretsStore!.stores.create = async function* () {
      throw new Error('400 {"errors":[{"code":1003,"message":"maximum_stores_exceeded"}]}');
    };
    const manager = new CloudflareControlPlaneManager({
      configManager,
      secretsManager: secrets,
      createClient: async () => client,
    });

    const result = await manager.provision({
      accountId: 'acct-1',
      apiToken: 'cf-token',
      components: { workers: false, queues: false, secretsStore: true },
      verify: false,
    });

    expect(result.ok).toBe(true);
    expect(result.secretsStore?.storeId).toBe('store-goodvibes');
    expect(configManager.get('cloudflare.secretsStoreId')).toBe('store-goodvibes');
    expect(result.steps.map((step) => step.message).join('\n')).toContain('Using existing Cloudflare Secrets Store goodvibes after create retry');
  });
});
