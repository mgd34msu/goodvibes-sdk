# The daemon refuses a derived send rather than disclosing it

**Date:** 2026-07-27
**Status:** Accepted (owner ruling)
**Supersedes:** the disclosure-only behaviour introduced with the `browser.*`
daemon verbs, in `control-plane/routes/email.ts`.

## Note for the round that wrote the disclosure

This inverts a decision you made deliberately, so here is the reasoning that
replaced it rather than a diff to discover.

Your `untrustedExposureDisclosure` attached the origins in scope to a send
receipt and let the send proceed. The stated reasoning was sound as far as it
went: an unattended daemon has nobody to take a refusal to, so a refusal there
is a dead end, whereas a disclosure travels with the receipt and lets a reader
weigh it.

The ruling went the other way, and the reason is the threat model rather than
the ergonomics: the situation to be designed out is a prompt injection reaching
the daemon through inbound email.

A disclosure is a note in a receipt nobody reads, on the one surface with no
human watching. An unattended daemon is precisely where a prompt injection pays
off best, because there is nobody to notice.

Ranking the daemon as the most permissive surface is backwards for this threat:
a product with a human attached refuses the same send.

**Your disclosure is kept**, for the sends that now pass. It stops being the
only protection; it does not stop being useful.

## What made strictness affordable

A blanket refusal on "has this process read anything untrusted" would be
unusable in a daemon, which reads mail and pages continuously. That check is
permanently tripped, and a boundary that is permanently tripped gets removed.

So the question was narrowed to one that is actually answerable: **does the
content of this specific outward action derive from untrusted input?**

- A scheduled report that queries a database and mails a summary derives from
  nothing a stranger wrote, and proceeds.
- A send whose recipient, subject or body repeats text from a page or a mailbox
  is refused.

Detection is by overlap with the untrusted text actually read, 8 shared
normalized words, or a 40-character shared span, with the recipient tested by
exact containment instead, because an address is short and high-signal and a
length threshold misses it entirely.

## What this does not claim

It catches derivation that leaves textual evidence. A sufficiently clever
paraphrase is not caught and no non-classifier could catch it. The remaining
defences are that untrusted content carries no authority at all, and that
outward actions still require confirmation.

## The one exemption: a send to the owner

Owner ruling. The owner is the trust root, not a third party, and reporting what
arrived is the point of an assistant reading the owner's mail. "What came in
overnight" is a summary that necessarily reuses the words of what came in, so
without an exemption the feature is refused in its most ordinary use.

Deliberately narrow, and each narrowing is tested:

- The owner's configured addresses only. **Not a domain** (that would exempt every
  colleague, and a forward to a colleague is a third-party disclosure), **not a
  pattern** (no plus-address folding), **not "internal"** (there is no such
  tier).

- **Not partial.** A send to the owner AND anyone else is refused, because
  naming the owner first and slipping a second recipient in alongside is exactly
  how this would be abused.

- Identity comes from configuration, `email.fromAddress`, `email.username`,
  `surfaces.email.from`/`.user`/`.username`, and never from a `From:` header,
  `Reply-To:`, delivery evidence, the ledger, or the body. A recipient the
  content chose is the attack, so content is not consulted.

- Nothing configured means no identity, so the exemption cannot fire and the
  refusal stays. That is the correct failure direction.

**To spoof it** an attacker must change the owner's stored mail configuration:
either an authenticated write to the daemon config API, or inducing the agent
to call a config-setting tool. Both are strictly stronger capabilities than
sending mail, anything able to rewrite daemon config can disable this guard
outright, repoint SMTP, or read the credential store. The exemption sits behind
a capability that already implies compromise.

**It exempts the taint rule and nothing else.** Link validation, the
confirmation gate and the explicit-user-request rule all still apply to a send
to the owner.

## Legitimate shapes that are still refused

Listed so they are ruled on rather than discovered:

- Forwarding a message body verbatim.
- Pasting a long identifier read from a page into a message.

Exempted after evidence: quoting a message you are replying to
(`stripQuotedFields`), replying to the envelope sender established from
delivery evidence, and boilerplate that appears in two or more distinct
senders' mail.

## Where it lives

- `platform/security/content-taint.ts`, the derivation check and its thresholds
- `platform/security/turn-boundary.ts`, what "this turn" means, and why
  automated work does not reset it
- `platform/security/link-validation.ts`, the gate a link must pass before
  anything opens it
- `control-plane/routes/email.ts`, `refuseTaintedSend`, ahead of the send
