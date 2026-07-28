/**
 * The FETCH response shapes a real IMAP server produces, and what the drain
 * loop does when it cannot read one.
 *
 * Every test here corresponds to something that was broken while 8356 tests
 * passed, and it passed because the fake mailbox wrote header blocks as plain
 * response lines — a shape no RFC 3501 server emits. Against a server that
 * sends a `{N}` literal, the client built envelopes with every field empty; and
 * against a server that puts the automatic `UID` item after the body section,
 * it produced no envelopes at all and the drain loop read that as "these
 * messages were expunged" and moved the cursor past them.
 *
 * So the fake now emits literals by default and can be told where to put the
 * UID, and these are the gates on both shapes plus the ambiguity the loop used
 * to resolve by guessing.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { ImapClient } from '../packages/sdk/src/platform/email/imap-client.ts';
import {
  fetchSection,
  parseFetchResponses,
} from '../packages/sdk/src/platform/email/imap-fetch-response.ts';
import {
  drainMailboxDelta,
  resolveWatcherSettings,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import type {
  MailboxReader,
  MailboxWire,
} from '../packages/sdk/src/platform/email/inbound/ports.ts';
import type {
  ImapEnvelope,
  ImapEnvelopeBatch,
} from '../packages/sdk/src/platform/email/imap-client.ts';
import {
  makeFakeMailbox,
  openMailboxSocket,
  type FakeMailboxOptions,
  type FakeMailboxServer,
} from './_helpers/fake-imap-mailbox.ts';
import {
  FakeClock,
  RecordingObserver,
  RecordingSink,
  cleanupInboundScratch,
  makeCursorStore,
  type RecordingCursorStore,
} from './_helpers/inbound-watcher-harness.ts';

const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';

const openMailboxes: FakeMailboxServer[] = [];
const openClients: ImapClient[] = [];

afterAll(() => { cleanupInboundScratch(); });

afterEach(async () => {
  while (openClients.length > 0) {
    const client = openClients.pop();
    if (client === undefined) continue;
    try {
      await client.logout();
    } catch {
      // The socket is being discarded either way.
    }
  }
  while (openMailboxes.length > 0) openMailboxes.pop()?.close();
});

async function connect(options: FakeMailboxOptions): Promise<{
  readonly mailbox: FakeMailboxServer;
  readonly client: ImapClient;
}> {
  const mailbox = await makeFakeMailbox(options);
  openMailboxes.push(mailbox);
  const client = new ImapClient({
    socket: await openMailboxSocket(mailbox.port),
    username: 'watched@example.test',
    password: 'an-app-password',
    mailbox: MAILBOX,
    timeoutMs: 2_000,
  });
  openClients.push(client);
  await client.open();
  return { mailbox, client };
}

function fake(uid: number, subject: string): {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly deliveredTo: string;
} {
  return {
    uid,
    from: `sender${uid}@sender.test`,
    subject,
    deliveredTo: 'watched@example.test',
  };
}

// ---------------------------------------------------------------------------
// The wire shapes, against the real client and a real socket
// ---------------------------------------------------------------------------

describe('a server that sends BODY[HEADER.FIELDS] as a {N} literal', () => {
  test('every envelope field is populated, From: included', async () => {
    // The regression this pins: `From:` is welded onto the `* n FETCH (` line
    // by the session's literal folding, and the old reader discarded that line
    // wholesale because the text after `FETCH ` began with `(`. Envelopes came
    // back with `from`, `subject`, `date` and `messageId` all empty strings,
    // and nothing downstream could tell that from a message with no headers.
    const { client } = await connect({ initial: [fake(101, 'the literal shape')] });
    const [envelope] = await client.fetchEnvelopes([101]);

    expect(envelope).toBeDefined();
    expect(envelope?.uid).toBe(101);
    expect(envelope?.from).toBe('sender101@sender.test');
    expect(envelope?.subject).toBe('the literal shape');
    expect(envelope?.date).toBe('Mon, 27 Jul 2026 09:00:00 +0000');
    expect(envelope?.messageId).toBe('<uid-101@example.test>');
    expect(envelope?.deliveredTo).toEqual(['watched@example.test']);
  });

  test('the same is true when the UID data item comes last', async () => {
    // `UID FETCH` makes the server add the UID item wherever it likes. When it
    // goes after the literal it is not on the `* n FETCH` line at all — it is
    // on the line that closes the response — and the old reader, which only
    // searched the text before the first `BODY` token of the start line, found
    // no UIDs, produced no envelopes, and reported success.
    const { client } = await connect({
      uidPosition: 'trailing',
      initial: [fake(101, 'trailing uid')],
    });
    const [envelope] = await client.fetchEnvelopes([101]);

    expect(envelope?.uid).toBe(101);
    expect(envelope?.subject).toBe('trailing uid');
    expect(envelope?.from).toBe('sender101@sender.test');
  });

  test('a multi-message fetch loses nothing, in either UID position', async () => {
    for (const uidPosition of ['leading', 'trailing'] as const) {
      const { client } = await connect({
        uidPosition,
        initial: [fake(101, 'one'), fake(102, 'two'), fake(103, 'three')],
      });
      const envelopes = await client.fetchEnvelopes([101, 102, 103]);
      expect(envelopes.map((envelope) => envelope.uid)).toEqual([101, 102, 103]);
      expect(envelopes.map((envelope) => envelope.subject))
        .toEqual(['one', 'two', 'three']);
    }
  });

  test('a non-ASCII subject survives the byte-counted literal intact', async () => {
    // `{n}` is a BYTE count (RFC 3501 §4.3) and the socket is read as utf8, so
    // a reader that took n CHARACTERS would stop short of the payload's end,
    // swallow the bytes that follow it — the closing `)` and the tagged
    // completion — and hang until the command timed out. `takeUtf8Bytes` exists
    // for exactly this and had no coverage on the watcher's path.
    const subject = 'Überweisung — 契約書 — naïve café ☕';
    const { client } = await connect({ initial: [fake(101, subject)] });
    const [envelope] = await client.fetchEnvelopes([101]);

    expect(envelope?.subject).toBe(subject);
    expect(envelope?.messageId).toBe('<uid-101@example.test>');
  });

  test('envelopes follow the order asked for, not the order answered', async () => {
    // A real server answers in sequence order however the UIDs were asked for.
    // Lining envelopes up positionally rather than by the UID data item reads
    // the wrong message; asking in reverse is what makes that visible.
    const { client } = await connect({
      initial: [fake(101, 'one'), fake(102, 'two'), fake(103, 'three')],
    });
    const envelopes = await client.fetchEnvelopes([103, 101]);

    expect(envelopes.map((envelope) => envelope.uid)).toEqual([103, 101]);
    expect(envelopes.map((envelope) => envelope.subject)).toEqual(['three', 'one']);
  });

  test('a scripted bare-line response is still read', async () => {
    // Not a shape any server produces, but it is what a hand-written test
    // fixture looks like, and reading it costs nothing.
    const { client } = await connect({
      sectionEncoding: 'bare-lines',
      initial: [fake(101, 'bare lines')],
    });
    const [envelope] = await client.fetchEnvelopes([101]);
    expect(envelope?.subject).toBe('bare lines');
    expect(envelope?.from).toBe('sender101@sender.test');
  });

  test('a response with no UID item is reported, not silently dropped', async () => {
    const { client } = await connect({
      unreadableUids: [102],
      initial: [fake(101, 'readable'), fake(102, 'no uid item')],
    });
    const batch = await client.fetchEnvelopeBatch([101, 102]);

    expect(batch.envelopes.map((envelope) => envelope.uid)).toEqual([101]);
    expect(batch.unreadable).toHaveLength(1);
    expect(batch.unreadable[0]?.detail).toMatch(/no UID data item/);
    // The distinction the drain loop needs: 102 is absent from `envelopes`,
    // and `unreadable` is what says that absence is not an expunge.
    expect(batch.unreadable[0]?.seq).toBe(2);
  });

  test('a UID that really is gone produces no response and no complaint', async () => {
    const { client } = await connect({ initial: [fake(101, 'here')] });
    const batch = await client.fetchEnvelopeBatch([101, 999]);
    expect(batch.envelopes.map((envelope) => envelope.uid)).toEqual([101]);
    expect(batch.unreadable).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The parser, on shapes a socket test cannot conveniently produce
// ---------------------------------------------------------------------------

describe('parseFetchResponses', () => {
  test('a UID written inside the header payload is not read as the message UID', () => {
    const payload = 'From: a@b.test\r\nSubject: UID 999 is not my uid\r\n\r\n';
    const responses = parseFetchResponses([
      `* 3 FETCH (UID 307 BODY[HEADER.FIELDS (FROM SUBJECT)] ${payload}`,
      ')',
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.uid).toBe(307);
    expect(responses[0]?.parseError).toBeNull();
  });

  test('a response cut short by the tagged completion is a parse failure', () => {
    const responses = parseFetchResponses([
      '* 3 FETCH (UID 307 BODY[HEADER.FIELDS (FROM)] From: a@b.test',
      'A0004 OK FETCH completed',
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.parseError).toMatch(/cut short by the command's completion/);
  });

  test('a response the stream ended in the middle of is a parse failure', () => {
    const responses = parseFetchResponses([
      '* 3 FETCH (UID 307 BODY[HEADER.FIELDS (FROM)] From: a@b.test',
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.parseError).not.toBeNull();
    // And it says nothing about the message, so nobody can mistake it for one.
    expect(responses[0]?.uid).toBeNull();
  });

  test('a NIL section is empty, which is not the same as unreadable', () => {
    const responses = parseFetchResponses(['* 3 FETCH (UID 307 BODY[TEXT] NIL)']);
    expect(responses[0]?.parseError).toBeNull();
    expect(responses[0]?.uid).toBe(307);
    expect(fetchSection(responses[0] ?? never(), (spec) => spec === 'TEXT')).toBe('');
  });

  test('a partial-section suffix is part of the marker, not of the key', () => {
    // Two lines, because that is what a folded literal is: the payload owns the
    // remainder of its line down to the last byte, and the `)` that closes the
    // response is on the next one. A payload is opaque bytes — a body that ends
    // in `)` is an ordinary body, and trimming one off the end would corrupt it.
    const responses = parseFetchResponses([
      '* 1 FETCH (UID 5 BODY[TEXT]<0> hello there)',
      ')',
    ]);
    expect(responses[0]?.parseError).toBeNull();
    expect(fetchSection(responses[0] ?? never(), (spec) => spec === 'TEXT'))
      .toBe('hello there)');
  });

  test('a UID inside a quoted data item is not read as the message UID', () => {
    const responses = parseFetchResponses([
      '* 1 FETCH (INTERNALDATE "UID 42" UID 7 FLAGS (\\Seen))',
    ]);
    expect(responses[0]?.uid).toBe(7);
  });
});

function never(): never {
  throw new Error('the parser returned no response where one was expected');
}

// ---------------------------------------------------------------------------
// The cursor rule the ambiguity used to break
// ---------------------------------------------------------------------------

describe('the drain loop tells an expunge from an unreadable answer', () => {
  const settings = resolveWatcherSettings({ account: ACCOUNT, mailbox: MAILBOX });

  /** A wire that answers one `UID SEARCH` with the UIDs given. */
  function wireReturning(uids: readonly number[]): MailboxWire {
    return {
      onUntagged: () => () => undefined,
      sendCommand: async () => 'A0001',
      sendRawLine: async () => undefined,
      awaitContinuation: async () => undefined,
      awaitTag: async () => [`* SEARCH ${uids.join(' ')}`, 'A0001 OK SEARCH completed'],
      waitForUntagged: async () => '',
    };
  }

  function envelopeFor(uid: number): ImapEnvelope {
    return {
      uid,
      from: `sender${uid}@sender.test`,
      subject: `subject ${uid}`,
      date: 'Mon, 27 Jul 2026 09:00:00 +0000',
      messageId: `<uid-${uid}@example.test>`,
      mailbox: MAILBOX,
      deliveredTo: ['watched@example.test'],
      deliveryEvidence: [],
      unverifiedToHeaderClaim: '',
      authenticationResults: [],
    };
  }

  function readerReturning(batch: ImapEnvelopeBatch): MailboxReader {
    return {
      capabilities: async () => ['IMAP4REV1'],
      fetchEnvelopes: async () => [...batch.envelopes],
      fetchEnvelopeBatch: async () => batch,
    };
  }

  async function drain(input: {
    readonly found: readonly number[];
    readonly batch: ImapEnvelopeBatch;
  }): Promise<{
    readonly report: Awaited<ReturnType<typeof drainMailboxDelta>>;
    readonly cursors: RecordingCursorStore;
    readonly sink: RecordingSink;
    readonly observer: RecordingObserver;
  }> {
    const { store: cursors } = await makeCursorStore({
      account: ACCOUNT, mailbox: MAILBOX, uidValidity: 42, lastSeenUid: 100,
    });
    const sink = new RecordingSink();
    const observer = new RecordingObserver();
    const report = await drainMailboxDelta({
      settings,
      reader: readerReturning(input.batch),
      wire: wireReturning(input.found),
      cursors,
      sink,
      clock: new FakeClock(),
      observer,
      cursor: {
        account: ACCOUNT, mailbox: MAILBOX, uidValidity: 42, lastSeenUid: 100,
        updatedAt: '2026-07-28T12:00:00.000Z',
      },
      via: 'poll',
      signal: new AbortController().signal,
    });
    return { report, cursors, sink, observer };
  }

  test('an unreadable response does NOT advance the cursor and IS reported', async () => {
    // The defect in one line: the loop could not tell "the server says UID 101
    // is gone" from "we failed to parse the answer for UID 101", and resolved
    // it by advancing — permanently skipping a message still in the mailbox.
    const { report, cursors, sink, observer } = await drain({
      found: [101],
      batch: {
        envelopes: [],
        unreadable: [{ seq: 1, uid: null, detail: 'no UID data item' }],
      },
    });

    expect(report.outcome).toBe('read-failed');
    expect(report.phase).toBe('fetch');
    expect(report.cursor.lastSeenUid).toBe(100);
    expect(cursors.advances).toEqual([]);
    expect(sink.uids).toEqual([]);
    const note = observer.notes.find((entry) => entry.kind === 'fetch-unreadable');
    expect(note).toBeDefined();
    expect(note?.detail).toMatch(/not evidence that the message is gone/);
    expect(note?.detail).toMatch(/UID 101/);
  });

  test('a genuine expunge still advances the cursor', async () => {
    const { report, cursors, observer } = await drain({
      found: [101],
      batch: { envelopes: [], unreadable: [] },
    });

    expect(report.outcome).toBe('complete');
    expect(report.vanished).toBe(1);
    expect(report.cursor.lastSeenUid).toBe(101);
    expect(cursors.advances).toEqual([101]);
    expect(observer.notes.some((entry) => entry.kind === 'fetch-unreadable')).toBe(false);
  });

  test('messages below an unreadable one are delivered; the rest are retried', async () => {
    // Ascending order matters: 101 is complete and the cursor may sit on it,
    // 102 is unknown and the cursor must not pass it, so 102 and 103 both come
    // again on the next pass. Re-fetching 103 costs one round trip; skipping
    // 102 costs the message.
    const { report, cursors, sink } = await drain({
      found: [101, 102, 103],
      batch: {
        envelopes: [envelopeFor(101), envelopeFor(103)],
        unreadable: [{ seq: 2, uid: null, detail: 'no UID data item' }],
      },
    });

    expect(sink.uids).toEqual([101]);
    expect(cursors.advances).toEqual([101]);
    expect(report.cursor.lastSeenUid).toBe(101);
    expect(report.outcome).toBe('read-failed');
  });
});

// ---------------------------------------------------------------------------
// End to end: a mixed-shape delta through the real client
// ---------------------------------------------------------------------------

describe('a delta over a real socket loses nothing', () => {
  test('three messages, trailing UIDs, all four envelope fields intact', async () => {
    const { client } = await connect({
      uidPosition: 'trailing',
      initial: [fake(101, 'one'), fake(102, 'two'), fake(103, 'three')],
    });
    const batch = await client.fetchEnvelopeBatch([101, 102, 103]);

    expect(batch.unreadable).toEqual([]);
    expect(batch.envelopes).toHaveLength(3);
    for (const envelope of batch.envelopes) {
      expect(envelope.from).toBe(`sender${envelope.uid}@sender.test`);
      expect(envelope.subject.length).toBeGreaterThan(0);
      expect(envelope.date).toBe('Mon, 27 Jul 2026 09:00:00 +0000');
      expect(envelope.messageId).toBe(`<uid-${envelope.uid}@example.test>`);
      expect(envelope.deliveredTo).toEqual(['watched@example.test']);
    }
  });
});
