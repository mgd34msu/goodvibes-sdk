/**
 * UnifiedRewindService — plan/apply over the existing history stores.
 *
 * Covers the dry-run preview + confirm-token gate, the symmetric undo point the
 * apply records (restore-the-restore), honest degradation when a store is not
 * wired, and the receipt events surfaces render.
 */
import { describe, expect, test } from 'bun:test';
import {
  UnifiedRewindService,
  RewindTokenError,
  type RewindAnchor,
  type RewindCheckpointView,
  type RewindConversationPort,
  type RewindRestoreResult,
  type RewindWorkspacePort,
} from '../packages/sdk/src/platform/rewind/index.js';
import { ConversationRewindHostBroker } from '../packages/sdk/src/platform/rewind/conversation-host-broker.js';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.js';
import {
  createConversationRewindHostBroker,
  registerRewindConversationHostGatewayMethods,
} from '../packages/sdk/src/platform/control-plane/routes/rewind-conversation-hosts.js';
import type { WorkspaceEvent } from '../packages/sdk/src/events/workspace.js';

function fakeWorkspace(overrides: Partial<{
  checkpoints: RewindCheckpointView[];
  restore: RewindRestoreResult;
  diffFiles: string[];
  restoreCalls: Array<{ id: string; safety: boolean | undefined }>;
}> = {}): RewindWorkspacePort {
  const checkpoints = overrides.checkpoints ?? [
    { id: 'wcp_a', turnId: 'turn-1', createdAt: 100, label: 'turn 1' },
    { id: 'wcp_b', turnId: 'turn-2', createdAt: 200, label: 'turn 2' },
  ];
  const restoreResult = overrides.restore ?? {
    checkpointId: 'wcp_a',
    safetyCheckpointId: 'wcp_safety',
    restoredFiles: ['src/a.ts', 'src/b.ts'],
    removedFiles: ['src/c.ts'],
  };
  const restoreCalls = overrides.restoreCalls ?? [];
  return {
    list: async (filter) => checkpoints.filter((c) => !filter?.sessionId || true),
    diff: async () => ({ files: overrides.diffFiles ?? ['src/a.ts', 'src/b.ts', 'src/c.ts'] }),
    restore: async (id, opts) => {
      restoreCalls.push({ id, safety: opts?.safetyCheckpoint });
      return { ...restoreResult, checkpointId: id };
    },
  };
}

const fakeConversation: RewindConversationPort = {
  preview: async () => ({ messagesToDrop: 4, messagesRemaining: 10 }),
  rewind: async () => ({ droppedMessages: 4, undoSnapshotId: 'conv_undo_1' }),
};

const anchor: RewindAnchor = { sessionId: 's1', turnId: 'turn-1' };

describe('rewind.plan — dry-run preview + confirm token', () => {
  test('files plan resolves the anchor checkpoint and its affected file count', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const plan = await service.plan(anchor, 'files');
    expect(plan.files).toEqual({ available: true, checkpointId: 'wcp_a', checkpointLabel: 'turn 1', affectedFileCount: 3 });
    expect(plan.conversation).toBeNull();
    expect(plan.token).toBeTruthy();
    expect(plan.expiresAt).toBeGreaterThan(0);
    expect(plan.warnings).toHaveLength(0);
  });

  test('conversation is reported unavailable (with a warning) when no store is wired', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const plan = await service.plan(anchor, 'both');
    expect(plan.conversation).toEqual({ available: false, messagesToDrop: 0, messagesRemaining: 0 });
    expect(plan.warnings.join(' ')).toContain('conversation rewind unavailable');
  });

  test('conversation plan uses the wired port', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace(), conversation: fakeConversation });
    const plan = await service.plan(anchor, 'conversation');
    expect(plan.conversation).toEqual({ available: true, messagesToDrop: 4, messagesRemaining: 10 });
    expect(plan.files).toBeNull();
  });

  test('with no turnId, the most-recent checkpoint for the session is chosen', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const plan = await service.plan({ sessionId: 's1' }, 'files');
    expect(plan.files?.checkpointId).toBe('wcp_b'); // createdAt 200 > 100
  });
});

describe('rewind.apply — confirm gate', () => {
  test('an unconfirmed apply returns a non-error refusal naming rewind.plan', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const result = await service.apply(anchor, 'files', {});
    expect(result.refused).toBe(true);
    expect(result.receipt).toBeNull();
    expect(result.refusal?.planMethod).toBe('rewind.plan');
    expect(result.refusal?.options).toEqual(['confirm', 'confirmToken']);
  });

  test('a valid confirm token authorizes the apply and is single-use', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const plan = await service.plan(anchor, 'files');
    const first = await service.apply(anchor, 'files', { confirmToken: plan.token });
    expect(first.refused).toBe(false);
    expect(first.receipt?.files?.restored).toBe(true);
    // Token is spent — a replay is rejected.
    await expect(service.apply(anchor, 'files', { confirmToken: plan.token })).rejects.toBeInstanceOf(RewindTokenError);
  });

  test('a token minted for one scope does not authorize a different scope', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const plan = await service.plan(anchor, 'files');
    await expect(service.apply(anchor, 'both', { confirmToken: plan.token })).rejects.toBeInstanceOf(RewindTokenError);
  });

  test('confirm:true bypasses the token', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const result = await service.apply(anchor, 'files', { confirm: true });
    expect(result.refused).toBe(false);
    expect(result.receipt?.files?.restored).toBe(true);
  });
});

describe('rewind.apply — symmetric undo point (restore-the-restore)', () => {
  test('applying files records the pre-restore safety checkpoint as the undo point', async () => {
    const restoreCalls: Array<{ id: string; safety: boolean | undefined }> = [];
    const service = new UnifiedRewindService({ workspace: fakeWorkspace({ restoreCalls }) });
    const receipt = (await service.apply(anchor, 'files', { confirm: true })).receipt!;
    // The workspace restore was asked to take a safety checkpoint.
    expect(restoreCalls).toEqual([{ id: 'wcp_a', safety: true }]);
    expect(receipt.files?.safetyCheckpointId).toBe('wcp_safety');
    // The receipt's undo block points back at that safety checkpoint — reversing the rewind.
    expect(receipt.undo.files).toEqual({ restoreCheckpointId: 'wcp_safety' });
    expect(receipt.files?.restoredFileCount).toBe(2);
    expect(receipt.files?.removedFileCount).toBe(1);
  });

  test('both scope records undo points for files and conversation', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace(), conversation: fakeConversation });
    const receipt = (await service.apply(anchor, 'both', { confirm: true })).receipt!;
    expect(receipt.undo.files).toEqual({ restoreCheckpointId: 'wcp_safety' });
    expect(receipt.undo.conversation).toEqual({ undoSnapshotId: 'conv_undo_1' });
    expect(receipt.conversation?.droppedMessages).toBe(4);
  });

  test('a no-op safety checkpoint (null) yields no files undo point', async () => {
    const service = new UnifiedRewindService({
      workspace: fakeWorkspace({ restore: { checkpointId: 'wcp_a', safetyCheckpointId: null, restoredFiles: [], removedFiles: [] } }),
    });
    const receipt = (await service.apply(anchor, 'files', { confirm: true })).receipt!;
    expect(receipt.undo.files).toBeNull();
  });
});

describe('rewind — receipt events', () => {
  test('plan emits REWIND_PLANNED and apply emits REWIND_APPLIED', async () => {
    const events: Array<{ event: WorkspaceEvent; sessionId: string }> = [];
    const service = new UnifiedRewindService({
      workspace: fakeWorkspace(),
      conversation: fakeConversation,
      emit: (event, sessionId) => events.push({ event, sessionId }),
    });
    const plan = await service.plan(anchor, 'both');
    await service.apply(anchor, 'both', { confirmToken: plan.token });
    const types = events.map((e) => e.event.type);
    expect(types).toEqual(['REWIND_PLANNED', 'REWIND_APPLIED']);
    const applied = events[1]!.event;
    if (applied.type === 'REWIND_APPLIED') {
      expect(applied.filesRestored).toBe(true);
      expect(applied.conversationRewound).toBe(true);
      expect(applied.undoAvailable).toBe(true);
      expect(applied.scope).toBe('both');
    }
    expect(events[0]!.sessionId).toBe('s1');
  });
});

// ---------------------------------------------------------------------------
// Conversation-scope rewind served by the surface hosting the conversation.
//
// The gap this closes: the daemon wired a conversation port whose registry
// nothing outside the daemon could populate, so a rewind of a session hosted by
// a client answered "0 messages to drop" — indistinguishable from a session
// already at the anchor. Exercised over a real GatewayMethodCatalog with the
// handlers attached the way the daemon attaches them.
// ---------------------------------------------------------------------------

const HOST_CONTEXT = { context: { admin: true } } as const;

interface HostHarness {
  readonly catalog: GatewayMethodCatalog;
  readonly broker: ConversationRewindHostBroker;
  readonly rewind: UnifiedRewindService;
}

function hostHarness(options: {
  readonly fallback?: RewindConversationPort | null | undefined;
  readonly answerTimeoutMs?: number | undefined;
} = {}): HostHarness {
  const broker = createConversationRewindHostBroker({
    fallback: options.fallback ?? null,
    ...(options.answerTimeoutMs === undefined ? {} : { answerTimeoutMs: options.answerTimeoutMs }),
  });
  const catalog = new GatewayMethodCatalog();
  registerRewindConversationHostGatewayMethods(catalog, broker);
  const rewind = new UnifiedRewindService({ workspace: null, conversation: broker });
  return { catalog, broker, rewind };
}

async function registerHost(h: HostHarness, sessionId: string, label = 'the terminal app'): Promise<string> {
  const result = await h.catalog.invoke('rewind.conversation.host.register', {
    ...HOST_CONTEXT,
    body: { sessionId, label },
  }) as { host: { hostId: string }; renewed: boolean };
  return result.host.hostId;
}

/** Serve one request the way a surface's poll loop would, then return it. */
async function serveOne(
  h: HostHarness,
  hostId: string,
  answer: Record<string, unknown>,
): Promise<{ kind: string; requestId: string }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const taken = await h.catalog.invoke('rewind.conversation.requests.take', {
      ...HOST_CONTEXT,
      body: { hostId, waitMs: 50 },
    }) as { requests: readonly { requestId: string; kind: string }[] };
    const request = taken.requests[0];
    if (!request) continue;
    await h.catalog.invoke('rewind.conversation.requests.answer', {
      ...HOST_CONTEXT,
      body: { hostId, requestId: request.requestId, ...answer },
    });
    return request;
  }
  throw new Error('no conversation rewind request arrived');
}

describe('conversation rewind hosts', () => {
  test('every host verb is cataloged, handled, ws-only, and session-scoped', () => {
    const { catalog } = hostHarness();
    const expected: Readonly<Record<string, string>> = {
      'rewind.conversation.host.register': 'write:sessions',
      'rewind.conversation.host.release': 'write:sessions',
      'rewind.conversation.hosts.list': 'read:sessions',
      'rewind.conversation.requests.take': 'read:sessions',
      'rewind.conversation.requests.answer': 'write:sessions',
    };
    for (const [id, scope] of Object.entries(expected)) {
      const descriptor = catalog.get(id);
      expect(descriptor, `${id} is not cataloged`).not.toBeNull();
      expect(catalog.hasHandler(id), `${id} has no handler`).toBe(true);
      expect(descriptor?.scopes).toEqual([scope]);
      expect(descriptor?.transport).toEqual(['ws']);
      expect(descriptor?.access).toBe('authenticated');
    }
  });

  test('with nobody hosting, the plan says so with a reason instead of reporting zero', async () => {
    const h = hostHarness();
    const plan = await h.rewind.plan({ sessionId: 'sess-1' }, 'conversation');
    expect(plan.conversation?.available).toBe(false);
    expect(plan.conversation?.messagesToDrop).toBe(0);
    // The distinction the old behaviour destroyed: "nobody can answer" is not
    // "there is nothing to drop", and the warning has to say which it is.
    expect(plan.warnings.join(' ')).toContain('no surface has offered a live conversation');
    expect(plan.warnings.join(' ')).toContain('sess-1');
  });

  test('a registered surface answers the plan, and the counts are its own', async () => {
    const h = hostHarness();
    const hostId = await registerHost(h, 'sess-1');
    const planned = h.rewind.plan({ sessionId: 'sess-1', turnId: 'turn-4' }, 'conversation');
    const served = await serveOne(h, hostId, { messagesToDrop: 6, messagesRemaining: 11 });
    expect(served.kind).toBe('preview');
    const plan = await planned;
    expect(plan.conversation).toEqual({ available: true, messagesToDrop: 6, messagesRemaining: 11 });
    expect(plan.warnings).toEqual([]);
  });

  test('an apply reaches the hosting surface and its receipt carries that surface\'s undo handle', async () => {
    const h = hostHarness();
    const hostId = await registerHost(h, 'sess-1');
    const applied = h.rewind.apply({ sessionId: 'sess-1', turnId: 'turn-4' }, 'conversation', { confirm: true });
    const served = await serveOne(h, hostId, { droppedMessages: 6, undoSnapshotId: 'rwc_from_the_surface' });
    expect(served.kind).toBe('rewind');
    const result = await applied;
    expect(result.receipt?.conversation).toEqual({
      rewound: true,
      droppedMessages: 6,
      undoSnapshotId: 'rwc_from_the_surface',
    });
    expect(result.receipt?.undo.conversation).toEqual({ undoSnapshotId: 'rwc_from_the_surface' });
  });

  test('a surface that says it cannot serve the request is reported as unavailable, with its words', async () => {
    const h = hostHarness();
    const hostId = await registerHost(h, 'sess-1');
    const planned = h.rewind.plan({ sessionId: 'sess-1' }, 'conversation');
    await serveOne(h, hostId, { unavailableReason: 'this session was closed while the request was in flight' });
    const plan = await planned;
    expect(plan.conversation?.available).toBe(false);
    expect(plan.warnings.join(' ')).toContain('closed while the request was in flight');
  });

  test('a surface that goes silent times out as unavailable, and a rewind never claims nothing was dropped', async () => {
    const h = hostHarness({ answerTimeoutMs: 60 });
    await registerHost(h, 'sess-1', 'the web app');
    const plan = await h.rewind.plan({ sessionId: 'sess-1' }, 'conversation');
    expect(plan.conversation?.available).toBe(false);
    expect(plan.warnings.join(' ')).toContain('did not answer within');

    const applied = await h.rewind.apply({ sessionId: 'sess-1' }, 'conversation', { confirm: true });
    expect(applied.receipt?.conversation?.rewound).toBe(false);
    // The one thing a timed-out rewind must not say is that the messages
    // survived: nobody here knows whether the surface truncated.
    expect(applied.receipt?.warnings.join(' ')).toContain('cannot be confirmed');
  });

  test('only the surface a request was put to can answer it, and only the host can release it', async () => {
    const h = hostHarness({ answerTimeoutMs: 5_000 });
    const hostId = await registerHost(h, 'sess-1');
    const planned = h.rewind.plan({ sessionId: 'sess-1' }, 'conversation');
    let taken: { requests: readonly { requestId: string }[] } = { requests: [] };
    for (let attempt = 0; attempt < 200 && taken.requests.length === 0; attempt += 1) {
      taken = await h.catalog.invoke('rewind.conversation.requests.take', {
        ...HOST_CONTEXT,
        body: { hostId, waitMs: 50 },
      }) as { requests: readonly { requestId: string }[] };
    }
    const requestId = taken.requests[0]?.requestId ?? '';

    await expect(h.catalog.invoke('rewind.conversation.requests.answer', {
      ...HOST_CONTEXT,
      body: { hostId: 'cvh_someone_else', requestId, messagesToDrop: 99, messagesRemaining: 0 },
    })).rejects.toThrow(/different surface|not registered/);

    await expect(h.catalog.invoke('rewind.conversation.host.release', {
      ...HOST_CONTEXT,
      body: { sessionId: 'sess-1', hostId: 'cvh_someone_else' },
    })).rejects.toThrow(/does not hold session/);

    // The real host closes it out so nothing is left waiting.
    await h.catalog.invoke('rewind.conversation.requests.answer', {
      ...HOST_CONTEXT,
      body: { hostId, requestId, messagesToDrop: 2, messagesRemaining: 3 },
    });
    expect((await planned).conversation?.messagesToDrop).toBe(2);
  });

  test('releasing answers what was outstanding rather than leaving it to time out', async () => {
    const h = hostHarness({ answerTimeoutMs: 5_000 });
    const hostId = await registerHost(h, 'sess-1');
    const planned = h.rewind.plan({ sessionId: 'sess-1' }, 'conversation');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const taken = await h.catalog.invoke('rewind.conversation.requests.take', {
        ...HOST_CONTEXT,
        body: { hostId, waitMs: 20 },
      }) as { requests: readonly unknown[] };
      if (taken.requests.length > 0) break;
    }
    await h.catalog.invoke('rewind.conversation.host.release', {
      ...HOST_CONTEXT,
      body: { sessionId: 'sess-1', hostId },
    });
    const plan = await planned;
    expect(plan.conversation?.available).toBe(false);
    expect(plan.warnings.join(' ')).toContain('released it');
    expect((await h.catalog.invoke('rewind.conversation.hosts.list', { ...HOST_CONTEXT, body: {} }) as {
      hosts: readonly unknown[];
    }).hosts).toEqual([]);
  });

  test('a re-registration renews, and a fresh claim replaces the surface that held the session', async () => {
    const h = hostHarness();
    const hostId = await registerHost(h, 'sess-1');
    const renewed = await h.catalog.invoke('rewind.conversation.host.register', {
      ...HOST_CONTEXT,
      body: { sessionId: 'sess-1', hostId },
    }) as { host: { hostId: string }; renewed: boolean };
    expect(renewed.renewed).toBe(true);
    expect(renewed.host.hostId).toBe(hostId);

    // A hostId that is not the session's host is refused rather than quietly
    // treated as a fresh claim.
    await expect(h.catalog.invoke('rewind.conversation.host.register', {
      ...HOST_CONTEXT,
      body: { sessionId: 'sess-1', hostId: 'cvh_not_the_host' },
    })).rejects.toThrow(/is not the registered host/);

    const claimed = await registerHost(h, 'sess-1', 'a second surface');
    expect(claimed).not.toBe(hostId);
    const hosts = (await h.catalog.invoke('rewind.conversation.hosts.list', { ...HOST_CONTEXT, body: {} }) as {
      hosts: readonly { hostId: string; label: string }[];
    }).hosts;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.label).toBe('a second surface');
    // The replaced surface can no longer take work for the session it lost.
    await expect(h.catalog.invoke('rewind.conversation.requests.take', {
      ...HOST_CONTEXT,
      body: { hostId },
    })).rejects.toThrow(/is not registered/);
  });

  test('a lapsed lease stops the surface being consulted, and says which surface lapsed', async () => {
    let clock = 1_000_000;
    const broker = createConversationRewindHostBroker({ now: () => clock });
    const host = broker.registerHost({ sessionId: 'sess-1', label: 'the terminal app', leaseMs: 5_000 });
    expect(broker.listHosts()).toHaveLength(1);
    clock += 5_001;
    const preview = await broker.preview({ sessionId: 'sess-1' });
    expect(preview.available).toBe(false);
    expect(broker.listHosts()).toEqual([]);
    expect(host.leaseExpiresAt).toBe(1_005_000);
  });

  test('a session the daemon hosts itself still reaches the in-process port', async () => {
    const inProcess: RewindConversationPort = {
      preview: async () => ({ messagesToDrop: 3, messagesRemaining: 7 }),
      rewind: async () => ({ droppedMessages: 3, undoSnapshotId: 'rwc_daemon' }),
    };
    const h = hostHarness({ fallback: inProcess });
    const plan = await h.rewind.plan({ sessionId: 'daemon-hosted' }, 'conversation');
    expect(plan.conversation).toEqual({ available: true, messagesToDrop: 3, messagesRemaining: 7 });

    // And a surface that registers for a session wins over the fallback for it,
    // because it is the process actually holding those messages.
    const hostId = await registerHost(h, 'daemon-hosted');
    const planned = h.rewind.plan({ sessionId: 'daemon-hosted' }, 'conversation');
    await serveOne(h, hostId, { messagesToDrop: 40, messagesRemaining: 1 });
    expect((await planned).conversation?.messagesToDrop).toBe(40);
  });

  test('an in-process port that reports unavailable is passed through, not overwritten with a zero', async () => {
    const silent: RewindConversationPort = {
      preview: async () => ({ messagesToDrop: 0, messagesRemaining: 0, available: false, unavailableReason: 'the daemon holds no conversation for this session' }),
      rewind: async () => ({ droppedMessages: 0, undoSnapshotId: '', available: false, unavailableReason: 'the daemon holds no conversation for this session' }),
    };
    const h = hostHarness({ fallback: silent });
    const plan = await h.rewind.plan({ sessionId: 'sess-1' }, 'conversation');
    expect(plan.conversation?.available).toBe(false);
    expect(plan.warnings.join(' ')).toContain('the daemon holds no conversation for this session');
  });

  test('shutdown answers everything outstanding rather than stranding a caller', async () => {
    const h = hostHarness({ answerTimeoutMs: 60_000 });
    await registerHost(h, 'sess-1');
    const planned = h.rewind.plan({ sessionId: 'sess-1' }, 'conversation');
    // Give the ask a tick to reach the broker's pending map.
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    h.broker.shutdown();
    const plan = await planned;
    expect(plan.conversation?.available).toBe(false);
    expect(plan.warnings.join(' ')).toContain('stopped serving conversation rewind');
  });
});
