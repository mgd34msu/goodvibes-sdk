/**
 * Can this connection actually read message content — asked, not assumed.
 *
 * Why this file exists
 * ────────────────────
 * The Gmail path refuses a `metadata`-scoped token BEFORE it calls
 * `users.history.list`, because Google's own description of that scope says it
 * grants "labels and headers, but not the email body", and a body-less delta
 * cannot satisfy a verification expectation. The refusal is possible there
 * because Google publishes what a grant covers.
 *
 * IMAP publishes nothing of the kind. There are no scopes; there is a mailbox
 * whose access rights the provider decides and never states. `LOGIN` succeeding
 * and `EXAMINE` succeeding say the account exists and the folder is there —
 * neither says the server will hand over what is inside a message. A provider
 * that permits headers and withholds content answers every command with `OK`
 * and returns nothing, which reads from the outside exactly like a mailbox
 * nobody has written to.
 *
 * So the equivalent of a scope comparison here is EVIDENCE: read one message
 * and check what came back against what the server itself said was there.
 *
 * Two halves, because one is not enough
 * ─────────────────────────────────────
 * 1. **A connect-time probe.** One existing message, bounded, `BODY.PEEK` so
 *    nothing is marked `\Seen`. A refusal is a capability failure; an empty
 *    section for a message whose own BODYSTRUCTURE declared a text part with
 *    octets in it is the same failure wearing a quiet mailbox's clothes.
 * 2. **A runtime invariant.** An empty mailbox has nothing to probe, so the
 *    probe cannot prove anything there — and a freshly created signup alias is
 *    empty by definition, which is the exact journey this capability serves.
 *    The same comparison therefore runs again on the first body actually
 *    fetched, and settles what the probe had to leave open.
 *
 * The comparison — DECLARED octets against RETURNED bytes — is what makes this
 * checkable rather than a guess, and it is why the probe fetches BODYSTRUCTURE
 * alongside the body rather than the body alone. Without the server's own
 * declaration there is no way to tell "this message is empty" from "this server
 * will not show me the message".
 *
 * Not the same probe as `ImapClient.probeBodyAccess()`
 * ────────────────────────────────────────────────────
 * That one sends `UID FETCH <uid> (UID BODY.PEEK[TEXT])` and reads any FETCH
 * response at all as success, which makes it the check for "will this server
 * answer a UID-addressed fetch" — the command form the real drain uses, and
 * worth asking at connect for that reason. It cannot see the case this file
 * exists for: a server that answers that fetch with an empty section passes it.
 *
 * This one sends sequence-addressed `FETCH n` and compares against the
 * declaration. Neither absorbs the other, and `inbound/connection.ts` runs both
 * — see the note at its `open()`.
 */

import {
  extractBodyStructure,
  extractFetchSection,
  hasFetchResponse,
  parseBodyStructure,
  selectBodyPart,
  type ImapBodyPart,
} from './imap-bodystructure.js';
import {
  classifyServerRefusal,
  ownerMessageForFailure,
  type EmailCapabilityFailureNotice,
} from './imap-open.js';
import type { ImapSession } from './imap-session.js';

/**
 * How much of the probed message is asked for.
 *
 * Small on purpose. The question is "does content come back at all", and a
 * whole message would answer it no better while pulling whatever a stranger
 * chose to attach through a connection that has not yet been declared healthy.
 */
export const IMAP_BODY_PROBE_BYTES = 512;

/**
 * What is known about this connection's ability to read message content.
 *
 * Three cases, not two, and the third is the one that would otherwise be
 * guessed wrong in both directions:
 *
 *   - `readable` — content came back. Demonstrated, not inferred.
 *   - `unfetchable` — the server accepted the fetch and gave nothing usable
 *     back, or refused it outright. Mail can be seen arriving and never read.
 *   - `unproven` — there was nothing to read from, so nothing was learned.
 *     NOT the same as `readable`: claiming a capability nobody has
 *     demonstrated is how the Gmail metadata-scope defect looked from outside.
 */
export type ImapBodyReadability =
  | {
    readonly kind: 'readable';
    /** Bytes the fetch returned. */
    readonly returnedBytes: number;
    /** Octets the server's own BODYSTRUCTURE declared. 0 when it declared none. */
    readonly declaredOctets: number;
    readonly detail: string;
  }
  | {
    readonly kind: 'unproven';
    /** Plain-language reason nothing could be demonstrated. Never a body. */
    readonly detail: string;
  }
  | {
    readonly kind: 'unfetchable';
    readonly declaredOctets: number;
    readonly returnedBytes: number;
    /**
     * The server's own wording where it said anything, and a description of
     * the declared-versus-returned mismatch where it said nothing. Never a
     * message body, never a credential.
     */
    readonly detail: string;
  };

/**
 * The octets the server declared for the parts a reader would be SHOWN.
 *
 * Attachments are excluded because they are described and never downloaded, so
 * a message that is one 30 MB archive declares nothing this can check.
 * `selectBodyPart` is the same chooser `fetchMessage` uses; a second notion of
 * "which part is the body" would be a second answer, and the quiet one wins.
 */
export function declaredTextOctets(parts: readonly ImapBodyPart[]): number {
  const plain = selectBodyPart(parts, 'plain');
  const html = selectBodyPart(parts, 'html');
  return Math.max(plain?.sizeBytes ?? 0, html?.sizeBytes ?? 0);
}

/**
 * The invariant, as a pure comparison: does what came back match what the
 * server said was there?
 *
 * This is half 2 as much as it is half 1 — the probe calls it with one probed
 * message, and a real body fetch calls it with the message it just read. One
 * rule, evaluated in both places, so "the mailbox went quiet" and "the server
 * will not show me the mail" cannot be confused at either call site.
 */
export function assessFetchedBody(input: {
  /** False when the server returned no FETCH response at all for this message. */
  readonly responded: boolean;
  /** From this message's OWN BODYSTRUCTURE. 0 when it declared no text part. */
  readonly declaredOctets: number;
  /** What the body fetch actually produced. */
  readonly returnedBytes: number;
  /** Which message this was about, for the detail. Never its content. */
  readonly subject: string;
}): ImapBodyReadability {
  if (!input.responded) {
    return {
      kind: 'unproven',
      detail: `The server returned no message for ${input.subject}, so it was `
        + 'gone before it could be read and nothing was learned about whether '
        + 'message content can be read.',
    };
  }
  if (input.returnedBytes > 0) {
    return {
      kind: 'readable',
      returnedBytes: input.returnedBytes,
      declaredOctets: input.declaredOctets,
      detail: `Read ${input.returnedBytes} byte(s) of ${input.subject}, so this `
        + 'account can read message content.',
    };
  }
  if (input.declaredOctets > 0) {
    return {
      kind: 'unfetchable',
      declaredOctets: input.declaredOctets,
      returnedBytes: 0,
      detail: `The server accepted the fetch for ${input.subject} and returned `
        + `an empty body, though its own BODYSTRUCTURE declared a text part of `
        + `${input.declaredOctets} octet(s). An empty answer to a message the `
        + 'server says has content in it is a withheld body, not an empty '
        + 'message.',
    };
  }
  return {
    kind: 'unproven',
    detail: `${input.subject} declares no readable text content, so reading it `
      + 'proved nothing either way about this account\'s access to message '
      + 'content.',
  };
}

/**
 * A connection that authenticated, opened its mailbox, and will not hand over
 * what is inside a message.
 *
 * Carries the same routable `notice` `ImapOpenError` does, and structurally —
 * `describeEmailCapabilityFailure` reads it off either without importing
 * either — so a withheld body reaches the owner by the path a refused
 * credential already travels, with its own reason and its own remedy.
 *
 * Deliberately NOT an `ImapOpenError` with `fetch`-shaped wording: the server
 * did not refuse a fetch here, it answered one and gave nothing back, and the
 * two have different fixes.
 */
export class ImapBodyCapabilityError extends Error {
  readonly mailbox: string;
  /** The server's own words, or '' when it said nothing and merely returned nothing. */
  readonly serverMessage: string;
  /** Always true: no amount of reconnecting grants an account access rights. */
  readonly terminal = true;
  readonly notice: EmailCapabilityFailureNotice;

  constructor(input: {
    readonly summary: string;
    readonly serverMessage: string;
    readonly mailbox: string;
  }) {
    super(
      input.serverMessage.length > 0
        ? `${input.summary} ${input.serverMessage}`
        : input.summary,
    );
    this.name = 'ImapBodyCapabilityError';
    this.mailbox = input.mailbox;
    this.serverMessage = input.serverMessage;
    this.notice = {
      reason: 'bodies-unfetchable',
      terminal: true,
      mailbox: input.mailbox,
      ownerMessage: ownerMessageForFailure('bodies-unfetchable', input.mailbox),
      serverMessage: input.serverMessage,
    };
  }
}

/** Raise the capability failure that an `unfetchable` reading means. */
export function bodyCapabilityFailure(input: {
  readonly mailbox: string;
  readonly summary: string;
  readonly serverMessage: string;
}): ImapBodyCapabilityError {
  return new ImapBodyCapabilityError(input);
}

/**
 * Send one probe command, and read a refusal for what it actually says.
 *
 * A `NO [LIMIT]`, a refused credential and a vanished mailbox are all things
 * the existing classifier already names and already handles, and re-labelling
 * any of them "this account cannot read bodies" would put a false and very
 * specific explanation in front of the owner. So only a refusal that names
 * NOTHING about itself becomes a body-capability failure; everything the
 * server characterised is re-thrown for `classifyOpenFailure` to place.
 *
 * A timeout or a dead socket is re-thrown untouched — that is a reconnect, and
 * calling it a capability verdict would stop a watcher over a network blip.
 */
async function probeCommand(
  session: Pick<ImapSession, 'command'>,
  command: string,
  mailbox: string,
): Promise<string[]> {
  try {
    return await session.command(command);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error ?? '');
    if (!text.startsWith('IMAP command failed:')) throw error;
    if (classifyServerRefusal(text, 'connection-failed') !== 'connection-failed') throw error;
    throw bodyCapabilityFailure({
      mailbox,
      summary: `The mailbox '${mailbox}' opened and the mail server refused to `
        + 'hand over the content of a message in it.',
      serverMessage: text,
    });
  }
}

/** The UID the server reported in a FETCH response, or 0 when it named none. */
function uidFrom(lines: readonly string[]): number {
  for (const line of lines) {
    const match = /\bUID (\d+)/.exec(line);
    if (match !== null) return parseInt(match[1] ?? '0', 10);
  }
  return 0;
}

/**
 * Read one existing message far enough to prove content can be read.
 *
 * The newest message is chosen by SEQUENCE number `exists`, which is the same
 * message the highest UID names — IMAP keeps UID order and sequence order
 * together — and costs no `UID SEARCH` to find. Its UID is read back off the
 * response so the detail can name it.
 *
 * BODYSTRUCTURE and the body arrive as two commands rather than one, on
 * purpose: in a single response the structure and the section sit in the same
 * FETCH item list, and `extractFetchSection` would collect the structure text
 * as part of the body. Two round trips, once per connection, buys a reading
 * that cannot be off by the server's item ordering.
 */
export async function probeMailboxBody(
  session: Pick<ImapSession, 'command'>,
  input: {
    /** `EXISTS` from EXAMINE. */
    readonly exists: number | null;
    readonly mailbox: string;
  },
): Promise<ImapBodyReadability> {
  const exists = input.exists ?? 0;
  if (exists <= 0) {
    return {
      kind: 'unproven',
      detail: `The mailbox '${input.mailbox}' holds no messages, so there was `
        + 'nothing to read and it is not yet proven that this account can read '
        + 'message content. The first message that arrives settles it.',
    };
  }

  const structureLines = await probeCommand(
    session,
    `FETCH ${exists} (UID BODYSTRUCTURE)`,
    input.mailbox,
  );
  if (!hasFetchResponse(structureLines)) {
    return {
      kind: 'unproven',
      detail: `The newest message in '${input.mailbox}' was gone before it could `
        + 'be read, so nothing was learned about whether message content can be '
        + 'read.',
    };
  }
  const parts = parseBodyStructure(extractBodyStructure(structureLines));
  const uid = uidFrom(structureLines);

  const bodyLines = await probeCommand(
    session,
    `FETCH ${exists} BODY.PEEK[]<0.${IMAP_BODY_PROBE_BYTES}>`,
    input.mailbox,
  );
  const section = extractFetchSection(bodyLines);
  return assessFetchedBody({
    responded: hasFetchResponse(bodyLines),
    declaredOctets: declaredTextOctets(parts),
    returnedBytes: section === null ? 0 : Buffer.byteLength(section, 'utf8'),
    subject: uid > 0
      ? `UID ${uid} in '${input.mailbox}'`
      : `the newest message in '${input.mailbox}'`,
  });
}
