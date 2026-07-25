/**
 * Confirmation routed back over the originating channel.
 *
 * A gate that requires walking to a terminal is the same friction with extra
 * steps, so agreement has to be answerable on whatever surface the proposal
 * went out on. This covers the shared ingress hook that every surface adapter
 * already calls:
 * - "yes" on the originating surface starts the work
 * - "no" declines and starts nothing
 * - an answer for a DIFFERENT surface does not resolve this surface's proposal
 * - a reply with nothing pending flows through as ordinary conversation
 * - an expired proposal is reported as expired and starts nothing
 */
import { describe, expect, test } from 'bun:test';
import {
  findProposalForReply,
  tryResolveWorkProposalReplyFromChannel,
} from '../packages/sdk/src/platform/daemon/work-proposal-reply.ts';
import { WorkProposalStore, type WorkProposalRecord } from '../packages/sdk/src/platform/agents/work-proposal-store.ts';
import type { ChannelIngressPolicyInput } from '../packages/sdk/src/platform/channels/index.ts';

function ingress(overrides: Partial<ChannelIngressPolicyInput> = {}): ChannelIngressPolicyInput {
  return {
    surface: 'ntfy',
    text: 'yes',
    userId: 'owner',
    channelId: 'goodvibes-agent',
    ...overrides,
  } as ChannelIngressPolicyInput;
}

function harness(options: { now?: () => number } = {}) {
  const store = new WorkProposalStore(options.now ? { now: options.now } : {});
  const started: Array<{ proposal: WorkProposalRecord; note?: string | undefined }> = [];
  const replies: Array<{ proposal: WorkProposalRecord; text: string }> = [];
  const deps = {
    proposals: store,
    startAgreedWork: async (proposal: WorkProposalRecord, note?: string) => {
      started.push({ proposal, ...(note ? { note } : {}) });
    },
    replyOnChannel: async (proposal: WorkProposalRecord, text: string) => {
      replies.push({ proposal, text });
    },
  };
  return { store, started, replies, deps };
}

describe('tryResolveWorkProposalReplyFromChannel', () => {
  test('agreement over the originating channel starts the work', async () => {
    const { store, started, deps } = harness();
    const proposal = store.create({
      surfaceKind: 'ntfy', task: 'fix the login bug', summary: 'fix the login bug',
      ttlMs: 30 * 60_000, channelId: 'goodvibes-agent', userId: 'owner',
    });

    const outcome = await tryResolveWorkProposalReplyFromChannel(ingress({ text: 'yeah go for it' }), deps);

    expect(outcome).toEqual({ consumed: true, action: 'accepted' });
    expect(started).toHaveLength(1);
    expect(started[0]!.proposal.id).toBe(proposal.id);
    expect(store.listPending()).toHaveLength(0);
    store.dispose();
  });

  test('steering text on the agreement rides along', async () => {
    const { store, started, deps } = harness();
    store.create({ surfaceKind: 'ntfy', task: 't', summary: 's', ttlMs: 60_000 });
    await tryResolveWorkProposalReplyFromChannel(ingress({ text: 'yes but only the adapter' }), deps);
    expect(started[0]!.note).toBe('but only the adapter');
    store.dispose();
  });

  test('a refusal starts nothing and says so on the channel', async () => {
    const { store, started, replies, deps } = harness();
    store.create({ surfaceKind: 'ntfy', task: 't', summary: 'fix the login bug', ttlMs: 60_000 });

    const outcome = await tryResolveWorkProposalReplyFromChannel(ingress({ text: 'nah, not now' }), deps);

    expect(outcome).toEqual({ consumed: true, action: 'declined' });
    expect(started).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain('fix the login bug');
    expect(store.listPending()).toHaveLength(0);
    store.dispose();
  });

  test('an answer on a different surface does not resolve this surface proposal', async () => {
    const { store, started, deps } = harness();
    store.create({ surfaceKind: 'ntfy', task: 't', summary: 's', ttlMs: 60_000 });

    const outcome = await tryResolveWorkProposalReplyFromChannel(ingress({ surface: 'telegram' }), deps);

    expect(outcome.consumed).toBe(false);
    expect(started).toHaveLength(0);
    expect(store.listPending({ surfaceKind: 'ntfy' })).toHaveLength(1);
    store.dispose();
  });

  test('a bare "yes" with nothing pending flows through as conversation', async () => {
    const { started, deps, store } = harness();
    const outcome = await tryResolveWorkProposalReplyFromChannel(ingress({ text: 'yes' }), deps);
    expect(outcome.consumed).toBe(false);
    expect(started).toHaveLength(0);
    store.dispose();
  });

  test('an unrelated message is never consumed as an answer', async () => {
    const { store, started, deps } = harness();
    store.create({ surfaceKind: 'ntfy', task: 't', summary: 's', ttlMs: 60_000 });
    const outcome = await tryResolveWorkProposalReplyFromChannel(ingress({ text: 'what is the status' }), deps);
    expect(outcome.consumed).toBe(false);
    expect(started).toHaveLength(0);
    expect(store.listPending()).toHaveLength(1);
    store.dispose();
  });

  test('agreeing to an expired proposal starts nothing', async () => {
    let now = 1_000_000;
    const { store, started, deps } = harness({ now: () => now });
    store.create({ surfaceKind: 'ntfy', task: 't', summary: 's', ttlMs: 60_000 });

    now += 60_001;
    const outcome = await tryResolveWorkProposalReplyFromChannel(ingress({ text: 'yes' }), deps);

    // Nothing answerable remains, so the "yes" is ordinary conversation.
    expect(outcome.consumed).toBe(false);
    expect(started).toHaveLength(0);
    store.dispose();
  });

  test('with no store wired the gate is inert', async () => {
    const outcome = await tryResolveWorkProposalReplyFromChannel(ingress(), {
      startAgreedWork: async () => { throw new Error('must not run'); },
      replyOnChannel: async () => { throw new Error('must not run'); },
    });
    expect(outcome.consumed).toBe(false);
  });

  test('a second "yes" behind the first does not start the work twice', async () => {
    const { store, started, deps } = harness();
    store.create({ surfaceKind: 'ntfy', task: 't', summary: 's', ttlMs: 60_000 });
    await tryResolveWorkProposalReplyFromChannel(ingress({ text: 'yes' }), deps);
    await tryResolveWorkProposalReplyFromChannel(ingress({ text: 'yes' }), deps);
    expect(started).toHaveLength(1);
    store.dispose();
  });
});

describe('findProposalForReply', () => {
  function record(overrides: Partial<WorkProposalRecord>): WorkProposalRecord {
    return {
      id: 'wp_1', createdAt: 1, expiresAt: 2, status: 'pending',
      surfaceKind: 'ntfy', task: 't', summary: 's', ...overrides,
    };
  }

  test('narrows to the same surface', () => {
    const pending = [record({ id: 'a', surfaceKind: 'telegram' }), record({ id: 'b', surfaceKind: 'ntfy' })];
    expect(findProposalForReply({ surface: 'ntfy' }, pending)?.id).toBe('b');
  });

  test('prefers a thread match', () => {
    const pending = [record({ id: 'a' }), record({ id: 'b', threadId: 'T1' })];
    expect(findProposalForReply({ surface: 'ntfy', threadId: 'T1' }, pending)?.id).toBe('b');
  });

  test('prefers a channel match when there is no thread', () => {
    const pending = [record({ id: 'a' }), record({ id: 'b', channelId: 'C1' })];
    expect(findProposalForReply({ surface: 'ntfy', channelId: 'C1' }, pending)?.id).toBe('b');
  });

  test('a proposal owned by another user is not answerable by this one', () => {
    const pending = [record({ id: 'a', userId: 'someone-else' })];
    expect(findProposalForReply({ surface: 'ntfy', userId: 'owner' }, pending)?.id).toBe('a');
    const mixed = [record({ id: 'a', userId: 'someone-else' }), record({ id: 'b', userId: 'owner' })];
    expect(findProposalForReply({ surface: 'ntfy', userId: 'owner' }, mixed)?.id).toBe('b');
  });

  test('nothing pending on this surface yields null', () => {
    expect(findProposalForReply({ surface: 'ntfy' }, [])).toBeNull();
  });
});
