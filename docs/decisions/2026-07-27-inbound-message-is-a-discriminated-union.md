# Decision: the found message is a discriminated union on source, like the cursor

Date: 2026-07-27
Scope: `packages/sdk/src/platform/email/inbound/`
Status: accepted

## Context

`docs/inbound-email.md` §3.4d states that `InboundMailboxMessage`,
`InboundMailSink`, `MailboxCursorPort`, `InboundMailObserver` and
`InboundCapabilityVerdict` "are already source-agnostic — only
`MailboxConnectionPort`, `MailboxReader` and `MailboxWire` are IMAP-shaped."

**That is wrong about `InboundMailboxMessage`, and it was verified wrong by
reading it.** As shipped (`inbound/ports.ts`) it is:

```ts
export interface InboundMailboxMessage {
  readonly account: string;
  readonly mailbox: string;
  readonly uidValidity: number;
  readonly uid: number;
  readonly envelope: ImapEnvelope;
  readonly via: 'idle' | 'poll';
}
```

`uidValidity`, `uid` and `ImapEnvelope` are IMAP, all three. A Gmail message
has a message resource id (an opaque string), a `historyId` (a decimal uint64
string), and a `GmailMessageBody`. It has no UID and no `UIDVALIDITY`, and
there is no mailbox in Gmail's sense either — mail is filed under labels and a
plus-addressed alias still lands in the one INBOX.

So the seam does not already exist at the sink. It has to be cut, and how it is
cut decides whether the source-agnostic half of this capability really is
written once.

## Decision

**`InboundMailboxMessage` becomes a union discriminated on `source`, over a
common base that carries every field the source-agnostic pipeline reads.**

```ts
/**
 * What any source can say about a message it found. Everything the pipeline
 * downstream of a source reads lives here, and nothing here is IMAP-shaped.
 */
export interface InboundMessageCommon {
  readonly account: string;
  /** The IMAP EXAMINE target, or the Gmail label. Identity of what was watched. */
  readonly mailbox: string;
  readonly from: string;
  readonly subject: string;
  /** The `Date:` header. Sender-written: display only, never an ordering key. */
  readonly claimedDate: string;
  readonly messageId: string;
  /** Receiver-written delivery evidence, top-most first. The correlation key. */
  readonly deliveredTo: readonly string[];
  /** The `To:` header verbatim. Display only, never evidence. */
  readonly unverifiedToHeaderClaim: string;
}

export interface ImapInboundMessage extends InboundMessageCommon {
  readonly source: 'imap';
  readonly uidValidity: number;
  readonly uid: number;
  readonly envelope: ImapEnvelope;
  readonly via: 'idle' | 'poll';
}

export interface GmailInboundMessage extends InboundMessageCommon {
  readonly source: 'gmail';
  /** Gmail's opaque message resource id. Not a number, never coerced to one. */
  readonly resourceId: string;
  /** The delta's high-water mark, a decimal uint64 STRING. */
  readonly historyId: string;
  /** Gmail's history delta carries the body; IMAP's envelope pass does not. */
  readonly body: string;
  /** Always `'poll'`. Gmail has no push available to a daemon behind NAT. */
  readonly via: 'poll';
}

export type InboundMailboxMessage = ImapInboundMessage | GmailInboundMessage;
```

This is the same shape, and the same discriminant, as the cursor decision in
`source-cursor.ts`. That is deliberate: one rule for "two sources, positions and
payloads that are not the same kind of thing", applied twice, rather than a
union in one place and a widened half-filled record in the other.

## Alternatives considered

**Synthesise a UID for Gmail messages.** Rejected, and it is the same mistake
the cursor union already refuses. There is no honest mapping from an opaque
Gmail resource id to a UID, so any mapping is invented; a fabricated UID would
then be written into a cursor, compared against a real one, and used to decide
what has already been handled. `source-cursor.ts` discards rather than coerces
for exactly this reason, and the message shape must not undo that one layer up.

**Widen `InboundMailboxMessage` with optional fields** — `uid?`, `historyId?`.
Rejected for the reason given in `source-cursor.ts`'s header: a record that is
always half-filled makes "half-filled" and "torn" indistinguishable, and every
consumer then does its own `if (msg.uid !== undefined)` with its own idea of
what the other case means. The union makes the exhaustive switch the compiler's
job.

**Two sinks, one per source.** Rejected: it duplicates expectation matching,
taint labelling, dedup, notice rendering and disclosure — the exact five things
§3.4d exists to write once. The whole value of the seam is that those are
written against `InboundMessageCommon` and never switch on `source` at all.

## Consequences, stated rather than discovered later

1. **`ImapEnvelope` stays on the IMAP variant and is not hoisted.** The
   pipeline reads the base; anything that genuinely needs IMAP specifics
   (`authenticationResults`, the full `deliveryEvidence` list with provenance)
   narrows first. Hoisting `ImapEnvelope` into the base would put IMAP back in
   the common type under a different name.

2. **`deliveredTo` is `readonly string[]` in the base, not `DeliveredRecipient`.**
   The brand is minted at the matching boundary, by
   `deliveredRecipientFromDeliveryHeaders` (top-most entry only) or
   `deliveredRecipientFromAliasMailbox`, and minting it is the pipeline's job,
   not a source's. A source that could hand the pipeline a pre-branded value
   could hand it a branded `To:` header, which is the forgery the brand exists
   to make unrepresentable. Both `ImapEnvelope.deliveredTo` and
   `GmailMessageBody.deliveredTo` are already ordered top-most-first, so the
   base field is a straight carry on both sides.

3. **The IMAP variant carries no body and the Gmail variant does.** This is a
   real asymmetry, not an oversight: `users.history.list` + `getMessage`
   returns bodies as part of collecting the delta, while the IMAP watcher
   deliberately fetches envelopes only and leaves the body fetch to the
   pipeline. The pipeline therefore needs a body-fetch step that is a no-op on
   the Gmail variant. It must not paper over this by pre-fetching IMAP bodies
   in the source: the whole point of the envelope pass is that a batch of
   headers is cheap and a batch of bodies is not.

4. **`via` narrows to `'poll'` on Gmail.** There is no Gmail push on this path
   (§3.4d: `users.watch` + Pub/Sub needs a public HTTPS endpoint and a GCP
   topic). Making the type say so means no surface can render "pushed" for a
   Gmail message by accident, which is the honesty requirement restated where
   the compiler can hold it.

5. **`claimedDate` is named for what it is.** It was `envelope.date`. Anything
   that sorts or windows on it is sorting on a value the sender wrote — the
   defect this round already fixed once in the webui inbox, and the subject of
   `2026-07-27-calendar-start-sort-is-not-the-defect.md`. The name is the
   warning.
