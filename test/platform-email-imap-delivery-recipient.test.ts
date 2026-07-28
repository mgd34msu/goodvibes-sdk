/**
 * Delivery-recipient evidence tests for ImapClient.
 *
 * These drive the real client through its injectable socket seam
 * (`ImapClientOptions.socket`) against an in-process fake IMAP server on
 * 127.0.0.1. No real mail server, no real account, no module mocking.
 *
 * The property under test: the recipient a message was DELIVERED to comes from
 * the mailbox we read and from the top-most delivery-agent trace header —
 * never from the sender-authored To: header.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { ImapClient, type ImapEnvelope } from '../packages/sdk/src/platform/email/imap-client.ts';

// ---------------------------------------------------------------------------
// Fake server harness
// ---------------------------------------------------------------------------

interface FakeServer {
  readonly port: number;
  readonly server: Server;
  readonly commands: readonly string[];
  close(): void;
}


import {
  FETCH_WIRE_SHAPES,
  writeFetchSectionResponse,
  type FetchWireShape,
} from './_helpers/imap-fetch-framing.ts';

/**
 * The framing the fake server answers FETCH with, for the suite currently
 * running.
 *
 * Module-level rather than a parameter threaded through fourteen call sites:
 * every test here funnels through `fetchOneEnvelope`, so one variable and a
 * `beforeEach` covers all of them across all three shapes. This file used to
 * send bare response lines exclusively — the one framing no RFC 3501 server
 * produces — so every assertion in it was about a shape that never arrives.
 */
let activeShape: FetchWireShape = FETCH_WIRE_SHAPES[0]!;

/**
 * Serves a canned header block for any HEADER.FIELDS fetch.
 * `headerLines` are written verbatim, so tests can express folding, duplicate
 * fields and blank lines exactly as they would arrive on the wire.
 */
function startFakeImapServer(headerLines: readonly string[]): Promise<FakeServer> {
  const commands: string[] = [];
  return new Promise<FakeServer>((resolve) => {
    const server = createServer((sock: Socket) => {
      sock.write('* OK IMAP4rev1 Fake Server ready\r\n');
      sock.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split(/\r\n/)) {
          if (line.trim().length === 0) continue;
          commands.push(line.trim());
          const tag = line.split(' ')[0] ?? 'A0001';
          if (line.includes('LOGIN')) {
            sock.write(`${tag} OK LOGIN completed\r\n`);
          } else if (line.includes('EXAMINE')) {
            sock.write('* 4 EXISTS\r\n');
            sock.write(`${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
          } else if (line.includes('SEARCH')) {
            sock.write('* SEARCH 4\r\n');
            sock.write(`${tag} OK SEARCH completed\r\n`);
          } else if (line.includes('FETCH') && line.includes('HEADER')) {
            // Sequence number 2, UID 4: the client asked by UID and must report
            // the UID it asked for, never the sequence number in the response
            // prefix.
            // Sequence number 2, UID 4 — and framed the way the shape under
            // test asks for, rather than as bare lines.
            writeFetchSectionResponse(sock, {
              seq: 2,
              uid: 4,
              section: 'BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID TO DELIVERED-TO X-ORIGINAL-TO)]',
              payload: `${headerLines.map((header) => `${header}\r\n`).join('')}\r\n`,
              uidPosition: activeShape.uidPosition,
              sectionEncoding: activeShape.sectionEncoding,
            });
            sock.write(`${tag} OK FETCH completed\r\n`);
          } else if (line.includes('LOGOUT')) {
            sock.write('* BYE logging out\r\n');
            sock.write(`${tag} OK LOGOUT completed\r\n`);
          }
        }
      });
      sock.on('error', () => { /* client teardown races are not failures */ });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({
        port,
        server,
        commands,
        close: () => server.close(),
      });
    });
  });
}

function connectSocket(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => resolve(sock));
  });
}

/** Runs one fetch against a fake server serving `headerLines`. */
async function fetchOneEnvelope(
  headerLines: readonly string[],
  mailbox?: string,
): Promise<{ envelope: ImapEnvelope; commands: readonly string[]; close(): void }> {
  const fake = await startFakeImapServer(headerLines);
  const socket = await connectSocket(fake.port);
  const client = new ImapClient({
    socket,
    username: 'agent@example.test',
    password: 'secret',
    timeoutMs: 3000,
    ...(mailbox === undefined ? {} : { mailbox }),
  });
  const close = (): void => {
    socket.destroy();
    fake.close();
  };
  await client.open();
  const envelopes = await client.fetchEnvelopes([4]);
  const envelope = envelopes[0];
  if (envelope === undefined) {
    close();
    throw new Error('fake server returned no envelope');
  }
  return { envelope, commands: fake.commands, close };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

for (const shape of FETCH_WIRE_SHAPES) {
describe(`ImapClient delivery-recipient evidence — ${shape.name}`, () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => { activeShape = shape; });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  test('a Delivered-To header is reported as the delivered recipient', async () => {
    const run = await fetchOneEnvelope([
      'Delivered-To: alias@example.com',
      'From: Sender <sender@vendor.test>',
      'To: alias@example.com',
      'Subject: Confirm your address',
      'Message-ID: <m1@vendor.test>',
    ]);
    cleanup = run.close;

    expect(run.envelope.deliveredTo).toEqual(['alias@example.com']);
    expect(run.envelope.deliveryEvidence).toEqual([
      { address: 'alias@example.com', rawValue: 'alias@example.com', source: 'delivered-to' },
    ]);
  });

  test('a forged To: header claiming the expected alias is not delivery evidence when Delivered-To names someone else', async () => {
    const run = await fetchOneEnvelope([
      'Delivered-To: someone-else@example.com',
      'From: Attacker <attacker@hostile.test>',
      'To: alias@example.com',
      'Subject: Confirm your address',
      'Message-ID: <m2@hostile.test>',
    ]);
    cleanup = run.close;

    expect(run.envelope.deliveredTo).toEqual(['someone-else@example.com']);
    expect(run.envelope.deliveredTo).not.toContain('alias@example.com');
    expect(run.envelope.deliveryEvidence.some((e) => e.address === 'alias@example.com')).toBe(false);
    // The claim is still surfaced, but only under a name that marks it unusable.
    expect(run.envelope.unverifiedToHeaderClaim).toBe('alias@example.com');
  });

  test('a forged Delivered-To placed below the genuine top-most one is ignored', async () => {
    const run = await fetchOneEnvelope([
      'Delivered-To: someone-else@example.com',
      'From: Attacker <attacker@hostile.test>',
      'Subject: Confirm your address',
      'Delivered-To: alias@example.com',
      'X-Original-To: alias@example.com',
      'To: alias@example.com',
      'Message-ID: <m3@hostile.test>',
    ]);
    cleanup = run.close;

    expect(run.envelope.deliveredTo).toEqual(['someone-else@example.com']);
    expect(run.envelope.deliveredTo).not.toContain('alias@example.com');
  });

  test('a forged Delivered-To directly adjacent below the genuine one is ignored', async () => {
    const run = await fetchOneEnvelope([
      'Delivered-To: someone-else@example.com',
      'Delivered-To: alias@example.com',
      'To: alias@example.com',
      'From: Attacker <attacker@hostile.test>',
    ]);
    cleanup = run.close;

    expect(run.envelope.deliveredTo).toEqual(['someone-else@example.com']);
  });

  test('a Delivered-To pasted into the message body is not read back as a header', async () => {
    const run = await fetchOneEnvelope([
      'Delivered-To: someone-else@example.com',
      'From: Attacker <attacker@hostile.test>',
      'To: alias@example.com',
      '',
      'Delivered-To: alias@example.com',
      'Please confirm.',
    ]);
    cleanup = run.close;

    expect(run.envelope.deliveredTo).toEqual(['someone-else@example.com']);
  });

  test('a folded Delivered-To line is unfolded before the address is read', async () => {
    const run = await fetchOneEnvelope([
      'Delivered-To:',
      '\talias-folded@example.com',
      'From: Sender <sender@vendor.test>',
      'Subject: Wrapped subject line',
      '  continues here',
      'To: alias-folded@example.com',
    ]);
    cleanup = run.close;

    expect(run.envelope.deliveredTo).toEqual(['alias-folded@example.com']);
    expect(run.envelope.subject).toBe('Wrapped subject line continues here');
  });

  test('an angle-bracketed and mixed-case Delivered-To normalizes to a bare lowercase address', async () => {
    const run = await fetchOneEnvelope([
      'Delivered-To: Signup Alias <Alias.Plus+Tag@Example.COM>',
      'From: Sender <sender@vendor.test>',
    ]);
    cleanup = run.close;

    expect(run.envelope.deliveredTo).toEqual(['alias.plus+tag@example.com']);
    expect(run.envelope.deliveryEvidence[0]?.rawValue)
      .toBe('Signup Alias <Alias.Plus+Tag@Example.COM>');
  });

  test('X-Original-To is accepted as evidence when it is the top-most delivery header', async () => {
    const run = await fetchOneEnvelope([
      'X-Original-To: alias@example.com',
      'From: Sender <sender@vendor.test>',
      'To: someone-else@example.com',
    ]);
    cleanup = run.close;

    expect(run.envelope.deliveredTo).toEqual(['alias@example.com']);
    expect(run.envelope.deliveryEvidence[0]?.source).toBe('x-original-to');
  });

  test('a message with no delivery header yields empty evidence rather than falling back to To:', async () => {
    const run = await fetchOneEnvelope([
      'From: Sender <sender@vendor.test>',
      'To: alias@example.com',
      'Subject: Confirm your address',
      'Message-ID: <m4@vendor.test>',
    ]);
    cleanup = run.close;

    expect(run.envelope.deliveredTo).toEqual([]);
    expect(run.envelope.deliveryEvidence).toEqual([]);
    expect(run.envelope.unverifiedToHeaderClaim).toBe('alias@example.com');
  });

  test('a malformed top-most Delivered-To yields empty evidence instead of reaching for a lower one', async () => {
    const run = await fetchOneEnvelope([
      'Delivered-To: not an address at all',
      'Delivered-To: alias@example.com',
      'From: Sender <sender@vendor.test>',
    ]);
    cleanup = run.close;

    expect(run.envelope.deliveredTo).toEqual([]);
  });

  test('malformed header input does not throw and still yields an envelope', async () => {
    const run = await fetchOneEnvelope([
      '\tcontinuation line with no owning field',
      ': leading colon with no field name',
      '   ',
      'NoColonAtAllOnThisLine',
      'Delivered-To: alias@example.com',
      'From: Sender <sender@vendor.test>',
    ]);
    cleanup = run.close;

    expect(run.envelope.deliveredTo).toEqual(['alias@example.com']);
    expect(run.envelope.from).toBe('Sender <sender@vendor.test>');
  });

  test('the mailbox the fetch ran against is reported on the envelope', async () => {
    const run = await fetchOneEnvelope(
      ['Delivered-To: alias@example.com', 'From: Sender <sender@vendor.test>'],
      'INBOX/signup-alias-7',
    );
    cleanup = run.close;

    expect(run.envelope.mailbox).toBe('INBOX/signup-alias-7');
    expect(run.commands.some((c) => c.includes('EXAMINE INBOX/signup-alias-7'))).toBe(true);
  });

  test('the mailbox defaults to INBOX when none is configured', async () => {
    const run = await fetchOneEnvelope(['From: Sender <sender@vendor.test>']);
    cleanup = run.close;

    expect(run.envelope.mailbox).toBe('INBOX');
    expect(run.commands.some((c) => c.includes('EXAMINE INBOX'))).toBe(true);
  });

  test('the fetch requests the delivery headers and still uses BODY.PEEK so nothing is marked read', async () => {
    const run = await fetchOneEnvelope([
      'Delivered-To: alias@example.com',
      'From: Sender <sender@vendor.test>',
    ]);
    cleanup = run.close;

    const fetchCommand = run.commands.find((c) => c.includes('FETCH') && c.includes('HEADER'));
    expect(fetchCommand).toBeDefined();
    expect(fetchCommand ?? '').toContain('BODY.PEEK[HEADER.FIELDS');
    expect(fetchCommand ?? '').toContain('DELIVERED-TO');
    expect(fetchCommand ?? '').toContain('X-ORIGINAL-TO');
    expect(run.commands.every((c) => !c.includes('STORE') && !c.includes('\\Seen'))).toBe(true);
    expect(run.commands.some((c) => c.includes('EXAMINE'))).toBe(true);
    expect(run.commands.every((c) => !/\bSELECT\b/.test(c))).toBe(true);
  });
});
}
