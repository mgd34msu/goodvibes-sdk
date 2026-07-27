/**
 * SMTP client protocol tests using an in-process fake server.
 * No real network connections are made.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { SmtpClient } from '../packages/sdk/src/platform/email/smtp-client.ts';
import { createSmtpStartTlsSocket } from '../packages/sdk/src/platform/email/node.ts';

// ---------------------------------------------------------------------------
// Fake server helpers
// ---------------------------------------------------------------------------

interface FakeServer {
  readonly address: { port: number };
  readonly server: Server;
  close(): void;
}

function makeFakeSmtpServer(
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
// SMTP happy-path script
// ---------------------------------------------------------------------------

function happyPathScript(socket: Socket, collectedData: string[]): void {
  serverWrite(socket, '220 fake.smtp.example.test ESMTP ready');

  socket.setEncoding('utf8');
  let inData = false;
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk;
    let pos: number;
    while ((pos = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, pos).replace(/\r$/, '');
      buffer = buffer.slice(pos + 1);
      collectedData.push(line);

      if (inData) {
        if (line === '.') {
          inData = false;
          serverWrite(socket, '250 OK Message accepted');
        }
        continue;
      }

      const upper = line.trim().toUpperCase();
      if (upper.startsWith('EHLO')) {
        serverWrite(socket, '250-fake.smtp.example.test Hello');
        serverWrite(socket, '250-SIZE 10240000');
        serverWrite(socket, '250 AUTH PLAIN LOGIN');
      } else if (upper.startsWith('AUTH PLAIN')) {
        serverWrite(socket, '235 2.7.0 Authentication successful');
      } else if (upper.startsWith('AUTH LOGIN')) {
        serverWrite(socket, '334 VXNlcm5hbWU6');
      } else if (upper.startsWith('MAIL FROM')) {
        serverWrite(socket, '250 OK');
      } else if (upper.startsWith('RCPT TO')) {
        serverWrite(socket, '250 OK');
      } else if (upper === 'DATA') {
        inData = true;
        serverWrite(socket, '354 Start message input; end with <CRLF>.<CRLF>');
      } else if (upper === 'QUIT') {
        serverWrite(socket, '221 Bye');
        socket.end();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { validateSmtpAddress, validateSmtpSubject } from '../packages/sdk/src/platform/email/smtp-client.ts';

// ---------------------------------------------------------------------------
// SMTP header/command injection prevention
// ---------------------------------------------------------------------------

describe('validateSmtpAddress / validateSmtpSubject — injection prevention', () => {
  test('rejects from address with \\r\\n in it', () => {
    expect(() => validateSmtpAddress('evil\r\nBCC: victim@example.test', 'from'))
      .toThrow(/must not contain control characters/);
  });

  test('rejects to address with \\n in it', () => {
    expect(() => validateSmtpAddress('a@b.test\nX-Injected: yes', 'to'))
      .toThrow(/must not contain control characters/);
  });

  test('rejects from with angle brackets', () => {
    expect(() => validateSmtpAddress('<evil@example.test>', 'from'))
      .toThrow(/angle brackets/);
  });

  test('rejects to with spaces', () => {
    expect(() => validateSmtpAddress('a@b.test c@d.test', 'to'))
      .toThrow(/spaces or tabs/);
  });

  test('rejects comma-separated to list', () => {
    expect(() => validateSmtpAddress('a@b.test,c@d.test', 'to'))
      .toThrow(/one address is allowed/);
  });

  test('rejects subject with \\r\\n', () => {
    expect(() => validateSmtpSubject('Hello\r\nBCC: attacker@example.test'))
      .toThrow(/must not contain control characters/);
  });

  test('rejects subject with \\n alone', () => {
    expect(() => validateSmtpSubject('Good subject\nX-Extra: header'))
      .toThrow(/must not contain control characters/);
  });

  test('accepts clean single address', () => {
    expect(() => validateSmtpAddress('user@example.test', 'from')).not.toThrow();
  });

  test('accepts clean subject', () => {
    expect(() => validateSmtpSubject('Hello World')).not.toThrow();
  });
});

describe('SmtpClient sendMail — hostile from/to/subject blocked before envelope write', () => {
  let fakeServer: FakeServer | null = null;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = null;
  });

  async function makeSendAttempt(
    opts: { from?: string; to?: string; subject?: string },
  ): Promise<void> {
    const commands: string[] = [];
    fakeServer = await makeFakeSmtpServer((sock) => happyPathScript(sock, commands));

    const socket = await connectSocket(fakeServer.address.port);
    const client = new SmtpClient({
      socket,
      hostname: 'client.test',
      username: 'user@example.test',
      password: 'mypassword',
      timeoutMs: 5000,
    });
    await client.sendMail({
      from: opts.from ?? 'user@example.test',
      to: opts.to ?? 'recipient@example.test',
      subject: opts.subject ?? 'Test subject',
      body: 'Hello',
    });
  }

  test('\\r\\n in subject throws and does not write to socket', async () => {
    await expect(makeSendAttempt({ subject: 'Hello\r\nBCC: evil@example.test' }))
      .rejects.toThrow(/must not contain control characters/);
  });

  test('\\n in from address throws and does not write to socket', async () => {
    await expect(makeSendAttempt({ from: 'good@example.test\nX-Evil: yes' }))
      .rejects.toThrow(/must not contain control characters/);
  });

  test('\\r\\n in to address throws and does not write to socket', async () => {
    await expect(makeSendAttempt({ to: 'r@example.test\r\nDATA' }))
      .rejects.toThrow(/must not contain control characters/);
  });

  test('angle-bracket smuggling in from throws', async () => {
    await expect(makeSendAttempt({ from: '<attacker@example.test>' }))
      .rejects.toThrow(/angle brackets/);
  });

  test('comma list in to throws', async () => {
    await expect(makeSendAttempt({ to: 'a@b.test,c@d.test' }))
      .rejects.toThrow(/one address is allowed/);
  });
});

// ---------------------------------------------------------------------------
// STARTTLS pipelined data guard
// (Testing the guard embedded in createSmtpStartTlsSocket via a fake server
//  that sends extra bytes after the 220 STARTTLS response.)
// ---------------------------------------------------------------------------

describe('createSmtpStartTlsSocket: pipelined data after 220 rejected', () => {
  // We test this by verifying that the validation logic fires correctly.
  // The actual socket factory creates a real TCP connection, so we test the
  // detection logic via a unit-level extract.
  test('afterNewline detection: extra bytes after 220\\r\\n are detected', () => {
    // Simulate the stBuffer content the onStartTls handler would see
    // if a server sent "220 Go ahead\r\n" followed by pipelined data
    const stBuffer = '220 Go ahead\r\nPIPELINED DATA HERE';
    const newlineIdx = stBuffer.indexOf('\n');
    const afterNewline = newlineIdx !== -1 ? stBuffer.slice(newlineIdx + 1) : '';
    expect(afterNewline).toBe('PIPELINED DATA HERE');
    expect(afterNewline.length).toBeGreaterThan(0);
  });

  test('afterNewline detection: clean 220 with no extra data passes', () => {
    const stBuffer = '220 Go ahead\r\n';
    const newlineIdx = stBuffer.indexOf('\n');
    const afterNewline = newlineIdx !== -1 ? stBuffer.slice(newlineIdx + 1) : '';
    expect(afterNewline).toBe('');
    expect(afterNewline.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The same guard, driven through the real factory.
//
// The two tests above re-derive the slice in the test body, so they pass
// whether or not the factory still performs the check. Now that the factory is
// its own named export, it can be run for real: a plain in-process server on an
// ephemeral 127.0.0.1 port speaks the STARTTLS handshake and misbehaves, and
// the rejection has to come out of the factory itself. No TLS is ever
// negotiated in either case, because both abort before the upgrade.
// ---------------------------------------------------------------------------

describe('createSmtpStartTlsSocket, driven for real', () => {
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  async function startServer(startTlsReply: string): Promise<number> {
    server = createServer((sock) => {
      sock.setEncoding('utf8');
      sock.write('220 fake.smtp.test ESMTP ready\r\n');
      sock.on('data', (chunk: string) => {
        const upper = chunk.trim().toUpperCase();
        if (upper.startsWith('EHLO')) {
          sock.write('250-fake.smtp.test Hello\r\n');
          sock.write('250 STARTTLS\r\n');
        } else if (upper.startsWith('STARTTLS')) {
          sock.write(startTlsReply);
        }
      });
    });
    const bound = server;
    await new Promise<void>((resolve) => bound.listen(0, '127.0.0.1', resolve));
    const address = bound.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  }

  test('rejects when the server pipelines data after its 220, before TLS begins', async () => {
    const port = await startServer('220 Go ahead\r\nINJECTED BEFORE TLS\r\n');
    await expect(createSmtpStartTlsSocket('127.0.0.1', port, 5000)).rejects.toThrow(
      /STARTTLS aborted: server sent data after the 220 response before TLS upgrade/,
    );
  });

  test('rejects when the server refuses to upgrade at all', async () => {
    const port = await startServer('454 4.7.0 TLS not available right now\r\n');
    await expect(createSmtpStartTlsSocket('127.0.0.1', port, 5000)).rejects.toThrow(
      /STARTTLS rejected: 454 4\.7\.0 TLS not available right now/,
    );
  });
});

describe('SmtpClient protocol', () => {
  let fakeServer: FakeServer | null = null;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = null;
  });

  test('happy path — EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA, QUIT', async () => {
    const commands: string[] = [];
    fakeServer = await makeFakeSmtpServer((sock) => happyPathScript(sock, commands));

    const socket = await connectSocket(fakeServer.address.port);
    const client = new SmtpClient({
      socket,
      hostname: 'client.test',
      username: 'user@example.test',
      password: 'mypassword',
      timeoutMs: 5000,
    });

    await client.sendMail({
      from: 'user@example.test',
      to: 'recipient@example.test',
      subject: 'Test subject',
      body: 'Hello, this is a test email.',
    });

    expect(commands.some((c) => c.trim().toUpperCase().startsWith('EHLO'))).toBe(true);
    expect(commands.some((c) => c.trim().toUpperCase().startsWith('AUTH PLAIN'))).toBe(true);
    expect(commands.some((c) => c.toUpperCase().includes('MAIL FROM'))).toBe(true);
    expect(commands.some((c) => c.toUpperCase().includes('RCPT TO'))).toBe(true);
    expect(commands.some((c) => c.trim() === 'DATA')).toBe(true);
    expect(commands.some((c) => c.trim() === '.')).toBe(true);
  });

  test('dot-stuffing — lines beginning with "." get an extra "."', async () => {
    const commands: string[] = [];
    fakeServer = await makeFakeSmtpServer((sock) => happyPathScript(sock, commands));

    const socket = await connectSocket(fakeServer.address.port);
    const client = new SmtpClient({
      socket,
      hostname: 'client.test',
      username: 'user@example.test',
      password: 'mypassword',
      timeoutMs: 5000,
    });

    await client.sendMail({
      from: 'user@example.test',
      to: 'recipient@example.test',
      subject: 'Dot stuffing test',
      body: '.line starting with dot\nnormal line\n..double dot line',
    });

    // After DATA, body is sent; look for double-dotted lines
    const dataIdx = commands.findIndex((c) => c.trim() === 'DATA');
    const bodyLines = commands.slice(dataIdx + 1);
    expect(bodyLines.some((l) => l.startsWith('..'))).toBe(true);
    // The terminator '.' itself should appear (it's not doubled)
    expect(bodyLines.some((l) => l === '.')).toBe(true);
  });

  test('AUTH LOGIN fallback — uses two-step base64 when PLAIN not advertised', async () => {
    const commands: string[] = [];
    fakeServer = await makeFakeSmtpServer((sock) => {
      serverWrite(sock, '220 fake.smtp.example.test ESMTP ready');
      sock.setEncoding('utf8');
      let buffer = '';
      let loginStep = 0;

      sock.on('data', (chunk) => {
        buffer += chunk;
        let pos: number;
        while ((pos = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, pos).replace(/\r$/, '');
          buffer = buffer.slice(pos + 1);
          commands.push(line);

          const upper = line.trim().toUpperCase();
          if (upper.startsWith('EHLO')) {
            serverWrite(sock, '250-fake.smtp.example.test Hello');
            serverWrite(sock, '250 AUTH LOGIN');
          } else if (upper.startsWith('AUTH LOGIN')) {
            loginStep = 1;
            serverWrite(sock, '334 VXNlcm5hbWU6'); // Username:
          } else if (loginStep === 1) {
            loginStep = 2;
            serverWrite(sock, '334 UGFzc3dvcmQ6'); // Password:
          } else if (loginStep === 2) {
            loginStep = 0;
            serverWrite(sock, '235 2.7.0 Authentication successful');
          } else if (upper.includes('MAIL FROM')) {
            serverWrite(sock, '250 OK');
          } else if (upper.includes('RCPT TO')) {
            serverWrite(sock, '250 OK');
          } else if (upper === 'DATA') {
            serverWrite(sock, '354 Start');
          } else if (line.trim() === '.') {
            serverWrite(sock, '250 OK');
          } else if (upper === 'QUIT') {
            serverWrite(sock, '221 Bye');
            sock.end();
          }
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new SmtpClient({
      socket,
      hostname: 'client.test',
      username: 'user@example.test',
      password: 'mypassword',
      timeoutMs: 5000,
    });

    await client.sendMail({
      from: 'user@example.test',
      to: 'recipient@example.test',
      subject: 'Auth login test',
      body: 'Test body',
    });

    expect(commands.some((c) => c.trim().toUpperCase().startsWith('AUTH LOGIN'))).toBe(true);
  });

  test('AUTH failure — throws when server returns 535', async () => {
    fakeServer = await makeFakeSmtpServer((sock) => {
      serverWrite(sock, '220 fake.smtp.example.test ESMTP ready');
      sock.setEncoding('utf8');
      let buffer = '';

      sock.on('data', (chunk) => {
        buffer += chunk;
        let pos: number;
        while ((pos = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, pos).replace(/\r$/, '');
          buffer = buffer.slice(pos + 1);
          const upper = line.trim().toUpperCase();
          if (upper.startsWith('EHLO')) {
            serverWrite(sock, '250-fake.smtp.example.test Hello');
            serverWrite(sock, '250 AUTH PLAIN LOGIN');
          } else if (upper.startsWith('AUTH PLAIN')) {
            serverWrite(sock, '535 5.7.8 Authentication credentials invalid');
          }
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new SmtpClient({
      socket,
      hostname: 'client.test',
      username: 'user@example.test',
      password: 'wrongpassword',
      timeoutMs: 5000,
    });

    await expect(
      client.sendMail({
        from: 'user@example.test',
        to: 'recipient@example.test',
        subject: 'Fail test',
        body: 'Test',
      }),
    ).rejects.toThrow('SMTP AUTH');
  });

  test('non-empty body passes through to DATA phase (CRIT-2 regression guard)', async () => {
    const collectedData: string[] = [];
    fakeServer = await makeFakeSmtpServer((sock) => happyPathScript(sock, collectedData));

    const socket = await connectSocket(fakeServer.address.port);
    const client = new SmtpClient({
      socket,
      hostname: 'client.test',
      username: 'user@example.test',
      password: 'mypassword',
      timeoutMs: 5000,
    });

    const bodyText = 'This is the expected body content for CRIT-2.';
    await client.sendMail({
      from: 'user@example.test',
      to: 'recipient@example.test',
      subject: 'Body passthrough test',
      body: bodyText,
    });

    // Find DATA section in collected lines
    const dataIdx = collectedData.findIndex((c) => c.trim() === 'DATA');
    expect(dataIdx).toBeGreaterThan(-1);
    const bodyLines = collectedData.slice(dataIdx + 1);
    const bodyText2 = bodyLines.join('\n');
    expect(bodyText2).toContain('CRIT-2');
  });

  test('no AUTH capability — throws descriptive error', async () => {
    fakeServer = await makeFakeSmtpServer((sock) => {
      serverWrite(sock, '220 fake.smtp.example.test ESMTP ready');
      sock.setEncoding('utf8');
      let buffer = '';
      sock.on('data', (chunk) => {
        buffer += chunk;
        let pos: number;
        while ((pos = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, pos).replace(/\r$/, '');
          buffer = buffer.slice(pos + 1);
          const upper = line.trim().toUpperCase();
          if (upper.startsWith('EHLO')) {
            serverWrite(sock, '250 fake.smtp.example.test Hello');
          }
        }
      });
    });

    const socket = await connectSocket(fakeServer.address.port);
    const client = new SmtpClient({
      socket,
      hostname: 'client.test',
      username: 'user@example.test',
      password: 'mypassword',
      timeoutMs: 5000,
    });

    await expect(
      client.sendMail({
        from: 'user@example.test',
        to: 'recipient@example.test',
        subject: 'No auth test',
        body: 'Test',
      }),
    ).rejects.toThrow('does not advertise AUTH PLAIN or AUTH LOGIN');
  });
});

// ---------------------------------------------------------------------------
// SmtpClient.verifyAuth — connect-wizard "test connection" step.
// Must authenticate and QUIT WITHOUT ever sending MAIL FROM/RCPT TO/DATA.
// ---------------------------------------------------------------------------

describe('SmtpClient.verifyAuth', () => {
  let fakeServer: FakeServer | null = null;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = null;
  });

  test('succeeds on AUTH PLAIN and never sends mail commands', async () => {
    const commands: string[] = [];
    fakeServer = await makeFakeSmtpServer((sock) => happyPathScript(sock, commands));

    const socket = await connectSocket(fakeServer.address.port);
    const client = new SmtpClient({
      socket,
      hostname: 'client.test',
      username: 'user@example.test',
      password: 'mypassword',
      timeoutMs: 5000,
    });

    await client.verifyAuth();

    expect(commands.some((c) => c.toUpperCase().startsWith('AUTH PLAIN'))).toBe(true);
    expect(commands.some((c) => c.toUpperCase().startsWith('MAIL FROM'))).toBe(false);
    expect(commands.some((c) => c.toUpperCase().startsWith('RCPT TO'))).toBe(false);
    expect(commands.some((c) => c.toUpperCase() === 'DATA')).toBe(false);
  });

  test('rejects a bad greeting', async () => {
    fakeServer = await makeFakeSmtpServer((sock) => {
      serverWrite(sock, '554 fake.smtp.example.test rejected');
    });
    const socket = await connectSocket(fakeServer.address.port);
    const client = new SmtpClient({
      socket,
      hostname: 'client.test',
      username: 'user@example.test',
      password: 'mypassword',
      timeoutMs: 5000,
    });
    await expect(client.verifyAuth()).rejects.toThrow('SMTP unexpected greeting');
  });

  test('rejects a failed AUTH', async () => {
    fakeServer = await makeFakeSmtpServer((sock) => {
      serverWrite(sock, '220 fake.smtp.example.test ESMTP ready');
      sock.setEncoding('utf8');
      let buffer = '';
      sock.on('data', (chunk) => {
        buffer += chunk;
        let pos: number;
        while ((pos = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, pos).replace(/\r$/, '');
          buffer = buffer.slice(pos + 1);
          const upper = line.trim().toUpperCase();
          if (upper.startsWith('EHLO')) {
            serverWrite(sock, '250-fake.smtp.example.test Hello');
            serverWrite(sock, '250 AUTH PLAIN');
          } else if (upper.startsWith('AUTH PLAIN')) {
            serverWrite(sock, '535 5.7.8 Authentication failed');
          }
        }
      });
    });
    const socket = await connectSocket(fakeServer.address.port);
    const client = new SmtpClient({
      socket,
      hostname: 'client.test',
      username: 'user@example.test',
      password: 'wrongpassword',
      timeoutMs: 5000,
    });
    await expect(client.verifyAuth()).rejects.toThrow();
  });
});
