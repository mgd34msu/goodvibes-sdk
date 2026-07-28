/**
 * A scripted fake IMAP mailbox, built on the same `makeFakeImapServer` /
 * `serverWrite` / `connectSocket` harness the client protocol tests already
 * drive. No real network, no TLS: a plain loopback pair on 127.0.0.1:0.
 *
 * It speaks the subset the inbound watcher needs — LOGIN, CAPABILITY, EXAMINE,
 * IDLE/DONE, UID SEARCH, UID FETCH — with the knobs the watcher's failure
 * modes require: refuse the login, refuse the mailbox, refuse IDLE, stop
 * answering mid-handshake, drop the socket, deliver mail while nobody is
 * connected.
 *
 * Two details are emulated ON PURPOSE because getting them wrong in the real
 * client is invisible until production:
 *
 *   - **Sequence numbers are not UIDs.** UIDs start at 101 while sequence
 *     numbers start at 1, so any code that confuses them reads the wrong
 *     message rather than accidentally working.
 *   - **`UID SEARCH UID 11:*` on a mailbox whose highest UID is 10 matches
 *     message 10.** RFC 3501 ranges are unordered pairs, so `11:*` becomes
 *     10:11. Real servers do this; a fake that returned nothing would let a
 *     watcher that trusts search output pass here and redeliver in production.
 */

import type { Socket } from 'node:net';
import {
  connectSocket,
  makeFakeImapServer,
  serverWrite,
  type FakeServer,
} from './fake-imap-server.ts';

export interface FakeMessage {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly deliveredTo: string;
}

/** How the server answers the "can you push?" question. */
export type FakeIdleAdvertisement =
  /** `[CAPABILITY … IDLE]` in the greeting. */
  | 'advertised'
  /** `[CAPABILITY …]` in the greeting, without IDLE in it. */
  | 'absent'
  /** Greeting says nothing; a CAPABILITY command answers with IDLE. */
  | 'silent-then-idle'
  /** Greeting says nothing; a CAPABILITY command answers without IDLE. */
  | 'silent-then-none'
  /** Greeting says nothing and CAPABILITY is never answered. */
  | 'silent-unanswered';

export interface FakeMailboxOptions {
  readonly uidValidity?: number;
  readonly idle?: FakeIdleAdvertisement;
  readonly login?: 'ok' | 'refused' | 'connection-limit';
  readonly examine?: 'ok' | 'refused';
  readonly fetch?: 'ok' | 'refused';
  readonly search?: 'ok' | 'refused';
  /** Answer `IDLE` with NO instead of a `+` continuation. */
  readonly refuseIdle?: boolean;
  /** Omit `[UIDVALIDITY n]` from the EXAMINE response. */
  readonly omitUidValidity?: boolean;
  /** Stop answering the tagged completion after this many DONEs. */
  readonly stallAfterDoneCount?: number | null;
  /** Messages already in the mailbox at connection time. */
  readonly initial?: readonly FakeMessage[];
}

interface LiveConnection {
  readonly socket: Socket;
  idleTag: string | null;
}

export interface FakeMailboxServer {
  readonly port: number;
  /** Every command line the server received, across every connection. */
  readonly commands: readonly string[];
  /** How many client connections have been accepted. */
  readonly connectionCount: number;
  /** UIDs currently in the mailbox. */
  readonly uids: readonly number[];
  /** Add a message; announce it with `* n EXISTS` to anyone connected. */
  deliver(subject?: string): FakeMessage;
  /** Add a message WITHOUT announcing it — mail that arrived while down. */
  deliverQuietly(subject?: string): FakeMessage;
  /** Remove a message and announce `* n EXPUNGE` with its sequence number. */
  expunge(uid: number): void;
  /** Write a raw untagged line to every live connection. */
  push(line: string): void;
  /** Destroy every live socket, as a network drop would. */
  dropConnections(): void;
  /** Run this once, on the next DONE, before the tagged completion is sent. */
  onNextDone(hook: (server: FakeMailboxServer) => void): void;
  /** Change the UIDVALIDITY the NEXT connection will be told. */
  setUidValidity(value: number): void;
  close(): void;
}

export async function makeFakeMailbox(
  options: FakeMailboxOptions = {},
): Promise<FakeMailboxServer> {
  const idleMode: FakeIdleAdvertisement = options.idle ?? 'advertised';
  const commands: string[] = [];
  const live = new Set<LiveConnection>();
  let messages: FakeMessage[] = [...(options.initial ?? [])];
  let uidValidity = options.uidValidity ?? 42;
  let nextUid = messages.length === 0
    ? 101
    : Math.max(...messages.map((message) => message.uid)) + 1;
  let doneCount = 0;
  let doneHook: ((server: FakeMailboxServer) => void) | null = null;
  let connectionCount = 0;
  let server: FakeServer;

  const greeting = (): string => {
    if (idleMode === 'advertised') return '* OK [CAPABILITY IMAP4rev1 IDLE] ready';
    if (idleMode === 'absent') return '* OK [CAPABILITY IMAP4rev1] ready';
    return '* OK ready';
  };

  const handle = (connection: LiveConnection, raw: string): void => {
    const line = raw.trim();
    if (line.length === 0) return;
    commands.push(line);
    const socket = connection.socket;

    if (line === 'DONE') {
      doneCount += 1;
      const hook = doneHook;
      doneHook = null;
      if (hook !== null) hook(api);
      const stallAt = options.stallAfterDoneCount ?? null;
      if (stallAt !== null && doneCount >= stallAt) return; // never completes
      const tag = connection.idleTag ?? 'A0001';
      connection.idleTag = null;
      serverWrite(socket, `${tag} OK IDLE terminated`);
      return;
    }

    const tag = line.split(' ')[0] ?? 'A0001';
    const rest = line.slice(tag.length + 1);

    if (/^LOGIN\b/i.test(rest) || /^AUTHENTICATE\b/i.test(rest)) {
      if (options.login === 'refused') {
        serverWrite(socket, `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        return;
      }
      if (options.login === 'connection-limit') {
        serverWrite(socket, `${tag} NO [LIMIT] Too many simultaneous connections`);
        return;
      }
      serverWrite(socket, `${tag} OK LOGIN completed`);
      return;
    }

    if (/^CAPABILITY\b/i.test(rest)) {
      if (idleMode === 'silent-unanswered') return;
      serverWrite(socket, idleMode === 'silent-then-idle'
        ? '* CAPABILITY IMAP4rev1 IDLE'
        : '* CAPABILITY IMAP4rev1');
      serverWrite(socket, `${tag} OK CAPABILITY completed`);
      return;
    }

    if (/^EXAMINE\b/i.test(rest)) {
      if (options.examine === 'refused') {
        serverWrite(socket, `${tag} NO Mailbox does not exist`);
        return;
      }
      serverWrite(socket, `* ${messages.length} EXISTS`);
      serverWrite(socket, '* 0 RECENT');
      if (options.omitUidValidity !== true) {
        serverWrite(socket, `* OK [UIDVALIDITY ${uidValidity}] UIDs valid`);
      }
      serverWrite(socket, `* OK [UIDNEXT ${nextUid}] Predicted next UID`);
      serverWrite(socket, `${tag} OK [READ-ONLY] EXAMINE completed`);
      return;
    }

    if (/^IDLE\b/i.test(rest)) {
      if (options.refuseIdle === true) {
        serverWrite(socket, `${tag} NO IDLE is not permitted for this account`);
        return;
      }
      connection.idleTag = tag;
      serverWrite(socket, '+ idling');
      return;
    }

    if (/^UID SEARCH\b/i.test(rest)) {
      if (options.search === 'refused') {
        serverWrite(socket, `${tag} NO Server busy, try again`);
        return;
      }
      serverWrite(socket, `* SEARCH ${searchRange(rest).join(' ')}`.trimEnd());
      serverWrite(socket, `${tag} OK SEARCH completed`);
      return;
    }

    if (/^UID FETCH\b/i.test(rest)) {
      if (options.fetch === 'refused') {
        serverWrite(socket, `${tag} NO Server error fetching message data`);
        return;
      }
      const wanted = (/^UID FETCH (\S+)/i.exec(rest)?.[1] ?? '')
        .split(',')
        .map((part) => parseInt(part, 10))
        .filter((value) => Number.isFinite(value));
      for (const uid of wanted) {
        const index = messages.findIndex((message) => message.uid === uid);
        if (index === -1) continue;
        const message = messages[index];
        if (message === undefined) continue;
        // Sequence number, deliberately not the UID.
        serverWrite(socket,
          `* ${index + 1} FETCH (UID ${uid} BODY[HEADER.FIELDS `
          + '(FROM SUBJECT DATE MESSAGE-ID TO DELIVERED-TO X-ORIGINAL-TO '
          + 'AUTHENTICATION-RESULTS)] ');
        serverWrite(socket, `From: ${message.from}`);
        serverWrite(socket, `Subject: ${message.subject}`);
        serverWrite(socket, 'Date: Mon, 27 Jul 2026 09:00:00 +0000');
        serverWrite(socket, `Message-ID: <uid-${uid}@example.test>`);
        serverWrite(socket, `Delivered-To: ${message.deliveredTo}`);
        serverWrite(socket, ')');
      }
      serverWrite(socket, `${tag} OK FETCH completed`);
      return;
    }

    if (/^LOGOUT\b/i.test(rest)) {
      serverWrite(socket, '* BYE Logging out');
      serverWrite(socket, `${tag} OK LOGOUT completed`);
      return;
    }

    serverWrite(socket, `${tag} BAD Unrecognised command`);
  };

  /**
   * Emulate `UID SEARCH UID a:*` faithfully, quirk included: when `a` is above
   * the highest UID present the range is inverted rather than empty.
   */
  const searchRange = (rest: string): number[] => {
    const match = /UID (\d+):\*/.exec(rest);
    const all = messages.map((message) => message.uid);
    if (match === null || all.length === 0) return all;
    const from = parseInt(match[1] ?? '1', 10);
    const highest = Math.max(...all);
    const low = Math.min(from, highest);
    const high = Math.max(from, highest);
    return all.filter((uid) => uid >= low && uid <= high);
  };

  const add = (subject: string, announce: boolean): FakeMessage => {
    const message: FakeMessage = {
      uid: nextUid,
      from: `sender${nextUid}@sender.test`,
      subject,
      deliveredTo: 'watched@example.test',
    };
    nextUid += 1;
    messages = [...messages, message];
    if (announce) {
      for (const connection of live) {
        serverWrite(connection.socket, `* ${messages.length} EXISTS`);
        serverWrite(connection.socket, '* 1 RECENT');
      }
    }
    return message;
  };

  const api: FakeMailboxServer = {
    get port() { return server.address.port; },
    get commands() { return commands; },
    get connectionCount() { return connectionCount; },
    get uids() { return messages.map((message) => message.uid); },
    deliver: (subject = 'Hello') => add(subject, true),
    deliverQuietly: (subject = 'Hello') => add(subject, false),
    expunge: (uid: number) => {
      const index = messages.findIndex((message) => message.uid === uid);
      if (index === -1) return;
      messages = messages.filter((message) => message.uid !== uid);
      for (const connection of live) {
        serverWrite(connection.socket, `* ${index + 1} EXPUNGE`);
      }
    },
    push: (line: string) => {
      for (const connection of live) serverWrite(connection.socket, line);
    },
    dropConnections: () => {
      for (const connection of live) {
        try {
          connection.socket.destroy();
        } catch {
          // already gone
        }
      }
      live.clear();
    },
    onNextDone: (hook) => { doneHook = hook; },
    setUidValidity: (value: number) => { uidValidity = value; },
    close: () => {
      api.dropConnections();
      server.close();
    },
  };

  server = await makeFakeImapServer((socket) => {
    connectionCount += 1;
    const connection: LiveConnection = { socket, idleTag: null };
    live.add(connection);
    socket.on('close', () => { live.delete(connection); });
    socket.on('error', () => { live.delete(connection); });
    serverWrite(socket, greeting());
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const at = buffer.indexOf('\n');
        if (at === -1) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        handle(connection, line);
      }
    });
  });

  return api;
}

/** Open one loopback socket to a fake mailbox. */
export function openMailboxSocket(port: number): Promise<Socket> {
  return connectSocket(port);
}
