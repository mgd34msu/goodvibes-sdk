/**
 * Tests for `historyListDelta` (`api-client.ts` + `history-delta.ts`) — Gmail
 * incremental sync via `users.history.list`.
 *
 * The defect this guards against: a Google credential that never carried a
 * Gmail read scope silently reporting "nothing new" forever, indistinguishable
 * from a mailbox that genuinely has no new mail. The two must never look the
 * same, and a `startHistoryId` that has aged out of Gmail's retention window
 * must never degrade into "no new messages" either.
 *
 * No real network calls are made anywhere in this file — every HTTP call goes
 * through an injected fake `GoogleApiFetchPort`.
 */

import { describe, expect, test } from 'bun:test';
import { GoogleApiClient, type GoogleApiFetchPort } from '../packages/sdk/src/platform/google/api-client.ts';
import { GoogleTokenManager } from '../packages/sdk/src/platform/google/token-manager.ts';
import type { GoogleOAuthCredentials } from '../packages/sdk/src/platform/google/credential-adoption.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tokenManagerWithScopes(scopes: readonly string[]): GoogleTokenManager {
  const credentials: GoogleOAuthCredentials = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    accessToken: 'valid-access-token',
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    scopes,
    tokenUri: 'https://oauth2.googleapis.com/token',
    origin: 'secret-store',
    location: 'test',
  };
  return new GoogleTokenManager(credentials, {
    refresh: async () => {
      throw new Error('refresh should never be called: the cached access token is valid for the whole test');
    },
  });
}

interface FakeCall {
  readonly url: string;
}

/** A fake HTTP layer keyed on the request path, so no real network call ever happens. */
function fakeFetchPort(handlers: {
  history: readonly Response[];
  messages?: Readonly<Record<string, Response>>;
}): { readonly port: GoogleApiFetchPort; readonly calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const historyQueue = [...handlers.history];
  return {
    calls,
    port: {
      fetch: async (url: string): Promise<Response> => {
        calls.push({ url });
        if (url.includes('/history')) {
          const next = historyQueue.shift();
          if (next === undefined) throw new Error(`no more fake history pages queued for ${url}`);
          return next;
        }
        const idMatch = /\/messages\/([^/?]+)/.exec(url);
        const id = idMatch?.[1];
        const message = id !== undefined ? handlers.messages?.[id] : undefined;
        if (message === undefined) throw new Error(`no fake message response for ${url}`);
        return message;
      },
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function gmailMessagePayload(input: {
  readonly id: string;
  readonly threadId: string;
  readonly to: string;
  readonly deliveredTo: readonly string[];
  readonly from: string;
  readonly subject: string;
  readonly bodyText: string;
}): unknown {
  const encodedBody = Buffer.from(input.bodyText, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const headers = [
    { name: 'From', value: input.from },
    { name: 'To', value: input.to },
    { name: 'Subject', value: input.subject },
    { name: 'Date', value: 'Mon, 27 Jul 2026 12:00:00 +0000' },
    ...input.deliveredTo.map((value) => ({ name: 'Delivered-To', value })),
  ];
  return {
    id: input.id,
    threadId: input.threadId,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: input.bodyText.slice(0, 40),
    payload: {
      mimeType: 'text/plain',
      headers,
      body: { data: encodedBody },
    },
  };
}

function historyPage(input: {
  readonly historyId: string;
  readonly addedMessageIds: readonly { id: string; threadId: string }[];
  readonly nextPageToken?: string;
}): unknown {
  return {
    historyId: input.historyId,
    ...(input.nextPageToken === undefined ? {} : { nextPageToken: input.nextPageToken }),
    history:
      input.addedMessageIds.length === 0
        ? []
        : [
            {
              id: input.historyId,
              messagesAdded: input.addedMessageIds.map((m) => ({ message: { id: m.id, threadId: m.threadId } })),
            },
          ],
  };
}

// ---------------------------------------------------------------------------
// 1. No Gmail scope -> typed unavailable, NEVER an empty success
// ---------------------------------------------------------------------------

describe('historyListDelta: scope gate', () => {
  test('a token without a Gmail scope reports unavailable: no-gmail-scope, and is NOT an empty success', async () => {
    const { port, calls } = fakeFetchPort({ history: [] });
    // Only the calendar scope — exactly setup-plan.ts's default grant.
    const client = new GoogleApiClient(tokenManagerWithScopes(['https://www.googleapis.com/auth/calendar.events']), port);

    const result = await client.historyListDelta({ startHistoryId: '100' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable: asserted false above');
    // The failure arm is `HistoryDeltaUnavailable | GoogleApiFailure`, and only
    // the first carries `unavailable`. Asserting the discriminating property is
    // present is part of the point of the test — a plain transient failure here
    // would be the defect — so it is checked rather than narrowed past.
    expect('unavailable' in result, 'expected the unavailable arm, not a transient GoogleApiFailure').toBe(true);
    if (!('unavailable' in result)) throw new Error('unreachable: asserted above');
    expect(result.unavailable).toBe('no-gmail-scope');

    // The two shapes must never be confusable: this is not `{ ok: true, value: { messages: [] } }`.
    expect('value' in result).toBe(false);

    // The gate must trip before any network call — this must not have hit the endpoint at all.
    expect(calls.length).toBe(0);
  });

  test('a token with ONLY gmail.metadata scope does not yield a normal successful delta with bodies', async () => {
    // gmail.metadata authorizes users.history.list itself, but its own scope
    // description reads "but not the email body" -- a delta built from it
    // could never carry a message body, so it must not look like a real one.
    const page = historyPage({ historyId: '101', addedMessageIds: [{ id: 'msg-1', threadId: 'thread-1' }] });
    const message = gmailMessagePayload({
      id: 'msg-1',
      threadId: 'thread-1',
      to: 'owner@example.com',
      deliveredTo: ['owner@example.com'],
      from: 'sender@example.com',
      subject: 'Hi',
      bodyText: 'hello',
    });
    const { port, calls } = fakeFetchPort({
      history: [jsonResponse(200, page)],
      messages: { 'msg-1': jsonResponse(200, message) },
    });
    const client = new GoogleApiClient(tokenManagerWithScopes(['https://www.googleapis.com/auth/gmail.metadata']), port);

    const result = await client.historyListDelta({ startHistoryId: '100' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable: asserted false above');
    // The failure arm is `HistoryDeltaUnavailable | GoogleApiFailure`, and only
    // the first carries `unavailable`. Asserting the discriminating property is
    // present is part of the point of the test — a plain transient failure here
    // would be the defect — so it is checked rather than narrowed past.
    expect('unavailable' in result, 'expected the unavailable arm, not a transient GoogleApiFailure').toBe(true);
    if (!('unavailable' in result)) throw new Error('unreachable: asserted above');
    expect(result.unavailable).toBe('metadata-scope-only');
    expect('value' in result).toBe(false);
    // Distinguishable from the other two reasons too.
    expect(result.unavailable).not.toBe('no-gmail-scope');
    expect(result.unavailable).not.toBe('resync-required');

    // Refused before ever calling history.list -- there is nothing useful a
    // metadata-only token could do with the result.
    expect(calls.length).toBe(0);
  });

  test('a token with gmail.readonly scope (a body-capable scope) DOES yield a normal successful delta with bodies', async () => {
    const page = historyPage({ historyId: '102', addedMessageIds: [{ id: 'msg-2', threadId: 'thread-2' }] });
    const message = gmailMessagePayload({
      id: 'msg-2',
      threadId: 'thread-2',
      to: 'owner@example.com',
      deliveredTo: ['owner@example.com'],
      from: 'sender@example.com',
      subject: 'Hi',
      bodyText: 'a real body',
    });
    const { port } = fakeFetchPort({
      history: [jsonResponse(200, page)],
      messages: { 'msg-2': jsonResponse(200, message) },
    });
    const client = new GoogleApiClient(tokenManagerWithScopes(['https://www.googleapis.com/auth/gmail.readonly']), port);

    const result = await client.historyListDelta({ startHistoryId: '100' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable: asserted true above');
    expect(result.value.messages).toHaveLength(1);
    // The delta yields `GmailMessageBody | GmailMessageMetadata`; only the
    // first carries a body, and a metadata-only result here would be the very
    // defect this asserts against — so its presence is checked, not assumed.
    const delivered = result.value.messages[0]!;
    expect('body' in delivered, 'expected a body, not a metadata-only message').toBe(true);
    if (!('body' in delivered)) throw new Error('unreachable: asserted above');
    expect(delivered.body).toBe('a real body');
  });
});

// ---------------------------------------------------------------------------
// 2. With a Gmail scope: fetches the delta, not the whole mailbox
// ---------------------------------------------------------------------------

describe('historyListDelta: with a granted Gmail scope', () => {
  test('performs the delta fetch and returns only what is new, with untrusted provenance and delivery evidence kept separate from `to`', async () => {
    const page = historyPage({
      historyId: '150',
      addedMessageIds: [{ id: 'msg-1', threadId: 'thread-1' }],
    });
    const message = gmailMessagePayload({
      id: 'msg-1',
      threadId: 'thread-1',
      to: 'owner@example.com',
      deliveredTo: ['signup-alias@example.com'],
      from: 'notifications@merchant.example',
      subject: 'Your verification code',
      bodyText: 'Your code is 482913.',
    });

    const { port, calls } = fakeFetchPort({
      history: [jsonResponse(200, page)],
      messages: { 'msg-1': jsonResponse(200, message) },
    });
    const client = new GoogleApiClient(tokenManagerWithScopes(['https://www.googleapis.com/auth/gmail.readonly']), port);

    const result = await client.historyListDelta({ startHistoryId: '100' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable: asserted true above');
    expect(result.value.historyId).toBe('150');
    expect(result.value.messages).toHaveLength(1);

    const fetched = result.value.messages[0]!;
    expect(fetched.id).toBe('msg-1');
    expect(fetched.provenance).toBe('untrusted-external');
    expect('body' in fetched, 'expected a body, not a metadata-only message').toBe(true);
    if (!('body' in fetched)) throw new Error('unreachable: asserted above');
    expect(fetched.body).toBe('Your code is 482913.');
    // Delivery evidence (receiver-written) is kept as its own field, separate
    // from the sender-controlled `to` header, and the two must not collapse.
    expect(fetched.deliveredTo).toEqual(['signup-alias@example.com']);
    expect(fetched.to).toBe('owner@example.com');
    expect(fetched.deliveredTo).not.toContain(fetched.to);

    // One call for the history page, one for the single new message — not a
    // re-listing of the whole mailbox.
    expect(calls.length).toBe(2);
  });

  test('a message that vanishes between history.list and getMessage is dropped, not surfaced as a delta failure', async () => {
    const page = historyPage({
      historyId: '151',
      addedMessageIds: [
        { id: 'msg-gone', threadId: 'thread-x' },
        { id: 'msg-2', threadId: 'thread-2' },
      ],
    });
    const message2 = gmailMessagePayload({
      id: 'msg-2',
      threadId: 'thread-2',
      to: 'owner@example.com',
      deliveredTo: [],
      from: 'sender@example.com',
      subject: 'Hi',
      bodyText: 'hello',
    });
    const { port } = fakeFetchPort({
      history: [jsonResponse(200, page)],
      messages: {
        'msg-gone': jsonResponse(404, { error: { message: 'Requested entity was not found.' } }),
        'msg-2': jsonResponse(200, message2),
      },
    });
    const client = new GoogleApiClient(tokenManagerWithScopes(['https://mail.google.com/']), port);

    const result = await client.historyListDelta({ startHistoryId: '100' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.messages.map((m) => m.id)).toEqual(['msg-2']);
    // Dropped as GONE, which is what a 404 means, and therefore NOT reported
    // as something that went unread — the delta is complete and its historyId
    // is a position the caller may take.
    expect(result.value.unreadable).toEqual([]);
  });

  test('a fetch that FAILED is reported in `unreadable`, not silently dropped like a 404', async () => {
    // The defect: every non-ok getMessage was read as "the message is gone".
    // A 429 is not a deletion — the message is still in the mailbox — and on a
    // forward-only history log a caller that took this delta's historyId could
    // never ask for the record again.
    const page = historyPage({
      historyId: '152',
      addedMessageIds: [
        { id: 'msg-limited', threadId: 'thread-l' },
        { id: 'msg-ok', threadId: 'thread-o' },
      ],
    });
    const messageOk = gmailMessagePayload({
      id: 'msg-ok',
      threadId: 'thread-o',
      to: 'owner@example.com',
      deliveredTo: [],
      from: 'sender@example.com',
      subject: 'Hi',
      bodyText: 'hello',
    });
    const { port } = fakeFetchPort({
      history: [jsonResponse(200, page)],
      messages: {
        'msg-limited': jsonResponse(429, { error: { message: 'Rate Limit Exceeded' } }),
        'msg-ok': jsonResponse(200, messageOk),
      },
    });
    const client = new GoogleApiClient(tokenManagerWithScopes(['https://mail.google.com/']), port);

    const result = await client.historyListDelta({ startHistoryId: '100' });

    // Still `ok`, and deliberately so: what WAS read is usable, and refusing
    // the whole delta would withhold a verification email we did fetch because
    // a sibling message was rate-limited.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.messages.map((m) => m.id)).toEqual(['msg-ok']);

    // But the delta now SAYS it is incomplete, which is the fact the caller
    // needs in order not to advance past msg-limited.
    expect(result.value.unreadable).toHaveLength(1);
    const problem = result.value.unreadable[0]!;
    expect(problem.id).toBe('msg-limited');
    expect(problem.status).toBe(429);
    expect(problem.detail.length).toBeGreaterThan(0);
    // Google's remedial step travels with the problem: a caller building an
    // owner-facing verdict from this has nowhere else to get one.
    expect(problem.fix.length).toBeGreaterThan(0);
    // An id that could not be read must never appear as a message.
    expect(result.value.messages.map((m) => m.id)).not.toContain('msg-limited');
  });

  test('a server fault and a refused token are unreadable too, carrying their own status', async () => {
    const page = historyPage({
      historyId: '153',
      addedMessageIds: [
        { id: 'msg-500', threadId: 'thread-a' },
        { id: 'msg-403', threadId: 'thread-b' },
      ],
    });
    const { port } = fakeFetchPort({
      history: [jsonResponse(200, page)],
      messages: {
        'msg-500': jsonResponse(500, { error: { message: 'Backend Error' } }),
        'msg-403': jsonResponse(403, { error: { message: 'Insufficient Permission' } }),
      },
    });
    const client = new GoogleApiClient(tokenManagerWithScopes(['https://mail.google.com/']), port);

    const result = await client.historyListDelta({ startHistoryId: '100' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.messages).toEqual([]);
    // Two unread messages, and the STATUS is preserved per entry rather than
    // flattened — a caller has to tell "wait" from "the grant changed", and it
    // cannot do that from a count.
    expect(result.value.unreadable.map((problem) => problem.status).sort()).toEqual([403, 500]);
    expect(result.value.unreadable.map((problem) => problem.id).sort())
      .toEqual(['msg-403', 'msg-500']);
  });

  test('an empty delta and an unread delta are different answers', async () => {
    // Both come back `ok` with no messages, and before `unreadable` existed
    // they were the same value. One means "nothing arrived"; the other means
    // "something arrived and we could not read it". Collapsing them is how a
    // mailbox goes quiet with nobody noticing.
    const quiet = fakeFetchPort({
      history: [jsonResponse(200, historyPage({ historyId: '170', addedMessageIds: [] }))],
      messages: {},
    });
    const unread = fakeFetchPort({
      history: [jsonResponse(200, historyPage({
        historyId: '170',
        addedMessageIds: [{ id: 'msg-x', threadId: 't-x' }],
      }))],
      messages: { 'msg-x': jsonResponse(503, { error: { message: 'Service Unavailable' } }) },
    });
    const scope = ['https://mail.google.com/'];

    const quietResult = await new GoogleApiClient(tokenManagerWithScopes(scope), quiet.port)
      .historyListDelta({ startHistoryId: '100' });
    const unreadResult = await new GoogleApiClient(tokenManagerWithScopes(scope), unread.port)
      .historyListDelta({ startHistoryId: '100' });

    expect(quietResult.ok).toBe(true);
    expect(unreadResult.ok).toBe(true);
    if (!quietResult.ok || !unreadResult.ok) throw new Error('unreachable');

    expect(quietResult.value.messages).toEqual([]);
    expect(unreadResult.value.messages).toEqual([]);
    // Same historyId, same empty message list, and the two are still
    // distinguishable — which is the entire requirement.
    expect(quietResult.value.historyId).toBe(unreadResult.value.historyId);
    expect(quietResult.value.unreadable).toEqual([]);
    expect(unreadResult.value.unreadable).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Pagination is followed to completion
// ---------------------------------------------------------------------------

describe('historyListDelta: pagination', () => {
  test('follows nextPageToken across multiple pages and aggregates every added message', async () => {
    const page1 = historyPage({
      historyId: '160',
      addedMessageIds: [{ id: 'msg-a', threadId: 't-a' }],
      nextPageToken: 'page-2-token',
    });
    const page2 = historyPage({
      historyId: '162',
      addedMessageIds: [{ id: 'msg-b', threadId: 't-b' }],
    });
    const msgA = gmailMessagePayload({
      id: 'msg-a',
      threadId: 't-a',
      to: 'owner@example.com',
      deliveredTo: ['owner@example.com'],
      from: 'a@example.com',
      subject: 'A',
      bodyText: 'body a',
    });
    const msgB = gmailMessagePayload({
      id: 'msg-b',
      threadId: 't-b',
      to: 'owner@example.com',
      deliveredTo: ['owner@example.com'],
      from: 'b@example.com',
      subject: 'B',
      bodyText: 'body b',
    });

    const { port, calls } = fakeFetchPort({
      history: [jsonResponse(200, page1), jsonResponse(200, page2)],
      messages: { 'msg-a': jsonResponse(200, msgA), 'msg-b': jsonResponse(200, msgB) },
    });
    const client = new GoogleApiClient(tokenManagerWithScopes(['https://www.googleapis.com/auth/gmail.modify']), port);

    const result = await client.historyListDelta({ startHistoryId: '100' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Final high-water mark is from the LAST page, not the first.
    expect(result.value.historyId).toBe('162');
    expect(result.value.messages.map((m) => m.id).sort()).toEqual(['msg-a', 'msg-b']);

    // Two history-page fetches (page1 has a nextPageToken, page2 does not) plus
    // two message fetches: pagination actually ran to completion rather than
    // stopping after the first page.
    const historyCalls = calls.filter((c) => c.url.includes('/history'));
    expect(historyCalls.length).toBe(2);
    expect(historyCalls[1]!.url).toContain('pageToken=page-2-token');
  });
});

// ---------------------------------------------------------------------------
// 4. Expired startHistoryId -> explicit resync-required, never an empty delta
// ---------------------------------------------------------------------------

describe('historyListDelta: expired startHistoryId', () => {
  test('an HTTP 404 from history.list yields unavailable: resync-required, NOT an empty success', async () => {
    const { port } = fakeFetchPort({
      history: [jsonResponse(404, { error: { message: 'Not found' } })],
    });
    const client = new GoogleApiClient(tokenManagerWithScopes(['https://www.googleapis.com/auth/gmail.readonly']), port);

    const result = await client.historyListDelta({ startHistoryId: 'ancient-history-id' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable: asserted false above');
    // The failure arm is `HistoryDeltaUnavailable | GoogleApiFailure`, and only
    // the first carries `unavailable`. Asserting the discriminating property is
    // present is part of the point of the test — a plain transient failure here
    // would be the defect — so it is checked rather than narrowed past.
    expect('unavailable' in result, 'expected the unavailable arm, not a transient GoogleApiFailure').toBe(true);
    if (!('unavailable' in result)) throw new Error('unreachable: asserted above');
    expect(result.unavailable).toBe('resync-required');
    expect('value' in result).toBe(false);
    // The two failure reasons must be distinguishable from one another too.
    expect(result.unavailable).not.toBe('no-gmail-scope');
  });

  test('a non-404 transient failure from history.list is passed through as an ordinary GoogleApiFailure, not gated as resync-required', async () => {
    const { port } = fakeFetchPort({
      history: [jsonResponse(500, { error: { message: 'Internal error' } })],
    });
    const client = new GoogleApiClient(tokenManagerWithScopes(['https://www.googleapis.com/auth/gmail.readonly']), port);

    const result = await client.historyListDelta({ startHistoryId: '100' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable: asserted false above');
    // This case asserts the OPPOSITE of the three above: a 500 from
    // history.list is an ordinary transient failure and must NOT be dressed up
    // as the unavailable arm, so `unavailable` must be absent here.
    expect('unavailable' in result).toBe(false);
    expect(result.status).toBe(500);
  });
});
