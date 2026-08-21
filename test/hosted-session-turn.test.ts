/**
 * hosted-session-turn.test.ts
 *
 * A real turn, in a real hosted session, against a stub provider.
 *
 * Everything else about hosted sessions can be true while the one claim that
 * matters is false: that this is the SAME loop a terminal runs, not a lighter
 * one wearing its name. So this drives an actual turn, model call, tool call,
 * tool result, second model call, through `createHostedSessionRuntime` over a
 * real client floor, and checks the three things that make it that loop:
 *
 *  - the tool the model asked for actually ran, out of the registry
 *    `registerAllTools` built, rooted at THIS session's workspace;
 *  - the turn's events reached the runtime bus stamped with this session's id,
 *    which is what lets an attached client watch a hosted turn over the SSE
 *    stream it already uses for a local one;
 *  - the transcript is the session's own, and survives a round trip through the
 *    persistence shape.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.ts';
import { createClientRuntimeServices, type ClientRuntimeServices } from '../packages/sdk/src/platform/runtime/client-services.ts';
import { createHostedSessionRuntime } from '../packages/sdk/src/platform/hosted-sessions/session-runtime.ts';
import type { ChatRequest, ChatResponse, LLMProvider } from '../packages/sdk/src/platform/providers/interface.ts';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry.ts';
import type { PermissionPromptDecision } from '../packages/sdk/src/platform/permissions/prompt.ts';

const PROVIDER = 'stub';
const MODEL = 'stub-1';

let root: string;
let workspace: string;
let services: ClientRuntimeServices;
let runtimeBus: RuntimeEventBus;
/** What the stub was asked, turn by turn. */
let requests: ChatRequest[];
/** The answers the stub gives, in order. */
let answers: ChatResponse[];

function textAnswer(content: string): ChatResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'completed',
  };
}

function stubProvider(): LLMProvider {
  return {
    name: PROVIDER,
    models: [MODEL],
    credentialAuthority: 'anonymous',
    modelSource: { kind: 'dated-static', asOf: '2026-01-01' },
    isConfigured: () => true,
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      return answers.shift() ?? textAnswer('nothing left to say');
    },
  } as unknown as LLMProvider;
}

function stubModel(): ModelDefinition {
  return {
    id: MODEL,
    provider: PROVIDER,
    registryKey: `${PROVIDER}:${MODEL}`,
    displayName: MODEL,
    description: 'a stub',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
    tier: 'standard',
  } as unknown as ModelDefinition;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-turn-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'note.txt'), 'the file this session can read\n');
  requests = [];
  answers = [];
  runtimeBus = new RuntimeEventBus();

  const configManager = new ConfigManager({
    surfaceRoot: 'goodvibes',
    configDir: join(root, 'cfg'),
    workingDir: workspace,
    homeDir: root,
  });
  // Everything this turn does is allowed: the permission gate is not what is
  // under test here (the trust-gated ask has its own suites), and a decline
  // would make the tool result an honest refusal rather than a read.
  const approveEverything = async (): Promise<PermissionPromptDecision> => ({ approved: true });

  services = createClientRuntimeServices({
    configManager,
    runtimeBus,
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    workingDir: workspace,
    homeDirectory: root,
    requestApproval: approveEverything,
    modelDiscovery: 'skip',
  });
  services.providerRegistry.registerRuntimeProvider({
    provider: stubProvider(),
    models: [stubModel()],
    replace: true,
  });
  services.providerRegistry.setCurrentModel(`${PROVIDER}:${MODEL}`);
});

afterEach(() => {
  services.dispose();
  rmSync(root, { recursive: true, force: true });
});

test('a hosted session runs a real turn and the transcript is its own', async () => {
  answers.push(textAnswer('I read nothing; here is a plain answer.'));
  const session = createHostedSessionRuntime({
    sessionId: 'hosted-turn-1',
    workspaceRoot: workspace,
    floor: { services, dispose: (): void => {} },
    systemPrompt: 'you are hosted by the daemon',
  });

  await session.submit('say something');

  expect(requests).toHaveLength(1);
  // The system prompt this session was composed with reached the model.
  expect(requests[0]!.systemPrompt).toContain('you are hosted by the daemon');
  // And the tool registry the loop was built with is a real one.
  expect(requests[0]!.tools?.length ?? 0).toBeGreaterThan(0);

  const transcript = session.conversation.getMessageSnapshot();
  expect(transcript.some((m) => m.role === 'user' && m.content === 'say something')).toBe(true);
  expect(transcript.some((m) => m.role === 'assistant')).toBe(true);
  session.dispose();
});

test('a tool the model calls actually runs, rooted at this session\'s workspace', async () => {
  answers.push({
    content: '',
    toolCalls: [{ id: 'call-1', name: 'read', arguments: { files: [{ path: 'note.txt' }] } }],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'tool_call',
  } as unknown as ChatResponse);
  answers.push(textAnswer('The note says what it says.'));

  const session = createHostedSessionRuntime({
    sessionId: 'hosted-turn-2',
    workspaceRoot: workspace,
    floor: { services, dispose: (): void => {} },
    systemPrompt: 'hosted',
  });

  await session.submit('read the note');

  // Two model calls: the one that asked for the tool, and the one that saw its
  // result. That round trip IS the tool-use loop.
  expect(requests).toHaveLength(2);
  const secondCallMessages = JSON.stringify(requests[1]!.messages);
  // The file's real content came back through the registry's read tool, which
  // means the registry was rooted at this workspace and the tool ran here.
  expect(secondCallMessages).toContain('the file this session can read');
  session.dispose();
});

test('turn events reach the runtime bus stamped with this session\'s id', async () => {
  const seen: { type: string; sessionId: string | undefined }[] = [];
  for (const type of ['TURN_SUBMITTED', 'TURN_COMPLETED'] as const) {
    runtimeBus.on(type, (envelope) => {
      seen.push({ type, sessionId: envelope.sessionId });
    });
  }
  answers.push(textAnswer('done'));

  const session = createHostedSessionRuntime({
    sessionId: 'hosted-turn-3',
    workspaceRoot: workspace,
    floor: { services, dispose: (): void => {} },
    systemPrompt: 'hosted',
  });
  await session.submit('go');

  // This is the whole streaming story: no new channel, because the events a
  // client already watches carry the hosted session's id.
  expect(seen.map((entry) => entry.type)).toEqual(['TURN_SUBMITTED', 'TURN_COMPLETED']);
  expect(new Set(seen.map((entry) => entry.sessionId))).toEqual(new Set(['hosted-turn-3']));
  session.dispose();
});

test('the transcript survives the persistence round trip a restart replays', async () => {
  answers.push(textAnswer('remember this'));
  const first = createHostedSessionRuntime({
    sessionId: 'hosted-turn-4',
    workspaceRoot: workspace,
    floor: { services, dispose: (): void => {} },
    systemPrompt: 'hosted',
  });
  await first.submit('the thing to remember');
  const payload = first.conversation.toJSON();
  first.dispose();

  const second = createHostedSessionRuntime({
    sessionId: 'hosted-turn-4',
    workspaceRoot: workspace,
    floor: { services, dispose: (): void => {} },
    systemPrompt: 'hosted',
  });
  second.conversation.fromJSON(payload as Parameters<typeof second.conversation.fromJSON>[0]);

  const restored = second.conversation.getMessageSnapshot();
  expect(restored.some((m) => m.role === 'user' && m.content === 'the thing to remember')).toBe(true);
  expect(restored.some((m) => m.role === 'assistant' && String(m.content).includes('remember this'))).toBe(true);
  second.dispose();
});

test('two hosted sessions in one workspace keep separate transcripts', async () => {
  answers.push(textAnswer('answer for a'), textAnswer('answer for b'));
  const floor = { services, dispose: (): void => {} };
  const a = createHostedSessionRuntime({ sessionId: 'hosted-a', workspaceRoot: workspace, floor, systemPrompt: 'hosted' });
  const b = createHostedSessionRuntime({ sessionId: 'hosted-b', workspaceRoot: workspace, floor, systemPrompt: 'hosted' });

  await a.submit('question a');
  await b.submit('question b');

  const aText = JSON.stringify(a.conversation.getMessageSnapshot());
  const bText = JSON.stringify(b.conversation.getMessageSnapshot());
  expect(aText).toContain('question a');
  expect(aText).not.toContain('question b');
  expect(bText).toContain('question b');
  expect(bText).not.toContain('question a');
  // The file cache and project index they share are per-workspace by design;
  // the conversation is not, and that is the split the engine rests on.
  expect(readFileSync(join(workspace, 'note.txt'), 'utf-8')).toContain('the file this session can read');
  a.dispose();
  b.dispose();
});
