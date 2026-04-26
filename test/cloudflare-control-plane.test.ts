import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../packages/sdk/src/_internal/platform/config/manager.js';
import { CloudflareControlPlaneManager } from '../packages/sdk/src/_internal/platform/cloudflare/manager.js';
import type {
  CloudflareApiClient,
  CloudflareConsumerLike,
  CloudflareQueueLike,
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

function makeCloudflareClient() {
  const queues: CloudflareQueueLike[] = [];
  const consumers: CloudflareConsumerLike[] = [];
  const calls = {
    queueCreates: [] as string[],
    workerUpdates: [] as Array<{ readonly scriptName: string; readonly metadata: Record<string, unknown> }>,
    secretUpdates: [] as Array<{ readonly scriptName: string; readonly name: string; readonly text: string }>,
    scheduleUpdates: [] as Array<{ readonly scriptName: string; readonly crons: readonly string[] }>,
    consumerCreates: [] as Array<{ readonly queueId: string; readonly scriptName: string; readonly deadLetterQueue?: string }>,
    scriptSubdomains: [] as string[],
  };

  const client: CloudflareApiClient = {
    accounts: {
      async get(params) {
        return { id: params.account_id, name: 'GoodVibes Test', type: 'standard' };
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
            return { enabled: true };
          },
          async delete() {
            return { enabled: false };
          },
          async get() {
            return { enabled: true };
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
});
