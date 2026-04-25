import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../packages/sdk/src/_internal/platform/config/manager.js';
import { DEFAULT_CONFIG } from '../packages/sdk/src/_internal/platform/config/schema.js';
import { DaemonBatchManager } from '../packages/sdk/src/_internal/platform/batch/manager.js';
import type { LLMProvider, ProviderBatchChatRequest, ProviderBatchResult } from '../packages/sdk/src/_internal/platform/providers/interface.js';
import type { ProviderRegistry } from '../packages/sdk/src/_internal/platform/providers/registry.js';

function makeConfigManager(): ConfigManager {
  const configDir = join(tmpdir(), `gv-batch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(configDir, { recursive: true });
  return new ConfigManager({ configDir });
}

function makeProvider(): LLMProvider & { readonly submitted: ProviderBatchChatRequest[] } {
  const submitted: ProviderBatchChatRequest[] = [];
  return {
    name: 'openai',
    models: ['gpt-test'],
    submitted,
    isConfigured: () => true,
    async chat() {
      throw new Error('not used');
    },
    batch: {
      kind: 'provider-batch',
      endpoints: ['/v1/chat/completions'],
      async createChatBatch(input) {
        submitted.push(...input.requests);
        return { providerBatchId: 'provider-batch-1', status: 'submitted' };
      },
      async retrieveBatch(providerBatchId) {
        return { providerBatchId, status: 'completed', resultAvailable: true };
      },
      async getResults() {
        return submitted.map((request): ProviderBatchResult => ({
          customId: request.customId,
          status: 'succeeded',
          response: {
            content: 'batched response',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 2 },
            stopReason: 'completed',
          },
        }));
      },
    },
  };
}

function makeRegistry(provider: LLMProvider): Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'getRegistered' | 'listProviders'> {
  return {
    getCurrentModel: () => ({
      id: 'gpt-test',
      provider: 'openai',
      registryKey: 'openai:gpt-test',
      displayName: 'GPT Test',
      description: 'test model',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
      contextWindow: 128_000,
      selectable: true,
      tier: 'standard',
    }),
    getForModel: () => provider,
    getRegistered: () => provider,
    listProviders: () => [provider],
  };
}

describe('daemon batch defaults', () => {
  test('batch and Cloudflare are off by default', () => {
    const config = DEFAULT_CONFIG as Record<string, Record<string, unknown>>;
    expect(config.batch.mode).toBe('off');
    expect(config.batch.queueBackend).toBe('local');
    expect(config.cloudflare.enabled).toBe(false);
    expect(config.cloudflare.freeTierMode).toBe(true);
  });
});

describe('DaemonBatchManager', () => {
  test('rejects job creation when batch mode is off', async () => {
    const configManager = makeConfigManager();
    const provider = makeProvider();
    const manager = new DaemonBatchManager({
      configManager,
      providerRegistry: makeRegistry(provider),
    });

    await expect(manager.createJob({
      request: { messages: [{ role: 'user', content: 'hi' }] },
    })).rejects.toThrow('Daemon batch mode is off');
  });

  test('queues, submits, polls, and completes provider batch jobs', async () => {
    const configManager = makeConfigManager();
    configManager.set('batch.mode', 'explicit');
    configManager.set('batch.maxDelayMs', 0);
    const provider = makeProvider();
    const manager = new DaemonBatchManager({
      configManager,
      providerRegistry: makeRegistry(provider),
    });

    const queued = await manager.createJob({
      provider: 'openai',
      model: 'gpt-test',
      request: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(queued.status).toBe('queued');

    const tick = await manager.tick({ forceSubmit: true });
    expect(tick.submittedJobs).toBe(1);
    expect(tick.completedJobs).toBe(1);

    const completed = await manager.getJob(queued.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.result?.content).toBe('batched response');
    expect(provider.submitted[0]?.customId).toBe(queued.id);
  });
});
