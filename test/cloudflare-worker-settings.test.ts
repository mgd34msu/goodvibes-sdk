import { describe, expect, test } from 'bun:test';
import type {
  CloudflareApiClient,
  CloudflareControlPlaneConfig,
  CloudflareDurableObjectNamespaceLike,
  CloudflareProvisionStep,
  CloudflareWorkerScriptLike,
} from '../packages/sdk/src/_internal/platform/cloudflare/types.js';
import {
  configureWorkerSchedule,
  configureWorkerSubdomain,
  uploadWorker,
} from '../packages/sdk/src/_internal/platform/cloudflare/worker-settings.js';

describe('Cloudflare Worker settings provisioning', () => {
  test('reads and reuses an account workers.dev subdomain before trying to configure it', async () => {
    const steps: CloudflareProvisionStep[] = [];
    let accountSubdomainUpdates = 0;
    let scriptSubdomainCreates = 0;
    const writes: Array<{ readonly key: string; readonly value: unknown }> = [];
    const enabledScripts = new Set<string>();
    const client = workerSettingsClient({
      readAccountSubdomain: async () => 'actual-subdomain',
      updateAccountSubdomain: async () => {
        accountSubdomainUpdates += 1;
        throw new Error('account subdomain should not be updated');
      },
      readScriptSubdomain: async (scriptName) => ({ enabled: enabledScripts.has(scriptName) }),
      createScriptSubdomain: async (scriptName) => {
        scriptSubdomainCreates += 1;
        enabledScripts.add(scriptName);
        return { enabled: true };
      },
    });

    const subdomain = await configureWorkerSubdomain({
      readConfig: () => ({ workerSubdomain: 'configured-subdomain' }) as CloudflareControlPlaneConfig,
      setConfig: (key, value) => writes.push({ key, value }),
      storeSecret: async () => undefined,
    }, client, {
      accountId: 'acct-1',
      workerName: 'goodvibes-batch-worker',
      requestedSubdomain: 'configured-subdomain',
      enableWorkersDev: true,
      steps,
      persist: true,
    });

    expect(subdomain).toBe('actual-subdomain');
    expect(accountSubdomainUpdates).toBe(0);
    expect(scriptSubdomainCreates).toBe(1);
    expect(writes).toContainEqual({ key: 'cloudflare.workerSubdomain', value: 'actual-subdomain' });
    expect(steps.map((step) => step.message).join('\n')).toContain('Using existing account workers.dev subdomain actual-subdomain');
  });

  test('recovers when Cloudflare reports the account already has a workers.dev subdomain', async () => {
    const steps: CloudflareProvisionStep[] = [];
    let reads = 0;
    const client = workerSettingsClient({
      readAccountSubdomain: async () => {
        reads += 1;
        if (reads === 1) throw new Error('not found yet');
        return 'existing-subdomain';
      },
      updateAccountSubdomain: async () => {
        throw new Error('409 {"errors":[{"code":10036,"message":"Account already has an associated subdomain."}]}');
      },
      readScriptSubdomain: async () => ({ enabled: true }),
    });

    const subdomain = await configureWorkerSubdomain({
      readConfig: () => ({ workerSubdomain: 'requested-subdomain' }) as CloudflareControlPlaneConfig,
      setConfig: () => undefined,
      storeSecret: async () => undefined,
    }, client, {
      accountId: 'acct-1',
      workerName: 'goodvibes-batch-worker',
      enableWorkersDev: true,
      steps,
      persist: true,
    });

    expect(subdomain).toBe('existing-subdomain');
    expect(steps.map((step) => step.message).join('\n')).toContain('after configure retry');
  });

  test('does not rewrite an existing matching Worker cron schedule', async () => {
    const steps: CloudflareProvisionStep[] = [];
    let scheduleUpdates = 0;
    const client = workerSettingsClient({
      readSchedule: async () => ({ schedules: [{ cron: '*/5 * * * *' }] }),
      updateSchedule: async () => {
        scheduleUpdates += 1;
        return { schedules: [{ cron: '*/5 * * * *' }] };
      },
    });

    await configureWorkerSchedule(client, {
      accountId: 'acct-1',
      workerName: 'goodvibes-batch-worker',
      workerCron: '*/5 * * * *',
      steps,
    });

    expect(scheduleUpdates).toBe(0);
    expect(steps.map((step) => step.message).join('\n')).toContain('Using existing Worker cron */5 * * * *.');
  });

  test('creates a Durable Object SQLite class migration only on first Worker upload', async () => {
    const metadata: Record<string, unknown>[] = [];
    const client = workerSettingsClient({
      updateWorker: async (_scriptName, body) => {
        metadata.push(body.metadata);
        return { id: 'goodvibes-batch-worker' };
      },
    });

    const result = await uploadWorker(client, {
      accountId: 'acct-1',
      workerName: 'goodvibes-batch-worker',
      queueName: '',
      daemonBaseUrl: 'https://daemon.example.com',
      queueJobPayloads: false,
      kvNamespaceId: '',
      r2BucketName: '',
      durableObject: true,
    });

    expect(result.durableObjectMigration).toBe('create-sqlite-class');
    expect(metadata[0]?.['migrations']).toEqual({
      new_tag: 'goodvibes-coordinator-v1',
      steps: [{ new_sqlite_classes: ['GoodVibesCoordinator'] }],
    });
  });

  test('does not reapply a Durable Object class migration when the Worker tag is current', async () => {
    const metadata: Record<string, unknown>[] = [];
    const client = workerSettingsClient({
      getWorker: async () => ({ id: 'goodvibes-batch-worker', migration_tag: 'goodvibes-coordinator-v1' }),
      updateWorker: async (_scriptName, body) => {
        metadata.push(body.metadata);
        return { id: 'goodvibes-batch-worker' };
      },
    });

    const result = await uploadWorker(client, {
      accountId: 'acct-1',
      workerName: 'goodvibes-batch-worker',
      queueName: '',
      daemonBaseUrl: 'https://daemon.example.com',
      queueJobPayloads: false,
      kvNamespaceId: '',
      r2BucketName: '',
      durableObject: true,
    });

    expect(result.durableObjectMigration).toBe('current');
    expect(metadata[0]?.['migrations']).toBeUndefined();
  });

  test('does not reapply a Durable Object class migration when the namespace already exists', async () => {
    const metadata: Record<string, unknown>[] = [];
    const client = workerSettingsClient({
      listDurableObjectNamespaces: async function* () {
        yield {
          id: 'do-1',
          class: 'GoodVibesCoordinator',
          name: 'GoodVibesCoordinator',
          script: 'goodvibes-batch-worker',
          use_sqlite: true,
        };
      },
      updateWorker: async (_scriptName, body) => {
        metadata.push(body.metadata);
        return { id: 'goodvibes-batch-worker' };
      },
    });

    const result = await uploadWorker(client, {
      accountId: 'acct-1',
      workerName: 'goodvibes-batch-worker',
      queueName: '',
      daemonBaseUrl: 'https://daemon.example.com',
      queueJobPayloads: false,
      kvNamespaceId: '',
      r2BucketName: '',
      durableObject: true,
    });

    expect(result.durableObjectMigration).toBe('existing-namespace');
    expect(result.namespaceId).toBe('do-1');
    expect(metadata[0]?.['migrations']).toBeUndefined();
  });

  test('recovers from Cloudflare 10074 by retrying Worker upload without the class migration', async () => {
    const metadata: Record<string, unknown>[] = [];
    const client = workerSettingsClient({
      updateWorker: async (_scriptName, body) => {
        metadata.push(body.metadata);
        if (metadata.length === 1) {
          throw new Error("400 {\"errors\":[{\"code\":10074,\"message\":\"Cannot apply new-sqlite-class migration to class 'GoodVibesCoordinator' that is already depended on by existing Durable Objects\"}]}");
        }
        return { id: 'goodvibes-batch-worker' };
      },
    });

    const result = await uploadWorker(client, {
      accountId: 'acct-1',
      workerName: 'goodvibes-batch-worker',
      queueName: '',
      daemonBaseUrl: 'https://daemon.example.com',
      queueJobPayloads: false,
      kvNamespaceId: '',
      r2BucketName: '',
      durableObject: true,
    });

    expect(result.durableObjectMigration).toBe('recovered-existing-class');
    expect(metadata).toHaveLength(2);
    expect(metadata[0]?.['migrations']).toBeDefined();
    expect(metadata[1]?.['migrations']).toBeUndefined();
  });
});

function workerSettingsClient(overrides: {
  readonly getWorker?: (scriptName: string) => Promise<CloudflareWorkerScriptLike>;
  readonly listWorkers?: () => AsyncIterable<CloudflareWorkerScriptLike>;
  readonly updateWorker?: (
    scriptName: string,
    body: { readonly metadata: Record<string, unknown>; readonly files: readonly File[] },
  ) => Promise<{ readonly id?: string }>;
  readonly listDurableObjectNamespaces?: () => AsyncIterable<CloudflareDurableObjectNamespaceLike>;
  readonly readAccountSubdomain?: () => Promise<string>;
  readonly updateAccountSubdomain?: (subdomain: string) => Promise<{ readonly subdomain: string }>;
  readonly readScriptSubdomain?: (scriptName: string) => Promise<{ readonly enabled: boolean }>;
  readonly createScriptSubdomain?: (scriptName: string) => Promise<{ readonly enabled: boolean }>;
  readonly readSchedule?: () => Promise<{ readonly schedules: readonly { readonly cron: string }[] }>;
  readonly updateSchedule?: (body: readonly { readonly cron: string }[]) => Promise<{ readonly schedules: readonly { readonly cron: string }[] }>;
}): CloudflareApiClient {
  return {
    workers: {
      subdomains: {
        get: async () => ({ subdomain: await (overrides.readAccountSubdomain?.() ?? Promise.resolve('')) }),
        update: async (params) => overrides.updateAccountSubdomain?.(params.subdomain) ?? { subdomain: params.subdomain },
      },
      scripts: {
        update: async (scriptName, params) => overrides.updateWorker?.(scriptName, params) ?? { id: scriptName },
        get: async (scriptName) => overrides.getWorker?.(scriptName) ?? { id: scriptName },
        list: async function* () {
          if (overrides.listWorkers) {
            for await (const worker of overrides.listWorkers()) yield worker;
          }
        },
        subdomain: {
          get: async (scriptName) => overrides.readScriptSubdomain?.(scriptName) ?? { enabled: false },
          create: async (scriptName) => overrides.createScriptSubdomain?.(scriptName) ?? { enabled: true },
          delete: async () => ({ enabled: false }),
        },
        schedules: {
          get: async () => overrides.readSchedule?.() ?? { schedules: [] },
          update: async (_scriptName, params) => overrides.updateSchedule?.(params.body) ?? { schedules: params.body },
        },
        secrets: {
          update: async (_scriptName, params) => ({ name: params.name, type: params.type }),
        },
      },
    },
    durableObjects: {
      namespaces: {
        list: async function* () {
          if (overrides.listDurableObjectNamespaces) {
            for await (const namespace of overrides.listDurableObjectNamespaces()) yield namespace;
          }
        },
      },
    },
    queues: undefined as never,
  } as CloudflareApiClient;
}
