import { afterEach, expect, test } from 'bun:test';
import { Orchestrator } from '../packages/sdk/src/platform/core/orchestrator.js';
import { ConversationManager } from '../packages/sdk/src/platform/core/conversation.js';
import { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.js';
import type { OrchestratorCoreServices } from '../packages/sdk/src/platform/core/orchestrator-runtime.js';
import type { PermissionManager } from '../packages/sdk/src/platform/permissions/manager.js';
import type { ChatRequest, ChatResponse } from '../packages/sdk/src/platform/providers/interface.js';
import { UNKNOWN_MODEL_PRICING } from '../packages/sdk/src/platform/providers/model-pricing.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const orchestrators: Orchestrator[] = [];
afterEach(() => { for (const orchestrator of orchestrators.splice(0)) orchestrator.dispose(); });

function fixture(chat: (request: ChatRequest) => Promise<ChatResponse>) {
  const conversation = new ConversationManager();
  const toolRegistry = new ToolRegistry();
  const model = { id: 'test', registryKey: 'test:test', provider: 'test', displayName: 'Test', capabilities: { reasoning: false } };
  const orchestrator = new Orchestrator({
    conversation,
    getViewportHeight: () => 20,
    scrollToEnd: () => {},
    toolRegistry,
    permissionManager: { getMode: () => 'allow-all', check: async () => true } as unknown as PermissionManager,
    services: { agentManager: { list: () => [], spawn: () => { throw new Error('unexpected spawn'); } }, wrfcController: { listChains: () => [] } },
  });
  orchestrators.push(orchestrator);
  orchestrator.setCoreServices({
    configManager: { get: (key: string) => key === 'display.stream' ? true : key === 'behavior.compactionStrategy' ? 'off' : undefined },
    providerRegistry: {
      getCurrentModel: () => model,
      getForModel: () => ({ chat }),
      getKnownContextWindowForModel: () => null,
      getContextWindowForModel: () => 0,
      getTokenLimitsForModel: () => ({ maxOutputTokens: 4096 }),
      resolveModelPricing: () => UNKNOWN_MODEL_PRICING,
      reconcileObservedContextWindow: () => {},
    },
  } as unknown as OrchestratorCoreServices);
  return { orchestrator, conversation, toolRegistry };
}

function answer(content: string): ChatResponse {
  return { content, toolCalls: [], stopReason: 'completed', usage: { inputTokens: 10, outputTokens: 5 } };
}

test('manual compaction interrupts generation, holds the turn, and resumes with compacted history', async () => {
  const started = deferred();
  const compacting = deferred();
  const release = deferred();
  const requests: ChatRequest[] = [];
  const { orchestrator, conversation } = fixture(async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      request.onDelta?.({ content: 'unfinished response' });
      started.resolve();
      return await new Promise<ChatResponse>((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => reject(new DOMException('Paused', 'AbortError')), { once: true });
      });
    }
    return answer('resumed answer');
  });
  conversation.addModelInstruction('keep this instruction');
  const turn = orchestrator.handleUserInput('finish the task');
  await started.promise;
  const compact = orchestrator.withCompaction(async () => {
    expect(conversation.getMessageSnapshot().some((message) => message.content === 'unfinished response')).toBe(false);
    compacting.resolve();
    await release.promise;
    conversation.replaceMessagesForLLM([{ role: 'user', content: 'compacted task state' }]);
    return 'receipt';
  });
  await compacting.promise;
  expect(requests).toHaveLength(1);
  expect(orchestrator.isThinking).toBe(true);
  release.resolve();
  expect(await compact).toBe('receipt');
  await turn;
  expect(requests).toHaveLength(2);
  expect(requests[1]!.messages).toEqual([{ role: 'user', content: 'compacted task state' }]);
  expect(requests[1]!.systemPrompt).toContain('keep this instruction');
  expect(conversation.getMessagesForLLM().at(-1)?.content).toBe('resumed answer');
  expect(conversation.getMessageSnapshot().some((message) => String(message.content).includes('cancelled'))).toBe(false);
});

test('compaction waits for tool results and resumes without repeating a side effect', async () => {
  const toolStarted = deferred();
  const finishTool = deferred();
  let executions = 0;
  const requests: ChatRequest[] = [];
  const { orchestrator, conversation, toolRegistry } = fixture(async (request) => {
    requests.push(request);
    return requests.length === 1
      ? { ...answer('using tool'), stopReason: 'tool_call', toolCalls: [{ id: 'write-1', name: 'write_test', arguments: {} }] }
      : answer('task completed');
  });
  toolRegistry.register({
    definition: { name: 'write_test', description: 'test side effect', parameters: { type: 'object', properties: {} } },
    execute: async () => {
      executions += 1;
      toolStarted.resolve();
      await finishTool.promise;
      return { success: true, output: 'write completed' };
    },
  });
  const turn = orchestrator.handleUserInput('write once');
  await toolStarted.promise;
  let compacted = false;
  const compact = orchestrator.withCompaction(async () => {
    const messages = conversation.getMessagesForLLM();
    expect(messages.at(-1)?.role).toBe('tool');
    expect(messages.at(-1)?.content).toContain('write completed');
    conversation.replaceMessagesForLLM(messages);
    compacted = true;
  });
  await Promise.resolve();
  expect(compacted).toBe(false);
  finishTool.resolve();
  await Promise.all([compact, turn]);
  expect(executions).toBe(1);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.messages.at(-1)?.role).toBe('tool');
  expect(conversation.getMessagesForLLM().at(-1)?.content).toBe('task completed');
});

test('a failed compaction releases the paused turn on its original history', async () => {
  const started = deferred();
  let calls = 0;
  const { orchestrator, conversation } = fixture(async (request) => {
    if (++calls === 1) {
      started.resolve();
      return await new Promise<ChatResponse>((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('paused')), { once: true }));
    }
    expect(request.messages).toEqual([{ role: 'user', content: 'original task' }]);
    return answer('recovered');
  });
  const turn = orchestrator.handleUserInput('original task');
  await started.promise;
  await expect(orchestrator.withCompaction(async () => { throw new Error('extraction failed'); })).rejects.toThrow('extraction failed');
  await turn;
  expect(conversation.getMessagesForLLM().at(-1)?.content).toBe('recovered');
});

test('cancel while compacting preserves compacted history and never restarts generation', async () => {
  const started = deferred();
  const compacting = deferred();
  const release = deferred();
  let calls = 0;
  const { orchestrator, conversation } = fixture(async (request) => {
    calls += 1;
    started.resolve();
    return await new Promise<ChatResponse>((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('paused')), { once: true }));
  });
  const turn = orchestrator.handleUserInput('original task');
  await started.promise;
  const compact = orchestrator.withCompaction(async () => {
    compacting.resolve();
    await release.promise;
    conversation.replaceMessagesForLLM([{ role: 'user', content: 'preserved context' }]);
  });
  await compacting.promise;
  orchestrator.abort();
  release.resolve();
  await Promise.all([compact, turn]);
  expect(calls).toBe(1);
  expect(conversation.getMessagesForLLM()[0]?.content).toBe('preserved context');
  expect(conversation.getMessageSnapshot().some((message) => message.content === '[Response cancelled]')).toBe(true);
});

test('concurrent compactions serialize and queued input waits for them', async () => {
  const release = deferred();
  const entered = deferred();
  const delivered = deferred();
  const order: string[] = [];
  const { orchestrator, conversation } = fixture(async () => { order.push('chat'); delivered.resolve(); return answer('queued answer'); });
  const first = orchestrator.withCompaction(async () => {
    order.push('first');
    entered.resolve();
    await release.promise;
    conversation.replaceMessagesForLLM([{ role: 'user', content: 'summary' }]);
  });
  await entered.promise;
  const second = orchestrator.withCompaction(async () => { order.push('second'); });
  await orchestrator.handleUserInput('queued task');
  expect(order).toEqual(['first']);
  release.resolve();
  await Promise.all([first, second]);
  await delivered.promise;
  expect(order).toEqual(['first', 'second', 'chat']);
  expect(conversation.getMessagesForLLM().filter((message) => message.content === 'queued task')).toHaveLength(1);
});

test('a provider that finishes after the pause request cannot commit a stale answer', async () => {
  const started = deferred();
  const stale = deferred<ChatResponse>();
  let calls = 0;
  const { orchestrator, conversation } = fixture(async () => {
    if (++calls === 1) { started.resolve(); return await stale.promise; }
    return answer('fresh answer');
  });
  const turn = orchestrator.handleUserInput('task');
  await started.promise;
  const compact = orchestrator.withCompaction(async () => {
    expect(conversation.getMessagesForLLM().some((message) => message.content === 'stale answer')).toBe(false);
  });
  stale.resolve(answer('stale answer'));
  await Promise.all([compact, turn]);
  expect(conversation.getMessagesForLLM().at(-1)?.content).toBe('fresh answer');
});

test('idle compaction waits for an in-flight follow-up acknowledgement before replacing history', async () => {
  const started = deferred();
  const response = deferred<ChatResponse>();
  const { orchestrator, conversation } = fixture(async () => { started.resolve(); return await response.promise; });
  orchestrator.enqueueConversationFollowUp({ key: 'agent:done', summary: 'agent finished its work' });
  await started.promise;
  let compacted = false;
  const compact = orchestrator.withCompaction(async () => {
    expect(conversation.getMessagesForLLM().at(-1)?.content).toBe('agent acknowledgement');
    compacted = true;
  });
  await Promise.resolve();
  expect(compacted).toBe(false);
  response.resolve(answer('agent acknowledgement'));
  await compact;
  expect(compacted).toBe(true);
});
