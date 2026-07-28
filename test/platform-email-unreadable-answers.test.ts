/**
 * What `email.inbox.list` and `email.inbox.read` say when the server answers
 * and this client cannot read the answer.
 *
 * Both used to say nothing at all, in the two different ways available to them:
 *
 *   - `listInbox` returned a SHORT PAGE with a `total` that still counted the
 *     full search match. UIDs 101/102/103 with 102 unreadable came back as
 *     `[103, 101]` and `total: 3`, and no field anywhere distinguished "102 was
 *     expunged between the search and the fetch" from "102 is in the mailbox
 *     and we could not read what the server said about it". `fetchEnvelopes`'
 *     own doc warns that "omission alone is not evidence of an expunge"; its
 *     one production caller ignored the warning.
 *   - `readMessage` returned `null`, which its caller renders as "no message
 *     with UID n is in the mailbox — it may have been moved or deleted since it
 *     was listed". For an unreadable answer that is a false statement about the
 *     owner's mailbox.
 *
 * The fake server here is scripted per UID so a test can make exactly one
 * message unreadable and leave the rest ordinary.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { EmailService } from '../packages/sdk/src/platform/email/email-service.ts';
import { createServiceBackedGateway } from '../packages/sdk/src/platform/control-plane/routes/email-composition.ts';
import {
  testDescribeSenderClaim,
  throwingEmailTransport,
} from './_helpers/platform-email-fixtures.ts';

const PASSWORD_KEY = 'GOODVIBES_EMAIL_PASSWORD';

interface FakeServer {
  readonly port: number;
  close(): void;
}

interface FakeOptions {
  /** UIDs the SEARCH answers with. */
  readonly present: readonly number[];
  /**
   * UIDs answered with a FETCH response that carries no header section.
   *
   * A real shape, not a torn socket: the response arrives, names its UID, and
   * has nothing in it this client can read a header out of.
   */
  readonly headerless: readonly number[];
  /** UIDs the server answers nothing at all for — a genuine expunge. */
  readonly absent?: readonly number[];
  /**
   * UIDs answered with a ZERO-LENGTH literal: `BODY[HEADER.FIELDS (...)] {0}`.
   *
   * Legal, and what a real server sends for a message carrying NONE of the
   * header fields that were asked for. RFC 3501 §4.3: `{0}` announces zero
   * bytes to follow.
   */
  readonly zeroLiteral?: readonly number[];
}

function headerBlock(uid: number): string {
  return `From: sender${String(uid)}@sender.test\r\n`
    + `Subject: Message ${String(uid)}\r\n`
    + 'Date: Mon, 27 Jul 2026 09:00:00 +0000\r\n'
    + `Message-ID: <uid-${String(uid)}@example.test>\r\n`
    + 'Delivered-To: owner@example.com\r\n'
    + '\r\n';
}

async function startFakeImap(options: FakeOptions): Promise<FakeServer> {
  const absent = options.absent ?? [];
  const server: Server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    const reply = (text: string): void => { socket.write(`${text}\r\n`); };

    reply('* OK IMAP4rev1 Fake Server ready');
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const index = buffer.indexOf('\r\n');
        if (index === -1) return;
        const line = buffer.subarray(0, index).toString('utf8');
        buffer = buffer.subarray(index + 2);
        if (line.length === 0) continue;
        const tag = line.split(' ')[0] ?? 'A0001';

        if (/\bLOGIN\b/.test(line)) { reply(`${tag} OK LOGIN completed`); continue; }
        if (/\bEXAMINE\b/.test(line)) {
          reply(`* ${String(options.present.length)} EXISTS`);
          reply('* OK [UIDVALIDITY 900]');
          reply(`* OK [UIDNEXT ${String(Math.max(...options.present, 0) + 1)}]`);
          reply(`${tag} OK [READ-ONLY] EXAMINE completed`);
          continue;
        }
        if (/\bLOGOUT\b/.test(line)) {
          reply('* BYE logging out');
          reply(`${tag} OK LOGOUT completed`);
          continue;
        }
        if (/SEARCH/.test(line)) {
          reply(`* SEARCH ${options.present.join(' ')}`);
          reply(`${tag} OK SEARCH completed`);
          continue;
        }
        if (/UID FETCH/.test(line) && line.includes('HEADER.FIELDS')) {
          const requested = (/UID FETCH ([\d,]+)/.exec(line)?.[1] ?? '')
            .split(',')
            .map((value) => parseInt(value, 10))
            .filter((value) => value > 0);
          let seq = 0;
          for (const uid of requested) {
            seq += 1;
            if (absent.includes(uid)) continue;
            if (options.headerless.includes(uid)) {
              // A response that names its UID and carries no header section.
              reply(`* ${String(seq)} FETCH (UID ${String(uid)})`);
              continue;
            }
            if ((options.zeroLiteral ?? []).includes(uid)) {
              socket.write(
                `* ${String(seq)} FETCH (UID ${String(uid)} `
                + `BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID TO DELIVERED-TO `
                + `X-ORIGINAL-TO AUTHENTICATION-RESULTS)] {0}\r\n`,
              );
              socket.write(')\r\n');
              continue;
            }
            const block = headerBlock(uid);
            socket.write(
              `* ${String(seq)} FETCH (UID ${String(uid)} `
              + `BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID TO DELIVERED-TO `
              + `X-ORIGINAL-TO AUTHENTICATION-RESULTS)] {${String(Buffer.byteLength(block, 'utf8'))}}\r\n`,
            );
            socket.write(block);
            socket.write(')\r\n');
          }
          reply(`${tag} OK FETCH completed`);
          continue;
        }
        if (/UID FETCH/.test(line)) {
          const uid = parseInt(/UID FETCH (\d+)/.exec(line)?.[1] ?? '0', 10);
          if (absent.includes(uid)) { reply(`${tag} OK FETCH completed`); continue; }
          if (options.headerless.includes(uid) && line.includes('BODY.PEEK[HEADER]')) {
            // The response arrives with a zero-length section: it is here, and
            // there is nothing in it.
            socket.write(`* 1 FETCH (UID ${String(uid)} BODY[HEADER] {0}\r\n`);
            socket.write(')\r\n');
            reply(`${tag} OK FETCH completed`);
            continue;
          }
          if (line.includes('BODY.PEEK[HEADER]')) {
            const block = headerBlock(uid);
            socket.write(
              `* 1 FETCH (UID ${String(uid)} BODY[HEADER] `
              + `{${String(Buffer.byteLength(block, 'utf8'))}}\r\n`,
            );
            socket.write(block);
            socket.write(')\r\n');
            reply(`${tag} OK FETCH completed`);
            continue;
          }
          if (line.includes('BODYSTRUCTURE')) {
            reply(`* 1 FETCH (UID ${String(uid)} BODYSTRUCTURE NIL)`);
            reply(`${tag} OK FETCH completed`);
            continue;
          }
          const body = 'the whole body\r\n';
          socket.write(
            `* 1 FETCH (UID ${String(uid)} BODY[TEXT] `
            + `{${String(Buffer.byteLength(body, 'utf8'))}}\r\n`,
          );
          socket.write(body);
          socket.write(')\r\n');
          reply(`${tag} OK FETCH completed`);
          continue;
        }
        reply(`${tag} OK completed`);
      }
    });
    socket.on('error', () => { /* client hangups are normal */ });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => server.close(),
  };
}

function buildService(port: number): EmailService {
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
  return new EmailService({
    getConfig: (key: string) => config[key],
    secretsManager: { get: async (key: string) => (key === PASSWORD_KEY ? 'pw' : null) },
    transport: throwingEmailTransport,
    describeSenderClaim: testDescribeSenderClaim,
    imapSocketFactory: async (host, p) => connect({ host, port: p }),
    recordUntrustedIngest: () => { /* not under test here */ },
  });
}

let fake: FakeServer | null = null;
afterEach(() => { fake?.close(); fake = null; });

// ---------------------------------------------------------------------------
// listInbox
// ---------------------------------------------------------------------------

describe('listInbox says when a page is short because an answer could not be read', () => {
  test('an unreadable message is REPORTED rather than silently dropped', async () => {
    fake = await startFakeImap({ present: [101, 102, 103], headerless: [102] });
    const result = await buildService(fake.port).listInbox({ unreadOnly: false, limit: 10 });

    // The page is genuinely short — that part was never in dispute.
    expect(result.messages.map((message) => message.uid)).toEqual([103, 101]);
    expect(result.total).toBe(3);

    // ...and now it says so, naming the UID the server answered for.
    expect(result.unreadable).toBeDefined();
    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable?.[0]?.uid).toBe(102);
    expect(result.unreadable?.[0]?.detail).toContain('no header section');
  });

  test('a complete page carries no unreadable field at all', async () => {
    // Additive means additive: the healthy shape is byte-for-byte what it was.
    fake = await startFakeImap({ present: [101, 102, 103], headerless: [] });
    const result = await buildService(fake.port).listInbox({ unreadOnly: false, limit: 10 });

    expect(result.messages).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.unreadable).toBeUndefined();
    expect('unreadable' in result).toBe(false);
  });

  test('a message the server never answered for is NOT reported as unreadable', async () => {
    // An expunge between the search and the fetch is ordinary and must not be
    // dressed up as a failure — the distinction cuts both ways.
    fake = await startFakeImap({ present: [101, 102, 103], headerless: [], absent: [102] });
    const result = await buildService(fake.port).listInbox({ unreadOnly: false, limit: 10 });

    expect(result.messages.map((message) => message.uid)).toEqual([103, 101]);
    expect(result.unreadable).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readMessage
// ---------------------------------------------------------------------------

describe('readMessage tells "gone" apart from "could not be read"', () => {
  test('a UID that is genuinely gone still answers null', async () => {
    fake = await startFakeImap({ present: [101], headerless: [], absent: [999] });
    expect(await buildService(fake.port).readMessage(999)).toBeNull();
  });

  test('a UID the server answered unreadably does NOT answer null', async () => {
    // `null` here is the false statement: it becomes "no message with UID 102
    // is in the mailbox", and the message is in the mailbox.
    fake = await startFakeImap({ present: [101, 102], headerless: [102] });
    await expect(buildService(fake.port).readMessage(102))
      .rejects.toThrow(/could not read/);
  });

  test('the structured result names all three outcomes', async () => {
    fake = await startFakeImap({ present: [101, 102], headerless: [102], absent: [999] });
    const service = buildService(fake.port);

    const read = await service.readMessageResult(101);
    expect(read.outcome).toBe('read');
    if (read.outcome === 'read') expect(read.detail.uid).toBe(101);

    expect((await service.readMessageResult(999)).outcome).toBe('gone');

    const unreadable = await service.readMessageResult(102);
    expect(unreadable.outcome).toBe('unreadable');
    if (unreadable.outcome === 'unreadable') {
      expect(unreadable.problems).not.toHaveLength(0);
      expect(unreadable.problems[0]?.detail).toContain('no readable header section');
    }
  });

  test('an ordinary message still reads normally', async () => {
    fake = await startFakeImap({ present: [101], headerless: [] });
    const detail = await buildService(fake.port).readMessage(101);
    expect(detail?.uid).toBe(101);
    expect(detail?.from).toBe('sender101@sender.test');
    expect(detail?.subject).toBe('Message 101');
  });
});

// ---------------------------------------------------------------------------
// The zero-length literal
// ---------------------------------------------------------------------------

describe('a `{0}` header section is an empty answer, not a missing message', () => {
  test('a message carrying none of the requested headers is still LISTED', async () => {
    // `{0}` is legal and means "zero bytes follow" (RFC 3501 §4.3). A server
    // answering BODY[HEADER.FIELDS (...)] for a message that has none of those
    // fields sends exactly this.
    //
    // The defect it guards: the reader used to fall through to the literal
    // branch, which leaves `literalBytesRemaining` at zero — so the owner line,
    // the `* n FETCH (` line itself, was never routed and the whole response
    // was dropped. A dropped response is indistinguishable from an expunge, so
    // this message vanished from the page and, in the watcher, the cursor
    // stepped straight over it.
    fake = await startFakeImap({ present: [101, 102, 103], headerless: [], zeroLiteral: [102] });
    const result = await buildService(fake.port).listInbox({ unreadOnly: false, limit: 10 });

    // 102 is present — with nothing in it, which is the truth about it.
    expect(result.messages.map((message) => message.uid)).toEqual([103, 102, 101]);
    expect(result.messages.find((message) => message.uid === 102)?.subject).toBe('');
    expect(result.total).toBe(3);
  });

  test('an empty answer is not reported as unreadable either', async () => {
    // The response WAS read. Reporting it as unreadable would be the same
    // conflation running the other way.
    fake = await startFakeImap({ present: [101, 102], headerless: [], zeroLiteral: [102] });
    const result = await buildService(fake.port).listInbox({ unreadOnly: false, limit: 10 });

    expect(result.unreadable).toBeUndefined();
  });

  test('the messages around it are unaffected', async () => {
    fake = await startFakeImap({ present: [101, 102, 103], headerless: [], zeroLiteral: [102] });
    const result = await buildService(fake.port).listInbox({ unreadOnly: false, limit: 10 });

    expect(result.messages.find((message) => message.uid === 103)?.subject).toBe('Message 103');
    expect(result.messages.find((message) => message.uid === 101)?.from).toBe('sender101@sender.test');
  });
});

// ---------------------------------------------------------------------------
// The wire verb
// ---------------------------------------------------------------------------

describe('email.inbox.list carries the fact over the wire, not just in-process', () => {
  test('the gateway passes unreadable through, so a remote caller can see it too', async () => {
    // The SDK-side field is only half the fix: `email.inbox.list` is served to
    // callers that never touch `EmailService`, and a schema that advertises the
    // field while the handler drops it would be worse than not having it.
    fake = await startFakeImap({ present: [101, 102, 103], headerless: [102] });
    const gateway = createServiceBackedGateway(buildService(fake.port));

    const result = await gateway.listInbox({ unreadOnly: false, limit: 10 });

    expect(result.messages.map((message) => message.uid)).toEqual([103, 101]);
    expect(result.total).toBe(3);
    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable?.[0]?.uid).toBe(102);
  });

  test('a whole page sends no unreadable key at all', async () => {
    fake = await startFakeImap({ present: [101, 102], headerless: [] });
    const gateway = createServiceBackedGateway(buildService(fake.port));

    const result = await gateway.listInbox({ unreadOnly: false, limit: 10 });

    expect(result.unreadable).toBeUndefined();
    expect('unreadable' in result).toBe(false);
  });

  test('an unreadable single message is NOT reported to the caller as a 404', async () => {
    // `readMessage` answering null here made the handler raise NOT_FOUND with
    // "it may have been moved or deleted since it was listed" — a false
    // statement about a message that is sitting in the mailbox.
    fake = await startFakeImap({ present: [101, 102], headerless: [102] });
    const gateway = createServiceBackedGateway(buildService(fake.port));

    await expect(gateway.readMessage(102)).rejects.toMatchObject({ code: 'EMAIL_REQUEST_FAILED' });
  });
});
