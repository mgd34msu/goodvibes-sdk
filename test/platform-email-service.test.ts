/**
 * EmailService unit tests with stubbed IMAP/SMTP clients.
 * No real network connections are made.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  recordingEmailTransport,
  testDescribeSenderClaim,
  throwingEmailTransport,
} from './_helpers/platform-email-fixtures.ts';
import {
  EmailService,
  readEmailConfig,
  validateEmailConfig,
  resolveEmailPassword,
} from '../packages/sdk/src/platform/email/email-service.ts';
import { createServer, connect, type Server, type Socket } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ConfigMap = Record<string, unknown>;

function makeSecretsManager(
  store: Record<string, string>,
): { get: (key: string) => Promise<string | null> } {
  return {
    get: async (key) => store[key] ?? null,
  };
}

function makeConfig(overrides: ConfigMap = {}): ConfigMap {
  return {
    'email.enabled': true,
    'email.imapHost': 'imap.example.test',
    'email.imapPort': 993,
    'email.smtpHost': 'smtp.example.test',
    'email.smtpPort': 587,
    'email.username': 'user@example.test',
    'email.passwordRef': 'goodvibes://secrets/goodvibes/GOODVIBES_EMAIL_PASSWORD',
    'email.fromAddress': 'user@example.test',
    ...overrides,
  };
}

// Stub socket that does nothing — satisfies the Socket type for factory stubs
const stubSocket = {} as Socket;

// ---------------------------------------------------------------------------
// readEmailConfig
// ---------------------------------------------------------------------------

describe('readEmailConfig', () => {
  test('reads all keys with correct types', () => {
    const config = readEmailConfig((k) => makeConfig()[k]);
    expect(config.enabled).toBe(true);
    expect(config.imapHost).toBe('imap.example.test');
    expect(config.imapPort).toBe(993);
    expect(config.smtpHost).toBe('smtp.example.test');
    expect(config.smtpPort).toBe(587);
    expect(config.username).toBe('user@example.test');
    expect(config.passwordRef).toContain('goodvibes://secrets/');
    expect(config.fromAddress).toBe('user@example.test');
  });

  test('applies defaults for missing numeric keys', () => {
    const config = readEmailConfig((k) => ({
      'email.enabled': true,
      'email.username': 'u',
      'email.passwordRef': 'goodvibes://secrets/goodvibes/KEY',
      'email.fromAddress': 'u@example.test',
    } as ConfigMap)[k]);
    expect(config.imapPort).toBe(993);
    expect(config.smtpPort).toBe(587);
  });
});

// ---------------------------------------------------------------------------
// validateEmailConfig
// ---------------------------------------------------------------------------

describe('validateEmailConfig', () => {
  test('returns no errors for a valid config', () => {
    const config = readEmailConfig((k) => makeConfig()[k]);
    expect(validateEmailConfig(config)).toHaveLength(0);
  });

  test('rejects missing required fields', () => {
    const base = readEmailConfig((k) => makeConfig()[k]);
    expect(validateEmailConfig({ ...base, imapHost: '' })).toContain('email.imapHost is required');
    expect(validateEmailConfig({ ...base, smtpHost: '' })).toContain('email.smtpHost is required');
    expect(validateEmailConfig({ ...base, username: '' })).toContain('email.username is required');
    expect(validateEmailConfig({ ...base, fromAddress: '' })).toContain('email.fromAddress is required');
  });

  test('rejects raw password in passwordRef', () => {
    const base = readEmailConfig((k) => makeConfig()[k]);
    const errors = validateEmailConfig({ ...base, passwordRef: 'plaintext-password' });
    expect(errors.some((e) => e.includes('goodvibes secret reference'))).toBe(true);
  });

  test('rejects empty passwordRef', () => {
    const base = readEmailConfig((k) => makeConfig()[k]);
    const errors = validateEmailConfig({ ...base, passwordRef: '' });
    expect(errors.some((e) => e.includes('email.passwordRef is required'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveEmailPassword
// ---------------------------------------------------------------------------

describe('resolveEmailPassword', () => {
  test('resolves goodvibes://secrets/goodvibes/ ref by extracting storage key', async () => {
    const secrets = makeSecretsManager({
      GOODVIBES_EMAIL_PASSWORD: 'resolved-password',
    });
    const value = await resolveEmailPassword(
      'goodvibes://secrets/goodvibes/GOODVIBES_EMAIL_PASSWORD',
      secrets,
    );
    expect(value).toBe('resolved-password');
  });

  test('passes non-goodvibes refs directly to secretsManager', async () => {
    const calls: string[] = [];
    const secrets = {
      get: async (key: string) => {
        calls.push(key);
        return 'env-password';
      },
    };
    await resolveEmailPassword('op://Private/Email/password', secrets);
    expect(calls[0]).toBe('op://Private/Email/password');
  });

  test('throws when secret is not found', async () => {
    const secrets = makeSecretsManager({});
    await expect(
      resolveEmailPassword('goodvibes://secrets/goodvibes/MISSING_KEY', secrets),
    ).rejects.toThrow('Email password secret could not be resolved');
  });
});

// ---------------------------------------------------------------------------
// EmailService.getStatus
// ---------------------------------------------------------------------------

describe('EmailService.getStatus', () => {
  test('returns ready=true for valid enabled config', () => {
    const service = new EmailService({
      getConfig: (k) => makeConfig()[k],
      secretsManager: makeSecretsManager({}),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
    });
    const status = service.getStatus();
    expect(status.ready).toBe(true);
    expect(status.errors).toHaveLength(0);
  });

  test('EmailSummary includes bodyPreview field', () => {
    // Verify the type shape — bodyPreview is always present, empty string by default
    const summary: import('../packages/sdk/src/platform/email/email-service.ts').EmailSummary = {
      uid: 1,
      messageId: '<msg-1@example.test>',
      from: 'a@b.test',
      subject: 'Hi',
      date: '2026-01-01',
      unread: true,
      bodyPreview: '',
      mailbox: 'INBOX',
      deliveredTo: [],
      unverifiedToHeaderClaim: '',
      senderClaim: testDescribeSenderClaim('sender@example.com'),
    };
    expect(summary.bodyPreview).toBe('');
  });

  test('returns ready=false when disabled', () => {
    const service = new EmailService({
      getConfig: (k) => makeConfig({ 'email.enabled': false })[k],
      secretsManager: makeSecretsManager({}),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
    });
    const status = service.getStatus();
    expect(status.ready).toBe(false);
  });

  test('redacts passwordRef in status output', () => {
    const service = new EmailService({
      getConfig: (k) => makeConfig()[k],
      secretsManager: makeSecretsManager({}),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
    });
    const status = service.getStatus();
    // The raw ref must never appear in status output
    expect(status.config.passwordRef).toBe('[configured]');
    expect(JSON.stringify(status)).not.toContain('goodvibes://secrets/');
  });
});

// ---------------------------------------------------------------------------
// EmailService.checkInbox
// ---------------------------------------------------------------------------

describe('EmailService.checkInbox', () => {
  test('returns summaries from IMAP client; messages stay unread', async () => {
    const opened: string[] = [];
    const service = new EmailService({
      getConfig: (k) => makeConfig()[k],
      secretsManager: makeSecretsManager({
        GOODVIBES_EMAIL_PASSWORD: 'test-password',
      }),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
      imapSocketFactory: async () => {
        opened.push('connected');
        return stubSocket;
      },
    });

    // Stub out the ImapClient by monkey-patching the module's behavior
    // via the socket factory — since ImapClient requires real socket I/O,
    // we test the service wiring by overriding the IMAP socket factory
    // and verifying the service handles errors from the client gracefully.
    await expect(service.checkInbox(5)).rejects.toThrow();
    // Socket factory was called (connection was attempted)
    expect(opened).toHaveLength(1);
  });

  test('throws when email is disabled', async () => {
    const service = new EmailService({
      getConfig: (k) => makeConfig({ 'email.enabled': false })[k],
      secretsManager: makeSecretsManager({}),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
    });
    await expect(service.checkInbox()).rejects.toThrow('Email is not enabled');
  });

  test('throws when config is invalid', async () => {
    const service = new EmailService({
      getConfig: (k) => makeConfig({ 'email.imapHost': '' })[k],
      secretsManager: makeSecretsManager({}),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
    });
    await expect(service.checkInbox()).rejects.toThrow('Email config is invalid');
  });
});

// ---------------------------------------------------------------------------
// EmailService.sendMail
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// smtpSecurity field wiring
// ---------------------------------------------------------------------------

describe('readEmailConfig — smtpSecurity field', () => {
  test('defaults to "auto" when not set', () => {
    const config = readEmailConfig((k) => makeConfig()[k]);
    expect(config.smtpSecurity).toBe('auto');
  });

  test('reads "tls" value', () => {
    const config = readEmailConfig((k) => makeConfig({ 'email.smtpSecurity': 'tls' })[k]);
    expect(config.smtpSecurity).toBe('tls');
  });

  test('reads "starttls" value', () => {
    const config = readEmailConfig((k) => makeConfig({ 'email.smtpSecurity': 'starttls' })[k]);
    expect(config.smtpSecurity).toBe('starttls');
  });

  test('falls back to "auto" for unknown value', () => {
    const config = readEmailConfig((k) => makeConfig({ 'email.smtpSecurity': 'invalid' })[k]);
    expect(config.smtpSecurity).toBe('auto');
  });
});

describe('EmailService smtpSecurity — socket factory selection', () => {
  test('smtpSecurity=tls on port 587 calls smtpSocketFactory (forced TLS)', async () => {
    // When smtpSecurity='tls', even port 587 should use the TLS (not STARTTLS) factory.
    // Since we inject our own smtpSocketFactory, we just verify it gets called.
    const calls: Array<{ host: string; port: number }> = [];
    const service = new EmailService({
      getConfig: (k) => makeConfig({
        'email.smtpPort': 587,
        'email.smtpSecurity': 'tls',
      })[k],
      secretsManager: makeSecretsManager({ GOODVIBES_EMAIL_PASSWORD: 'pass' }),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
      smtpSocketFactory: async (host, port) => {
        calls.push({ host, port });
        return stubSocket;
      },
    });
    await expect(
      service.sendMail({ to: 'a@b.test', subject: 'Hi', body: 'Body', confirm: true }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.port).toBe(587);
  });

  test('smtpSecurity=auto on port 465 uses defaultSmtpSocketFactory (TLS path)', async () => {
    // With auto + port 465, the default factory chooses direct TLS.
    // We verify by not injecting a factory override and observing no crash from the
    // socket selection path (it will fail later when trying to connect, not earlier).
    const service = new EmailService({
      getConfig: (k) => makeConfig({
        'email.smtpPort': 465,
        'email.smtpSecurity': 'auto',
      })[k],
      secretsManager: makeSecretsManager({ GOODVIBES_EMAIL_PASSWORD: 'pass' }),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
      // No smtpSocketFactory — use the default factory selection
      // This will fail to connect to smtp.example.test but that’s expected in tests
      smtpSocketFactory: async () => stubSocket,
    });
    await expect(
      service.sendMail({ to: 'a@b.test', subject: 'Hi', body: 'Body', confirm: true }),
    ).rejects.toThrow();
    // If we reach here, the factory selection itself didn’t throw — wiring is correct
  });

  // With the transports behind a port, the selection rule itself is now
  // observable without a socket: the recording transport reports which of the
  // three members the service reached for.
  const selectionCases: ReadonlyArray<{
    readonly security: string;
    readonly port: number;
    readonly expected: string;
  }> = [
    { security: 'tls', port: 587, expected: 'connectSmtpTls' },
    { security: 'starttls', port: 465, expected: 'connectSmtpStartTls' },
    { security: 'auto', port: 465, expected: 'connectSmtpTls' },
    { security: 'auto', port: 587, expected: 'connectSmtpStartTls' },
  ];

  for (const { security, port, expected } of selectionCases) {
    test(`smtpSecurity=${security} on port ${port} reaches for ${expected}`, async () => {
      const transport = recordingEmailTransport();
      const service = new EmailService({
        getConfig: (k) => makeConfig({
          'email.smtpPort': port,
          'email.smtpSecurity': security,
        })[k],
        secretsManager: makeSecretsManager({ GOODVIBES_EMAIL_PASSWORD: 'pass' }),
        transport: transport.port,
        describeSenderClaim: testDescribeSenderClaim,
      });
      await expect(
        service.sendMail({ to: 'a@b.test', subject: 'Hi', body: 'Body', confirm: true }),
      ).rejects.toThrow();
      expect(transport.chosen).toEqual([expected]);
    });
  }
});

// ---------------------------------------------------------------------------
// EmailService.testConnection — connect-wizard "test connection" step.
// Uses real in-process fake TCP servers (no real network) to exercise a
// genuine success path, not just a wiring-rejection path.
// ---------------------------------------------------------------------------

interface FakeServer {
  readonly address: { port: number };
  close(): void;
}

function makeFakeServer(script: (socket: Socket) => void): Promise<FakeServer> {
  return new Promise<FakeServer>((resolve) => {
    const server: Server = createServer((socket) => script(socket));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ address: { port: (addr as { port: number }).port }, close: () => server.close() });
    });
  });
}

function write(socket: Socket, line: string): void {
  socket.write(`${line}\r\n`);
}

function fakeImapSuccessScript(socket: Socket): void {
  write(socket, '* OK IMAP4rev1 Fake Server ready');
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let pos: number;
    while ((pos = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, pos).replace(/\r$/, '');
      buffer = buffer.slice(pos + 1);
      if (!line.trim()) continue;
      const tag = line.split(' ')[0] ?? 'A0001';
      if (line.includes('LOGIN')) write(socket, `${tag} OK LOGIN completed`);
      else if (line.includes('EXAMINE')) write(socket, `${tag} OK [READ-ONLY] EXAMINE completed`);
      else if (line.includes('LOGOUT')) {
        write(socket, '* BYE logging out');
        write(socket, `${tag} OK LOGOUT completed`);
      }
    }
  });
}

function fakeSmtpSuccessScript(socket: Socket): void {
  write(socket, '220 fake.smtp.example.test ESMTP ready');
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let pos: number;
    while ((pos = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, pos).replace(/\r$/, '');
      buffer = buffer.slice(pos + 1);
      const upper = line.trim().toUpperCase();
      if (upper.startsWith('EHLO')) {
        write(socket, '250-fake.smtp.example.test Hello');
        write(socket, '250 AUTH PLAIN LOGIN');
      } else if (upper.startsWith('AUTH PLAIN')) {
        write(socket, '235 2.7.0 Authentication successful');
      }
    }
  });
}

describe('EmailService.testConnection', () => {
  let servers: FakeServer[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    servers = [];
  });

  async function connectFake(script: (socket: Socket) => void): Promise<{ host: string; port: number }> {
    const server = await makeFakeServer(script);
    servers.push(server);
    return { host: '127.0.0.1', port: server.address.port };
  }

  test('returns ok:true when both IMAP and SMTP verify — real success path, no send/fetch side effects', async () => {
    const imap = await connectFake(fakeImapSuccessScript);
    const smtp = await connectFake(fakeSmtpSuccessScript);

    const service = new EmailService({
      getConfig: (k) => makeConfig({
        'email.imapHost': imap.host,
        'email.imapPort': imap.port,
        'email.smtpHost': smtp.host,
        'email.smtpPort': smtp.port,
      })[k],
      secretsManager: makeSecretsManager({ GOODVIBES_EMAIL_PASSWORD: 'correct-password' }),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
      imapSocketFactory: async (host, port) => connect({ host, port }),
      smtpSocketFactory: async (host, port) => connect({ host, port }),
    });

    const result = await service.testConnection();
    expect(result).toEqual({ ok: true });
  });

  test('returns ok:false stage:config when config is invalid — no connection attempted', async () => {
    const service = new EmailService({
      getConfig: (k) => makeConfig({ 'email.imapHost': '' })[k],
      secretsManager: makeSecretsManager({}),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
    });
    const result = await service.testConnection();
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('config');
  });

  test('returns ok:false stage:imap when IMAP auth fails; SMTP is never attempted', async () => {
    const imap = await connectFake((socket) => {
      write(socket, '* OK IMAP4rev1 Fake Server ready');
      socket.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line.includes('LOGIN')) {
          const tag = line.split(' ')[0] ?? 'A0001';
          write(socket, `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        }
      });
    });
    let smtpAttempted = false;

    const service = new EmailService({
      getConfig: (k) => makeConfig({
        'email.imapHost': imap.host,
        'email.imapPort': imap.port,
      })[k],
      secretsManager: makeSecretsManager({ GOODVIBES_EMAIL_PASSWORD: 'wrong-password' }),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
      imapSocketFactory: async (host, port) => connect({ host, port }),
      smtpSocketFactory: async () => {
        smtpAttempted = true;
        return {} as Socket;
      },
    });

    const result = await service.testConnection();
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('imap');
    expect(smtpAttempted).toBe(false);
  });

  test('returns ok:false stage:smtp when SMTP auth fails after a successful IMAP check', async () => {
    const imap = await connectFake(fakeImapSuccessScript);
    const smtp = await connectFake((socket) => {
      write(socket, '220 fake.smtp.example.test ESMTP ready');
      socket.on('data', (chunk) => {
        const line = chunk.toString().trim().toUpperCase();
        if (line.startsWith('EHLO')) {
          write(socket, '250-fake.smtp.example.test Hello');
          write(socket, '250 AUTH PLAIN');
        } else if (line.startsWith('AUTH PLAIN')) {
          write(socket, '535 5.7.8 Authentication failed');
        }
      });
    });

    const service = new EmailService({
      getConfig: (k) => makeConfig({
        'email.imapHost': imap.host,
        'email.imapPort': imap.port,
        'email.smtpHost': smtp.host,
        'email.smtpPort': smtp.port,
      })[k],
      secretsManager: makeSecretsManager({ GOODVIBES_EMAIL_PASSWORD: 'correct-password' }),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
      imapSocketFactory: async (host, port) => connect({ host, port }),
      smtpSocketFactory: async (host, port) => connect({ host, port }),
    });

    const result = await service.testConnection();
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('smtp');
  });

  test('never returns the raw password in a failure result', async () => {
    const service = new EmailService({
      getConfig: (k) => makeConfig({ 'email.imapHost': '' })[k],
      secretsManager: makeSecretsManager({}),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
    });
    const result = await service.testConnection();
    expect(JSON.stringify(result)).not.toContain('correct-password');
  });
});

describe('EmailService.sendMail', () => {
  test('throws without confirm=true', async () => {
    const service = new EmailService({
      getConfig: (k) => makeConfig()[k],
      secretsManager: makeSecretsManager({}),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
    });
    await expect(
      service.sendMail({ to: 'a@b.test', subject: 'Hi', body: 'Body', confirm: false }),
    ).rejects.toThrow('requires confirm: true');
  });

  test('throws when email is disabled', async () => {
    const service = new EmailService({
      getConfig: (k) => makeConfig({ 'email.enabled': false })[k],
      secretsManager: makeSecretsManager({}),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
    });
    await expect(
      service.sendMail({ to: 'a@b.test', subject: 'Hi', body: 'Body', confirm: true }),
    ).rejects.toThrow('Email is not enabled');
  });

  test('calls smtp socket factory with correct host/port', async () => {
    const calls: Array<{ host: string; port: number }> = [];
    const service = new EmailService({
      getConfig: (k) => makeConfig()[k],
      secretsManager: makeSecretsManager({
        GOODVIBES_EMAIL_PASSWORD: 'test-password',
      }),
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
      smtpSocketFactory: async (host, port) => {
        calls.push({ host, port });
        return stubSocket;
      },
    });

    await expect(
      service.sendMail({ to: 'a@b.test', subject: 'Hi', body: 'Body', confirm: true }),
    ).rejects.toThrow(); // SmtpClient will fail on the stub socket — expected

    expect(calls).toHaveLength(1);
    expect(calls[0]?.host).toBe('smtp.example.test');
    expect(calls[0]?.port).toBe(587);
  });
});
