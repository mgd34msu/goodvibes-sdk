/**
 * homeassistant-grounding.test.ts
 *
 * The Home Assistant conversation turn can reference the pre-registered
 * home-graph knowledge space: when the input carries a grounding reference and
 * a home-graph reader is wired, resolveHomeAssistantChatSession consults the
 * graph (HomeGraphService.ask) and folds the retrieved grounding into the
 * turn's system prompt. Without a reference (or reader) the turn stays
 * ungrounded, and a graph failure never breaks the turn.
 */
import { describe, expect, test } from 'bun:test';
import {
  resolveHomeAssistantChatSession,
  type HomeAssistantChatInput,
  type HomeAssistantChatRuntime,
  type HomeGraphGroundingReader,
} from '../packages/sdk/src/platform/daemon/homeassistant-chat.js';
import type { CompanionChatManager } from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import type { CompanionChatSession } from '../packages/sdk/src/platform/companion/companion-chat-types.js';
import type { AutomationRouteBinding } from '../packages/sdk/src/platform/automation/routes.js';
import type { HomeGraphAskInput, HomeGraphAskResult } from '../packages/sdk/src/platform/knowledge/home-graph/types.js';

interface Harness {
  runtime: HomeAssistantChatRuntime;
  lastSystemPrompt(): string | undefined;
  askedQueries: HomeGraphAskInput[];
}

function makeHarness(reader?: HomeGraphGroundingReader): Harness {
  let created: string | undefined;
  const askedQueries: HomeGraphAskInput[] = [];
  const session = (systemPrompt: string): CompanionChatSession => {
    created = systemPrompt;
    return {
      id: 'chat-1',
      title: 'Home Assistant',
      status: 'active',
      updatedAt: Date.now(),
    } as unknown as CompanionChatSession;
  };
  const chatManager = {
    init: async () => {},
    getSession: () => null,
    closeSession: () => {},
    createSession: (input: { systemPrompt: string }) => session(input.systemPrompt),
    updateSession: (_id: string, input: { systemPrompt: string }) => session(input.systemPrompt),
  } as unknown as CompanionChatManager;
  const binding: AutomationRouteBinding = { id: 'bind-1', metadata: {} } as unknown as AutomationRouteBinding;
  const routeBindings = {
    start: async () => {},
    upsertBinding: async () => binding,
    patchBinding: async () => binding,
  };
  const wrappedReader: HomeGraphGroundingReader | undefined = reader && {
    ask: (input) => {
      askedQueries.push(input);
      return reader.ask(input);
    },
  };
  const runtime: HomeAssistantChatRuntime = {
    configManager: { get: () => undefined },
    routeBindings: routeBindings as unknown as HomeAssistantChatRuntime['routeBindings'],
    chatManager,
    ...(wrappedReader ? { homeGraph: wrappedReader } : {}),
  };
  return { runtime, lastSystemPrompt: () => created, askedQueries };
}

function makeInput(overrides: Partial<HomeAssistantChatInput> = {}): HomeAssistantChatInput {
  return {
    text: 'What thermostats are in the living room?',
    messageId: 'm-1',
    conversationId: 'conv-1',
    surfaceId: 'homeassistant',
    channelId: 'living_room',
    title: 'Home Assistant',
    remoteSessionTtlMs: 60_000,
    ...overrides,
  };
}

function askResult(text: string, confidence: number): HomeGraphAskResult {
  return {
    ok: true,
    spaceId: 'homeassistant:home-1',
    query: 'q',
    answer: { text, mode: 'concise', confidence, sources: [], linkedObjects: [] },
  } as unknown as HomeGraphAskResult;
}

describe('Home Assistant home-graph grounding', () => {
  test('a grounding reference folds the graph answer into the system prompt', async () => {
    const reader: HomeGraphGroundingReader = {
      ask: async () => askResult('The living room has a Nest thermostat (climate.living_room).', 0.9),
    };
    const harness = makeHarness(reader);
    await resolveHomeAssistantChatSession(harness.runtime, makeInput({ grounding: { installationId: 'home-1' } }));
    const prompt = harness.lastSystemPrompt();
    expect(prompt).toContain('Home graph grounding');
    expect(prompt).toContain('Nest thermostat');
    expect(prompt).toContain('confidence 90%');
    // the turn's actual question is the query sent to the graph
    expect(harness.askedQueries[0]!.query).toBe('What thermostats are in the living room?');
    expect(harness.askedQueries[0]!.installationId).toBe('home-1');
  });

  test('no grounding reference -> no graph query, no grounding block', async () => {
    const reader: HomeGraphGroundingReader = { ask: async () => askResult('unused', 0.5) };
    const harness = makeHarness(reader);
    await resolveHomeAssistantChatSession(harness.runtime, makeInput());
    expect(harness.askedQueries).toHaveLength(0);
    expect(harness.lastSystemPrompt()).not.toContain('Home graph grounding');
  });

  test('an empty graph answer adds no grounding block', async () => {
    const reader: HomeGraphGroundingReader = { ask: async () => askResult('   ', 0.0) };
    const harness = makeHarness(reader);
    await resolveHomeAssistantChatSession(harness.runtime, makeInput({ grounding: { knowledgeSpaceId: 'homeassistant:home-1' } }));
    expect(harness.lastSystemPrompt()).not.toContain('Home graph grounding');
  });

  test('a graph failure degrades to an ungrounded turn, never breaking it', async () => {
    const reader: HomeGraphGroundingReader = {
      ask: async () => {
        throw new Error('graph unavailable');
      },
    };
    const harness = makeHarness(reader);
    const resolution = await resolveHomeAssistantChatSession(harness.runtime, makeInput({ grounding: { installationId: 'home-1' } }));
    expect(resolution.session.id).toBe('chat-1');
    expect(harness.lastSystemPrompt()).not.toContain('Home graph grounding');
  });
});
