/**
 * daemon-channel-continuation-tools.test.ts
 *
 * The tools a channel conversation is actually offered on a SERVED daemon.
 *
 * `createRuntimeServices` installs a continuation runner that spawns a
 * conversational turn with the conversational tool list (profile, read, find,
 * fetch). `DaemonServer` then installs its OWN runner over it
 * (`configureDaemonSessionContinuation`). That runner used to spawn with no
 * tool list and a bare `shared-session:<id>` context, so a Telegram follow-up
 * queued behind a running turn was offered read, write, edit, find, exec,
 * analyze, inspect, fetch and registry, and not `profile`.
 *
 * Nothing here stubs a runner. Both cases run through the real composition:
 * the daemon's broker, the daemon's conversation gate, the daemon's
 * AgentManager, and a scripted provider that records the tool definitions it
 * was sent. A follow-up is continued the way it is in production, the first
 * agent finishes, AGENT_COMPLETED reaches the broker over the runtime bus, and
 * the broker hands the queued input to whichever runner is installed.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { DaemonServer } from '../packages/sdk/src/platform/daemon/facade.js';
import { gateSurfaceSpawn } from '../packages/sdk/src/platform/daemon/surface-conversation-gate.js';
import type { DaemonSurfaceActionHelper } from '../packages/sdk/src/platform/daemon/surface-actions.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createRuntimeServices, type RuntimeServices } from '../packages/sdk/src/platform/runtime/services.js';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.js';
import type { ChatRequest, ChatResponse, LLMProvider } from '../packages/sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry.js';
import { trackDisposables } from './_helpers/disposables.ts';

const PROVIDER = 'scripted';
const MODEL = 'scripted-1';
const WAIT_MS = 15_000;

const FIRST_MESSAGE = 'Hey, are you there?';
const FOLLOW_UP = 'Hey, are you still there?';

/** Tools a conversational turn must have. */
const REQUIRED = ['profile', 'read'];
/** Tools a conversational turn must never be offered: it cannot start work. */
const FORBIDDEN = ['write', 'edit', 'exec'];

const disposables = trackDisposables();
const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Harness {
  readonly services: RuntimeServices;
  readonly daemon: DaemonServer;
  /** Every request the scripted provider received, in order. */
  readonly requests: ChatRequest[];
  /** Lets the first model call (the running turn) return. */
  readonly releaseFirst: () => void;
}

function text(content: string): ChatResponse {
  return { content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' };
}

function requestText(request: ChatRequest): string {
  return JSON.stringify(request.messages ?? []);
}

function toolNames(request: ChatRequest): string[] {
  return (request.tools ?? []).map((tool) => tool.name);
}

async function waitFor<T>(what: string, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

function buildHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-channel-continuation-tools-'));
  tmpRoots.push(root);
  const workingDir = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });

  const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: 'goodvibes-test' });
  // Nobody answers permission prompts here; the turns under test call no tools.
  configManager.set('permissions.backgroundAgents', 'allow-all');

  const requests: ChatRequest[] = [];
  let release: () => void = () => {};
  const firstMayReturn = new Promise<void>((resolve) => { release = resolve; });
  let heldFirst = false;

  const provider = {
    name: PROVIDER,
    models: [MODEL],
    credentialAuthority: 'anonymous',
    modelSource: { kind: 'dated-static', asOf: '2026-01-01' },
    isConfigured: () => true,
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      // The first conversational turn stays running until the test has queued
      // its follow-up behind it.
      if (!heldFirst && requestText(request).includes(FIRST_MESSAGE)) {
        heldFirst = true;
        await firstMayReturn;
      }
      return text('I am here.');
    },
  } as unknown as LLMProvider;

  const services = disposables.add(createRuntimeServices({
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    getConversationTitle: () => 'channel continuation tools',
    workingDir,
    homeDirectory,
  }));
  services.providerRegistry.registerRuntimeProvider({
    provider,
    models: [{
      id: MODEL, provider: PROVIDER, registryKey: `${PROVIDER}:${MODEL}`, displayName: MODEL, description: 'scripted',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
      contextWindow: 200_000, selectable: true, tier: 'standard',
    } as unknown as ModelDefinition],
    replace: true,
  });
  services.providerRegistry.setCurrentModel(`${PROVIDER}:${MODEL}`);

  // Composing the daemon over these services is what replaces the runtime's
  // continuation runner with the facade's. The injected graph is the test's to
  // dispose (see daemon-agent-knowledge-routes.test.ts).
  const daemon = new DaemonServer({ runtimeServices: services });
  return { services, daemon, requests, releaseFirst: () => release() };
}

/**
 * Start the first turn of a Telegram conversation the way an adapter does:
 * the broker records the message, and the spawn goes through the daemon's own
 * conversation gate, which is what every channel adapter's `trySpawnAgent` is.
 */
async function startTelegramConversation(harness: Harness): Promise<{ sessionId: string; agentId: string }> {
  const broker = harness.services.sessionBroker;
  const submission = await broker.submitMessage({
    surfaceKind: 'telegram',
    surfaceId: 'telegram:bot-1',
    externalId: 'chat-1',
    threadId: 'chat-1',
    userId: '42',
    title: 'Telegram',
    body: FIRST_MESSAGE,
  });
  expect(submission.mode).toBe('spawn');
  const helper = (harness.daemon as unknown as { surfaceActionHelper: DaemonSurfaceActionHelper }).surfaceActionHelper;
  const spawned = gateSurfaceSpawn(
    helper.conversationGateDeps(),
    { surface: 'telegram', text: FIRST_MESSAGE, userId: '42', channelId: 'chat-1', threadId: 'chat-1' },
    { mode: 'spawn', task: submission.task! },
    'test.telegramFirstTurn',
    submission.session.id,
  );
  if (spawned instanceof Response) {
    throw new Error(`first turn was not spawned: ${await spawned.text()}`);
  }
  await broker.bindAgent(submission.session.id, spawned.id);
  return { sessionId: submission.session.id, agentId: spawned.id };
}

function expectConversationalTools(request: ChatRequest): void {
  const names = toolNames(request);
  for (const tool of REQUIRED) expect(names).toContain(tool);
  for (const tool of FORBIDDEN) expect(names).not.toContain(tool);
}

describe('a served daemon offers a channel conversation the conversational tools', () => {
  test('the first turn of a Telegram conversation', async () => {
    const harness = buildHarness();
    try {
      await startTelegramConversation(harness);
      const first = await waitFor('the first turn to reach the provider', () =>
        harness.requests.find((r) => requestText(r).includes(FIRST_MESSAGE)));
      expectConversationalTools(first);
    } finally {
      harness.releaseFirst();
    }
  }, WAIT_MS + 5_000);

  test('a follow-up queued behind a running turn, once it is continued', async () => {
    const harness = buildHarness();
    try {
      const { sessionId, agentId } = await startTelegramConversation(harness);
      await waitFor('the first turn to be running in the provider', () =>
        harness.requests.some((r) => requestText(r).includes(FIRST_MESSAGE)) ? true : undefined);

      const followUp = await harness.services.sessionBroker.followUpMessage({
        sessionId,
        surfaceKind: 'telegram',
        surfaceId: 'telegram:bot-1',
        externalId: 'chat-1',
        threadId: 'chat-1',
        userId: '42',
        title: 'Telegram',
        body: FOLLOW_UP,
      });
      expect(followUp.mode).toBe('queued-follow-up');
      expect(followUp.activeAgentId).toBe(agentId);

      // The running turn finishes; the broker continues the queued follow-up
      // through the runner the daemon installed.
      harness.releaseFirst();
      const continued = await waitFor('the continued turn to reach the provider', () =>
        harness.requests.find((r) => requestText(r).includes(FOLLOW_UP)));

      expectConversationalTools(continued);
    } finally {
      harness.releaseFirst();
    }
  }, WAIT_MS + 5_000);
});
