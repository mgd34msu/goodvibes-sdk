/**
 * How a FETCH response is framed on the wire, in one place.
 *
 * A `BODY[...]` section can reach a client in three shapes, and a client that
 * handles one of them handles none of the others by accident:
 *
 *   - **bare lines**, the section marker, then the payload as ordinary
 *     response lines, then `)`. No RFC 3501 server sends this. Every fake in
 *     this repository sent it exclusively, which is how a parser that
 *     discarded every real header block sat under 8,000 green tests.
 *   - **literal, UID leading**, `UID n BODY[...] {N}` then N bytes. The
 *     client's reader folds the payload onto the owner line, so the parser
 *     sees one long record rather than a run of lines.
 *   - **literal, UID trailing**, `BODY[...] {N}` then N bytes then ` UID n)`.
 *     Equally legal: RFC 3501 fixes no order for data items, and the automatic
 *     `UID` item routinely comes last.
 *
 * Extracted from `fake-imap-mailbox.ts` rather than copied into each caller.
 * Literal framing is byte arithmetic, `{n}` counts BYTES while the socket is
 * read as utf8, and a second hand-rolled copy would be a second chance to get
 * that wrong, in a helper whose entire job is to be more correct than the code
 * it tests. Four copies was the alternative.
 */

import type { Socket } from 'node:net';
import { serverWrite, serverWriteRaw } from './fake-imap-server.ts';

/** Where the automatic `UID` data item sits relative to the section. */
export type FakeUidPosition = 'leading' | 'trailing';

/**
 * How the section payload is framed.
 *
 * `literal` is what servers do and is the default everywhere. `bare-lines` is
 * kept only so a test can assert the client still copes with the shape the
 * fakes used to send, it is not a shape to write new tests against.
 */
export type FakeSectionEncoding = 'literal' | 'bare-lines';

export interface FetchWireShape {
  /** Reads in a test name. */
  readonly name: string;
  readonly uidPosition: FakeUidPosition;
  readonly sectionEncoding: FakeSectionEncoding;
}

/**
 * The three framings every `fetchEnvelopes`-facing test should cover.
 *
 * Exported as a table so a suite iterates it rather than picking one and
 * inheriting whichever blind spot that shape has. The two literal entries are
 * the ones a real server produces; the bare entry is the legacy shape.
 */
export const FETCH_WIRE_SHAPES: readonly FetchWireShape[] = [
  { name: 'literal, UID leading', uidPosition: 'leading', sectionEncoding: 'literal' },
  { name: 'literal, UID trailing', uidPosition: 'trailing', sectionEncoding: 'literal' },
  { name: 'bare lines, UID leading', uidPosition: 'leading', sectionEncoding: 'bare-lines' },
];

export interface FetchSectionResponseInput {
  /** The `* n FETCH` sequence number. Deliberately not the UID. */
  readonly seq: number;
  readonly uid: number;
  /** e.g. `BODY[HEADER.FIELDS (FROM SUBJECT)]`. */
  readonly section: string;
  /** The section payload, CRLF-terminated exactly as it goes on the wire. */
  readonly payload: string;
  readonly uidPosition?: FakeUidPosition;
  readonly sectionEncoding?: FakeSectionEncoding;
  /**
   * Omit the `UID` item entirely, the shape a server sends when it answers
   * with a response the client cannot key, which is a different failure from
   * an expunged message and must not be conflated with one.
   */
  readonly omitUid?: boolean;
}

/**
 * Write one `* n FETCH (...)` response in the requested framing.
 *
 * The literal count is `Buffer.byteLength`, never `payload.length`: `{n}` is a
 * byte count and the client reads the socket as utf8, so a fake that counted
 * characters would be correct only for pure-ASCII mail and would desynchronise
 * the client's reader on anything else. That is the same arithmetic the client
 * has to get right, so getting it wrong here would hide getting it wrong
 * there.
 */
export function writeFetchSectionResponse(
  socket: Socket,
  input: FetchSectionResponseInput,
): void {
  const position: FakeUidPosition = input.uidPosition ?? 'leading';
  const leading = !input.omitUid && position === 'leading' ? `UID ${String(input.uid)} ` : '';
  const trailing = !input.omitUid && position === 'trailing' ? ` UID ${String(input.uid)}` : '';

  if ((input.sectionEncoding ?? 'literal') === 'bare-lines') {
    serverWrite(socket, `* ${String(input.seq)} FETCH (${leading}${input.section} `);
    for (const line of input.payload.split('\r\n')) serverWrite(socket, line);
    serverWrite(socket, `${trailing})`);
    return;
  }

  serverWriteRaw(socket,
    `* ${String(input.seq)} FETCH (${leading}${input.section} `
    + `{${String(Buffer.byteLength(input.payload, 'utf8'))}}\r\n`);
  serverWriteRaw(socket, input.payload);
  serverWriteRaw(socket, `${trailing})\r\n`);
}
