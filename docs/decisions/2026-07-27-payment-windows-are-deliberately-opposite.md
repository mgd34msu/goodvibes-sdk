# The two payment windows are deliberately opposite

**Date:** 2026-07-27
**Status:** Accepted (owner rulings)
**Applies to:** the payment capability, `docs/payments.md` §8

## Note for whoever finds these and wants to unify them

You have found two timed prompts that look like near-duplicates of each other and
of `ApprovalBroker`. Merging them into one primitive would be a natural cleanup
and it would be a serious defect. Here is the reasoning, so you do not have to
reconstruct it from a diff.

**Above budget, an approval. Silence means DENIED.**

> "if i didn't want the approval to expire, I should have just increased the
> limit... puts it directly in the human's hands, never lets automated spending
> happen"

**Within budget, a veto. Silence means PROCEEDS.**

Ten minutes by default, fired once the final total is known and before payment.
One word cancels.

The two are not variants of one behaviour with a different default. They answer
different questions. The approval asks *may this happen at all*, and an
unanswered question about money above the limit must resolve to no. The veto
announces *this is about to happen*, and an unanswered announcement about money
inside a limit the owner already set must resolve to yes, otherwise the limit he
set does nothing and every purchase is an approval.

Collapsing them means picking one silence rule for both. Either every
above-budget purchase starts going through unattended, or every in-budget
purchase stalls waiting for a human, and the second one gets "fixed" by flipping
the default, which produces the first one.

## How the asymmetry is defended in code

- `SilenceMeaning = 'denied' | 'proceeds'`, with `APPROVAL_GATE` and
  `VETO_WINDOW` as separate constants carrying separate values.
- A test named *the two windows must never agree* asserts both values
  individually and asserts they differ.
- Two separate state machine functions. There is deliberately no shared
  `openTimedPrompt()`, the duplication is load-bearing.

## The other rulings that travel with them

- **Undeliverable notification**: above budget refuses, within budget proceeds.
  The full decision order, including the shipping ladder that is always attempted
  before an overage refusal, is in `docs/payments.md` §6.
- **Command authority**: these prompts arrive over the TUI, the agent terminal,
  or a channel like Telegram. **Never email, permanently.**
- **Presence is not attention.** The window runs its full duration wherever he
  is. Only an explicit acknowledgement short-circuits it; no focus, idle or
  activity signal touches it.

  > "this is for situations where the user is multitasking and doesn't look at
  > the specific terminal session for an extended period of time"

## Where it lives

- `docs/payments.md`, the full design
- `platform/payments/windows.ts`, the two state machines and the two constants
