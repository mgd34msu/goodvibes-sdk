/**
 * companion-chat-branching.test.ts
 *
 * The regenerate + edit-and-branch verbs at the CompanionChatManager level, with
 * a real manager and a deterministic mock provider so the full turn actually
 * re-runs and produces a new assistant message. Proves the HONEST-LINEAGE
 * contract: a regenerated or edited turn's predecessor is retained (marked
 * superseded, still returned by getMessages), never silently dropped; and the
 * re-run turn only sees the active branch, not the superseded history.
 *
 * The daemon-wire proof of the same verbs over real HTTP (invoke + routes,
 * closed/deleted-session refusals with machine codes) lives in
 * companion-chat-verbs-daemon-wire.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { settleEvents } from './_helpers/test-timeout.js';
import { CompanionChatManager } from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import type {
  CompanionLLMProvider,
  CompanionProviderChunk,
  CompanionProviderMessage,
} from '../packages/sdk/src/platform/companion/companion-chat-manager.js';

/**
 * A provider that replies with a caller-controlled sequence of texts (one per
 * turn) AND records the messages it was handed each turn, so a test can prove
 * the re-run turn saw only the active conversation branch.
 */
function makeScriptedProvider(replies: string[]): CompanionLLMProvider & {
  readonly turns: CompanionProviderMessage[][];
} {
  const turns: CompanionProviderMessage[][] = [];
  let index = 0;
  return {
    turns,
    async *chatStream(messages): AsyncIterable<CompanionProviderChunk> {
      turns.push(messages.map((m) => ({ ...m })));
      const reply = replies[index] ?? `reply-${index}`;
      index += 1;
      yield { type: 'text_delta', delta: reply };
      yield { type: 'done' };
    },
  };
}

function makeManager(provider: CompanionLLMProvider): CompanionChatManager {
  return new CompanionChatManager({
    provider,
    eventPublisher: { publishEvent() {} },
    gcIntervalMs: 999_999,
    rateLimiter: false,
  });
}

const activeOnly = (
  messages: readonly { supersededAt?: number | undefined }[],
): typeof messages => messages.filter((m) => m.supersededAt === undefined) as typeof messages;

describe('regenerate — honest lineage', () => {
  test('supersedes the prior response (retained, retrievable) and produces a fresh one', async () => {
    const provider = makeScriptedProvider(['first answer', 'second answer']);
    const manager = makeManager(provider);
    const session = manager.createSession({ provider: 'p', model: 'm' });

    await manager.postMessage(session.id, 'What is 2+2?');
    await settleEvents();
    const afterFirst = manager.getMessages(session.id);
    const firstAssistant = afterFirst.find((m) => m.role === 'assistant');
    expect(firstAssistant?.content).toBe('first answer');

    const result = manager.regenerateMessage(session.id);
    expect(result.regeneratedFrom).toBe(firstAssistant!.id);
    expect(result.supersededMessageIds).toContain(firstAssistant!.id);
    expect(result.turnStarted).toBe(true);
    await settleEvents();

    const all = manager.getMessages(session.id);
    // The prior response is NOT gone — it is retained, flagged superseded.
    const retainedFirst = all.find((m) => m.id === firstAssistant!.id);
    expect(retainedFirst).toBeDefined();
    expect(retainedFirst!.content).toBe('first answer');
    expect(typeof retainedFirst!.supersededAt).toBe('number');
    expect(retainedFirst!.supersededReason).toBe('regenerate');

    // A new active assistant response exists with the regenerated content.
    const active = activeOnly(all);
    const activeAssistant = active.find((m) => m.role === 'assistant');
    expect(activeAssistant).toBeDefined();
    expect(activeAssistant!.id).not.toBe(firstAssistant!.id);
    expect(activeAssistant!.content).toBe('second answer');

    // The user prompt was NOT superseded (regenerate re-runs from it).
    expect(active.some((m) => m.role === 'user' && m.content === 'What is 2+2?')).toBe(true);

    // The re-run turn saw only the active branch: the second turn's context did
    // NOT include the superseded 'first answer'.
    const secondTurnMessages = provider.turns[1]!;
    expect(secondTurnMessages.some((m) => JSON.stringify(m).includes('first answer'))).toBe(false);
  });

  test('regenerating with no assistant response is an honest refusal', () => {
    const manager = makeManager(makeScriptedProvider([]));
    const session = manager.createSession({ provider: 'p', model: 'm' });
    expect(() => manager.regenerateMessage(session.id)).toThrow();
    try {
      manager.regenerateMessage(session.id);
    } catch (err) {
      expect((err as { code?: string }).code).toBe('NO_ASSISTANT_MESSAGE');
      expect((err as { status?: number }).status).toBe(409);
    }
  });
});

describe('edit-and-branch — honest lineage', () => {
  test('supersedes the original message (retained) and branches with revisionOf', async () => {
    const provider = makeScriptedProvider(['answer to red', 'answer to blue']);
    const manager = makeManager(provider);
    const session = manager.createSession({ provider: 'p', model: 'm' });

    await manager.postMessage(session.id, 'Tell me about red');
    await settleEvents();
    const afterFirst = manager.getMessages(session.id);
    const originalUser = afterFirst.find((m) => m.role === 'user')!;
    const originalAssistant = afterFirst.find((m) => m.role === 'assistant')!;

    const result = manager.editMessage(session.id, {
      messageId: originalUser.id,
      content: 'Tell me about blue',
    });
    expect(result.editedFrom).toBe(originalUser.id);
    expect(result.messageId).not.toBe(originalUser.id);
    expect(result.supersededMessageIds).toContain(originalUser.id);
    expect(result.supersededMessageIds).toContain(originalAssistant.id);
    await settleEvents();

    const all = manager.getMessages(session.id);
    // Original user message retained, flagged superseded — retrievable.
    const retainedUser = all.find((m) => m.id === originalUser.id)!;
    expect(retainedUser.content).toBe('Tell me about red');
    expect(typeof retainedUser.supersededAt).toBe('number');
    expect(retainedUser.supersededReason).toBe('edit');

    // New user message carries the edit and links back via revisionOf.
    const newUser = all.find((m) => m.id === result.messageId)!;
    expect(newUser.role).toBe('user');
    expect(newUser.content).toBe('Tell me about blue');
    expect(newUser.revisionOf).toBe(originalUser.id);
    expect(newUser.supersededAt).toBeUndefined();

    // A fresh assistant answer to the edited message exists on the active branch.
    const active = activeOnly(all);
    const activeAssistant = active.find((m) => m.role === 'assistant')!;
    expect(activeAssistant.content).toBe('answer to blue');

    // The branch turn saw the edited message, not the original.
    const branchTurn = provider.turns[1]!;
    const branchText = JSON.stringify(branchTurn);
    expect(branchText.includes('Tell me about blue')).toBe(true);
    expect(branchText.includes('Tell me about red')).toBe(false);
  });

  test('editing an unknown message id refuses with MESSAGE_NOT_FOUND', () => {
    const manager = makeManager(makeScriptedProvider([]));
    const session = manager.createSession({ provider: 'p', model: 'm' });
    try {
      manager.editMessage(session.id, { messageId: 'nope', content: 'x' });
      throw new Error('expected refusal');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('MESSAGE_NOT_FOUND');
      expect((err as { status?: number }).status).toBe(404);
    }
  });

  test('editing an assistant message refuses with NOT_A_USER_MESSAGE', async () => {
    const manager = makeManager(makeScriptedProvider(['a']));
    const session = manager.createSession({ provider: 'p', model: 'm' });
    await manager.postMessage(session.id, 'Q');
    await settleEvents();
    const assistant = manager.getMessages(session.id).find((m) => m.role === 'assistant')!;
    try {
      manager.editMessage(session.id, { messageId: assistant.id, content: 'x' });
      throw new Error('expected refusal');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('NOT_A_USER_MESSAGE');
      expect((err as { status?: number }).status).toBe(400);
    }
  });
});

describe('closed / unknown session refusals', () => {
  test('regenerate + edit on a closed session throw SESSION_CLOSED (409)', async () => {
    const manager = makeManager(makeScriptedProvider(['a']));
    const session = manager.createSession({ provider: 'p', model: 'm' });
    await manager.postMessage(session.id, 'Q');
    await settleEvents();
    const user = manager.getMessages(session.id).find((m) => m.role === 'user')!;
    manager.closeSession(session.id);

    for (const act of [
      () => manager.regenerateMessage(session.id),
      () => manager.editMessage(session.id, { messageId: user.id, content: 'x' }),
    ]) {
      try {
        act();
        throw new Error('expected SESSION_CLOSED refusal');
      } catch (err) {
        expect((err as { code?: string }).code).toBe('SESSION_CLOSED');
        expect((err as { status?: number }).status).toBe(409);
      }
    }
  });

  test('regenerate + edit on an unknown session throw SESSION_NOT_FOUND (404)', () => {
    const manager = makeManager(makeScriptedProvider([]));
    for (const act of [
      () => manager.regenerateMessage('ghost'),
      () => manager.editMessage('ghost', { messageId: 'm', content: 'x' }),
    ]) {
      try {
        act();
        throw new Error('expected SESSION_NOT_FOUND refusal');
      } catch (err) {
        expect((err as { code?: string }).code).toBe('SESSION_NOT_FOUND');
        expect((err as { status?: number }).status).toBe(404);
      }
    }
  });
});
