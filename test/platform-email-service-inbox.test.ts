/**
 * The service methods the daemon serves `email.inbox.list`, `email.inbox.read`
 * and `email.draft.create` from, against an in-process fake IMAP server.
 *
 * What these are really checking is that the daemon's answers are TRUE:
 * that `unreadOnly: false` runs a different search rather than being ignored,
 * that `total` describes the match and not the page, that a message read in
 * full is labelled as untrusted exactly as a listed one is, and that a draft
 * goes to the folder the server named.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { EmailService } from '../packages/sdk/src/platform/email/email-service.ts';
import {
  testDescribeSenderClaim,
  throwingEmailTransport,
} from './_helpers/platform-email-fixtures.ts';

const PASSWORD_KEY = 'GOODVIBES_EMAIL_PASSWORD';

interface FakeServer {
  readonly port: number;
  readonly commands: string[];
  readonly literals: string[];
  close(): void;
}

const HEADERS_BY_UID: Readonly<Record<number, readonly string[]>> = {
  1: [
    'From: Alice <alice@example.test>',
    'To: owner@example.com',
    'Subject: First',
    'Message-ID: <one@example.test>',
    'Delivered-To: owner@example.com',
  ],
  2: [
    'From: Bob <bob@spam.example>',
    'Subject: Second',
    'Message-ID: <two@example.test>',
    'Content-Type: text/plain; charset=us-ascii',
  ],
};

/**
 * Speaks the commands the service issues. SEARCH UNSEEN answers `1`, SEARCH
 * ALL answers `1 2 3`, so a test can tell the two apart by their results.
 */
async function startFakeImap(): Promise<FakeServer> {
  const commands: string[] = [];
  const literals: string[] = [];

  const server: Server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let literalRemaining = 0;
    let literalOwnerTag = '';
    const reply = (text: string): void => { socket.write(`${text}\r\n`); };

    const sectionReply = (payload: string, section: string, tag: string): void => {
      socket.write(`* 1 FETCH (BODY[${section}] {${Buffer.byteLength(payload, 'utf8')}}\r\n`);
      socket.write(payload);
      socket.write(')\r\n');
      reply(`${tag} OK FETCH completed`);
    };

    reply('* OK IMAP4rev1 Fake Server ready');
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (literalRemaining > 0) {
          if (buffer.length < literalRemaining) return;
          literals.push(buffer.subarray(0, literalRemaining).toString('utf8'));
          buffer = buffer.subarray(literalRemaining);
          literalRemaining = 0;
          continue;
        }
        const index = buffer.indexOf('\r\n');
        if (index === -1) return;
        const line = buffer.subarray(0, index).toString('utf8');
        buffer = buffer.subarray(index + 2);
        if (line.length === 0) {
          if (literalOwnerTag.length > 0) {
            reply(`${literalOwnerTag} OK [APPENDUID 1 77] APPEND completed`);
            literalOwnerTag = '';
          }
          continue;
        }
        commands.push(line);
        const tag = line.split(' ')[0] ?? 'A0001';
        const literalMatch = /\{(\d+)\}$/.exec(line);
        if (literalMatch) {
          literalRemaining = parseInt(literalMatch[1] ?? '0', 10);
          literalOwnerTag = tag;
          reply('+ Ready');
          continue;
        }
        if (/\bLOGIN\b/.test(line)) reply(`${tag} OK LOGIN completed`);
        else if (/\bEXAMINE\b/.test(line)) reply(`${tag} OK [READ-ONLY] EXAMINE completed`);
        else if (/\bLOGOUT\b/.test(line)) {
          reply('* BYE logging out');
          reply(`${tag} OK LOGOUT completed`);
        } else if (/SEARCH/.test(line)) {
          reply(line.includes('UNSEEN') ? '* SEARCH 1' : '* SEARCH 1 2 3');
          reply(`${tag} OK SEARCH completed`);
        } else if (/ LIST /.test(line)) {
          reply('* LIST (\\HasNoChildren \\Drafts) "/" "[Gmail]/Drafts"');
          reply(`${tag} OK LIST completed`);
        } else if (/UID FETCH/.test(line) && line.includes('HEADER.FIELDS')) {
          // One FETCH response per requested UID, each carrying its own UID
          // data item. The `* n` prefix is a SEQUENCE number even here, so it
          // is deliberately not the UID: a client that reported the prefix
          // would report the wrong identifier.
          const requested = (/UID FETCH ([\d,]+)/.exec(line)?.[1] ?? '')
            .split(',')
            .map((value) => parseInt(value, 10))
            .filter((value) => value > 0);
          requested.forEach((uid, index) => {
            const headers = HEADERS_BY_UID[uid] ?? ['From: nobody@example.test'];
            socket.write(`* ${index + 1} FETCH (UID ${uid} BODY[HEADER.FIELDS (FROM)] \r\n`);
            socket.write(`${headers.join('\r\n')}\r\n`);
            socket.write(')\r\n');
          });
          reply(`${tag} OK FETCH completed`);
        } else if (/UID FETCH/.test(line)) {
          const uid = parseInt(/UID FETCH (\d+)/.exec(line)?.[1] ?? '0', 10);
          const headers = HEADERS_BY_UID[uid];
          if (headers === undefined) {
            reply(`${tag} OK FETCH completed`); // a UID that is gone
          } else if (line.includes('BODY.PEEK[HEADER]')) {
            sectionReply(`${headers.join('\r\n')}\r\n\r\n`, 'HEADER', tag);
          } else if (line.includes('BODYSTRUCTURE')) {
            reply(`* 1 FETCH (UID ${uid} BODYSTRUCTURE NIL)`);
            reply(`${tag} OK FETCH completed`);
          } else {
            sectionReply('the whole body\r\n', 'TEXT', tag);
          }
        } else {
          reply(`${tag} OK completed`);
        }
      }
    });
    socket.on('error', () => { /* client hangups are normal */ });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    commands,
    literals,
    close: () => server.close(),
  };
}

interface RecordedIngest {
  readonly surface: 'email';
  readonly origin: string;
  readonly at: string;
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
    imapSocketFactory: async (host, p) => connect({ host, port: p }),
    recordUntrustedIngest: (ingest) => { ingests.push(ingest); },
  });
  return { service, ingests };
}

describe('EmailService.listInbox', () => {
  let fake: FakeServer | null = null;
  afterEach(() => { fake?.close(); fake = null; });

  test('defaults to unread only, and carries uid and messageId through', async () => {
    fake = await startFakeImap();
    const { service } = buildService(fake.port);
    const result = await service.listInbox();

    expect(fake.commands.some((line) => line.includes('SEARCH UNSEEN'))).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.uid).toBe(1);
    expect(result.messages[0]?.messageId).toBe('<one@example.test>');
    expect(result.messages[0]?.unread).toBe(true);
  });

  test('unreadOnly: false runs a different SEARCH rather than being ignored', async () => {
    fake = await startFakeImap();
    const { service } = buildService(fake.port);
    const result = await service.listInbox({ unreadOnly: false });

    expect(fake.commands.some((line) => line.includes('SEARCH ALL'))).toBe(true);
    expect(result.messages).toHaveLength(3);
    // Only sequence 1 came back from SEARCH UNSEEN, so the other two are read.
    // Reporting all three as unread would be a fabricated flag.
    expect(result.messages.map((message) => message.unread)).toEqual([true, false, false]);
  });

  test('total counts the match, not the page', async () => {
    fake = await startFakeImap();
    const { service } = buildService(fake.port);
    const result = await service.listInbox({ unreadOnly: false, limit: 2 });

    expect(result.messages).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  test('since is passed to the server as a SINCE criterion', async () => {
    fake = await startFakeImap();
    const { service } = buildService(fake.port);
    await service.listInbox({ since: new Date('2026-03-09T00:00:00Z') });

    const search = fake.commands.find((line) => line.includes('SEARCH')) ?? '';
    expect(search).toContain('SINCE');
    expect(search).toContain('-Mar-2026');
  });

  test('checkInbox still returns exactly the unread listing', async () => {
    fake = await startFakeImap();
    const { service } = buildService(fake.port);
    const summaries = await service.checkInbox(5);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.subject).toBe('First');
    expect(fake.commands.some((line) => line.includes('SEARCH UNSEEN'))).toBe(true);
    expect(fake.commands.some((line) => line.includes('SEARCH ALL'))).toBe(false);
  });
});

describe('EmailService.readMessage', () => {
  let fake: FakeServer | null = null;
  afterEach(() => { fake?.close(); fake = null; });

  test('returns the whole message and records the untrusted ingest', async () => {
    fake = await startFakeImap();
    const { service, ingests } = buildService(fake.port);
    const detail = await service.readMessage(2);

    expect(detail?.subject).toBe('Second');
    expect(detail?.bodyText).toBe('the whole body\n');
    expect(detail?.attachments).toEqual([]);
    // A full body is more attacker-controlled text than a preview, not less,
    // so it is labelled the same way the listing labels one.
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.surface).toBe('email');
    expect(ingests[0]?.origin).toBe('email:spam.example (claimed)');
  });

  test('a UID that is gone reads as null, and records nothing', async () => {
    fake = await startFakeImap();
    const { service, ingests } = buildService(fake.port);

    await expect(service.readMessage(4242)).resolves.toBeNull();
    expect(ingests).toEqual([]);
  });
});

describe('EmailService.createDraft', () => {
  let fake: FakeServer | null = null;
  afterEach(() => { fake?.close(); fake = null; });

  test('uses the configured from address and the discovered Drafts folder', async () => {
    fake = await startFakeImap();
    const { service } = buildService(fake.port);
    const result = await service.createDraft({
      to: 'bob@example.test',
      subject: 'Draft subject',
      body: 'Draft body',
    });

    expect(result.mailbox).toBe('[Gmail]/Drafts');
    expect(result.uid).toBe(77);
    expect(fake.literals[0]).toContain('From: owner@example.com');
    expect(fake.literals[0]).toContain('To: bob@example.test');
    expect(fake.literals[0]).toContain('Subject: Draft subject');
  });

  test('an explicit from overrides the configured one', async () => {
    fake = await startFakeImap();
    const { service } = buildService(fake.port);
    await service.createDraft({
      to: 'bob@example.test',
      from: 'other@example.com',
      subject: 'Hi',
      body: 'Hi',
    });

    expect(fake.literals[0]).toContain('From: other@example.com');
  });

  test('a CRLF-injected field is refused before anything is appended', async () => {
    fake = await startFakeImap();
    const { service } = buildService(fake.port);

    await expect(
      service.createDraft({
        to: 'bob@example.test\r\nBcc: attacker@evil.test',
        subject: 'Hi',
        body: 'Hi',
      }),
    ).rejects.toThrow(/control characters/);
    expect(fake.literals).toEqual([]);
    expect(fake.commands.some((line) => line.includes('APPEND'))).toBe(false);
  });

  test('drafting requires email.enabled, like every other mailbox operation', async () => {
    fake = await startFakeImap();
    const config: Record<string, unknown> = { 'email.enabled': false };
    const service = new EmailService({
      getConfig: (key: string) => config[key],
      secretsManager: { get: async () => 'pw' },
      transport: throwingEmailTransport,
      describeSenderClaim: testDescribeSenderClaim,
    });

    await expect(
      service.createDraft({ to: 'a@b.test', subject: 'x', body: 'y' }),
    ).rejects.toThrow('Email is not enabled');
    await expect(service.readMessage(1)).rejects.toThrow('Email is not enabled');
    await expect(service.listInbox()).rejects.toThrow('Email is not enabled');
  });
});
