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
 * One probe, both command forms
 * ─────────────────────────────
 * There were briefly two probes here — one asking "will this server answer a
 * UID-addressed fetch", the other asking "does what came back match what was
 * declared" — costing three round trips between them. They are one probe now,
 * because they were two halves of one question. `probeMailboxBody` issues the
 * sequence-addressed BODYSTRUCTURE that supplies the declaration and the
 * UID-addressed body fetch that exercises the drain's own addressing, in two
 * round trips, and neither form is droppable. The argument is at that function.
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
 * Three outcomes, and the third is the one that would otherwise be guessed
 * wrong in both directions:
 *
 *   - `readable` — content came back. Demonstrated, not inferred.
 *   - `unreadable` — this account cannot read message content. Mail can be
 *     seen arriving and never read.
 *   - `unproven` — there was nothing to read from, so nothing was learned.
 *     NOT the same as `readable`: claiming a capability nobody has
 *     demonstrated is how the Gmail metadata-scope defect looked from outside.
 *
 * Discriminated on `outcome`, in the same discipline as `ImapIdleSupport`: the
 * evidence for an outcome does not exist as a property until `outcome` has been
 * narrowed, so `if (probe.returnedBytes > 0)` on an unnarrowed probe does not
 * compile rather than compiling and reading `undefined` as falsy.
 */
export type ImapBodyProbe =
  | {
    readonly outcome: 'readable';
    /** Bytes the body fetch returned. The proof, not an inference from it. */
    readonly returnedBytes: number;
    readonly detail: string;
  }
  | {
    readonly outcome: 'unproven';
    /** Plain-language reason nothing could be demonstrated. Never a body. */
    readonly detail: string;
  }
  | {
    readonly outcome: 'unreadable';
    /** How it was learned. One fact, two ways of finding it out. */
    readonly evidence: ImapBodyUnreadableEvidence;
    /**
     * Plain language, carrying the server's own wording where it gave any.
     * Never a message body, never a credential.
     */
    readonly detail: string;
  };

/**
 * The two ways a connection demonstrates it cannot read message content.
 *
 * They are one outcome rather than two because they carry the same meaning for
 * the owner and the same remedy — this account is not permitted to read message
 * content — and a reader that had to handle them separately would be handling
 * the same finding twice. They stay distinguishable because the EVIDENCE
 * genuinely differs, and each case carries only the evidence it actually has:
 * there is no declaration to report when the server refused before declaring
 * anything, and no server wording to report when the server said nothing and
 * merely returned nothing.
 *
 *   - `withheld` — the server ACCEPTED the fetch and returned an empty body for
 *     a message its own BODYSTRUCTURE declared has content in it. This is the
 *     case that has no other detector: a refusal-only check reads it as success,
 *     and from outside it is indistinguishable from a mailbox nobody wrote to.
 *   - `refused` — the server declined, and named no condition
 *     `classifyServerRefusal` can place. A refusal it CAN place ([LIMIT], an
 *     auth code, a mailbox code) never reaches here; it is re-thrown for the
 *     classifier that already owns it, because "this account may not read
 *     bodies" would be a specific and false explanation for a busy server.
 */
export type ImapBodyUnreadableEvidence =
  | { readonly kind: 'withheld'; readonly declaredOctets: number }
  | { readonly kind: 'refused'; readonly serverMessage: string };

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
}): ImapBodyProbe {
  if (!input.responded) {
    return {
      outcome: 'unproven',
      detail: `The server returned no message for ${input.subject}, so it was `
        + 'gone before it could be read and nothing was learned about whether '
        + 'message content can be read.',
    };
  }
  if (input.returnedBytes > 0) {
    return {
      outcome: 'readable',
      returnedBytes: input.returnedBytes,
      detail: `Read ${input.returnedBytes} byte(s) of ${input.subject}, so this `
        + 'account can read message content.',
    };
  }
  if (input.declaredOctets > 0) {
    return {
      outcome: 'unreadable',
      evidence: { kind: 'withheld', declaredOctets: input.declaredOctets },
      detail: `The server accepted the fetch for ${input.subject} and returned `
        + `an empty body, though its own BODYSTRUCTURE declared a text part of `
        + `${input.declaredOctets} octet(s). An empty answer to a message the `
        + 'server says has content in it is a withheld body, not an empty '
        + 'message.',
    };
  }
  return {
    outcome: 'unproven',
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

/** Raise the capability failure an `unreadable` outcome means. */
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
 * ONE probe, TWO command forms, and both are load-bearing
 * ──────────────────────────────────────────────────────
 * This used to be two separate probes making three round trips between them,
 * and the reason they merged is that each was answering half of one question:
 *
 *   1. `FETCH <exists> (UID BODYSTRUCTURE)` — SEQUENCE-addressed. Asks the
 *      server to describe the newest message, which is what supplies the
 *      declared octet count the whole check compares against, and its UID.
 *      The newest message is chosen by sequence number `exists` because that is
 *      the same message the highest UID names — IMAP keeps UID order and
 *      sequence order together — and it costs no `UID SEARCH` to find.
 *   2. `UID FETCH <uid> BODY.PEEK[]<0.N>` — UID-addressed, and deliberately so.
 *      That is the command form the real drain uses, so a server that refuses
 *      UID-addressed fetches is caught HERE, at connect, rather than on the
 *      first message that matters. Fetching the body by sequence number instead
 *      would leave that refusal undiscovered until a verification mail arrived.
 *
 * So the two forms are not redundant: the first is the only source of the
 * declaration, and the second is the only exercise of the drain's own
 * addressing. Losing either loses a case — a withheld body becomes invisible
 * without the comparison, and a UID-refusing server becomes invisible without
 * the UID fetch.
 *
 * Two round trips, once per connection. The pair cannot collapse into one
 * command: in a single response the structure and the section sit in the same
 * FETCH item list, and `extractFetchSection` would collect the structure text
 * as part of the body, which would read as "content came back" for a server
 * that returned none.
 *
 * `BODY.PEEK`, and bounded to `IMAP_BODY_PROBE_BYTES`, so nothing is marked
 * `\Seen` and no large message is pulled through a connection that has not yet
 * been declared healthy.
 */
export async function probeMailboxBody(
  session: Pick<ImapSession, 'command'>,
  input: {
    /** `EXISTS` from EXAMINE. */
    readonly exists: number | null;
    readonly mailbox: string;
  },
): Promise<ImapBodyProbe> {
  const exists = input.exists ?? 0;
  if (exists <= 0) {
    return {
      outcome: 'unproven',
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
      outcome: 'unproven',
      detail: `The newest message in '${input.mailbox}' was gone before it could `
        + 'be read, so nothing was learned about whether message content can be '
        + 'read.',
    };
  }
  const parts = parseBodyStructure(extractBodyStructure(structureLines));
  const uid = uidFrom(structureLines);

  // UID-addressed whenever the server named a UID, because that is the form the
  // drain uses. Falling back to the sequence form when it named none is not a
  // silent downgrade of the check: the declared-versus-returned comparison —
  // the part with no other detector — runs either way, and refusing to probe at
  // all because a server omitted a UID it was explicitly asked for would turn a
  // server quirk into a mailbox nobody watches.
  const bodyLines = await probeCommand(
    session,
    uid > 0
      ? `UID FETCH ${uid} BODY.PEEK[]<0.${IMAP_BODY_PROBE_BYTES}>`
      : `FETCH ${exists} BODY.PEEK[]<0.${IMAP_BODY_PROBE_BYTES}>`,
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
