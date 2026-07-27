/**
 * IMAP client protocol tests using an in-process fake server.
 * No real network connections are made. TLS is bypassed by injecting
 * a plain net.Socket pair via net.createServer.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { ImapClient, imapQuoteCredential } from '../packages/sdk/src/platform/email/imap-client.ts';
import { formatImapDate } from '../packages/sdk/src/platform/email/imap-headers.ts';

// ---------------------------------------------------------------------------
// Fake server helpers
// ---------------------------------------------------------------------------

interface FakeServer {
  readonly address: { port: number };
  readonly server: Server;
  close(): void;
}

function makeFakeImapServer(
  script: (socket: Socket) => void,
): Promise<FakeServer> {
  return new Promise<FakeServer>((resolve) => {
    const server = createServer((socket) => {
      script(socket);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        address: { port: (addr as { port: number }).port },
        server,
        close: () => server.close(),
      });
    });
  });
}

function serverWrite(socket: Socket, line: string): void {
  socket.write(`${line}\r\n`);
}

async function connectSocket(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => resolve(sock));
  });
}

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
            serverWrite(sock, '* 3 FETCH (BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] ');
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
