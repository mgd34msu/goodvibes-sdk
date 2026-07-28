# The CVV is stored

**Date:** 2026-07-27
**Status:** Accepted (owner ruling, stated directly)
**Applies to:** the payment capability, `docs/payments.md` §9.5

## The ruling

> "we save the cvv, full stop. it is 100% needed for autonomous action."

Settled and closed. This is not an open question in the code, the tests, the
documentation, or any future review.

## Note for whoever arrives to harden this

You have found a card verification value in a secret store and recognised it as
something PCI DSS 3.2 prohibits storing after authorization. That recognition is
correct and the conclusion you are about to draw from it is wrong for this
system. Here is the reasoning, so you do not have to reconstruct it.

**Autonomous action is the entire capability.** Not a convenience on top of it —
the thing itself. The design rests on two windows, and the in-budget one is a
veto: the owner is told what is about to happen, and if he says nothing the
purchase proceeds. His words for why it works that way:

> "this is for situations where the user is multitasking and doesn't look at the
> specific terminal session for an extended period of time"

A purchase that pauses to ask a human for a three-digit code is an attended
purchase. Every veto window would become an approval, silence would stop meaning
anything, and the feature would be a slower way of buying something by hand.

So removing the stored CVV does not make this feature safer. **It makes it not
exist.** The honest comparison is not "stored CVV versus prompted CVV", it is
"this capability versus no capability", and that is the owner's call to make. He
made it.

## What that costs, stated plainly

Documentation of a decision is not a hedge on it, and he is entitled to know what
he is carrying.

Anyone who can read both `~/.goodvibes/daemon/secrets.enc` and
`~/.goodvibes/secrets.key` holds the card number, the expiry, the CVV and the
billing address — a complete card-not-present kit, usable at any merchant, with
no further access to this machine. Filesystem permissions and AES-256-GCM at rest
defend against another user on the same host. Neither defends against a process
running as the owner, and a home-directory backup carries the whole set.

**A virtual card bounds that loss and a real card number does not.** This is
guidance about which instrument to provision, and it is where the real risk
reduction lives:

- Virtual card: the worst case is one number with an issuer-enforced ceiling,
  killable from an app in a minute. The cap is enforced by the issuer, so it
  holds when our software is wrong, when it is compromised, and when it is not
  running.
- Real card: the worst case is the card his rent comes out of, and nothing in
  this software can cap it.

## What is actually load-bearing

The decision is safe to live with because of the containment, not because of any
argument about scope. Each of these is asserted by a test over real output:

- Daemon secret tier only, forced by `resolveSecretWriteScope` — never the config
  file.
- Encrypted at rest; the on-disk bytes do not contain the value.
- Never logged, on any path.
- Never rendered on any surface. `payments.cards.*` returns metadata only —
  there is no operator method that can return it.
- Never echoed while being typed, not only masked at rest.
- Absent from every export, diagnostic dump and support bundle, verified by
  walking the real payloads.

If you want to improve the safety of this design, that list is where the work
is. Deleting the stored CVV is not on it.

## The setting still exists

`payments.cvvHandling` ships as a real setting per the platform rule that a flag
is a feature: `'stored'` (default) and `'prompt'`. Choosing `'prompt'` disables
unattended purchasing, and the surface says exactly that at the moment of
selection — `CVV_PROMPT_TRADEOFF_WARNING` in `platform/payments/index.ts`. The
trade-off belongs in front of whoever flips the switch.
