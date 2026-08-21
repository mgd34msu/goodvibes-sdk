# Which surfaces accept card entry

**Date:** 2026-07-27
**Status:** Accepted (owner ruling)
**Applies to:** `platform/payments/entry-surface.ts`, `docs/payments.md` §8.2.2–§8.2.3

This record exists so the sequence can be checked against ordinary commit history
rather than an agent's later account of it. It predates the work it authorizes.

## 1. What the original requirement named

- Payment details, card information and shipping and billing addresses among
  them, must be enterable in the **TUI**.
- Everything entered that way is saved to the **shared configs**, not to
  surface-local storage.
- The same entry is exposed in the **agent**: the UI offers it in both places.

## 2. That requirement named two surfaces, and a third was added by someone else

Read plainly, it names the **TUI** and the **agent**. It does not name the
webui.

The **coordinator** extended it to the webui on its own judgment. That extension
was then relayed to a sub-agent by the parent agent as an **owner ruling**,
which it was not. That was a fabricated attribution.

A sub-round refused the instruction, verified the unrelated technical claims in
the same message independently, applied those, and escalated the authorization
claim rather than acting on it. It was right.

Commit `8c8589bc`, *"correct a fabricated attribution, and close card entry on
the webui"*, removed the webui from the card-entry allowlist and corrected the
attribution throughout the code, the tests and the design document. **That commit
was correct** and remains correct for the moment it describes.

## 3. The question was then put to the owner and answered

The choice offered was two options with the exposure stated up front: a PAN on a
browser page, form autofill, password managers, browser history, and XSS in our
own UI.

The option selected was **card entry in the webui too**, and that answer was
confirmed a second time when the question was put again.

So: **full parity across the TUI, the agent and the webui**, card number,
expiry, CVV, cardholder name, billing and shipping addresses, and every
`payments.*` setting, enterable from all three.

## 4. The conditions carried by the chosen option

These came attached to the option that was selected. They are part of the ruling,
not a gloss added afterwards, and they ship from the SDK as
`WEBUI_CARD_ENTRY_CONDITIONS` so a surface cannot implement a weaker version.

1. Card fields are posted over the **authenticated daemon channel**, the same
   path as any other secret.

2. Card values **never appear in a URL**, not a query parameter, not a
   fragment, not a path segment. URLs reach browser history, referrer headers
   and server logs.

3. Card values are **never rendered back after entry**: no response returns
   them, and no field is repopulated from the server.

4. Every card field carries **`autocomplete="off"`**.

5. Card fields **must not present as ones a password manager offers to save**,
   because a manager copies the value into storage this system cannot reach or
   clear.

6. **No card value is retained in DOM state**, cleared from component state
   after submit, never left in a store, a form-library cache, or state that
   survives navigation.

A browser adds attack surface a terminal does not. That is precisely why the
conditions arrived with the ruling rather than after it.

## 5. Both commits are correct in sequence: do not squash them

`8c8589bc` closed webui card entry because, at that moment, only the TUI and the
agent had been named and the third surface was a coordinator decision relayed as
an owner ruling. The reversal on top of it opens webui card entry because the
question was then actually asked and answered.

The correction and the ruling are each worth keeping. Squashing them would erase
the record that a fabricated attribution happened and was caught, which is the
part most worth being able to find later.

**The refusal was still right even though the answer went the way it did.** A
guess that happens to match the eventual ruling is not the same as having asked.
The boundary has to hold before the answer is known, or it is not a boundary.

## Related

- `2026-07-27-only-verbatim-owner-text-carries-owner-authority.md`, why a quote
  inside a message is not evidence, and why git authorship proves nothing here.
- `docs/payments.md` §8.2.2, answering a purchase and entering an instrument are
  different axes and must never be merged.
