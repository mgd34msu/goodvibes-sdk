# Decision: a remote channel may decide about a purchase and may never carry the instrument

Date: 2026-07-27
Scope: `daemon/surface-actions.ts`, `daemon/surface-card-gate.ts`, `security/card-shapes.ts`, and every remote messaging adapter
Status: accepted

**Provenance, stated plainly: the card-shape refusal is a coordinator ruling,
not an owner quote.** The owner's ruling it enforces is his own, card details
are entered only at a local terminal or the webui, never over a remote messaging
channel. The refusal below is the daemon-side enforcement of that ruling, and it
is recorded as a coordinator decision so nobody later cites it back as something
he said.

The other half, that approvals and vetoes for purchases work over remote
channels, **is** his explicit ruling, and it stays.

## Why this is its own record

These two rules look alike and point in opposite directions, and they are
currently stated together in one subsection of `docs/inbound-email.md` (§11.0).
A rule that lives only inside a long design document about something else is a
rule a later reader unifies away without ever seeing the argument against it.
The argument is short enough to keep whole.

## The distinction

**Authority over a decision is not a channel for a secret.**

| | Approving or vetoing a purchase | Entering the payment instrument |
|---|---|---|
| Over a remote channel | **Allowed**, owner's ruling | **Refused** |
| What travels | "yes" / "no" about a purchase already described | a PAN, a security code, an expiry |
| What an interceptor gains | knowledge of one decision he could have inferred from the outcome anyway | the ability to spend, anywhere, until the card is cancelled |
| Where it ends up | a message history, alongside every other message | a third party's message history, unerasable, replayable |
| Reversible | the purchase can be disputed, refunded, cancelled | the card can only be cancelled and reissued |

The asymmetry is not about how sensitive the two feel. It is that a decision is
scoped to one purchase and expires with it, while an instrument is a standing
capability to spend that outlives every purchase it was used for.

## What is enforced

1. A message on any remote messaging channel carrying card-shaped content, a
   PAN-shaped digit run that passes Luhn, a security code, an expiry pattern, is **refused**. Not stored, not logged, not transcribed, not placed in a
   notice body: nowhere it can be read later.
2. The refusal reply names only the matched **shapes**, never the digits. A
   refusal that echoes the number back has written the number into the history
   it was refusing to write it into.
3. **No card-entry prompt is ever offered on a remote channel**, because
   prompting is itself the harm, it invites the owner to type a card number
   into Telegram, where it lands somewhere nobody can erase.
4. The check runs on the shared ingress hook
   (`SurfaceActions.authorizeSurfaceIngress`) and runs **first**, before
   `evaluateIngress`, before proposal-reply resolution, before approval-reply
   resolution. Everything downstream may store, log or transcribe, so the check
   must precede all of it. Per-adapter placement would be wrong for the reason
   the payments round learned firsthand: a fix applied per-adapter leaves the
   other seventeen open.
5. **The refusal reply is always delivered**, even though the content is
   dropped. This is the one case where silence would do harm: an unheard
   objection inside a veto window elapses into a completed purchase. He is told
   immediately, on the same channel, and can resend without the digits.

## The consequence that is deliberate, not an oversight

A message that would have been a valid approval or a valid veto **is refused if
it carries card shapes**. The owner does not get his veto counted just because
he also pasted a card number into it. He gets an immediate refusal naming the
shapes and can resend the veto alone, which is why rule 5 exists and why the
refusal is never silent.

## Where inbound mail differs, and why

Inbound mail carrying card shapes is **redacted, not refused**
(`email/inbound/record-store.ts` calls `redactCardShapes` on the subject and the
body excerpt). This is not an inconsistency:

- A remote channel message is something the owner **typed**. Refusing it teaches
  him not to, and he can resend. There is a person on the other end to tell.
- Mail is something a **merchant sent**, an order confirmation with the last
  four, or worse. Refusing it would discard evidence of a purchase he made, from
  a sender who cannot be asked to resend. Redaction keeps the record and drops
  the digits.

The rule underneath both: the digits are never persisted. What differs is
whether the surrounding message survives, and that turns on whether anyone can
send it again.

## Alternatives considered

**Allow card entry over a remote channel with a confirmation step.** Rejected:
the prompt is the harm. A confirmation step happens after the number has already
been typed into the channel.

**Refuse approvals and vetoes over remote channels too, for symmetry.**
Rejected, and it is not the coordinator's to rule, the owner ruled explicitly
that approvals and vetoes work over remote channels. Symmetry is not a reason to
remove a capability he asked for.

**Detect and redact card shapes on remote channels instead of refusing, as mail
does.** Rejected: redaction would silently accept the message, and the owner
would never learn that typing a card into Telegram is not a thing that works. He
would keep doing it, and each attempt would put the digits into the channel's
history before our redaction ever saw them, the harm has already happened by
the time the daemon reads the message, so the response has to be one that
changes his behavior.
