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
    expect(result.value.messages[0]!.body).toBe('a real body');
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
    expect('unavailable' in result).toBe(false);
    expect(result.status).toBe(500);
  });
});
