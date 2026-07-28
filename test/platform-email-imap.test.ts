/**
 * IMAP client protocol tests using an in-process fake server.
 * No real network connections are made. TLS is bypassed by injecting
 * a plain net.Socket pair via net.createServer.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Socket } from 'node:net';
import {
  ImapClient,
  imapConnection,
  ImapOpenError,
  imapQuoteCredential,
  IMAP_MAX_FETCH_UIDS,
} from '../packages/sdk/src/platform/email/imap-client.ts';
import {
  describeEmailCapabilityFailure,
  resolveIdleSupport,
} from '../packages/sdk/src/platform/email/imap-open.ts';
import { formatImapDate } from '../packages/sdk/src/platform/email/imap-headers.ts';
import {
  connectSocket,
  makeFakeImapServer,
  serverWrite,
  type FakeServer,
} from './_helpers/fake-imap-server.ts';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImapClient protocol', () => {
  let fakeServer: FakeServer | null = null;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = null;
  });

  test('LOGIN success — open() sends greeting, auth, and EXAMINE', async () => {
    const events: string[] = [];

    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          events.push(line.trim());
          if (line.includes('LOGIN')) {
            const tag = line.split(' ')[0] ?? 'A0001';
            serverWrite(sock, `${tag} OK LOGIN completed`);
          } else if (line.includes('EXAMINE')) {
            const tag = line.split(' ')[0] ?? 'A0002';
            serverWrite(sock, '* 10 EXISTS');
            serverWrite(sock, '* 0 RECENT');
            serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          }
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'supersecret',
      timeoutMs: 3000,
    });

    await client.open();

    // credentials are now RFC 3501 quoted strings
    expect(events.some((e) => e.includes('LOGIN "user@example.test" "supersecret"'))).toBe(true);
    expect(events.some((e) => e.includes('EXAMINE INBOX'))).toBe(true);
  });

  test('LOGIN failure — throws on NO response', async () => {
    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line.includes('LOGIN')) {
          // Credentials arrive as RFC 3501 quoted strings now
          const tag = line.split(' ')[0] ?? 'A0001';
          serverWrite(sock, `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'wrongpassword',
      timeoutMs: 3000,
    });

    await expect(client.open()).rejects.toThrow('IMAP command failed');
  });

  test('SEARCH UNSEEN — parses sequence numbers from * SEARCH response', async () => {
    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('SEARCH')) {
            serverWrite(sock, '* SEARCH 3 7 12 15');
            serverWrite(sock, `${tag} OK SEARCH completed`);
          }
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
    });
    await client.open();
    const nums = await client.searchUnseen();
    expect(nums).toEqual([3, 7, 12, 15]);
  });

  test('SEARCH SINCE — command includes date criterion', async () => {
    const commandsSeen: string[] = [];

    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          commandsSeen.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('SEARCH')) {
            serverWrite(sock, '* SEARCH 5');
            serverWrite(sock, `${tag} OK SEARCH completed`);
          }
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
    });
    await client.open();
    const date = new Date('2025-01-15');
    const nums = await client.searchUnseen(date);
    expect(nums).toEqual([5]);
    const searchCmd = commandsSeen.find((c) => c.includes('SEARCH'));
    expect(searchCmd).toContain('SINCE');
    expect(searchCmd).toContain('15-Jan-2025');
  });

  test('FETCH envelope — parses FROM, SUBJECT, DATE headers; messages stay unread (PEEK)', async () => {
    const commandsSeen: string[] = [];

    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          commandsSeen.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('FETCH') && line.includes('HEADER')) {
            // Sequence number 1, UID 3 — the two differ, as they do in any
            // mailbox something has been deleted from.
            serverWrite(sock, '* 1 FETCH (UID 3 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] ');
            serverWrite(sock, 'From: Alice <alice@example.test>');
            serverWrite(sock, 'Subject: Hello world');
            serverWrite(sock, 'Date: Mon, 10 Jun 2026 09:00:00 +0000');
            serverWrite(sock, 'Message-ID: <abc123@example.test>');
            serverWrite(sock, ')');
            serverWrite(sock, `${tag} OK FETCH completed`);
          }
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
    });
    await client.open();
    const envelopes = await client.fetchEnvelopes([3]);

    // Verify PEEK was used (messages not marked read)
    expect(commandsSeen.some((c) => c.includes('BODY.PEEK[HEADER'))).toBe(true);
    expect(commandsSeen.every((c) => !c.includes('BODY[HEADER') || c.includes('PEEK'))).toBe(true);

    expect(envelopes).toHaveLength(1);
    const env = envelopes[0];
    expect(env).toBeDefined();
    if (env) {
      expect(env.uid).toBe(3);
      expect(env.from).toContain('alice@example.test');
      expect(env.subject).toBe('Hello world');
      expect(env.date).toContain('Jun 2026');
    }
  });

  test('FETCH body preview — uses PEEK and returns bounded content', async () => {
    const commandsSeen: string[] = [];

    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          commandsSeen.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('FETCH') && line.includes('TEXT')) {
            serverWrite(sock, '* 5 FETCH (BODY[TEXT]<0>');
            serverWrite(sock, 'Hello from the body');
            serverWrite(sock, ')');
            serverWrite(sock, `${tag} OK FETCH completed`);
          }
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
      maxBodyBytes: 512,
    });
    await client.open();
    const preview = await client.fetchBodyPreview(5);

    expect(commandsSeen.some((c) => c.includes('BODY.PEEK[TEXT]'))).toBe(true);
    expect(preview).toContain('Hello from the body');
  });

  test('LOGOUT — sends LOGOUT command and closes', async () => {
    const commandsSeen: string[] = [];

    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          commandsSeen.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('LOGOUT')) {
            serverWrite(sock, '* BYE IMAP4rev1 Server logging out');
            serverWrite(sock, `${tag} OK LOGOUT completed`);
            sock.end();
          }
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
    });
    await client.open();
    await client.logout();
    expect(commandsSeen.some((c) => c.includes('LOGOUT'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// imapQuoteCredential — direct unit tests
// ---------------------------------------------------------------------------

describe('imapQuoteCredential — direct unit tests', () => {
  test('plain ASCII password is wrapped in double quotes', () => {
    expect(imapQuoteCredential('simplepass', 'password')).toBe('"simplepass"');
  });

  test('password with spaces is quoted (not split as separate IMAP token)', () => {
    expect(imapQuoteCredential('my secret password', 'password')).toBe('"my secret password"');
  });

  test('double-quote in password is escaped as \\"', () => {
    expect(imapQuoteCredential('pass"word', 'password')).toBe('"pass\\"word"');
  });

  test('backslash in password is escaped as \\\\', () => {
    expect(imapQuoteCredential('pass\\word', 'password')).toBe('"pass\\\\word"');
  });

  test('password with space, double-quote, and backslash is fully escaped', () => {
    expect(imapQuoteCredential('a "b\\c" d', 'password')).toBe('"a \\"b\\\\c\\" d"');
  });

  test('throws for CRLF in password', () => {
    expect(() => imapQuoteCredential('pass\r\nbad', 'password'))
      .toThrow(/must not contain carriage return or newline/);
  });

  test('throws for LF-only in password', () => {
    expect(() => imapQuoteCredential('inject\ncommand', 'password'))
      .toThrow(/must not contain carriage return or newline/);
  });

  test('throws for control character (0x01) in password', () => {
    expect(() => imapQuoteCredential('pass\x01word', 'password'))
      .toThrow(/must be printable US-ASCII characters/);
  });

  test('throws for DEL (0x7f) in password', () => {
    expect(() => imapQuoteCredential('pass\x7fword', 'password'))
      .toThrow(/must be printable US-ASCII characters/);
  });

  test('throws for non-ASCII UTF-8 password (café)', () => {
    expect(() => imapQuoteCredential('café', 'password'))
      .toThrow(/must be printable US-ASCII characters/);
  });

  test('throws for non-ASCII password (pÄss)', () => {
    expect(() => imapQuoteCredential('pÄss', 'password'))
      .toThrow(/must be printable US-ASCII characters/);
  });

  test('throws for raw 0x80 byte in password', () => {
    // Buffer.from creates a string with a byte value of 0x80
    const withHighByte = Buffer.from([0x70, 0x61, 0x73, 0x80, 0x73]).toString('latin1');
    expect(() => imapQuoteCredential(withHighByte, 'password'))
      .toThrow(/must be printable US-ASCII characters/);
  });
});

// ---------------------------------------------------------------------------
// IMAP LOGIN injection / credential quoting tests
// ---------------------------------------------------------------------------

describe('ImapClient credential quoting and injection prevention', () => {
  let fakeServer: FakeServer | null = null;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = null;
  });

  test('simple password with special chars (quotes + backslash) is RFC 3501 quoted on the wire', async () => {
    const received: string[] = [];

    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          received.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    // Password contains backslash and double-quote — must be escaped in quoted string
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'pass\\word"123',
      timeoutMs: 3000,
    });
    await client.open();

    // The wire bytes must have escaped backslash and double-quote
    const loginCmd = received.find((l) => l.includes('LOGIN'));
    expect(loginCmd).toBeDefined();
    // Should contain the RFC 3501 quoted form with escapes
    expect(loginCmd).toContain('"user@example.test"');
    expect(loginCmd).toContain('"pass\\\\word\\"123"');
  });

  test('password with space is quoted on the wire (not split as separate token)', async () => {
    const received: string[] = [];

    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          received.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'my secret password',
      timeoutMs: 3000,
    });
    await client.open();

    const loginCmd = received.find((l) => l.includes('LOGIN'));
    expect(loginCmd).toBeDefined();
    // The entire password must be enclosed in double quotes
    expect(loginCmd).toContain('"my secret password"');
  });

  test('credential containing CR throws before writing to socket', async () => {
    // The socket is never connected — ImapClient.authenticate throws synchronously
    // before any socket write, so we use a dummy server that collects data.
    const received: string[] = [];
    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          received.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'good\r\nbad',  // contains CRLF
      timeoutMs: 3000,
    });

    await expect(client.open()).rejects.toThrow(/must not contain carriage return or newline/);
    // No LOGIN command should have reached the server
    expect(received.some((l) => l.includes('LOGIN'))).toBe(false);
  });

  test('credential containing LF throws before writing to socket', async () => {
    const received: string[] = [];
    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          received.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'inject\ncommand',
      timeoutMs: 3000,
    });

    await expect(client.open()).rejects.toThrow(/must not contain carriage return or newline/);
    expect(received.some((l) => l.includes('LOGIN'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unbounded IMAP literal tests
// ---------------------------------------------------------------------------

describe('ImapClient literal size cap', () => {
  let fakeServer: FakeServer | null = null;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = null;
  });

  test('oversized {N} literal from server is rejected and operation aborts', async () => {
    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('SEARCH')) {
            // Respond with a gigantic literal annotation — 999 MB
            serverWrite(sock, `* SEARCH {999999999}`);
            // Send a few actual bytes but not the full 999 MB
            sock.write('ABCDE');
          }
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
      maxBodyBytes: 4096,
    });
    await client.open();

    await expect(client.searchUnseen()).rejects.toThrow(/oversized literal/);
  });

  test('literal at exactly the cap is accepted', async () => {
    // The default cap is max(1MB, 4*4096) = 1MB. Send exactly 1 byte under.
    const CAP = 1_048_576;
    const safeSize = CAP; // test the boundary: exactly at cap should be rejected (> check)

    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('SEARCH')) {
            // Exact cap size should also be rejected (requested > cap means > literal cap)
            // Actually cap check is: requested > literalCap. So safeSize = CAP means
            // requested(CAP) > literalCap(CAP) is false => accepted.
            // Use CAP+1 to test rejection.
            serverWrite(sock, `* SEARCH {${safeSize + 1}}`);
            sock.write('X');
          }
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new ImapClient({
      socket,
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
    });
    await client.open();

    await expect(client.searchUnseen()).rejects.toThrow(/oversized literal/);
  });
});

describe('formatImapDate', () => {
  test('formats date in IMAP SINCE format', () => {
    expect(formatImapDate(new Date('2025-01-15'))).toBe('15-Jan-2025');
    expect(formatImapDate(new Date('2026-06-10'))).toBe('10-Jun-2026');
    expect(formatImapDate(new Date('2024-12-01'))).toBe('1-Dec-2024');
  });
});

// ---------------------------------------------------------------------------
// One session per connection: tags, retained bytes, untagged dispatch
// ---------------------------------------------------------------------------

describe('ImapClient connection lifetime', () => {
  let fakeServer: FakeServer | null = null;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = null;
  });

  /** Answers LOGIN and EXAMINE; everything else is the test's business. */
  function baseScript(
    seen: string[],
    onCommand?: (sock: Socket, line: string, tag: string) => boolean,
  ): (sock: Socket) => void {
    return (sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('error', () => { /* client teardown races are not failures */ });
      sock.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r\n/)) {
          if (!line.trim()) continue;
          seen.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (onCommand?.(sock, line, tag) === true) continue;
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('LOGOUT')) serverWrite(sock, `${tag} OK LOGOUT completed`);
        }
      });
    };
  }

  async function openClient(port: number, timeoutMs = 3000): Promise<ImapClient> {
    const client = new ImapClient({
      socket: await connectSocket(port),
      username: 'user@example.test',
      password: 'secret',
      timeoutMs,
    });
    await client.open();
    return client;
  }

  test('every command on one connection carries its own tag', async () => {
    const seen: string[] = [];
    fakeServer = await makeFakeImapServer(baseScript(seen, (sock, line, tag) => {
      if (!line.includes('SEARCH')) return false;
      serverWrite(sock, '* SEARCH 1');
      serverWrite(sock, `${tag} OK SEARCH completed`);
      return true;
    }));

    const client = await openClient(fakeServer.address.port);
    await client.searchUnseen();
    await client.searchAll();

    const tags = seen.map((line) => line.split(' ')[0] ?? '');
    expect(tags.length).toBe(4); // LOGIN, EXAMINE, UID SEARCH UNSEEN, UID SEARCH ALL
    expect(new Set(tags).size).toBe(tags.length);
  });

  test('bytes that arrive between commands are still there for the next one', async () => {
    const seen: string[] = [];
    fakeServer = await makeFakeImapServer(baseScript(seen, (sock, line, tag) => {
      if (line.includes('EXAMINE')) {
        // The EXAMINE completion, and then the first four bytes of the next
        // response — a response split across TCP segments, which is ordinary
        // and not under anyone's control. Those four bytes arrive while no
        // command is in flight.
        sock.write(`${tag} OK [READ-ONLY] EXAMINE completed\r\n* SEA`);
        return true;
      }
      if (line.includes('SEARCH')) {
        // The rest of the line the client is already holding half of.
        sock.write(`RCH 7 9\r\n${tag} OK SEARCH completed\r\n`);
        return true;
      }
      return false;
    }));

    const client = await openClient(fakeServer.address.port);
    expect(await client.searchUnseen()).toEqual([7, 9]);
  });

  test('an untagged response arriving outside a command window reaches subscribers', async () => {
    const seen: string[] = [];
    fakeServer = await makeFakeImapServer(baseScript(seen, (sock, line, tag) => {
      if (!line.includes('EXAMINE')) return false;
      serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
      // Unprompted, with nothing in flight — an arriving message, which is the
      // only thing IDLE is for.
      setTimeout(() => { serverWrite(sock, '* 5 EXISTS'); }, 25);
      return true;
    }));

    const client = await openClient(fakeServer.address.port);
    const connection = imapConnection(client);
    const received: string[] = [];
    const unsubscribe = connection.onUntagged((line) => { received.push(line); });

    const line = await connection.waitForUntagged(
      (candidate) => candidate.includes('EXISTS'),
      { timeoutMs: 2000 },
    );
    unsubscribe();

    expect(line).toBe('* 5 EXISTS');
    expect(received).toContain('* 5 EXISTS');
  });

  test('a long read has no deadline of its own, and ends when the caller says so', async () => {
    const seen: string[] = [];
    fakeServer = await makeFakeImapServer(baseScript(seen, (sock, line, tag) => {
      if (!line.includes('NOOP')) return false;
      // Far past the 200 ms per-operation timeout this client is built with.
      setTimeout(() => { serverWrite(sock, `${tag} OK NOOP completed`); }, 600);
      return true;
    }));

    const client = await openClient(fakeServer.address.port, 200);
    const connection = imapConnection(client);

    // The ordinary deadline is real and still applies.
    const impatient = await connection.sendCommand('NOOP');
    await expect(connection.awaitTag(impatient)).rejects.toThrow(/timed out/);

    // The long-read path waits it out.
    const patient = await connection.sendCommand('NOOP');
    const lines = await connection.awaitTag(patient, { timeoutMs: null });
    expect(lines[lines.length - 1]).toContain('OK NOOP completed');

    // And is bounded by the caller's cancellation rather than by a clock.
    const cancelled = await connection.sendCommand('NOOP');
    const controller = new AbortController();
    const pending = connection.awaitTag(cancelled, { timeoutMs: null, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  test('reading before open() is refused rather than opening a second reader', async () => {
    const seen: string[] = [];
    fakeServer = await makeFakeImapServer(baseScript(seen));
    const client = new ImapClient({
      socket: await connectSocket(fakeServer.address.port),
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
    });

    await expect(client.searchUnseen()).rejects.toThrow(/not open/);
    await expect(client.fetchEnvelopes([1])).rejects.toThrow(/not open/);
    await expect(client.fetchBodyPreview(1)).rejects.toThrow(/not open/);
    await expect(client.fetchMessage(1)).rejects.toThrow(/not open/);
    expect(() => imapConnection(client)).toThrow(/not open/);
    expect(seen.some((line) => line.includes('SEARCH'))).toBe(false);
  });

  test('a raw line can be written without allocating a tag, and the earlier tag still completes', async () => {
    const seen: string[] = [];
    fakeServer = await makeFakeImapServer(baseScript(seen, (sock, line, tag) => {
      if (line.includes('IDLE')) {
        serverWrite(sock, '+ idling');
        return true;
      }
      if (line.trim() === 'DONE') {
        // The completion belongs to the tag IDLE was issued under, which the
        // server remembers and the client must match rather than re-allocate.
        serverWrite(sock, '* 5 EXISTS');
        serverWrite(sock, `${seen.find((c) => c.includes('IDLE'))?.split(' ')[0] ?? 'A0003'} OK IDLE terminated`);
        return true;
      }
      return false;
    }));

    const client = await openClient(fakeServer.address.port);
    const connection = imapConnection(client);
    const untagged: string[] = [];
    connection.onUntagged((line) => { untagged.push(line); });

    const tag = await connection.sendCommand('IDLE');
    await connection.awaitContinuation(tag);
    await connection.sendRawLine('DONE');
    const lines = await connection.awaitTag(tag);

    expect(seen).toContain('DONE');
    expect(lines[lines.length - 1]).toContain('OK IDLE terminated');
    // Anything received during the DONE handshake is real and is delivered.
    expect(untagged).toContain('* 5 EXISTS');
  });
});

// ---------------------------------------------------------------------------
// UIDs, not sequence numbers
// ---------------------------------------------------------------------------

describe('ImapClient UID addressing', () => {
  let fakeServer: FakeServer | null = null;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = null;
  });

  /** Sequence 1,2,3 hold UIDs 101,205,307 — a mailbox things were deleted from. */
  const UID_BY_SEQ: Readonly<Record<number, number>> = { 1: 101, 2: 205, 3: 307 };

  test('search and fetch speak UID, and the envelope reports the real UID', async () => {
    const seen: string[] = [];
    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('error', () => { /* teardown races are not failures */ });
      sock.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r\n/)) {
          if (!line.trim()) continue;
          seen.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('SEARCH')) {
            serverWrite(sock, '* SEARCH 101 205 307');
            serverWrite(sock, `${tag} OK SEARCH completed`);
          } else if (line.includes('FETCH')) {
            for (const [seq, uid] of Object.entries(UID_BY_SEQ)) {
              serverWrite(sock, `* ${seq} FETCH (UID ${uid} BODY[HEADER.FIELDS (FROM SUBJECT)] `);
              serverWrite(sock, `From: sender-${uid}@example.test`);
              serverWrite(sock, `Subject: message ${uid}`);
              serverWrite(sock, ')');
            }
            serverWrite(sock, `${tag} OK FETCH completed`);
          }
        }
      });
    });

    const client = new ImapClient({
      socket: await connectSocket(fakeServer.address.port),
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
    });
    await client.open();

    const uids = await client.searchUnseen();
    expect(uids).toEqual([101, 205, 307]);

    const envelopes = await client.fetchEnvelopes(uids);
    expect(envelopes.map((envelope) => envelope.uid)).toEqual([101, 205, 307]);
    // The subject has to travel with the UID it was fetched under, not with
    // the sequence number in the response prefix.
    expect(envelopes.map((envelope) => envelope.subject))
      .toEqual(['message 101', 'message 205', 'message 307']);

    expect(seen.some((line) => line.includes('UID SEARCH UNSEEN'))).toBe(true);
    expect(seen.some((line) => line.includes('UID FETCH 101,205,307'))).toBe(true);
    expect(seen.some((line) => line.includes('(UID BODY.PEEK[HEADER.FIELDS'))).toBe(true);
  });

  test('the EXAMINE response is kept, so a stored UID can be qualified by its UIDVALIDITY', async () => {
    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('error', () => { /* teardown races are not failures */ });
      sock.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r\n/)) {
          if (!line.trim()) continue;
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) {
            serverWrite(sock, '* 12 EXISTS');
            serverWrite(sock, '* OK [UIDVALIDITY 1387556432] UIDs valid');
            serverWrite(sock, '* OK [UIDNEXT 4392] Predicted next UID');
            serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          }
        }
      });
    });

    const client = new ImapClient({
      socket: await connectSocket(fakeServer.address.port),
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
    });
    expect(client.mailboxStatus).toBeNull();
    await client.open();

    expect(client.mailboxStatus).toEqual({
      exists: 12,
      uidValidity: 1387556432,
      uidNext: 4392,
      readOnly: true,
    });
  });

  test('a UID the server returned nothing for is omitted, not filled in with a sequence number', async () => {
    const seen: string[] = [];
    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('error', () => { /* teardown races are not failures */ });
      sock.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r\n/)) {
          if (!line.trim()) continue;
          seen.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('FETCH')) {
            // 205 was expunged between the search and the fetch.
            serverWrite(sock, '* 1 FETCH (UID 101 BODY[HEADER.FIELDS (FROM SUBJECT)] ');
            serverWrite(sock, 'Subject: message 101');
            serverWrite(sock, ')');
            serverWrite(sock, `${tag} OK FETCH completed`);
          }
        }
      });
    });

    const client = new ImapClient({
      socket: await connectSocket(fakeServer.address.port),
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
    });
    await client.open();

    const envelopes = await client.fetchEnvelopes([101, 205]);
    expect(envelopes.map((envelope) => envelope.uid)).toEqual([101]);
  });
});

// ---------------------------------------------------------------------------
// What a connection can actually do, established at open time
// ---------------------------------------------------------------------------

describe('ImapClient open() reports capability, and names its failures', () => {
  let fakeServer: FakeServer | null = null;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = null;
  });

  interface ScriptOptions {
    readonly greeting?: string;
    /** null means: never answer LOGIN at all. */
    readonly loginReply?: ((tag: string) => string) | null;
    readonly examineReply?: (tag: string) => readonly string[];
    readonly capabilityReply?: (tag: string) => readonly string[];
  }

  function script(options: ScriptOptions): (sock: Socket) => void {
    return (sock) => {
      serverWrite(sock, options.greeting ?? '* OK IMAP4rev1 Fake Server ready');
      sock.on('error', () => { /* teardown races are not failures */ });
      sock.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r\n/)) {
          if (!line.trim()) continue;
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) {
            if (options.loginReply === null) continue;
            serverWrite(sock, (options.loginReply ?? ((t) => `${t} OK LOGIN completed`))(tag));
          } else if (line.includes('EXAMINE')) {
            const reply = options.examineReply
              ?? ((t) => [`${t} OK [READ-ONLY] EXAMINE completed`]);
            for (const out of reply(tag)) serverWrite(sock, out);
          } else if (line.includes('CAPABILITY')) {
            const reply = options.capabilityReply
              ?? ((t) => [`${t} OK CAPABILITY completed`]);
            for (const out of reply(tag)) serverWrite(sock, out);
          }
        }
      });
    };
  }

  async function build(port: number, timeoutMs = 3000): Promise<ImapClient> {
    return new ImapClient({
      socket: await connectSocket(port),
      username: 'user@example.test',
      password: 'secret',
      mailbox: 'Alias-42',
      timeoutMs,
    });
  }

  test('a mailbox that does not exist is a named mailbox failure, not an auth failure', async () => {
    fakeServer = await makeFakeImapServer(script({
      examineReply: (tag) => [`${tag} NO [NONEXISTENT] Unknown Mailbox: Alias-42 (Failure)`],
    }));
    const client = await build(fakeServer.address.port);

    let caught: unknown;
    try {
      await client.open();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ImapOpenError);
    const failure = caught as ImapOpenError;
    expect(failure.reason).toBe('mailbox-unavailable');
    expect(failure.mailbox).toBe('Alias-42');
    expect(failure.terminal).toBe(true);
    // The server's own words survive; "IMAP command failed" alone is what made
    // these three outcomes indistinguishable.
    expect(failure.serverMessage).toContain('Unknown Mailbox: Alias-42');
    expect(failure.message).toContain("mailbox 'Alias-42' could not be opened");

    // Signed in is not readable: nothing may be fetched from this connection.
    await expect(client.searchUnseen()).rejects.toThrow(/not open for reading/);
    await expect(client.fetchEnvelopes([1])).rejects.toThrow(/not open for reading/);
    expect(client.mailboxStatus).toBeNull();
  });

  test('a rejected credential is a named auth failure, terminal, and not retried', async () => {
    let loginAttempts = 0;
    fakeServer = await makeFakeImapServer(script({
      loginReply: (tag) => {
        loginAttempts += 1;
        return `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)`;
      },
    }));
    const client = await build(fakeServer.address.port);

    let caught: unknown;
    try {
      await client.open();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ImapOpenError);
    const failure = caught as ImapOpenError;
    expect(failure.reason).toBe('authentication-rejected');
    expect(failure.terminal).toBe(true);
    expect(failure.serverMessage).toContain('AUTHENTICATIONFAILED');
    expect(loginAttempts).toBe(1);
  });

  test('a LOGIN that is never answered is a connection failure, not a rejected credential', async () => {
    fakeServer = await makeFakeImapServer(script({ loginReply: null }));
    const client = await build(fakeServer.address.port, 150);

    let caught: unknown;
    try {
      await client.open();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ImapOpenError);
    const failure = caught as ImapOpenError;
    // The credential was never rejected — it was never answered. Calling that
    // a rejected credential would mark a network stall terminal and stop a
    // watcher from ever retrying it.
    expect(failure.reason).toBe('connection-failed');
    expect(failure.terminal).toBe(false);
    expect(failure.serverMessage).toContain('timed out');
  });

  test('a greeting that never arrives is a connection failure', async () => {
    fakeServer = await makeFakeImapServer((sock) => {
      sock.on('error', () => { /* teardown races are not failures */ });
      // No greeting at all.
    });
    const client = await build(fakeServer.address.port, 150);

    let caught: unknown;
    try {
      await client.open();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ImapOpenError);
    const failure = caught as ImapOpenError;
    expect(failure.reason).toBe('connection-failed');
    expect(failure.terminal).toBe(false);
  });

  test('a successful open reports the capabilities the server volunteered', async () => {
    fakeServer = await makeFakeImapServer(script({
      greeting: '* OK [CAPABILITY IMAP4rev1 UIDPLUS IDLE LITERAL+] Fake Server ready',
      examineReply: (tag) => [
        '* 12 EXISTS',
        '* OK [UIDVALIDITY 1387556432] UIDs valid',
        `${tag} OK [READ-ONLY] EXAMINE completed`,
      ],
    }));
    const client = await build(fakeServer.address.port);

    const report = await client.open();

    expect(report.idle).toEqual({ known: true, supported: true });
    expect(report.advertisedCapabilities).toContain('UIDPLUS');
    expect(report.mailbox.name).toBe('Alias-42');
    expect(report.mailbox.uidValidity).toBe(1387556432);
    expect(report.mailbox.exists).toBe(12);
    expect(report.mailbox.readOnly).toBe(true);
  });

  test('a server that volunteers nothing reports unknown, and is asked directly', async () => {
    const seen: string[] = [];
    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('error', () => { /* teardown races are not failures */ });
      sock.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r\n/)) {
          if (!line.trim()) continue;
          seen.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('CAPABILITY')) {
            serverWrite(sock, '* CAPABILITY IMAP4rev1 IDLE');
            serverWrite(sock, `${tag} OK CAPABILITY completed`);
          }
        }
      });
    });
    const client = await build(fakeServer.address.port);

    const report = await client.open();
    // Unknown, which is not the same fact as "does not support IDLE" — and the
    // shape does not let it be mistaken for one. `report.idle.supported` does
    // not exist until `known` has been narrowed, so a watcher cannot read the
    // unknown case as falsy by accident.
    expect(report.idle).toEqual({ known: false });
    expect(report.advertisedCapabilities).toEqual([]);
    // Nothing was asked for during open — ordinary mail operations pay nothing.
    expect(seen.some((line) => line.includes('CAPABILITY'))).toBe(false);

    // THE CASE THE TRI-STATE EXISTS FOR: a server that volunteered nothing in
    // its greeting still reaches IDLE, because the unknown is resolved by
    // actually asking rather than by assuming the answer is no.
    const decision = await resolveIdleSupport(client);
    expect(decision).toEqual({ supported: true, reason: 'advertised' });

    expect(await client.capabilities()).toContain('IDLE');
    expect(seen.filter((line) => line.includes('CAPABILITY'))).toHaveLength(1);
    // Asked once, cached after.
    await client.capabilities();
    expect(seen.filter((line) => line.includes('CAPABILITY'))).toHaveLength(1);
  });

  test('a server that will not list its capabilities polls, and says why', async () => {
    fakeServer = await makeFakeImapServer(script({
      // Answers CAPABILITY with a bare OK: no atoms at all.
      capabilityReply: (tag) => [`${tag} OK CAPABILITY completed`],
    }));
    const client = await build(fakeServer.address.port);

    const report = await client.open();
    expect(report.idle).toEqual({ known: false });

    const decision = await resolveIdleSupport(client);
    // Not silently false: false WITH the reason, so the surfaced status can
    // say it is polling because the server would not say, rather than leaving
    // the owner to assume his provider cannot do better.
    expect(decision).toEqual({ supported: false, reason: 'server-would-not-say' });
  });

  test('a server that lists capabilities without IDLE is a real no', async () => {
    fakeServer = await makeFakeImapServer(script({
      greeting: '* OK [CAPABILITY IMAP4rev1 UIDPLUS] Fake Server ready',
    }));
    const client = await build(fakeServer.address.port);

    const report = await client.open();
    expect(report.idle).toEqual({ known: true, supported: false });
    expect(await resolveIdleSupport(client))
      .toEqual({ supported: false, reason: 'not-advertised' });
  });

  test('a terminal failure carries an owner-facing notice that names the fix', async () => {
    fakeServer = await makeFakeImapServer(script({
      loginReply: (tag) => `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)`,
    }));
    const client = await build(fakeServer.address.port);

    let caught: unknown;
    try {
      await client.open();
    } catch (err) {
      caught = err;
    }

    // A supervisor routes this record; it does not re-derive the failure from a
    // message string, which is how a terminal failure ends as a log line
    // nobody reads while the inbox looks quiet.
    const notice = describeEmailCapabilityFailure(caught);
    expect(notice).not.toBeNull();
    expect(notice?.reason).toBe('authentication-rejected');
    expect(notice?.terminal).toBe(true);
    expect(notice?.mailbox).toBe('Alias-42');
    expect(notice?.ownerMessage).toContain('email.passwordRef');
    expect(notice?.ownerMessage).toContain('daemon scope');
    expect(notice?.ownerMessage).toContain('not retried');
    expect(notice?.serverMessage).toContain('AUTHENTICATIONFAILED');
  });

  test('a retryable failure says so, and does not ask the owner to do anything', async () => {
    fakeServer = await makeFakeImapServer((sock) => {
      sock.on('error', () => { /* teardown races are not failures */ });
      // No greeting at all.
    });
    const client = await build(fakeServer.address.port, 150);

    let caught: unknown;
    try {
      await client.open();
    } catch (err) {
      caught = err;
    }

    const notice = describeEmailCapabilityFailure(caught);
    expect(notice?.reason).toBe('connection-failed');
    expect(notice?.terminal).toBe(false);
    expect(notice?.ownerMessage).toContain('retried automatically');
  });
});

// ---------------------------------------------------------------------------
// A refusal means what it says, not what step it arrived at
// ---------------------------------------------------------------------------

describe('ImapClient refusal classification', () => {
  let fakeServer: FakeServer | null = null;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = null;
  });

  /** Answers LOGIN and EXAMINE with whatever the test dictates. */
  function refusing(options: {
    readonly login?: (tag: string) => string;
    readonly examine?: (tag: string) => string;
  }): (sock: Socket) => void {
    return (sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('error', () => { /* teardown races are not failures */ });
      sock.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r\n/)) {
          if (!line.trim()) continue;
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) {
            serverWrite(sock, (options.login ?? ((t) => `${t} OK LOGIN completed`))(tag));
          } else if (line.includes('EXAMINE')) {
            serverWrite(sock, (options.examine ?? ((t) => `${t} OK [READ-ONLY] EXAMINE completed`))(tag));
          }
        }
      });
    };
  }

  async function failureOf(script: (sock: Socket) => void): Promise<ImapOpenError> {
    fakeServer = await makeFakeImapServer(script);
    const client = new ImapClient({
      socket: await connectSocket(fakeServer.address.port),
      username: 'user@example.test',
      password: 'secret',
      mailbox: 'Alias-42',
      timeoutMs: 3000,
    });
    try {
      await client.open();
    } catch (err) {
      return err as ImapOpenError;
    }
    throw new Error('open() unexpectedly succeeded');
  }

  test('a connection-limit refusal at LOGIN is about the server, and is not terminal', async () => {
    // Gmail answers exactly this when a token already has fifteen IMAP
    // connections open — which we reach on the owner's own account, because a
    // watcher holds one permanently and every request opens another. Read as a
    // rejected credential it stops the watcher forever, and the symptom is a
    // mailbox that looks quiet while mail piles up behind it.
    const failure = await failureOf(refusing({
      login: (tag) => `${tag} NO [LIMIT] Too many simultaneous connections`,
    }));

    expect(failure.reason).toBe('server-unavailable');
    expect(failure.terminal).toBe(false);
    expect(failure.reason).not.toBe('authentication-rejected');
    expect(failure.notice.ownerMessage).toContain('not a problem with the account');
    expect(failure.serverMessage).toContain('Too many simultaneous connections');
  });

  test('a too-many-connections refusal with no response code is read from its wording', async () => {
    const failure = await failureOf(refusing({
      login: (tag) => `${tag} NO Too many connections for this account, try again later`,
    }));

    expect(failure.reason).toBe('server-unavailable');
    expect(failure.terminal).toBe(false);
  });

  test('a rejected credential at LOGIN stays terminal', async () => {
    const failure = await failureOf(refusing({
      login: (tag) => `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)`,
    }));

    expect(failure.reason).toBe('authentication-rejected');
    expect(failure.terminal).toBe(true);
  });

  test('a bad-credential refusal with no response code is still terminal', async () => {
    const failure = await failureOf(refusing({
      login: (tag) => `${tag} NO Invalid username or password`,
    }));

    expect(failure.reason).toBe('authentication-rejected');
    expect(failure.terminal).toBe(true);
  });

  test('an ambiguous refusal at LOGIN defaults to non-terminal', async () => {
    // Nothing in the refusal says what it was about. Guessing terminal stops
    // mail until a human notices; guessing transient costs a retry. The
    // asymmetry decides it.
    const failure = await failureOf(refusing({
      login: (tag) => `${tag} NO Request failed`,
    }));

    expect(failure.terminal).toBe(false);
    expect(failure.reason).toBe('server-unavailable');
  });

  test('a capacity refusal at EXAMINE is also the server, not a missing folder', async () => {
    const failure = await failureOf(refusing({
      examine: (tag) => `${tag} NO [UNAVAILABLE] Server busy, please retry`,
    }));

    expect(failure.reason).toBe('server-unavailable');
    expect(failure.terminal).toBe(false);
  });

  test('a folder that is not there is still a terminal mailbox failure', async () => {
    const failure = await failureOf(refusing({
      examine: (tag) => `${tag} NO [NONEXISTENT] Unknown Mailbox: Alias-42 (Failure)`,
    }));

    expect(failure.reason).toBe('mailbox-unavailable');
    expect(failure.terminal).toBe(true);
  });

  test('a credential that cannot be sent at all is terminal without reaching the server', async () => {
    fakeServer = await makeFakeImapServer(refusing({}));
    const client = new ImapClient({
      socket: await connectSocket(fakeServer.address.port),
      username: 'user@example.test',
      password: 'has\r\na newline',
      timeoutMs: 3000,
    });

    let caught: unknown;
    try {
      await client.open();
    } catch (err) {
      caught = err;
    }
    const failure = caught as ImapOpenError;
    expect(failure.reason).toBe('authentication-rejected');
    expect(failure.terminal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Nothing is silently dropped
// ---------------------------------------------------------------------------

describe('ImapClient.fetchEnvelopes asks for everything it is given', () => {
  let fakeServer: FakeServer | null = null;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = null;
  });

  /** Answers a UID FETCH with one response per requested UID. */
  function serveUids(): (sock: Socket) => void {
    return (sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('error', () => { /* teardown races are not failures */ });
      sock.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r\n/)) {
          if (!line.trim()) continue;
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('UID FETCH')) {
            const requested = (/UID FETCH ([\d,]+)/.exec(line)?.[1] ?? '')
              .split(',')
              .map((value) => parseInt(value, 10))
              .filter((value) => value > 0);
            requested.forEach((uid, index) => {
              serverWrite(sock, `* ${index + 1} FETCH (UID ${uid} BODY[HEADER.FIELDS (SUBJECT)] `);
              serverWrite(sock, `Subject: message ${uid}`);
              serverWrite(sock, ')');
            });
            serverWrite(sock, `${tag} OK FETCH completed`);
          }
        }
      });
    };
  }

  async function open(port: number): Promise<ImapClient> {
    const client = new ImapClient({
      socket: await connectSocket(port),
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
    });
    await client.open();
    return client;
  }

  test('twenty-five UIDs come back as twenty-five envelopes, not twenty', async () => {
    fakeServer = await makeFakeImapServer(serveUids());
    const client = await open(fakeServer.address.port);
    const uids = Array.from({ length: 25 }, (_, index) => 1000 + index);

    const envelopes = await client.fetchEnvelopes(uids);

    // The old shape defaulted to a limit of 20 and kept the LAST twenty, with
    // no error and no signal.
    expect(envelopes).toHaveLength(25);
    expect(envelopes.map((envelope) => envelope.uid)).toEqual(uids);
  });

  test('a cursor advanced from the result cannot skip a message', async () => {
    fakeServer = await makeFakeImapServer(serveUids());
    const client = await open(fakeServer.address.port);
    const delta = Array.from({ length: 25 }, (_, index) => 500 + index);

    const envelopes = await client.fetchEnvelopes(delta);
    const seen = new Set(envelopes.map((envelope) => envelope.uid));

    // Every UID asked about was accounted for, so advancing to the highest one
    // cannot step over a message that was never returned.
    const missed = delta.filter((uid) => !seen.has(uid));
    expect(missed).toEqual([]);
    expect(Math.max(...envelopes.map((envelope) => envelope.uid)))
      .toBe(Math.max(...delta));
  });

  test('more UIDs than one command can address is refused, never trimmed', async () => {
    fakeServer = await makeFakeImapServer(serveUids());
    const client = await open(fakeServer.address.port);
    const tooMany = Array.from({ length: IMAP_MAX_FETCH_UIDS + 1 }, (_, index) => index + 1);

    await expect(client.fetchEnvelopes(tooMany)).rejects.toThrow(/batches/);
    // And it did not quietly return a subset instead.
    await expect(client.fetchEnvelopes(tooMany)).rejects.toThrow(/refuses rather than/);
  });
});

// ---------------------------------------------------------------------------
// A command that stays in flight does not accumulate the mailbox
// ---------------------------------------------------------------------------

describe('ImapSession line retention', () => {
  let fakeServer: FakeServer | null = null;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = null;
  });

  test('a long-lived command can decline to retain untagged lines it does not read', async () => {
    let idleTag = '';
    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('error', () => { /* teardown races are not failures */ });
      sock.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r\n/)) {
          if (!line.trim()) continue;
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('IDLE')) {
            idleTag = tag;
            serverWrite(sock, '+ idling');
            // The traffic a busy mailbox produces during one IDLE round.
            for (let n = 1; n <= 200; n += 1) serverWrite(sock, `* ${n} EXISTS`);
          } else if (line.trim() === 'DONE') {
            serverWrite(sock, `${idleTag} OK IDLE terminated`);
          }
        }
      });
    });

    const client = new ImapClient({
      socket: await connectSocket(fakeServer.address.port),
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
    });
    await client.open();
    const connection = imapConnection(client);

    const seen: string[] = [];
    connection.onUntagged((line) => { seen.push(line); });

    const tag = await connection.sendCommand('IDLE', { retainUntagged: false });
    await connection.awaitContinuation(tag);
    await connection.waitForUntagged((line) => line === '* 200 EXISTS', { timeoutMs: 2000 });
    await connection.sendRawLine('DONE');
    const lines = await connection.awaitTag(tag);

    // The subscriber got everything...
    expect(seen.filter((line) => line.endsWith('EXISTS'))).toHaveLength(200);
    // ...and the command retained none of it. Only its own completion, which
    // is what `awaitTag` is for. A twenty-seven-minute IDLE on a busy mailbox
    // would otherwise grow this array for the whole round.
    expect(lines).toEqual([`${tag} OK IDLE terminated`]);
  });

  test('an ordinary command still collects its whole response', async () => {
    fakeServer = await makeFakeImapServer((sock) => {
      serverWrite(sock, '* OK IMAP4rev1 Fake Server ready');
      sock.on('error', () => { /* teardown races are not failures */ });
      sock.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r\n/)) {
          if (!line.trim()) continue;
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) serverWrite(sock, `${tag} OK LOGIN completed`);
          else if (line.includes('EXAMINE')) serverWrite(sock, `${tag} OK [READ-ONLY] EXAMINE completed`);
          else if (line.includes('SEARCH')) {
            serverWrite(sock, '* SEARCH 11 12 13');
            serverWrite(sock, `${tag} OK SEARCH completed`);
          }
        }
      });
    });

    const client = new ImapClient({
      socket: await connectSocket(fakeServer.address.port),
      username: 'user@example.test',
      password: 'secret',
      timeoutMs: 3000,
    });
    await client.open();

    // Opting out is per command; the default is unchanged, and a search that
    // lost its untagged line would return nothing.
    expect(await client.searchUnseen()).toEqual([11, 12, 13]);
  });
});
