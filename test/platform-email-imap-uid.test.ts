/**
 * List-then-read, against a mailbox where a message's UID and its sequence
 * number are different numbers.
 *
 * That is every mailbox anything has ever been deleted from, and it is the
 * case the previous code got wrong: `SEARCH` returned sequence numbers,
 * `fetchEnvelopes` reported one in a field named `uid`, and `email.inbox.read`
 * then passed it to `UID FETCH` — so opening a message from a listing opened a
 * different message. These tests hold the two numbers apart on purpose (seq
 * 1,2,3 hold UIDs 101,205,307) so that reporting the wrong one is a visible
 * failure rather than a coincidence.
 *
 * The second property here is body-preview attribution: the preview is fetched
 * for one message and must be shown against that message, and recorded as
 * untrusted content written by that message's sender.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { connect, type Socket } from 'node:net';
import { EmailService } from '../packages/sdk/src/platform/email/email-service.ts';
import {
  testDescribeSenderClaim,
  throwingEmailTransport,
} from './_helpers/platform-email-fixtures.ts';
import {
  makeFakeImapServer,
  serverWrite,
  type FakeServer,
} from './_helpers/fake-imap-server.ts';

const PASSWORD_KEY = 'GOODVIBES_EMAIL_PASSWORD';

interface FakeMessage {
  readonly seq: number;
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
}

/** Three messages whose sequence numbers and UIDs cannot be confused. */
const MESSAGES: readonly FakeMessage[] = [
  { seq: 1, uid: 101, from: 'Ann <ann@one.test>', subject: 'oldest', body: 'body of 101' },
  { seq: 2, uid: 205, from: 'Bo <bo@two.test>', subject: 'middle', body: 'body of 205' },
  { seq: 3, uid: 307, from: 'Cy <cy@three.test>', subject: 'newest', body: 'body of 307' },
];

function messageByUid(uid: number): FakeMessage | undefined {
  return MESSAGES.find((message) => message.uid === uid);
}

/**
 * A server that answers UID commands by UID and sequence-number commands by
 * sequence number, and refuses to pretend the two are the same.
 */
async function startFakeImap(commands: string[]): Promise<FakeServer> {
  return makeFakeImapServer((sock) => {
    serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
    sock.on('error', () => { /* client teardown races are not failures */ });
    sock.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString().split(/\r\n/)) {
        const line = raw.trim();
        if (line.length === 0) continue;
        commands.push(line);
        const tag = line.split(' ')[0] ?? 'A0001';

        if (/\bLOGIN\b/.test(line)) {
          serverWrite(sock, `${tag} OK LOGIN completed`);
        } else if (/\bEXAMINE\b/.test(line)) {
          serverWrite(sock, '* 3 EXISTS');
          serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
        } else if (/\bLOGOUT\b/.test(line)) {
          serverWrite(sock, '* BYE logging out');
          serverWrite(sock, `${tag} OK LOGOUT completed`);
        } else if (/UID SEARCH/.test(line)) {
          serverWrite(sock, `* SEARCH ${MESSAGES.map((m) => m.uid).join(' ')}`);
          serverWrite(sock, `${tag} OK SEARCH completed`);
        } else if (/^\S+ SEARCH/.test(line)) {
          // A plain SEARCH answers with SEQUENCE numbers. Anything that ends up
          // treating these as UIDs reads the wrong message, which is the point.
          serverWrite(sock, `* SEARCH ${MESSAGES.map((m) => m.seq).join(' ')}`);
          serverWrite(sock, `${tag} OK SEARCH completed`);
        } else if (/UID FETCH/.test(line)) {
          const requested = (/UID FETCH ([\d,]+)/.exec(line)?.[1] ?? '')
            .split(',')
            .map((value) => parseInt(value, 10))
            .filter((value) => value > 0);
          for (const uid of requested) {
            const message = messageByUid(uid);
            if (message === undefined) continue; // no such UID: no FETCH response
            if (line.includes('HEADER.FIELDS')) {
              serverWrite(sock, `* ${message.seq} FETCH (UID ${message.uid} BODY[HEADER.FIELDS (FROM SUBJECT)] `);
              serverWrite(sock, `From: ${message.from}`);
              serverWrite(sock, `Subject: ${message.subject}`);
              serverWrite(sock, ')');
            } else if (line.includes('BODY.PEEK[HEADER]')) {
              serverWrite(sock, `* ${message.seq} FETCH (UID ${message.uid} BODY[HEADER] `);
              serverWrite(sock, `From: ${message.from}`);
              serverWrite(sock, `Subject: ${message.subject}`);
              serverWrite(sock, ')');
            } else if (line.includes('BODYSTRUCTURE')) {
              serverWrite(sock, `* ${message.seq} FETCH (UID ${message.uid} BODYSTRUCTURE NIL)`);
            } else {
              serverWrite(sock, `* ${message.seq} FETCH (UID ${message.uid} BODY[TEXT]<0> `);
              serverWrite(sock, message.body);
              serverWrite(sock, ')');
            }
          }
          serverWrite(sock, `${tag} OK FETCH completed`);
        } else if (/FETCH/.test(line)) {
          // A sequence-number FETCH. Answered from the sequence-number side, so
          // a client that addressed by the wrong number gets the wrong message
          // rather than an error that would hide the mistake.
          const seq = parseInt(/FETCH (\d+)/.exec(line)?.[1] ?? '0', 10);
          const message = MESSAGES.find((candidate) => candidate.seq === seq);
          if (message !== undefined) {
            serverWrite(sock, `* ${message.seq} FETCH (BODY[TEXT]<0> `);
            serverWrite(sock, message.body);
            serverWrite(sock, ')');
          }
          serverWrite(sock, `${tag} OK FETCH completed`);
        } else {
          serverWrite(sock, `${tag} OK completed`);
        }
      }
    });
  });
}

interface RecordedIngest {
  readonly surface: 'email';
  readonly origin: string;
  readonly content?: string | undefined;
}

function buildService(port: number): {
  readonly service: EmailService;
  readonly ingests: RecordedIngest[];
} {
  const config: Record<string, unknown> = {
    'email.enabled': true,
    'email.imapHost': '127.0.0.1',
    'email.imapPort': port,
    'email.smtpHost': '127.0.0.1',
    'email.smtpPort': 587,
    'email.username': 'owner@example.com',
    'email.passwordRef': `goodvibes://secrets/goodvibes/${PASSWORD_KEY}`,
    'email.fromAddress': 'owner@example.com',
  };
  const ingests: RecordedIngest[] = [];
  const service = new EmailService({
    getConfig: (key: string) => config[key],
    secretsManager: { get: async (key: string) => (key === PASSWORD_KEY ? 'pw' : null) },
    transport: throwingEmailTransport,
    describeSenderClaim: testDescribeSenderClaim,
    imapSocketFactory: async (host, p): Promise<Socket> => connect({ host, port: p }),
    recordUntrustedIngest: (ingest) => { ingests.push(ingest as RecordedIngest); },
  });
  return { service, ingests };
}

describe('list then read, where UID and sequence number differ', () => {
  let fake: FakeServer | null = null;
  afterEach(() => { fake?.close(); fake = null; });

  test('the listing reports real UIDs and asks for them by UID', async () => {
    const commands: string[] = [];
    fake = await startFakeImap(commands);
    const { service } = buildService(fake.address.port);

    const result = await service.listInbox({ unreadOnly: false });

    expect(result.messages.map((message) => message.uid)).toEqual([101, 205, 307]);
    expect(result.messages.map((message) => message.subject))
      .toEqual(['oldest', 'middle', 'newest']);
    expect(commands.some((line) => line.includes('UID SEARCH ALL'))).toBe(true);
    expect(commands.some((line) => line.includes('UID FETCH 101,205,307'))).toBe(true);
  });

  test('reading a listed message reads the message that was listed', async () => {
    const commands: string[] = [];
    fake = await startFakeImap(commands);
    const { service } = buildService(fake.address.port);

    const listed = await service.listInbox({ unreadOnly: false });
    const middle = listed.messages[1];
    expect(middle?.subject).toBe('middle');

    const detail = await service.readMessage(middle?.uid ?? 0);
    // Reporting sequence number 2 as the uid would have read UID 2, which is
    // not in the mailbox at all — a null, or worse, somebody else's message.
    expect(detail?.subject).toBe('middle');
    expect(detail?.bodyText).toContain('body of 205');
  });

  test('the body preview belongs to the message it was fetched from', async () => {
    const commands: string[] = [];
    fake = await startFakeImap(commands);
    const { service, ingests } = buildService(fake.address.port);

    // Two of three: the page is the highest UIDs, 205 and 307.
    const result = await service.listInbox({ unreadOnly: false, limit: 2 });

    expect(result.messages.map((message) => message.uid)).toEqual([205, 307]);
    expect(result.messages[0]?.bodyPreview).toBe('');
    expect(result.messages[1]?.bodyPreview).toContain('body of 307');
    // Never the oldest match's body against the first row of the page.
    expect(result.messages[0]?.bodyPreview).not.toContain('body of 101');

    // And the same text is attributed to the sender who actually wrote it.
    const withBody = ingests.filter((ingest) => (ingest.content ?? '').includes('body of'));
    expect(withBody).toHaveLength(1);
    expect(withBody[0]?.origin).toBe('email:three.test (claimed)');
    expect(withBody[0]?.content).toContain('body of 307');
  });
});
