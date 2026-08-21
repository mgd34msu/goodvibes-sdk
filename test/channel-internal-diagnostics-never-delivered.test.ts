/**
 * Internal tool-registry and tool-selection output must never reach a channel.
 *
 * The owner messaged the bot on Telegram and received these, as chat messages,
 * inside the exchange:
 *
 *     registry, email send
 *     fetch, standard
 *     find
 *     exec, standard
 *
 * That is `AgentRecord.progress`. The orchestrator writes the running tool's
 * name and a scrap of its arguments there for the TUI's activity surfaces, and
 * two routes carried it to the phone: the runtime `AGENT_PROGRESS` event, and
 * the daemon poller handing the raw string to `deliverProgress`. The channel
 * status renderer strips the `Turn 3 · ` prefix, so what landed was the bare
 * tool trace.
 *
 * The fix is an audience on the progress line, denied by default, checked at
 * the one place every channel's body is built (`eventLine`). These tests hold
 * that boundary on EVERY surface, because one renderer serves all of them.
 */
import { describe, expect, test } from 'bun:test';
import { ChannelReplyPipeline } from '../packages/sdk/src/platform/channels/reply-pipeline.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { emitAgentCompleted, emitAgentProgress } from '../packages/sdk/src/platform/runtime/emitters/agents.js';
import { eventLine, normalizeChannelRenderEventFromRuntime } from '../packages/sdk/src/platform/channels/reply-render.js';
import { DEFAULT_POLICY } from '../packages/sdk/src/platform/channels/reply-policy.js';
import {
  defaultRenderAudienceForKind,
  isOwnerFacingRenderEvent,
} from '../packages/sdk/src/platform/channels/render-audience.js';
import { summarizeToolArgs } from '../packages/sdk/src/platform/agents/orchestrator-utils.js';
import { setAgentProgress } from '../packages/sdk/src/platform/agents/progress-audience.js';
import type { ChannelRenderEvent, ChannelRenderEventKind, ChannelSurface } from '../packages/sdk/src/platform/channels/types.js';
import { waitFor } from './_helpers/test-timeout.js';

/** The exact lines the owner received. */
const LEAKED_LINES = ['registry — email send', 'fetch — standard', 'find', 'exec — standard', 'registry — gmail'] as const;

const ALL_SURFACES = Object.keys(DEFAULT_POLICY) as ChannelSurface[];

interface Published {
  readonly phase: string;
  readonly text: string;
}

function harness(surfaceKind: string) {
  const published: Published[] = [];
  let now = 2_000_000;
  const bus = new RuntimeEventBus();
  const channelPlugins = {
    getRenderPolicy: async () => null,
    render: async (_surface: string, request: { phase: string; text: string }) => {
      published.push({ phase: request.phase, text: request.text });
      return { delivered: true, metadata: {} };
    },
  };
  const pipeline = new ChannelReplyPipeline({
    channelPlugins,
    routeBindings: { captureReplyTarget: async () => {} },
    runtimeBus: bus,
    now: () => now,
  } as unknown as ConstructorParameters<typeof ChannelReplyPipeline>[0]);

  let sequence = 0;
  return {
    pipeline,
    published,
    bodies: () => published.map((entry) => entry.text),
    advance(ms: number) { now += ms; },
    track(agentId: string) {
      pipeline.trackPending({
        agentId,
        surfaceKind,
        task: 'send that email',
        createdAt: now,
        routeId: 'route-1',
      } as unknown as Parameters<ChannelReplyPipeline['trackPending']>[0]);
    },
    async progress(agentId: string, text: string, audience?: 'owner' | 'operator') {
      sequence += 1;
      emitAgentProgress(bus, {
        sessionId: 'test-session',
        traceId: `progress-${sequence}`,
        source: 'test',
        agentId,
      }, { agentId, progress: text, ...(audience ? { audience } : {}) });
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    },
    async complete(agentId: string, output: string) {
      sequence += 1;
      emitAgentCompleted(bus, {
        sessionId: 'test-session',
        traceId: `complete-${sequence}`,
        source: 'test',
        agentId,
      }, { agentId, durationMs: 5, output });
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    },
  };
}

describe('the exact leak the owner saw', () => {
  test('tool-activity progress never reaches a Telegram body, and the real answer still does', async () => {
    const h = harness('telegram');
    h.track('agent-telegram');
    // Exactly the sequence that produced the owner's screenshot: one registry
    // lookup, then the tools it turned up, all as orchestrator progress.
    for (const line of LEAKED_LINES) {
      h.advance(20_000);
      await h.progress('agent-telegram', `Turn 1 · ${line}`, 'operator');
    }
    await h.complete('agent-telegram', 'Sent. The message is on its way.');
    await waitFor(() => h.published.length > 0);

    const body = h.bodies().join('\n');
    for (const line of LEAKED_LINES) {
      expect(body).not.toContain(line);
    }
    // The reply that SHOULD have been there is untouched: the fix removes the
    // diagnostics, it does not silence the conversation.
    expect(body).toContain('Sent. The message is on its way.');
  });

  test('an UNMARKED progress line is treated as operator and dropped', async () => {
    const h = harness('telegram');
    h.track('agent-unmarked');
    h.advance(20_000);
    // No audience at all, an older emitter, a plugin, a caller that forgot.
    await h.progress('agent-unmarked', 'Turn 2 · registry — gmail');
    await h.complete('agent-unmarked', 'Done.');
    await waitFor(() => h.published.length > 0);
    expect(h.bodies().join('\n')).not.toContain('registry — gmail');
  });

  test('owner-facing progress still gets through — the fix is not a blanket mute', async () => {
    const h = harness('telegram');
    h.track('agent-owner-progress');
    // Past MIN_PROGRESS_NOTIFICATION_AGE_MS (30s), so a progress update is
    // worth interrupting for at all.
    h.advance(40_000);
    await h.progress('agent-owner-progress', 'Rate limited, retrying in 60s…', 'owner');
    await waitFor(() => h.published.length > 0);
    expect(h.bodies().join('\n')).toContain('Rate limited, retrying in 60s…');
  });
});

describe('every channel, not just the one that was reported', () => {
  for (const surface of ALL_SURFACES) {
    test(`${surface} drops tool-activity progress`, async () => {
      const h = harness(surface);
      h.track(`agent-${surface}`);
      h.advance(20_000);
      await h.progress(`agent-${surface}`, 'Turn 1 · registry — email send', 'operator');
      h.advance(20_000);
      await h.progress(`agent-${surface}`, 'Turn 1 · exec — standard', 'operator');
      await h.complete(`agent-${surface}`, 'All set.');
      await waitFor(() => h.published.length > 0);

      const body = h.bodies().join('\n');
      expect(body).not.toContain('registry — email send');
      expect(body).not.toContain('exec — standard');
      expect(body).toContain('All set.');
    });
  }
});

describe('the render boundary itself', () => {
  const KINDS: readonly ChannelRenderEventKind[] = [
    'assistant_text', 'reasoning', 'tool_start', 'tool_result', 'plan',
    'approval', 'command_output', 'patch', 'compaction', 'model', 'status', 'error',
  ];

  function evt(kind: ChannelRenderEventKind, extra: Partial<ChannelRenderEvent> = {}): ChannelRenderEvent {
    return { id: `x:${kind}`, kind, phase: 'progress', ts: 1, metadata: {}, text: 'diagnostic text', ...extra };
  }

  test('a diagnostic kind renders nothing, however it is dressed up', () => {
    for (const kind of ['tool_start', 'tool_result', 'plan', 'command_output', 'patch', 'compaction', 'model'] as const) {
      expect(defaultRenderAudienceForKind(kind)).toBe('operator');
      expect(eventLine(evt(kind, { toolName: 'registry', summary: 'email send' }), 'public')).toBeNull();
    }
  });

  test('every kind has an audience and the default denies for anything not explicitly the owner\'s', () => {
    const ownerKinds = KINDS.filter((kind) => defaultRenderAudienceForKind(kind) === 'owner');
    expect([...ownerKinds].sort()).toEqual(['approval', 'assistant_text', 'error', 'reasoning']);
  });

  test('an explicit operator stamp beats an otherwise owner-facing kind', () => {
    const event = evt('assistant_text', { audience: 'operator' });
    expect(isOwnerFacingRenderEvent(event)).toBe(false);
    expect(eventLine(event, 'public')).toBeNull();
  });

  test('AGENT_PROGRESS carries its audience into the render event', () => {
    const envelope = {
      type: 'AGENT_PROGRESS',
      ts: 1,
      traceId: 't',
      source: 's',
      payload: { type: 'AGENT_PROGRESS', agentId: 'a', progress: 'registry — gmail' },
    } as unknown as Parameters<typeof normalizeChannelRenderEventFromRuntime>[0];
    const [event] = normalizeChannelRenderEventFromRuntime(envelope);
    expect(event?.audience).toBe('operator');
    expect(eventLine(event!, 'public')).toBeNull();
  });
});

describe('the progress line itself', () => {
  test('setAgentProgress cannot leave the audience behind', () => {
    const record: { progress?: string; progressAudience?: 'owner' | 'operator' } = {};
    setAgentProgress(record, 'Turn 1 · registry — email send', 'operator');
    expect(record.progressAudience).toBe('operator');
    setAgentProgress(record, 'Rate limited, retrying in 60s…', 'owner');
    expect(record.progressAudience).toBe('owner');
  });

  test('a tool label never names an argument that has nothing to do with the call', () => {
    // `exec` puts its command one level down; the old flat scan missed it and
    // fell back to the first string it found, which was `verbosity: 'standard'`.
    expect(summarizeToolArgs({ commands: [{ cmd: 'git status' }], verbosity: 'standard' })).toBe(' — git status');
    expect(summarizeToolArgs({ urls: [{ url: 'https://example.com' }], verbosity: 'standard' })).toBe(' — https://example.com');
    // Nothing recognisable: say nothing rather than something misleading.
    expect(summarizeToolArgs({ verbosity: 'standard' })).toBe('');
    expect(summarizeToolArgs({ output: { format: 'standard' } })).toBe('');
  });
});
