import { describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonFileStore } from '../packages/sdk/src/platform/state/json-file-store.ts';
import { PersistentStore } from '../packages/sdk/src/platform/state/persistent-store.ts';
import { ProjectIndex } from '../packages/sdk/src/platform/state/project-index.ts';
import { FileStateCache } from '../packages/sdk/src/platform/state/file-cache.ts';
import { TelemetryDB } from '../packages/sdk/src/platform/state/telemetry.ts';
import { KVState } from '../packages/sdk/src/platform/state/kv-state.ts';
import { SQLiteStore } from '../packages/sdk/src/platform/state/sqlite-store.ts';
import { AutomationJobStore } from '../packages/sdk/src/platform/automation/store/jobs.ts';
import { AutomationRunStore } from '../packages/sdk/src/platform/automation/store/runs.ts';
import { AutomationRouteStore } from '../packages/sdk/src/platform/automation/store/routes.ts';
import { AutomationSourceStore } from '../packages/sdk/src/platform/automation/store/sources.ts';
import { TaskScheduler } from '../packages/sdk/src/platform/scheduler/scheduler.ts';
import { DaemonBatchManager } from '../packages/sdk/src/platform/batch/manager.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { ApprovalBroker } from '../packages/sdk/src/platform/control-plane/approval-broker.ts';
import { loadSessionBrokerState } from '../packages/sdk/src/platform/control-plane/session-broker-state.ts';
import { ChannelPolicyManager } from '../packages/sdk/src/platform/channels/policy-manager.ts';
import { DistributedRuntimeManager } from '../packages/sdk/src/platform/runtime/remote/distributed-runtime-manager.ts';
import { rowToRecord } from '../packages/sdk/src/platform/state/memory-store-helpers.ts';
import { loadWatcherSnapshotFromPath } from '../packages/sdk/src/platform/watchers/store.ts';
import { createTeamTool } from '../packages/sdk/src/platform/tools/team/index.ts';
import { createWorklistTool } from '../packages/sdk/src/platform/tools/worklist/index.ts';
import type { LLMProvider } from '../packages/sdk/src/platform/providers/interface.ts';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.ts';

function tempDir(label: string): string {
  return join(tmpdir(), `gv-${label}-${randomUUID()}`);
}

describe('state persistence failures', () => {
  test('PersistentStore rejects invalid JSON instead of returning an empty store', async () => {
    const dir = tempDir('persistent-store');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.json');
    writeFileSync(file, '{bad', 'utf-8');

    await expect(new PersistentStore(file).load()).rejects.toThrow('PersistentStore failed to load');
  });

  test('JsonFileStore rejects invalid JSON instead of returning an empty store', async () => {
    const dir = tempDir('json-file-store');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.json');
    writeFileSync(file, '{bad', 'utf-8');

    await expect(new JsonFileStore(file).load()).rejects.toThrow('JsonFileStore failed to load');
  });

  test('PersistentStore concurrent saves do not race on a shared tmp path', async () => {
    const dir = tempDir('persistent-store-concurrent');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.json');
    const store = new PersistentStore<{ readonly value: string }>(file);

    await Promise.all([
      store.persist({ value: 'first' }),
      store.persist({ value: 'second' }),
      store.persist({ value: 'third' }),
    ]);

    expect(['first', 'second', 'third']).toContain((await store.load())?.value);
    expect(readdirSync(dir).filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });

  test('JsonFileStore concurrent saves do not race on a shared tmp path', async () => {
    const dir = tempDir('json-file-store-concurrent');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.json');
    const store = new JsonFileStore<{ readonly value: string }>(file);

    await Promise.all([
      store.save({ value: 'first' }),
      store.save({ value: 'second' }),
      store.save({ value: 'third' }),
    ]);

    expect(['first', 'second', 'third']).toContain((await store.load())?.value);
    expect(readdirSync(dir).filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });

  test('ProjectIndex rejects corrupt on-disk indexes instead of treating them as empty', async () => {
    const root = tempDir('project-index');
    mkdirSync(join(root, '.goodvibes'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'project-index.json'), '{bad', 'utf-8');

    await expect(new ProjectIndex(root).load()).rejects.toThrow('ProjectIndex load failed');
  });

  test('FileStateCache reports unreadable cached files instead of returning a cache miss', () => {
    const dir = tempDir('file-cache-read');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tracked.txt');
    writeFileSync(file, 'cached content', 'utf-8');

    const cache = new FileStateCache();
    cache.update(file, 'cached content');
    rmSync(file);
    mkdirSync(file);

    expect(() => cache.lookup(file)).toThrow('FileStateCache failed to read cached file');
  });

  test('FileStateCache still treats missing cached files as misses', () => {
    const dir = tempDir('file-cache-missing');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tracked.txt');

    const cache = new FileStateCache();
    cache.update(file, 'cached content');

    expect(cache.lookup(file)).toEqual({ status: 'miss' });
  });

  test('SQLiteStore throws on file-backed save failures', async () => {
    const dir = tempDir('sqlite-store-save');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'state.db');
    const store = new SQLiteStore(dbPath);
    await store.init((db) => {
      db.run('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY)');
    });
    mkdirSync(dbPath);

    await expect(store.save()).rejects.toThrow();
    store.close();
  });

  test('TelemetryDB throws on file-backed save failures', async () => {
    const dir = tempDir('telemetry-db-save');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'telemetry.db');
    const db = new TelemetryDB(dbPath);
    await db.init();
    db.recordToolCall('tool', {}, { success: true }, 1, 1);
    mkdirSync(dbPath);

    await expect(db.save()).rejects.toThrow();
    db.close();
  });

  test('KVState rejects corrupt session files instead of starting a replacement session', async () => {
    const stateDir = tempDir('kv-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'session_1234abcd.json'), '{bad', 'utf-8');

    await expect(new KVState({ stateDir, sessionId: '1234abcd' }).load()).rejects.toThrow('JsonFileStore failed to load');
  });

  test('watcher snapshots reject malformed persisted state instead of loading as empty', () => {
    const dir = tempDir('watcher-store');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'watchers.json');
    writeFileSync(file, '{bad', 'utf-8');

    expect(() => loadWatcherSnapshotFromPath(file)).toThrow();
  });

  test('worklist tool rejects malformed persisted state instead of overwriting it', async () => {
    const dir = tempDir('worklist-store');
    mkdirSync(join(dir, '.goodvibes'), { recursive: true });
    writeFileSync(join(dir, '.goodvibes', 'worklists.json'), '{bad', 'utf-8');

    await expect(createWorklistTool().execute({
      storageRoot: dir,
      mode: 'list',
    })).rejects.toThrow();
  });

  test('team tool rejects malformed persisted state instead of overwriting it', async () => {
    const dir = tempDir('team-store');
    mkdirSync(join(dir, '.goodvibes'), { recursive: true });
    writeFileSync(join(dir, '.goodvibes', 'teams.json'), '{bad', 'utf-8');

    await expect(createTeamTool().execute({
      storageRoot: dir,
      mode: 'list',
    })).rejects.toThrow();
  });

  test('automation stores reject malformed snapshots instead of resetting collections', async () => {
    const dir = tempDir('automation-store');
    mkdirSync(dir, { recursive: true });

    const jobs = join(dir, 'jobs.json');
    const runs = join(dir, 'runs.json');
    const routes = join(dir, 'routes.json');
    const sources = join(dir, 'sources.json');
    writeFileSync(jobs, JSON.stringify({ version: 1, jobs: {} }), 'utf-8');
    writeFileSync(runs, JSON.stringify({ version: 1, runs: {} }), 'utf-8');
    writeFileSync(routes, JSON.stringify({ version: 1, routes: {} }), 'utf-8');
    writeFileSync(sources, JSON.stringify({ version: 1, sources: {} }), 'utf-8');

    await expect(new AutomationJobStore(jobs).load()).rejects.toThrow('Automation jobs store snapshot is invalid');
    await expect(new AutomationRunStore(runs).load()).rejects.toThrow('Automation runs store snapshot is invalid');
    await expect(new AutomationRouteStore(routes).load()).rejects.toThrow('Automation routes store snapshot is invalid');
    await expect(new AutomationSourceStore(sources).load()).rejects.toThrow('Automation sources store snapshot is invalid');
  });

  test('TaskScheduler rejects malformed snapshots instead of starting empty', async () => {
    const dir = tempDir('scheduler-store');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'scheduler.json');
    writeFileSync(file, JSON.stringify({ tasks: {}, history: [] }), 'utf-8');

    await expect(new TaskScheduler({ storePath: file }).start()).rejects.toThrow('TaskScheduler store snapshot is invalid');
  });

  test('TaskScheduler rejects malformed persisted task records', async () => {
    const dir = tempDir('scheduler-records');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'scheduler.json');
    writeFileSync(file, JSON.stringify({
      tasks: [{
        name: 'missing id',
        cron: '* * * * *',
        prompt: 'run',
        enabled: true,
        runCount: 0,
        createdAt: Date.now(),
      }],
      history: [],
    }), 'utf-8');

    await expect(new TaskScheduler({ storePath: file }).start()).rejects.toThrow('TaskScheduler store snapshot is invalid');
  });

  test('DaemonBatchManager rejects malformed snapshots instead of resetting jobs', async () => {
    const dir = tempDir('batch-store');
    mkdirSync(dir, { recursive: true });
    const storePath = join(dir, 'batch.json');
    writeFileSync(storePath, JSON.stringify({ version: 1, jobs: [] }), 'utf-8');
    const configManager = new ConfigManager({ configDir: join(dir, 'config') });
    configManager.set('batch.mode', 'explicit');
    const provider: LLMProvider = {
      name: 'test',
      models: ['model'],
      async chat() {
        throw new Error('not used');
      },
    };
    const providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'getRegistered' | 'listProviders'> = {
      getCurrentModel: () => ({
        id: 'model',
        provider: 'test',
        registryKey: 'test:model',
        displayName: 'Test Model',
        capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 4096,
        selectable: true,
      }),
      getForModel: () => provider,
      getRegistered: () => provider,
      listProviders: () => [provider],
    };
    const manager = new DaemonBatchManager({ configManager, providerRegistry, storePath });

    await expect(manager.listJobs()).rejects.toThrow('Daemon batch store snapshot is invalid');
  });

  test('DaemonBatchManager rejects malformed persisted job records', async () => {
    const dir = tempDir('batch-records');
    mkdirSync(dir, { recursive: true });
    const storePath = join(dir, 'batch.json');
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      jobs: {
        'batch-job-1': {
          id: 'batch-job-2',
          provider: 'test',
          model: 'model',
          status: 'queued',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          request: { messages: [] },
          attempts: 0,
        },
      },
    }), 'utf-8');
    const configManager = new ConfigManager({ configDir: join(dir, 'config') });
    configManager.set('batch.mode', 'explicit');
    const provider: LLMProvider = {
      name: 'test',
      models: ['model'],
      async chat() {
        throw new Error('not used');
      },
    };
    const providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'getRegistered' | 'listProviders'> = {
      getCurrentModel: () => ({
        id: 'model',
        provider: 'test',
        registryKey: 'test:model',
        displayName: 'Test Model',
        capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 4096,
        selectable: true,
      }),
      getForModel: () => provider,
      getRegistered: () => provider,
      listProviders: () => [provider],
    };
    const manager = new DaemonBatchManager({ configManager, providerRegistry, storePath });

    await expect(manager.listJobs()).rejects.toThrow('Daemon batch store snapshot is invalid');
  });

  test('control-plane, channel, and distributed stores reject malformed records', async () => {
    const dir = tempDir('control-records');
    mkdirSync(dir, { recursive: true });

    const approvals = join(dir, 'approvals.json');
    writeFileSync(approvals, JSON.stringify({ approvals: [{ id: 'approval-1' }] }), 'utf-8');
    await expect(new ApprovalBroker({ storePath: approvals }).start()).rejects.toThrow('Shared approval store snapshot is invalid');

    expect(() => loadSessionBrokerState({
      sessions: [{ id: 'sess-1' }],
      messages: [],
      inputs: [],
    } as never)).toThrow('Shared session store snapshot is invalid');

    const policies = join(dir, 'policies.json');
    writeFileSync(policies, JSON.stringify({
      policies: [{ surface: 'slack', groupPolicies: [{}] }],
      audit: [],
    }), 'utf-8');
    await expect(new ChannelPolicyManager({ storePath: policies }).start()).rejects.toThrow('Channel policy store snapshot is invalid');

    const distributed = join(dir, 'distributed.json');
    writeFileSync(distributed, JSON.stringify({
      pairRequests: [],
      peers: [{
        id: 'peer-1',
        kind: 'node',
        label: 'Node',
        tokens: [{ id: 'token-1' }],
      }],
      work: [],
      audit: [],
    }), 'utf-8');
    await expect(new DistributedRuntimeManager(distributed).start()).rejects.toThrow('Distributed runtime store snapshot is invalid');
  });

  test('memory row parser rejects corrupt persisted JSON fields instead of clearing them', () => {
    const now = Date.now();
    const columns = [
      'id',
      'scope',
      'cls',
      'summary',
      'detail',
      'tags',
      'provenance',
      'review_state',
      'confidence',
      'reviewed_at',
      'reviewed_by',
      'stale_reason',
      'created_at',
      'updated_at',
    ];
    const values = [
      'mem-bad',
      'project',
      'fact',
      'bad persisted row',
      null,
      '{bad',
      '[]',
      'fresh',
      60,
      null,
      null,
      null,
      now,
      now,
    ];

    expect(() => rowToRecord(columns, values)).toThrow(/tags.*invalid.*JSON/);
  });
});
