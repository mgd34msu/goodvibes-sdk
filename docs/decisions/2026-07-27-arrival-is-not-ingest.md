# Decision: an arriving email is recorded when a turn reads it, never when the daemon receives it

Date: 2026-07-27
Scope: inbound email × untrusted-content taint. Constrains any future background reader.
Status: accepted

## Context

The daemon is gaining a listener for incoming mail (`docs/inbound-email.md`).
That listener runs continuously, in the background, with nobody watching.

The untrusted-content ledger it would feed is **one instance per process**
(`getProcessUntrustedContentLedger()`), scoped to a turn by a watermark that
`startTurn()` advances. `evaluateOutwardEffect` refuses an outward action when
anything was ingested since that watermark.

Those two facts do not compose. A watcher that records ingest at the moment mail
arrives writes into whatever turn window happens to be open at that moment. Mail
landing at 03:00 while the owner is mid-request would refuse that outward action
on the basis of a message no turn read, no model saw, and nobody asked for.

The consequence is not friction. It is that anyone who knows the owner's email
address could disable the agent's outward actions on demand simply by sending
mail, and could do it repeatedly, at will, from anywhere, with no access to
anything. A defense against injected instructions would have become a remote
off switch operated by strangers.

This is worse than the defect the taint round is currently fixing, and it would
have been introduced by the round meant to make mail useful.

## Decision

> **The turn ledger records a body when a turn reads it, never when the daemon
> receives it.**

Concretely:

- Arriving mail is written to a durable **inbound record store**, which is not
  the turn ledger and has no watermark. Arrival is a fact about the mailbox.
- `ledger.record()` is called only from where it is called today, `EmailService.listInbox` / `readMessage`, inside a turn that asked for mail, and from no new place.
- Owner notices are rendered from structured fields (sender, subject, delivery
  evidence, link verdicts), so telling the owner mail arrived never ingests a
  body into a turn.
- Expectation matching does read the body, but it is a pure comparison that
  emits a decision. It records the *outcome* in the inbound store; it does not
  record the body into the turn ledger.

## Alternatives considered

**Record on arrival and accept the refusals.** Rejected: it is the remote off
switch described above.

**Give the watcher its own ledger instance.** Rejected as insufficient rather
than wrong. It removes the cross-talk, but a second ledger invites a later
"unification" that reintroduces exactly this, and it answers the wrong question, the issue is not *which* ledger, it is that arrival is not the event that
should be recorded at all.

**Advance the turn watermark after each arrival.** Rejected outright, and it is
worth naming because it looks like a fix. Anything that lets inbound content
move the watermark lets content arrange for the record of itself to be erased
before the action it was trying to cause. That is the precise attack the
watermark exists to stop.

## Consequences

- The taint round and this round must not both add `ledger.record()` calls to
  the arrival path. Neither list of owned files overlaps; this is the one
  semantic boundary between them.

- Inbound mail must never be treated as owner-direct.
  `inputOriginIsOwnerDirect(origin)` returns `true` when `origin === undefined`
 , "nothing routed it in, that is the keyboard". Inbound mail *is* routed in,
  so every inbound-originated invocation must supply an origin carrying
  `ownerDirect: false` **explicitly**, never omit it and never rely on its
  source name being absent from a list.

- The rule generalizes beyond email, and should be applied to any future
  background reader, a calendar sync, a feed poller, a webhook receiver. The
  question to ask is not "is this content untrusted" (it always is) but "did a
  turn ask for it". If nothing asked, nothing is ingested.
