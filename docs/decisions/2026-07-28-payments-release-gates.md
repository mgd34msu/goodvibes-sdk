# Payments release gates

**Date:** 2026-07-28
**Status:** Open — these block the payments round from shipping
**Owner of this list:** the SDK round (not the individual consumers)

Every payments consumer builds against a **local SDK overlay**, not a published
package. This is expected for new work and it is a sequencing dependency, not a
consumer-side problem to be rediscovered three times.

## The blocking fact

Published `@pellux/goodvibes-sdk` **1.18.0 and 1.18.1 contain no
`platform/payments` subpath at all** — verified from the bun cache, not assumed.
The subpath was added on this branch (`d0e1efe4`) and has never been published.

Consequences:

- webui, TUI and agent payments work all resolve `@pellux/goodvibes-sdk` through
  an overlay or a `file:` tarball.
- **Nothing in the payments round can ship until the SDK publishes that
  subpath.** Consumers cannot restore their npm pins before that, so every
  consumer's `sdk:gate` / `publish:check` is red by construction until it lands.

Sequencing is therefore: **SDK publishes with `./platform/payments` → consumers
restore npm pins → consumer gates go green → consumers ship.** The two-stage
release-train pattern, with this round's specific dependency named.

## Gate 1 — `WEBUI_CARD_ENTRY_CONDITIONS` is duplicated

The webui round could not import the constant from the overlay build, so it
mirrored the six condition strings character-for-character, pinned their content
in a test, and left a note to delete the copy once the pin carries the export.
That was the right call under the constraint.

It is still the duplicated-constant drift class: two copies of a security-
relevant list, one of which can quietly fall behind.

**Gate:** when the SDK pin carries `./platform/payments`, delete the webui copy
and import `WEBUI_CARD_ENTRY_CONDITIONS` from the SDK.

**Drift risk closed early (2026-07-28):** `payments-cards.test.ts` now asserts
the mirrored copy equals the SDK's exported constant whenever that export is
resolvable, and skips against a published pin rather than failing. Proved by
mutation — changing one character in the mirror fails it. So the two cannot
diverge silently while the gate remains open; what is still outstanding is
deleting the copy.

## Gate 2 — the notice sanitizer is duplicated

`platform/security/notice-text.ts` (this branch) and
`platform/email/inbound-notice.ts` (branch `inbound-email-config`, commit
`140cbcb4`) carry behaviourally identical markup-neutralisation and
mention-breaking. Mine is deliberately identical so the two can collapse.

**Gate:** when `inbound-email-config` merges, collapse both onto
`security/notice-text.ts` and delete the private copy. Two copies of a security
escaper is how one of them falls behind — and this one guards a message that
authorises a charge.

## Gate 3 — the overlay artifact is from the wrong era

The webui round's `node_modules` overlay was built from SDK `4b3953c4`, the
**pre-correction** commit where `'webui'` was in `CARD_ENTRY_SURFACES` because of
a fabricated attribution rather than because the owner had ruled.

The value is identical to the post-ruling one, so behaviour is correct — but the
artifact predates the correction and the ruling that replaced it. That round
deliberately did not re-link, because re-linking can write into an active SDK
worktree; correct call given the shared-tree hazard.

**Gate — DONE (2026-07-28).** Overlay refreshed from `wo/payments-spec@7c6fe559`
(clean tree) into the webui worktree, replacing the `4b3953c4` artifact. Verified
afterwards: the export is present, the allowlist still resolves `'webui'`, and
the suite is 2168 pass / 0 fail. The SDK worktree was idle and stayed clean
through the link.

The TUI and agent worktrees still hold `file:` tarball links built earlier in the
round and should be refreshed the same way before their gates are trusted.

## Why these are gates and not cleanups

Each one is a place where the shipped artifact and the source of record disagree.
That is tolerable inside a round and not tolerable across a release, because the
disagreement is invisible from the consumer side: an imported constant and a
mirrored one look identical at the call site, and an overlay built from the wrong
commit produces correct behaviour right up until it does not.
