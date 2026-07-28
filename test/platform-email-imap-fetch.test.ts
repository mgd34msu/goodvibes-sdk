/**
 * Whole-message reads and draft appends, against an in-process fake IMAP
 * server. No real network connection is made and no TLS is involved: the
 * client takes an injected socket, so a plain `net` pair on 127.0.0.1:0 is a
 * complete server for these purposes.
 *
 * The fake server counts literals in BYTES, exactly as a real one does. That
 * is what makes the APPEND assertions meaningful: if the client declared
 * `{N}` from a character count, the server would read N bytes, stop short of
 * the message, and the remainder would arrive as commands — which is asserted
 * against directly rather than inferred.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { ImapClient } from '../packages/sdk/src/platform/email/imap-client.ts';
import {
  parseBodyStructure,
  attachmentsFromParts,
  decodeTextPart,
  selectBodyPart,
} from '../packages/sdk/src/platform/email/imap-bodystructure.ts';
import {
  buildDraftMessage,
  encodeHeaderValue,
  formatRfc5322Date,
  parseAppendUid,
  selectDraftsMailbox,
} from '../packages/sdk/src/platform/email/imap-draft.ts';
import { takeUtf8Bytes } from '../packages/sdk/src/platform/email/imap-session.ts';
import {
  IMAP_BODY_PROBE_BYTES,
  ImapBodyCapabilityError,
  assessFetchedBody,
  declaredTextOctets,
  probeMailboxBody,
} from '../packages/sdk/src/platform/email/imap-body-probe.ts';
import { describeEmailCapabilityFailure } from '../packages/sdk/src/platform/email/imap-open.ts';

// ---------------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------------

interface FakeState {
  /** Every command line the client sent, literals excluded. */
  readonly commands: string[];
  /** Every literal payload the client uploaded, decoded as UTF-8. */
  readonly literals: string[];
  /** The `{N}` byte counts the client declared, in order. */
  readonly declaredBytes: number[];
  /** The byte length actually received for each literal. */
  readonly receivedBytes: number[];
}

interface CommandContext {
  readonly tag: string;
  readonly line: string;
  /** True when this fires after a literal payload completed the command. */
  readonly afterLiteral: boolean;
  readonly reply: (text: string) => void;
  readonly writeRaw: (text: string) => void;
  readonly state: FakeState;
}

interface FakeServer {
  readonly port: number;
  readonly state: FakeState;
  close(): void;
}

/**
 * Start a fake IMAP server. LOGIN and EXAMINE are answered for every test;
 * everything else is delegated to `onCommand`.
 */
function startFakeImap(
  onCommand: (ctx: CommandContext) => void,
): Promise<FakeServer> {
  const state: FakeState = { commands: [], literals: [], declaredBytes: [], receivedBytes: [] };

  return new Promise<FakeServer>((resolve) => {
    const server: Server = createServer((socket: Socket) => {
      let buffer = Buffer.alloc(0);
      let literalRemaining = 0;
      let literalChunks: Buffer[] = [];
      let literalOwner: { tag: string; line: string } | null = null;

      const writeRaw = (text: string): void => { socket.write(text); };
      const reply = (text: string): void => { socket.write(`${text}\r\n`); };

      const dispatch = (line: string, afterLiteral: boolean): void => {
        const tag = line.split(' ')[0] ?? 'A0001';
        if (/\bLOGIN\b/.test(line)) { reply(`${tag} OK LOGIN completed`); return; }
        if (/\bEXAMINE\b/.test(line)) { reply(`${tag} OK [READ-ONLY] EXAMINE completed`); return; }
        if (/\bLOGOUT\b/.test(line)) {
          reply('* BYE logging out');
          reply(`${tag} OK LOGOUT completed`);
          socket.end();
          return;
        }
        onCommand({ tag, line, afterLiteral, reply, writeRaw, state });
      };

      socket.write('* OK IMAP4rev1 Fake Server ready\r\n');
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (literalRemaining > 0) {
            if (buffer.length < literalRemaining) return;
            literalChunks.push(buffer.subarray(0, literalRemaining));
            buffer = buffer.subarray(literalRemaining);
            literalRemaining = 0;
            const payload = Buffer.concat(literalChunks);
            literalChunks = [];
            state.literals.push(payload.toString('utf8'));
            state.receivedBytes.push(payload.length);
            continue;
          }
          const index = buffer.indexOf('\r\n');
          if (index === -1) return;
          const line = buffer.subarray(0, index).toString('utf8');
          buffer = buffer.subarray(index + 2);

          if (line.length === 0) {
            // The CRLF that terminates a command whose last argument was a
            // literal. The command is only complete now.
            if (literalOwner !== null) {
              const owner = literalOwner;
              literalOwner = null;
              dispatch(owner.line, true);
            }
            continue;
          }

          state.commands.push(line);
          const literalMatch = /\{(\d+)\}$/.exec(line);
          if (literalMatch) {
            const declared = parseInt(literalMatch[1] ?? '0', 10);
            state.declaredBytes.push(declared);
            literalRemaining = declared;
            literalOwner = { tag: line.split(' ')[0] ?? 'A0001', line };
            reply('+ Ready for literal data');
            continue;
          }
          dispatch(line, false);
        }
      });
      socket.on('error', () => { /* the client hanging up is normal here */ });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: (address as { port: number }).port,
        state,
        close: () => server.close(),
      });
    });
  });
}

async function connectSocket(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => resolve(socket));
  });
}

async function openClient(port: number): Promise<ImapClient> {
  const client = new ImapClient({
    socket: await connectSocket(port),
    username: 'owner@example.test',
    password: 'app-password',
    timeoutMs: 3000,
  });
  await client.open();
  return client;
}

/** Write a `* n FETCH (BODY[<section>] {N}` response with a byte-counted literal. */
function writeSection(
  ctx: CommandContext,
  section: string,
  payload: string,
): void {
  ctx.writeRaw(`* 1 FETCH (BODY[${section}] {${Buffer.byteLength(payload, 'utf8')}}\r\n`);
  ctx.writeRaw(payload);
  ctx.writeRaw(')\r\n');
  ctx.reply(`${ctx.tag} OK FETCH completed`);
}

// ---------------------------------------------------------------------------
// fetchMessage
// ---------------------------------------------------------------------------

const MULTIPART_HEADERS = [
  'From: Alice <alice@example.test>',
  'To: victim@example.test',
  'Delivered-To: alias-42@example.test',
  'Subject: Déjeuner',
  'Date: Mon, 10 Jun 2026 09:00:00 +0000',
  'Message-ID: <m1@example.test>',
  'Content-Type: multipart/mixed; boundary="b1"',
  'Authentication-Results: mx.example.test; dkim=pass',
  '',
  '',
].join('\r\n');

const MULTIPART_STRUCTURE =
  '((("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 120 4)' +
  '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "BASE64" 200 5) "ALTERNATIVE")' +
  '("APPLICATION" "PDF" ("NAME" "invoice.pdf") NIL NIL "BASE64" 24000 NIL ' +
  '("attachment" ("FILENAME" "invoice.pdf")) NIL) "MIXED")';

describe('ImapClient.fetchMessage', () => {
  let fake: FakeServer | null = null;

  afterEach(() => {
    fake?.close();
    fake = null;
  });

  test('returns text, html and attachment metadata for a multipart message', async () => {
    fake = await startFakeImap((ctx) => {
      if (ctx.line.includes('BODY.PEEK[HEADER]')) {
        writeSection(ctx, 'HEADER', MULTIPART_HEADERS);
      } else if (ctx.line.includes('BODYSTRUCTURE')) {
        ctx.reply(`* 1 FETCH (UID 42 BODYSTRUCTURE ${MULTIPART_STRUCTURE})`);
        ctx.reply(`${ctx.tag} OK FETCH completed`);
      } else if (ctx.line.includes('BODY.PEEK[1.1]')) {
        writeSection(ctx, '1.1', 'Bonjour caf=C3=A9 monde\r\n');
      } else if (ctx.line.includes('BODY.PEEK[1.2]')) {
        writeSection(ctx, '1.2', `${Buffer.from('<p>Héllo</p>', 'utf8').toString('base64')}\r\n`);
      } else {
        ctx.reply(`${ctx.tag} OK completed`);
      }
    });

    const client = await openClient(fake.port);
    const detail = await client.fetchMessage(42);

    expect(detail).not.toBeNull();
    if (detail === null) return;

    expect(detail.bodyText).toBe('Bonjour café monde\n');
    expect(detail.bodyHtml).toBe('<p>Héllo</p>');
    expect(detail.attachments).toEqual([
      { filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 24000 },
    ]);

    // The whole-message read carries the SAME provenance labelling the inbox
    // listing does — mailbox, delivery evidence, and the To: header still
    // named as an unverified claim.
    expect(detail.uid).toBe(42);
    expect(detail.mailbox).toBe('INBOX');
    expect(detail.deliveredTo).toEqual(['alias-42@example.test']);
    expect(detail.unverifiedToHeaderClaim).toBe('victim@example.test');
    expect(detail.authenticationResults).toEqual(['mx.example.test; dkim=pass']);
    expect(detail.messageId).toBe('<m1@example.test>');
    // A subject that only survives a literal read counted in BYTES: 'Déjeuner'
    // is 9 bytes and 8 characters, so a character count would desynchronize
    // the whole response.
    expect(detail.subject).toBe('Déjeuner');
  });

  test('uses UID FETCH and BODY.PEEK — never plain BODY[, which would set \\Seen', async () => {
    fake = await startFakeImap((ctx) => {
      if (ctx.line.includes('BODY.PEEK[HEADER]')) writeSection(ctx, 'HEADER', MULTIPART_HEADERS);
      else if (ctx.line.includes('BODYSTRUCTURE')) {
        ctx.reply(`* 1 FETCH (UID 42 BODYSTRUCTURE ${MULTIPART_STRUCTURE})`);
        ctx.reply(`${ctx.tag} OK FETCH completed`);
      } else writeSection(ctx, '1.1', 'plain\r\n');
    });

    const client = await openClient(fake.port);
    await client.fetchMessage(42);

    const fetches = fake.state.commands.filter((line) => line.includes('FETCH'));
    expect(fetches.length).toBeGreaterThan(0);
    for (const line of fetches) {
      // The bytes on the wire, not an intention: a plain BODY[ anywhere here
      // would mark the owner's mail read.
      expect(line.includes('BODY[')).toBe(false);
      expect(line).toContain('UID FETCH');
    }
    expect(fetches.some((line) => line.includes('BODY.PEEK[HEADER]'))).toBe(true);
    expect(fetches.some((line) => line.includes('BODY.PEEK[1.1]'))).toBe(true);
  });

  test('unknown UID returns null rather than throwing', async () => {
    fake = await startFakeImap((ctx) => {
      // RFC 3501: a non-existent UID is ignored, so the server answers OK with
      // no untagged FETCH at all.
      ctx.reply(`${ctx.tag} OK FETCH completed`);
    });

    const client = await openClient(fake.port);
    await expect(client.fetchMessage(9999)).resolves.toBeNull();
  });

  test('malformed BODYSTRUCTURE yields no attachments and no throw', async () => {
    const singleHeaders = [
      'From: bob@example.test',
      'Subject: Plain note',
      'Content-Type: text/plain; charset=us-ascii',
      '',
      '',
    ].join('\r\n');

    fake = await startFakeImap((ctx) => {
      if (ctx.line.includes('BODY.PEEK[HEADER]')) writeSection(ctx, 'HEADER', singleHeaders);
      else if (ctx.line.includes('BODYSTRUCTURE')) {
        ctx.reply('* 1 FETCH (UID 7 BODYSTRUCTURE NIL)');
        ctx.reply(`${ctx.tag} OK FETCH completed`);
      } else if (ctx.line.includes('BODY.PEEK[TEXT]')) {
        writeSection(ctx, 'TEXT', 'the body\r\n');
      } else ctx.reply(`${ctx.tag} OK completed`);
    });

    const client = await openClient(fake.port);
    const detail = await client.fetchMessage(7);

    expect(detail).not.toBeNull();
    expect(detail?.attachments).toEqual([]);
    // A single-part message is still readable through the TEXT fallback.
    expect(detail?.bodyText).toBe('the body\n');
  });

  test('unreadable structure on a multipart message fetches no part content', async () => {
    fake = await startFakeImap((ctx) => {
      if (ctx.line.includes('BODY.PEEK[HEADER]')) writeSection(ctx, 'HEADER', MULTIPART_HEADERS);
      else if (ctx.line.includes('BODYSTRUCTURE')) {
        ctx.reply('* 1 FETCH (UID 42 BODYSTRUCTURE NIL)');
        ctx.reply(`${ctx.tag} OK FETCH completed`);
      } else writeSection(ctx, 'TEXT', 'should never be asked for\r\n');
    });

    const client = await openClient(fake.port);
    const detail = await client.fetchMessage(42);

    expect(detail?.attachments).toEqual([]);
    expect(detail?.bodyText).toBe('');
    // BODY[TEXT] of a multipart message is every part concatenated, including
    // the encoded attachments this method exists not to download.
    expect(fake.state.commands.some((line) => line.includes('BODY.PEEK[TEXT]'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// appendDraft
// ---------------------------------------------------------------------------

/** A LIST reply where a decoy `Drafts` folder precedes the flagged one. */
const GMAIL_LIST = [
  '* LIST (\\HasNoChildren) "/" "INBOX"',
  '* LIST (\\HasNoChildren) "/" "Drafts"',
  '* LIST (\\Noselect \\HasChildren) "/" "[Gmail]"',
  '* LIST (\\HasNoChildren \\Drafts) "/" "[Gmail]/Drafts"',
];

function draftServer(options: { list: readonly string[]; appendUid: number | null }) {
  return (ctx: CommandContext): void => {
    if (ctx.line.startsWith('A') && / LIST /.test(ctx.line)) {
      for (const line of options.list) ctx.reply(line);
      ctx.reply(`${ctx.tag} OK LIST completed`);
      return;
    }
    if (/\bAPPEND\b/.test(ctx.line) && ctx.afterLiteral) {
      const status = options.appendUid === null
        ? 'OK APPEND completed'
        : `OK [APPENDUID 1234567890 ${options.appendUid}] APPEND completed`;
      ctx.reply(`${ctx.tag} ${status}`);
      return;
    }
    if (/\bAPPEND\b/.test(ctx.line)) return; // continuation already sent
    ctx.reply(`${ctx.tag} OK completed`);
  };
}

describe('ImapClient.appendDraft', () => {
  let fake: FakeServer | null = null;

  afterEach(() => {
    fake?.close();
    fake = null;
  });

  test('declares the literal in bytes for a multi-byte subject and body', async () => {
    fake = await startFakeImap(draftServer({ list: GMAIL_LIST, appendUid: 4242 }));

    const subject = 'Réunion café ☕';
    const body = 'Bonjour — ça va?\n日本語のテキスト\n';
    const client = await openClient(fake.port);
    await client.appendDraft({
      to: 'bob@example.test',
      from: 'owner@example.test',
      subject,
      body,
    });

    const declared = fake.state.declaredBytes[0];
    const received = fake.state.receivedBytes[0];
    const payload = fake.state.literals[0] ?? '';

    // The server read exactly the count the client declared...
    expect(declared).toBe(received);
    // ...and that count was a BYTE count: the payload is longer in bytes than
    // in characters, so `.length` would have been short by 30-odd bytes.
    expect(received).toBe(Buffer.byteLength(payload, 'utf8'));
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(payload.length);

    // A short count would have left the tail of the message to be parsed as
    // IMAP commands. Nothing of the message appears in the command stream, and
    // the payload really did end with the whole body.
    expect(fake.state.commands.some((line) => line.includes('日本語'))).toBe(false);
    expect(payload.endsWith(body.replace(/\n/g, '\r\n'))).toBe(true);

    // The subject survives the round trip as an RFC 2047 encoded-word.
    const encoded = /^Subject: (.+)$/m.exec(payload)?.[1] ?? '';
    const decoded = encoded
      .split(/\r\n\s|\s(?==\?)/)
      .map((word) => {
        const match = /^=\?UTF-8\?B\?(.*)\?=$/.exec(word.trim());
        return match === null ? word : Buffer.from(match[1] ?? '', 'base64').toString('utf8');
      })
      .join('');
    expect(decoded).toBe(subject);
  });

  test('writes the \\Draft flag and reports the APPENDUID the server gave', async () => {
    fake = await startFakeImap(draftServer({ list: GMAIL_LIST, appendUid: 4242 }));

    const client = await openClient(fake.port);
    const result = await client.appendDraft({
      to: 'bob@example.test',
      from: 'owner@example.test',
      subject: 'Hello',
      body: 'Hi there',
    });

    expect(result.uid).toBe(4242);
    const append = fake.state.commands.find((line) => line.includes('APPEND')) ?? '';
    expect(append).toContain('(\\Draft)');
  });

  test('reports uid null when the server advertises no APPENDUID', async () => {
    fake = await startFakeImap(draftServer({ list: GMAIL_LIST, appendUid: null }));

    const client = await openClient(fake.port);
    const result = await client.appendDraft({
      to: 'bob@example.test',
      from: 'owner@example.test',
      subject: 'Hello',
      body: 'Hi there',
    });

    // No id is invented to fill the field.
    expect(result.uid).toBeNull();
    expect(result.mailbox).toBe('[Gmail]/Drafts');
  });

  test('prefers the \\Drafts special-use folder over a same-named one', async () => {
    fake = await startFakeImap(draftServer({ list: GMAIL_LIST, appendUid: 1 }));

    const client = await openClient(fake.port);
    const result = await client.appendDraft({
      to: 'bob@example.test',
      from: 'owner@example.test',
      subject: 'Hello',
      body: 'Hi there',
    });

    expect(result.mailbox).toBe('[Gmail]/Drafts');
    const append = fake.state.commands.find((line) => line.includes('APPEND')) ?? '';
    expect(append).toContain('"[Gmail]/Drafts"');
    expect(append).not.toContain('APPEND Drafts');
  });

  test('falls back to Drafts when the server describes no folders', async () => {
    fake = await startFakeImap(draftServer({ list: [], appendUid: null }));

    const client = await openClient(fake.port);
    const result = await client.appendDraft({
      to: 'bob@example.test',
      from: 'owner@example.test',
      subject: 'Hello',
      body: 'Hi there',
    });

    expect(result.mailbox).toBe('Drafts');
  });

  test('an explicit mailbox overrides discovery entirely', async () => {
    fake = await startFakeImap(draftServer({ list: GMAIL_LIST, appendUid: null }));

    const client = await openClient(fake.port);
    const result = await client.appendDraft({
      to: 'bob@example.test',
      from: 'owner@example.test',
      subject: 'Hello',
      body: 'Hi there',
      mailbox: 'Entwürfe',
    });

    expect(result.mailbox).toBe('Entwürfe');
    expect(fake.state.commands.some((line) => line.includes('LIST'))).toBe(false);
    // Non-ASCII mailbox names go on the wire as RFC 3501 modified UTF-7 —
    // without that, a Drafts folder in any language but English is unusable.
    const append = fake.state.commands.find((line) => line.includes('APPEND')) ?? '';
    expect(append).toContain('"Entw&APw-rfe"');
  });

  test('refuses a CRLF-injected recipient before anything reaches the server', async () => {
    fake = await startFakeImap(draftServer({ list: GMAIL_LIST, appendUid: null }));

    const client = await openClient(fake.port);
    await expect(
      client.appendDraft({
        to: 'bob@example.test\r\nBcc: attacker@evil.test',
        from: 'owner@example.test',
        subject: 'Hello',
        body: 'Hi there',
      }),
    ).rejects.toThrow(/control characters/);

    // Refused, not sanitized, and refused before a byte was written.
    expect(fake.state.commands.some((line) => line.includes('APPEND'))).toBe(false);
    expect(fake.state.literals).toEqual([]);
  });

  test('refuses a CRLF-injected subject, from, in-reply-to and references', async () => {
    fake = await startFakeImap(draftServer({ list: GMAIL_LIST, appendUid: null }));
    const client = await openClient(fake.port);
    const base = { to: 'bob@example.test', from: 'owner@example.test', subject: 'Hi', body: 'b' };

    await expect(
      client.appendDraft({ ...base, subject: 'Hi\r\nBcc: attacker@evil.test' }),
    ).rejects.toThrow(/control characters/);
    await expect(
      client.appendDraft({ ...base, from: 'owner@example.test\r\nBcc: attacker@evil.test' }),
    ).rejects.toThrow(/control characters/);
    await expect(
      client.appendDraft({ ...base, inReplyTo: '<a@b>\r\nBcc: attacker@evil.test' }),
    ).rejects.toThrow(/control characters/);
    await expect(
      client.appendDraft({ ...base, references: '<a@b>\r\nBcc: attacker@evil.test' }),
    ).rejects.toThrow(/control characters/);

    expect(fake.state.literals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchAll
// ---------------------------------------------------------------------------

describe('ImapClient.searchAll', () => {
  let fake: FakeServer | null = null;

  afterEach(() => {
    fake?.close();
    fake = null;
  });

  test('searches ALL, and SINCE when given a date', async () => {
    fake = await startFakeImap((ctx) => {
      if (ctx.line.includes('SEARCH')) {
        ctx.reply('* SEARCH 2 4 6');
        ctx.reply(`${ctx.tag} OK SEARCH completed`);
        return;
      }
      ctx.reply(`${ctx.tag} OK completed`);
    });

    const client = await openClient(fake.port);
    expect(await client.searchAll()).toEqual([2, 4, 6]);
    await client.searchAll(new Date('2026-01-15T00:00:00Z'));

    const searches = fake.state.commands.filter((line) => line.includes('SEARCH'));
    expect(searches[0]).toContain('SEARCH ALL');
    expect(searches[1]).toContain('SINCE');
    expect(searches[1]).toContain('-Jan-2026');
    // The unread-only search is a different command, not a filter applied after.
    expect(searches.some((line) => line.includes('UNSEEN'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure parsing and composition
// ---------------------------------------------------------------------------

describe('BODYSTRUCTURE parsing is defensive', () => {
  test('a truncated structure yields parts or nothing, never a throw', () => {
    for (const input of [
      '',
      '(',
      '((("TEXT" "PLAIN"',
      '("TEXT" "PLAIN" ("CHARSET"',
      'NIL',
      '())))))',
      '("TEXT" "PLAIN" ("CHARSET" "utf-8) NIL NIL "7BIT" 12 1)',
      `(${'('.repeat(200)}"TEXT" "PLAIN")`,
    ]) {
      expect(() => parseBodyStructure(input)).not.toThrow();
      expect(Array.isArray(parseBodyStructure(input))).toBe(true);
    }
  });

  test('attachment metadata comes from the structure, never from content', () => {
    const parts = parseBodyStructure(MULTIPART_STRUCTURE);
    expect(parts.map((part) => part.section)).toEqual(['1.1', '1.2', '2']);
    expect(selectBodyPart(parts, 'plain')?.section).toBe('1.1');
    expect(selectBodyPart(parts, 'html')?.section).toBe('1.2');
    expect(attachmentsFromParts(parts)).toEqual([
      { filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 24000 },
    ]);
  });

  test('a text part with a filename is an attachment, not the body', () => {
    const structure =
      '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1)' +
      '("TEXT" "PLAIN" ("CHARSET" "UTF-8" "NAME" "notes.txt") NIL NIL "7BIT" 99 3 NIL ' +
      '("attachment" ("FILENAME" "notes.txt")) NIL) "MIXED")';
    const parts = parseBodyStructure(structure);
    expect(selectBodyPart(parts, 'plain')?.section).toBe('1');
    expect(attachmentsFromParts(parts)).toEqual([
      { filename: 'notes.txt', contentType: 'text/plain', sizeBytes: 99 },
    ]);
  });

  test('transfer decoding handles base64, quoted-printable and neither', () => {
    expect(decodeTextPart('SGVsbG8gd29ybGQ=', 'base64', 'utf-8')).toBe('Hello world');
    expect(decodeTextPart('caf=C3=A9', 'quoted-printable', 'utf-8')).toBe('café');
    expect(decodeTextPart('a=\r\nb', 'quoted-printable', 'utf-8')).toBe('ab');
    expect(decodeTextPart('plain\r\ntext', '7bit', '')).toBe('plain\ntext');
    expect(decodeTextPart('%%%not base64%%%', 'base64', 'utf-8')).not.toBe(undefined);
    expect(decodeTextPart('', 'base64', 'utf-8')).toBe('');
  });
});

describe('Drafts discovery', () => {
  test('prefers \\Drafts, then an exact name, then a trailing segment', () => {
    expect(selectDraftsMailbox(GMAIL_LIST)).toBe('[Gmail]/Drafts');
    expect(selectDraftsMailbox([
      '* LIST (\\HasNoChildren) "/" "INBOX"',
      '* LIST (\\HasNoChildren) "/" "DRAFTS"',
      '* LIST (\\HasNoChildren) "/" "[Gmail]/Drafts"',
    ])).toBe('DRAFTS');
    expect(selectDraftsMailbox([
      '* LIST (\\HasNoChildren) "/" "[Gmail]/Drafts"',
    ])).toBe('[Gmail]/Drafts');
    expect(selectDraftsMailbox(['* LIST (\\HasNoChildren) "/" "INBOX"'])).toBeNull();
    expect(selectDraftsMailbox([])).toBeNull();
  });

  test('a \\Noselect path node is never chosen', () => {
    expect(selectDraftsMailbox([
      '* LIST (\\Noselect \\Drafts) "/" "[Gmail]"',
      '* LIST (\\HasNoChildren) "/" "Drafts"',
    ])).toBe('Drafts');
  });

  test('unparseable LIST lines are skipped, not thrown on', () => {
    expect(() => selectDraftsMailbox(['garbage', '* LIST', '* LIST () NIL'])).not.toThrow();
  });
});

describe('APPENDUID and draft composition', () => {
  test('APPENDUID is read when present and null when absent', () => {
    expect(parseAppendUid(['A1 OK [APPENDUID 38505 3955] APPEND completed'])).toBe(3955);
    expect(parseAppendUid(['A1 OK APPEND completed'])).toBeNull();
    expect(parseAppendUid(['A1 OK [APPENDUID 38505 notanumber] done'])).toBeNull();
    expect(parseAppendUid([])).toBeNull();
  });

  test('a non-ASCII header value is folded into RFC 2047 encoded-words', () => {
    expect(encodeHeaderValue('plain ascii')).toBe('plain ascii');
    const long = encodeHeaderValue('é'.repeat(120));
    for (const line of long.split('\r\n')) {
      expect(line.trim().length).toBeLessThanOrEqual(76);
    }
    const decoded = long
      .split(/\r\n\s/)
      .map((word) => Buffer.from(/\?B\?(.*)\?=/.exec(word)?.[1] ?? '', 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe('é'.repeat(120));
  });

  test('the composed message has real headers, a blank line, and CRLF endings', () => {
    const message = buildDraftMessage(
      {
        to: 'bob@example.test',
        from: 'owner@example.test',
        subject: 'Hello',
        body: 'line one\nline two',
        inReplyTo: '<a@b.test>',
        references: '<a@b.test>',
      },
      new Date('2026-07-27T12:00:00Z'),
    );

    expect(message).toContain('Date: Mon, 27 Jul 2026 12:00:00 +0000');
    expect(message).toContain('To: bob@example.test');
    expect(message).toContain('In-Reply-To: <a@b.test>');
    expect(message).toContain('References: <a@b.test>');
    expect(message).toContain('\r\n\r\nline one\r\nline two\r\n');
    // The id that matters is stamped at send time; a second one here would
    // match nothing.
    expect(message.includes('Message-ID:')).toBe(false);
  });

  test('formatRfc5322Date is UTC with a numeric offset', () => {
    expect(formatRfc5322Date(new Date('2026-01-05T03:04:05Z')))
      .toBe('Mon, 05 Jan 2026 03:04:05 +0000');
  });
});

describe('takeUtf8Bytes', () => {
  test('takes whole characters up to a byte budget', () => {
    expect(takeUtf8Bytes('abc', 2)).toEqual({ taken: 'ab', bytes: 2 });
    // 'é' is two bytes: a budget of 3 fits 'a' plus 'é'.
    expect(takeUtf8Bytes('aéb', 3)).toEqual({ taken: 'aé', bytes: 3 });
    // A budget that ends mid-character stops before it.
    expect(takeUtf8Bytes('aéb', 2)).toEqual({ taken: 'a', bytes: 1 });
    expect(takeUtf8Bytes('日本', 6)).toEqual({ taken: '日本', bytes: 6 });
    expect(takeUtf8Bytes('', 10)).toEqual({ taken: '', bytes: 0 });
    expect(takeUtf8Bytes('abc', 0)).toEqual({ taken: '', bytes: 0 });
  });

  test('always makes progress, even when the budget splits a character', () => {
    // A server whose count lands inside a multi-byte sequence must not be able
    // to make the reader loop forever.
    expect(takeUtf8Bytes('é', 1)).toEqual({ taken: 'é', bytes: 1 });
    expect(takeUtf8Bytes('😀', 2)).toEqual({ taken: '😀', bytes: 2 });
  });
});

describe('FETCH responses from servers that vary the shape', () => {
  let fake: FakeServer | null = null;

  afterEach(() => {
    fake?.close();
    fake = null;
  });

  test('the automatic UID item is not read as part of the message', async () => {
    // RFC 3501 has the server include UID in every UID FETCH response, and
    // servers differ on whether it comes before or after the section.
    fake = await startFakeImap((ctx) => {
      if (ctx.line.includes('BODY.PEEK[HEADER]')) {
        const headers = 'From: alice@example.test\r\nSubject: Trailing uid\r\n\r\n';
        ctx.writeRaw(`* 1 FETCH (BODY[HEADER] {${Buffer.byteLength(headers, 'utf8')}}\r\n`);
        ctx.writeRaw(headers);
        ctx.writeRaw('UID 55)\r\n');
        ctx.reply(`${ctx.tag} OK FETCH completed`);
      } else if (ctx.line.includes('BODYSTRUCTURE')) {
        ctx.reply('* 1 FETCH (UID 55 BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 9 1))');
        ctx.reply(`${ctx.tag} OK FETCH completed`);
      } else {
        ctx.writeRaw('* 1 FETCH (UID 55 BODY[1] {9}\r\n');
        ctx.writeRaw('body text');
        ctx.writeRaw('UID 55)\r\n');
        ctx.reply(`${ctx.tag} OK FETCH completed`);
      }
    });

    const client = await openClient(fake.port);
    const detail = await client.fetchMessage(55);

    expect(detail?.subject).toBe('Trailing uid');
    expect(detail?.bodyText).toBe('body text');
    expect(detail?.bodyText).not.toContain('UID');
  });

  test('a short section returned as a quoted string is read as text', async () => {
    fake = await startFakeImap((ctx) => {
      if (ctx.line.includes('BODY.PEEK[HEADER]')) {
        ctx.reply('* 1 FETCH (UID 8 BODY[HEADER] "From: a@b.test\r\n\r\n")');
        ctx.reply(`${ctx.tag} OK FETCH completed`);
      } else if (ctx.line.includes('BODYSTRUCTURE')) {
        ctx.reply('* 1 FETCH (UID 8 BODYSTRUCTURE NIL)');
        ctx.reply(`${ctx.tag} OK FETCH completed`);
      } else {
        ctx.reply('* 1 FETCH (UID 8 BODY[TEXT] "short body")');
        ctx.reply(`${ctx.tag} OK FETCH completed`);
      }
    });

    const client = await openClient(fake.port);
    const detail = await client.fetchMessage(8);
    expect(detail?.bodyText).toBe('short body');
  });
});

// ---------------------------------------------------------------------------
// The body-capability probe, and the invariant that outlives it
// ---------------------------------------------------------------------------

/**
 * A session that answers scripted replies, so the probe's own logic is under
 * test rather than a server's. `command` either resolves with response lines
 * or throws, exactly as `ImapSession.command` does for a `NO`.
 */
function scriptedSession(
  answer: (command: string) => readonly string[],
): { command(text: string): Promise<string[]>; readonly commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    async command(text: string): Promise<string[]> {
      commands.push(text);
      return [...answer(text)];
    },
  };
}

const PROBE_STRUCTURE_120 = (uid: number): string[] => [
  `* 3 FETCH (UID ${uid} BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") `
  + 'NIL NIL "7BIT" 120 4))',
  'A0005 OK FETCH completed',
];

const PROBE_STRUCTURE_ZERO = (uid: number): string[] => [
  `* 3 FETCH (UID ${uid} BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") `
  + 'NIL NIL "7BIT" 0 0))',
  'A0005 OK FETCH completed',
];

const PROBE_BODY_PRESENT = (uid: number): string[] => [
  `* 3 FETCH (UID ${uid} BODY[]<0> `,
  'From: sender@example.test',
  '',
  'Your verification code is inside this body.',
  ')',
  'A0006 OK FETCH completed',
];

const PROBE_BODY_EMPTY = (uid: number): string[] => [
  `* 3 FETCH (UID ${uid} BODY[]<0> NIL)`,
  'A0006 OK FETCH completed',
];

describe('assessFetchedBody — declared octets against returned bytes', () => {
  test('bytes came back, so the capability is demonstrated', () => {
    const reading = assessFetchedBody({
      responded: true,
      declaredOctets: 120,
      returnedBytes: 118,
      subject: "UID 7 in 'INBOX'",
    });
    expect(reading.outcome).toBe('readable');
  });

  test('nothing came back for a message the server SAID has content: withheld', () => {
    // This is the whole point of fetching BODYSTRUCTURE alongside the body.
    // Without the declaration there is no way to tell this from a quiet
    // mailbox, and a quiet mailbox is what a broken one looks like.
    const reading = assessFetchedBody({
      responded: true,
      declaredOctets: 120,
      returnedBytes: 0,
      subject: "UID 7 in 'INBOX'",
    });
    expect(reading.outcome).toBe('unreadable');
    expect(reading.detail).toContain('120');
  });

  test('a message that declares no text content is not a failure', () => {
    const reading = assessFetchedBody({
      responded: true,
      declaredOctets: 0,
      returnedBytes: 0,
      subject: "UID 7 in 'INBOX'",
    });
    expect(reading.outcome).toBe('unproven');
  });

  test('a message that vanished before it was read proves nothing either way', () => {
    const reading = assessFetchedBody({
      responded: false,
      declaredOctets: 120,
      returnedBytes: 0,
      subject: "UID 7 in 'INBOX'",
    });
    expect(reading.outcome).toBe('unproven');
  });
});

describe('declaredTextOctets', () => {
  test('takes the readable parts and ignores what is only described', () => {
    const parts = parseBodyStructure(MULTIPART_STRUCTURE);
    // text/plain 120, text/html 200, and a 24 000-byte PDF that is never
    // fetched and must not be counted as evidence of anything.
    expect(declaredTextOctets(parts)).toBe(200);
  });

  test('an unreadable structure declares nothing', () => {
    expect(declaredTextOctets(parseBodyStructure('(((('))).toBe(0);
  });
});

describe('probeMailboxBody', () => {
  test('reads the newest message and reports the capability as demonstrated', async () => {
    const session = scriptedSession((command) =>
      /BODYSTRUCTURE/.test(command) ? PROBE_STRUCTURE_120(137) : PROBE_BODY_PRESENT(137));

    const reading = await probeMailboxBody(session, { exists: 3, mailbox: 'INBOX' });

    expect(reading.outcome).toBe('readable');
    expect(reading.detail).toContain('UID 137');
    // TWO round trips, and the two command FORMS are the whole reason this is
    // one probe rather than the two it replaced.
    //
    // The first is sequence-addressed, because it is what supplies the declared
    // octet count the comparison needs. The second is UID-addressed — `UID
    // FETCH 137`, not `FETCH 3` — because that is the form the real drain uses,
    // so a server that refuses UID-addressed fetches is caught here at connect
    // rather than on the first message that matters. Rewriting the second as a
    // sequence fetch would still satisfy every other assertion in this file and
    // would silently drop that case.
    //
    // Read-only and bounded throughout: a plain BODY[ would mark the owner's
    // mail read, and an unbounded fetch would pull whatever a stranger attached
    // down a connection that is not yet declared healthy.
    expect(session.commands).toEqual([
      'FETCH 3 (UID BODYSTRUCTURE)',
      `UID FETCH 137 BODY.PEEK[]<0.${IMAP_BODY_PROBE_BYTES}>`,
    ]);
    for (const command of session.commands) {
      expect(command.includes(' BODY[')).toBe(false);
    }
  });

  test('an empty section for a declared text part is a withheld body', async () => {
    const session = scriptedSession((command) =>
      /BODYSTRUCTURE/.test(command) ? PROBE_STRUCTURE_120(137) : PROBE_BODY_EMPTY(137));

    const reading = await probeMailboxBody(session, { exists: 3, mailbox: 'INBOX' });

    expect(reading.outcome).toBe('unreadable');
    expect(reading.detail).toContain('120');
  });

  test('a legitimately zero-octet body is not a failure', async () => {
    const session = scriptedSession((command) =>
      /BODYSTRUCTURE/.test(command) ? PROBE_STRUCTURE_ZERO(137) : PROBE_BODY_EMPTY(137));

    const reading = await probeMailboxBody(session, { exists: 3, mailbox: 'INBOX' });
    expect(reading.outcome).toBe('unproven');
  });

  test('an empty mailbox is unproven, and does not claim to have been verified', async () => {
    const session = scriptedSession(() => []);
    const reading = await probeMailboxBody(session, { exists: 0, mailbox: 'INBOX' });

    expect(reading.outcome).toBe('unproven');
    expect(reading.detail).toContain('not yet proven');
    // Nothing was asked of the server, because there was nothing to ask about.
    expect(session.commands).toEqual([]);
  });

  test('a message expunged between EXAMINE and the probe proves nothing', async () => {
    // EXISTS is a snapshot. RFC 3501 says a FETCH for a message that is gone
    // is answered OK with no untagged response at all, and treating that as a
    // withheld body would condemn a working mailbox over ordinary churn.
    const session = scriptedSession(() => ['A0005 OK FETCH completed']);
    const reading = await probeMailboxBody(session, { exists: 3, mailbox: 'INBOX' });

    expect(reading.outcome).toBe('unproven');
    // It stopped there rather than fetching a body for a message that is gone.
    expect(session.commands).toEqual(['FETCH 3 (UID BODYSTRUCTURE)']);
  });

  test('a refusal that names nothing about itself is a capability failure', async () => {
    const session = {
      async command(text: string): Promise<string[]> {
        if (/BODYSTRUCTURE/.test(text)) return PROBE_STRUCTURE_120(137);
        throw new Error('IMAP command failed: A0006 NO Not permitted');
      },
    };

    const error = await probeMailboxBody(session, { exists: 3, mailbox: 'INBOX' })
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ImapBodyCapabilityError);
    const notice = describeEmailCapabilityFailure(error);
    expect(notice?.reason).toBe('bodies-unfetchable');
    expect(notice?.terminal).toBe(true);
    // The server's own words are carried, and the remedy names access rights
    // rather than sending the owner to change a password that works.
    expect(notice?.serverMessage).toContain('Not permitted');
    expect(notice?.ownerMessage).toContain('access');
  });

  test('a refusal the server DID characterise is left to the existing classifier', async () => {
    // `NO [LIMIT]` is Gmail's too-many-connections answer. Calling that "this
    // account cannot read bodies" would put a false and very specific
    // explanation in front of the owner and stop the watcher permanently.
    const session = {
      async command(text: string): Promise<string[]> {
        if (/BODYSTRUCTURE/.test(text)) return PROBE_STRUCTURE_120(137);
        throw new Error('IMAP command failed: A0006 NO [LIMIT] Too many simultaneous connections');
      },
    };

    const error = await probeMailboxBody(session, { exists: 3, mailbox: 'INBOX' })
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(ImapBodyCapabilityError);
    expect(describeEmailCapabilityFailure(error)).toBeNull();
  });

  test('a timeout is a reconnect, not a verdict about the account', async () => {
    const session = {
      async command(): Promise<string[]> {
        throw new Error('IMAP command timed out after 15000ms');
      },
    };

    const error = await probeMailboxBody(session, { exists: 3, mailbox: 'INBOX' })
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(ImapBodyCapabilityError);
  });
});

describe('fetchMessage enforces the same invariant on a real read', () => {
  let fake: FakeServer | null = null;

  afterEach(() => {
    fake?.close();
    fake = null;
  });

  /** Headers, a structure declaring 120 + 200 octets, and empty sections. */
  async function withheldBodyServer(): Promise<FakeServer> {
    return startFakeImap((ctx) => {
      if (ctx.line.includes('BODY.PEEK[HEADER]')) {
        writeSection(ctx, 'HEADER', MULTIPART_HEADERS);
      } else if (ctx.line.includes('BODYSTRUCTURE')) {
        ctx.reply(`* 1 FETCH (UID 42 BODYSTRUCTURE ${MULTIPART_STRUCTURE})`);
        ctx.reply(`${ctx.tag} OK FETCH completed`);
      } else {
        ctx.reply('* 1 FETCH (UID 42 BODY[1.1] NIL)');
        ctx.reply(`${ctx.tag} OK FETCH completed`);
      }
    });
  }

  async function openEnforcingClient(port: number): Promise<ImapClient> {
    const client = new ImapClient({
      socket: await connectSocket(port),
      username: 'owner@example.test',
      password: 'app-password',
      timeoutMs: 3000,
      enforceBodyReadable: true,
    });
    await client.open();
    return client;
  }

  test('an empty body for a declared text part raises rather than reading blank', async () => {
    fake = await withheldBodyServer();
    const client = await openEnforcingClient(fake.port);

    const error = await client.fetchMessage(42).then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ImapBodyCapabilityError);
    expect(describeEmailCapabilityFailure(error)?.reason).toBe('bodies-unfetchable');
  });

  test('without the option the same read is unchanged — blank, and no throw', async () => {
    // The default stays what the mail reader already relied on; the inbound
    // path opts in, because there an unreadable body is not a cosmetic gap.
    fake = await withheldBodyServer();
    const client = await openClient(fake.port);

    const detail = await client.fetchMessage(42);
    expect(detail?.bodyText).toBe('');
    expect(detail?.subject).toBe('Déjeuner');
  });
});
