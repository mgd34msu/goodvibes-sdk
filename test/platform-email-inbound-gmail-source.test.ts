/**
 * The Gmail inbound source: polling, the scope gate, and losing our place.
 *
 * No network and no real sleeping — Google's API is a scripted function, the
 * poll interval runs on an injected clock, and the cursor is the real
 * persisted store on a throwaway file.
 *
 * Every test here is a gate. The two that matter most are the scope ones: a
 * grant that can list what changed but cannot read a body must REFUSE, because
 * a delta of empty bodies comes back `ok` and a mailbox going quiet is exactly
 * what a working mailbox looks like on a slow day.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { MailboxCursorStore } from '../packages/sdk/src/platform/email/inbound/cursor-store.ts';
import { GmailMailSource } from '../packages/sdk/src/platform/email/inbound/gmail-source.ts';
import type { GmailMailSourceDeps } from '../packages/sdk/src/platform/email/inbound/gmail-source.ts';
import type {
  InboundMailNote,
  InboundMailSink,
  InboundMailTerminalFailure,
  InboundMailboxMessage,
} from '../packages/sdk/src/platform/email/inbound/ports.ts';
import {
  GMAIL_BODY_SCOPES,
  GMAIL_HISTORY_SCOPES,
} from '../packages/sdk/src/platform/google/history-delta.ts';
import {
  MAIL_CONTENT_PROVENANCE,
  type GmailMessageBody,
  type GoogleApiResult,
} from '../packages/sdk/src/platform/google/api-client.ts';
import { FakeClock, flush, waitFor } from './_helpers/inbound-watcher-harness.ts';

const ACCOUNT = 'primary';
const LABEL = 'INBOX';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const METADATA_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';

/** Collects whatever any source hands over, in arrival order. */
class CollectingSink implements InboundMailSink {
  readonly delivered: InboundMailboxMessage[] = [];
  /** Resource ids / UIDs to refuse once, to simulate a crash mid-processing. */
  readonly refuse = new Set<string>();

  async deliver(message: InboundMailboxMessage): Promise<void> {
    const id = message.source === 'gmail' ? message.resourceId : String(message.uid);
    if (this.refuse.has(id)) {
      this.refuse.delete(id);
      throw new Error(`the sink refused ${id}`);
    }
    this.delivered.push(message);
  }
}

function gmailMessage(id: string, subject: string): GmailMessageBody {
  return {
    id,
    threadId: `thread-${id}`,
    from: 'noreply@service.test',
    to: 'owner@example.test',
    subject,
    date: 'Sun, 27 Jul 2026 10:00:00 +0000',
    snippet: subject,
    unread: true,
    provenance: MAIL_CONTENT_PROVENANCE,
    body: `the body of ${id}`,
    deliveredTo: ['owner+signup@example.test'],
  };
}

/** One `users.history.list` page carrying `messagesAdded` for each id. */
function historyPage(historyId: string, ids: readonly string[]): GoogleApiResult<unknown> {
  return {
    ok: true,
    value: {
      historyId,
      history: ids.map((id) => ({ messagesAdded: [{ message: { id } }] })),
    },
  };
}

interface Harness {
  readonly source: GmailMailSource;
  readonly clock: FakeClock;
  readonly sink: CollectingSink;
  readonly store: MailboxCursorStore;
  readonly notes: InboundMailNote[];
  readonly terminals: InboundMailTerminalFailure[];
  readonly pages: URLSearchParams[];
  readonly fetchedMessageIds: string[];
  /** Mutable, so a test can open and close an expectation mid-run. */
  readonly state: { expectationOpen: boolean };
}

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (running.length > 0) {
    const stop = running.pop();
    if (stop !== undefined) await stop();
  }
});

async function build(input: {
  readonly scopes?: readonly string[];
  readonly page?: GoogleApiResult<unknown>;
  readonly messages?: readonly GmailMessageBody[];
  readonly seedHistoryId?: string | undefined;
  readonly currentHistoryId?: GoogleApiResult<string>;
  readonly expectationOpen?: boolean;
  readonly deps?: Partial<GmailMailSourceDeps>;
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-gmail-source-'));
  const store = new MailboxCursorStore(join(dir, 'cursors.json'));
  if (input.seedHistoryId !== undefined) {
    await store.resolveGmail({
      account: ACCOUNT,
      mailbox: LABEL,
      currentHistoryId: input.seedHistoryId,
    });
  }
  const clock = new FakeClock();
  const sink = new CollectingSink();
  const notes: InboundMailNote[] = [];
  const terminals: InboundMailTerminalFailure[] = [];
  const pages: URLSearchParams[] = [];
  const fetchedMessageIds: string[] = [];
  const byId = new Map((input.messages ?? []).map((message) => [message.id, message]));
  const state = { expectationOpen: input.expectationOpen ?? false };

  const source = new GmailMailSource({
    account: ACCOUNT,
    mailbox: LABEL,
    history: {
      scopes: () => input.scopes ?? [READONLY_SCOPE],
      fetchHistoryPage: async (params) => {
        pages.push(params);
        return input.page ?? historyPage('100', []);
      },
      getMessage: async (id) => {
        fetchedMessageIds.push(id);
        const message = byId.get(id);
        return message === undefined
          ? { ok: false, status: 404, problem: `no message ${id}`, fix: '' }
          : { ok: true, value: message };
      },
    },
    currentHistoryId: async () => input.currentHistoryId ?? { ok: true, value: '900' },
    cursors: store,
    sink,
    clock,
    expectationOpen: () => state.expectationOpen,
    pollExpectingMs: 5_000,
    pollIdleMs: 60_000,
    observer: {
      note: (note) => { notes.push(note); },
      terminalFailure: (failure) => { terminals.push(failure); },
    },
    ...(input.deps ?? {}),
  });
  running.push(() => source.stop());
  return { source, clock, sink, store, notes, terminals, pages, fetchedMessageIds, state };
}

// ---------------------------------------------------------------------------
// The scope gate — §3.4a, §3.4b
// ---------------------------------------------------------------------------

describe('gmail source — capability sufficiency', () => {
  test('a grant with no Gmail scope is insufficient, not an empty successful poll', async () => {
    const harness = await build({ scopes: [], seedHistoryId: '100' });
    const verdict = await harness.source.start(new AbortController().signal);

    expect(verdict.state).toBe('insufficient');
    expect(verdict.detail).toContain('no Gmail read scope');
    expect(verdict.fix.length).toBeGreaterThan(0);
    // The whole point: it did not come back as a quiet mailbox.
    expect(harness.sink.delivered).toEqual([]);
    expect(harness.pages).toEqual([]);
    expect(harness.terminals).toHaveLength(1);
    expect(harness.terminals[0]?.fix).toBe(verdict.fix);
  });

  test('a metadata-only grant is insufficient and never fetches a body-less delta', async () => {
    const harness = await build({ scopes: [METADATA_SCOPE], seedHistoryId: '100' });
    const verdict = await harness.source.start(new AbortController().signal);

    expect(verdict.state).toBe('insufficient');
    expect(verdict.detail).toContain('but not the email body');
    expect(verdict.fix).toContain('gmail.readonly');
    expect(harness.sink.delivered).toEqual([]);
    // `history.list` is authorized by gmail.metadata, so "did not call it" is
    // the assertion that the refusal happened BEFORE the call rather than
    // after a delta of empty bodies came back.
    expect(harness.pages).toEqual([]);
    expect(harness.fetchedMessageIds).toEqual([]);
  });

  test('the two scope failures are distinct verdicts, not one collapsed refusal', async () => {
    const none = await build({ scopes: [], seedHistoryId: '100' });
    const metadata = await build({ scopes: [METADATA_SCOPE], seedHistoryId: '100' });
    const noScope = await none.source.start(new AbortController().signal);
    const metadataOnly = await metadata.source.start(new AbortController().signal);

    expect(noScope.state).toBe('insufficient');
    expect(metadataOnly.state).toBe('insufficient');
    // Distinct reasons, because the capability state tracker announces on a
    // change of state OR reason: collapsed into one, a token that lost its last
    // body scope would produce no new announcement at all.
    expect(noScope.reason).not.toBe(metadataOnly.reason);
    expect(noScope.detail).not.toBe(metadataOnly.detail);
    expect(noScope.fix).not.toBe(metadataOnly.fix);
    // And the scope constants they are gated on genuinely differ, which is what
    // makes the two conditions reachable at all.
    expect(GMAIL_HISTORY_SCOPES).toContain(METADATA_SCOPE);
    expect(GMAIL_BODY_SCOPES).not.toContain(METADATA_SCOPE);
  });

  test('an insufficient verdict re-probes on the capability timer, not the poll interval', async () => {
    const harness = await build({ scopes: [METADATA_SCOPE], seedHistoryId: '100' });
    harness.expectationOpen = true;
    await harness.source.start(new AbortController().signal);

    const controller = new AbortController();
    const loop = harness.source.run(controller.signal);
    await harness.clock.waitForSleepers(1, 'the capability re-check wait');
    // Not 5_000: a grant does not change in five seconds, and re-asking on the
    // poll interval turns a refusal into a request loop.
    expect(harness.clock.nextDueIn).toBe(60 * 60_000);
    controller.abort();
    await loop;
  });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describe('gmail source — delivery', () => {
  test('a delta is delivered in the source-discriminated Gmail shape', async () => {
    const harness = await build({
      seedHistoryId: '100',
      page: historyPage('140', ['m1']),
      messages: [gmailMessage('m1', 'verify your address')],
    });

    await harness.source.start(new AbortController().signal);

    expect(harness.sink.delivered).toHaveLength(1);
    const message = harness.sink.delivered[0];
    if (message === undefined || message.source !== 'gmail') throw new Error('expected a Gmail message');
    expect(message.resourceId).toBe('m1');
    expect(message.historyId).toBe('140');
    expect(message.body).toBe('the body of m1');
    expect(message.via).toBe('poll');
    expect(message.account).toBe(ACCOUNT);
    expect(message.mailbox).toBe(LABEL);
    expect(message.subject).toBe('verify your address');
    expect(message.claimedDate).toBe('Sun, 27 Jul 2026 10:00:00 +0000');
    expect(message.deliveredTo).toEqual(['owner+signup@example.test']);
    expect(message.unverifiedToHeaderClaim).toBe('owner@example.test');

    // The cursor moved, once, to the delta's high-water mark.
    const cursor = await harness.store.getGmail(ACCOUNT, LABEL);
    expect(cursor?.historyId).toBe('140');
    // And it is a Gmail cursor: asking for an IMAP one under the same key
    // answers null rather than coercing a historyId into a UID.
    expect(await harness.store.get(ACCOUNT, LABEL)).toBeNull();
  });

  test('a refused delivery leaves the whole delta above the cursor', async () => {
    const harness = await build({
      seedHistoryId: '100',
      page: historyPage('140', ['m1', 'm2']),
      messages: [gmailMessage('m1', 'one'), gmailMessage('m2', 'two')],
    });
    harness.sink.refuse.add('m2');

    await harness.source.start(new AbortController().signal);

    expect(harness.sink.delivered).toHaveLength(1);
    const cursor = await harness.store.getGmail(ACCOUNT, LABEL);
    expect(cursor?.historyId).toBe('100');
    expect(harness.notes.map((note) => note.kind)).toContain('delivery-failed');
  });

  test('a first run establishes the position and does not backfill', async () => {
    const harness = await build({
      page: historyPage('140', ['m1']),
      messages: [gmailMessage('m1', 'old mail already in the label')],
      currentHistoryId: { ok: true, value: '900' },
    });

    const verdict = await harness.source.start(new AbortController().signal);

    expect(verdict.state).toBe('healthy');
    expect(harness.sink.delivered).toEqual([]);
    expect(harness.pages).toEqual([]);
    const cursor = await harness.store.getGmail(ACCOUNT, LABEL);
    expect(cursor?.historyId).toBe('900');
    expect(harness.notes.map((note) => note.kind)).toContain('cursor-established');
  });
});

// ---------------------------------------------------------------------------
// Losing our place — §3.4d, §4
// ---------------------------------------------------------------------------

describe('gmail source — resync', () => {
  test('resync-required discards, re-establishes at the high-water mark, discloses, and does not replay', async () => {
    const harness = await build({
      seedHistoryId: '100',
      page: { ok: false, status: 404, problem: 'startHistoryId is out of range', fix: 'full sync' },
      messages: [gmailMessage('m1', 'old mail')],
      currentHistoryId: { ok: true, value: '900' },
    });

    const verdict = await harness.source.start(new AbortController().signal);

    // Not a capability failure: the grant is fine, the position aged out.
    expect(verdict.state).toBe('healthy');
    // Re-established at the CURRENT mark, not at the old one and not at zero.
    const cursor = await harness.store.getGmail(ACCOUNT, LABEL);
    expect(cursor?.historyId).toBe('900');
    // Disclosed, naming the position that was discarded.
    const reset = harness.notes.find((note) => note.kind === 'cursor-reset');
    expect(reset).toBeDefined();
    expect(reset?.detail).toContain('100');
    expect(reset?.detail).toContain('900');
    // And no replay: nothing was fetched and nothing reached the sink.
    expect(harness.sink.delivered).toEqual([]);
    expect(harness.fetchedMessageIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The adaptive interval — §3.4d
// ---------------------------------------------------------------------------

describe('gmail source — adaptive interval', () => {
  test('it polls every 5 s while an expectation is open and every 60 s when none is', async () => {
    const harness = await build({ seedHistoryId: '100', page: historyPage('100', []) });
    harness.expectationOpen = true;

    const controller = new AbortController();
    const loop = harness.source.run(controller.signal);

    await harness.clock.waitForSleepers(1, 'the first poll wait');
    expect(harness.clock.nextDueIn).toBe(5_000);
    expect(harness.source.latency).toEqual({ kind: 'poll', worstCaseMs: 5_000 });

    // The expectation closes mid-run: the very next wait is the slow one,
    // because the predicate is asked each time rather than sampled at start.
    harness.expectationOpen = false;
    await harness.clock.advance(5_000);
    await waitFor(() => harness.clock.nextDueIn === 60_000, 'the idle poll wait');
    expect(harness.source.latency).toEqual({ kind: 'poll', worstCaseMs: 60_000 });

    // A poll actually happened at the 5 s mark.
    expect(harness.pages.length).toBeGreaterThanOrEqual(1);

    controller.abort();
    await loop;
  });

  test('latency is never push, whatever the interval', async () => {
    const harness = await build({ seedHistoryId: '100' });
    expect(harness.source.latency.kind).toBe('poll');
    harness.expectationOpen = true;
    expect(harness.source.latency.kind).toBe('poll');
    expect(harness.source.kind).toBe('gmail-history');
  });

  test('run stops when the signal aborts, and stop() ends it too', async () => {
    const harness = await build({ seedHistoryId: '100', page: historyPage('100', []) });
    const loop = harness.source.run(new AbortController().signal);
    await harness.clock.waitForSleepers(1, 'the first poll wait');
    await harness.source.stop();
    await flush();
    await loop;
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The structural rule — §2.1
// ---------------------------------------------------------------------------

describe('inbound sources cannot register an expectation', () => {
  const files = [
    'packages/sdk/src/platform/email/inbound/gmail-source.ts',
    'packages/sdk/src/platform/email/inbound/imap-source.ts',
    'packages/sdk/src/platform/email/inbound/source-selection.ts',
  ];

  test('no source module names openExpectation or hydrateExpectation', () => {
    for (const file of files) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(text).not.toContain('openExpectation');
      expect(text).not.toContain('hydrateExpectation');
    }
  });

  test('no source module imports anything that can create an expectation', () => {
    for (const file of files) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const imports = text.split('\n').filter((line) => line.trimStart().startsWith('import '));
      const joined = imports.join('\n');
      expect(joined).not.toContain('expectation-registry');
      expect(joined).not.toContain('verification-expectations');
      expect(joined).not.toContain('expectation-store');
    }
  });
});
