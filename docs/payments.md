# Payments — design

**Status:** implemented. This document is the design of record.
**Owner rulings recorded here are settled.** Choices made under zero-deferrals
where the owner had not ruled are listed in §12.1 as rulings taken, with their
reasoning, so they can be overturned deliberately rather than discovered.

A card turns a successful prompt injection from "sends an email" into "buys
something". The platform has just spent a round hardening against exactly that
(`docs/decisions/2026-07-27-daemon-refuses-derived-sends.md`), and this
capability is the one place where that hardening has to hold with money on the
other side of it. Read the security section before the feature sections.

---

## 1. Where it lives

The SDK owns the capability, the daemon serves it, surfaces are wiring and UI
only. Owner's framing:

> "the agent, the tui, the webui, those all exist as a means to expose different
> parts of the SDK to a user interface"

> "the daemon needs all of the abilities"

Concretely:

| Layer | Owns |
|---|---|
| `packages/sdk/src/platform/payments/*` | Budget arithmetic, the decision order, both window state machines, the shipping ladder, message rendering, the audit ledger, the taint gate. All pure and injectable. |
| `packages/sdk/src/platform/control-plane/` (`method-catalog-payments.ts`, `routes/payments.ts`) | The `payments.*` operator methods the daemon serves. |
| `packages/sdk/src/platform/config/schema-domain-payments.ts` | The config schema, defaults, validation. |
| TUI / agent / webui | Settings forms, the approval and veto prompts, the purchase list. No decision logic. |

Card material and settings live in the **daemon-owned** config and secret tiers,
so any surface can enter them and the daemon can use them with every surface
closed and across restarts.

---

## 2. What the owner enters

Card number, expiry, CVV, billing address, shipping address, and budget settings.

### 2.1 Virtual cards are the recommended configuration

**Recommendation (not a blocker):** configure a virtual card — an issuer-minted
number with a hard spend cap set at the issuer — rather than the real card.

The reason is where the limit lives. A budget enforced by this software is
enforced by code that a bug, a misconfiguration or a successful injection can
get past. A cap set at the issuer is enforced by the issuer: it holds when the
daemon is wrong, when it is compromised, and when it is not running at all. And
the blast radius of a leaked virtual number is one card that can be killed in an
app, not the card the owner's rent comes out of.

So the design supports both, prefers one:

- `payments.cards[].kind: 'virtual' | 'real'`
- A virtual card records `issuerCapCents` and `issuerCapWindow` as **declared**
  facts — the daemon cannot verify them, so they are shown to the owner as "you
  told us this" and never treated as an enforcement layer of ours.
- Configuring a `real` card surfaces the recommendation once, records the
  acknowledgement, and proceeds. It is not blocked.

---

## 3. Storage tiers

### 3.1 Secret tier — card material

Card material goes to `SecretsManager`
(`packages/sdk/src/platform/config/secrets.ts`), daemon scope, secure medium.
Encrypted at rest with AES-256-GCM under a random 32-byte keyfile
(`~/.goodvibes/secrets.key`, 0600 in a 0700 directory), never a key derived from
hostname or username.

Secret key names are **derived, never hand-picked**, via
`daemonSecretKeyFor(configPath)` in
`packages/sdk/src/platform/config/daemon-secret-keys.ts`. Adding `payments.` to
`DAEMON_OWNED_CONFIG_PREFIXES` (`config/config-ownership.ts`) makes
`resolveSecretWriteScope` force every payment secret into the daemon tier
regardless of what scope a caller asks for:

| Config path | Derived secret key |
|---|---|
| `payments.cards.<cardId>.pan` | `GOODVIBES_PAYMENTS_CARDS_<CARDID>_PAN` |
| `payments.cards.<cardId>.expiry` | `GOODVIBES_PAYMENTS_CARDS_<CARDID>_EXPIRY` |
| `payments.cards.<cardId>.cvv` | `GOODVIBES_PAYMENTS_CARDS_<CARDID>_CVV` |
| `payments.cards.<cardId>.cardholderName` | `GOODVIBES_PAYMENTS_CARDS_<CARDID>_CARDHOLDERNAME` |

**These are write-only across every wire.** There is no operator method that
returns them, no log line that contains them, and no error message that echoes
them. Read-back for surfaces goes through the existing secret-free status
adapter pattern — `createCredentialStatusProvider()` in
`config/credential-status.ts`, which returns
`{ configured, usable, source, scope, secure, overriddenByEnv }` and never a
value. `payments.cards.list` returns metadata only: `id`, `label`, `brand`,
`last4`, `kind`, `expiryMonth`/`expiryYear` (needed to warn on expiry),
`issuerCapCents`, `addedAt`.

`payments.card.status` (per card) reports whether each required field is present
without revealing any of them, so a surface can render "CVV not set" without the
daemon ever emitting one.

### 3.2 Config tier — settings

Daemon-owned config, following the `atRest.*` worked example exactly: a
`PaymentsConfig` interface in `schema-types-platform.ts`, `paymentsConfigDefaults`
and `paymentsConfigSettings` in a new `schema-domain-payments.ts`, both wired
into `schema.ts`, and `'payments.'` added to `DAEMON_OWNED_CONFIG_PREFIXES`.
Persisted to the daemon tier (`~/.goodvibes/daemon/settings.json`) through
`ConfigManager.set()` → `persistDaemonKey`.

```ts
interface PaymentsConfig {
  /** Master switch. Nothing in this capability runs while false. */
  enabled: boolean;                         // default false

  defaultCardId: string;                    // default ''

  billingAddress: PostalAddress;            // default: all fields ''
  shippingAddress: PostalAddress;           // default: all fields ''

  budget: {
    /** The item price is checked against this. Minor units. */
    dailyItemCents: number;                 // default 0
    /** Unavoidable charges only: tax, mandatory fees, delivery. Minor units. */
    dailyOverageCents: number;              // default 0
    perPurchaseCeiling: {
      enabled: boolean;                     // default TRUE  (owner ruling)
      cents: number;                        // default 0
    };
    overageTolerance: {
      enabled: boolean;                     // default FALSE (owner ruling)
      dailyAllowanceCents: number;          // default 0
    };
  };

  shipping: {
    preferredTier: 'normal' | 'fast' | 'fastest';   // default 'normal'
  };

  windows: {
    /** Within budget. Silence PROCEEDS. */
    vetoMinutes: number;                    // default 10 (owner ruling)
    /** Above budget. Silence DENIES. */
    approvalMinutes: number;                // default 60 (ruled)
  };

  /** Ordered. Email is not expressible here; see §8.2. */
  notifyChannels: readonly CommandAuthorityChannel[];   // default []

  cvvHandling: 'stored' | 'prompt';         // default 'stored' (ruled) — see §9.5
}
```

Card metadata (`payments.cards[]`: id, label, brand, last4, kind, issuer cap)
lives in config; card material lives in secrets. The two are joined by `cardId`.

**Every money default is `0`, and `enabled` defaults to `false`.** Owner's rule
for defaults here:

> "default to most safe, the user can change affirmatively"

Zero is the most safe number: the capability is fully configured and still buys
nothing until he affirmatively sets an amount. A refusal against a zero budget
reads "the daily item budget is 0 — set one" rather than failing obscurely.

**Note on the billing address.** It sits in config rather than in the secret
store because surfaces must display and edit it, and it is not card material.
It is worth saying plainly that a billing address beside a card number is what an
address-verification check tests, so anyone who can read both the daemon config
tier and the secret store has a complete card-not-present kit. The mitigations
are the ones in §9.5, and the virtual-card recommendation is the strongest of
them.

### 3.3 Paths

All payment state resolves through the formalized surface-root mechanism in
`platform/runtime/surface-root.ts` (`resolveSharedDirectory`,
`resolveSurfaceDirectory`, `requireSurfaceRoot`) — no hand-built paths.

| State | Location |
|---|---|
| Settings | daemon tier `~/.goodvibes/daemon/settings.json` |
| Card material | daemon secret store `~/.goodvibes/daemon/secrets.enc` |
| Spend ledger | `~/.goodvibes/daemon/payments/spend.jsonl` |
| Audit ledger | `~/.goodvibes/daemon/payments/audit.jsonl` |
| Pending windows | `~/.goodvibes/daemon/payments/pending.json` |

---

## 4. Timezone and the day boundary

**The daemon has no timezone concept today.** Searched: no global timezone or
locale config key exists; the only IANA timezone strings in the SDK are
per-schedule fields in `platform/scheduler/scheduler.ts` and
`platform/automation/schedules.ts`, and `device.location.*` is a paired-phone
GPS permission, unrelated. This capability adds the first one.

### 4.1 The setting

A **general** daemon setting, not a payments-specific one, because the next
feature that needs a calendar day should not add a second:

```
daemon.timezone: string   // IANA name, default '' meaning UTC
```

Validated with the predicate already proven in `scheduler.ts`:

```ts
try { Intl.DateTimeFormat(undefined, { timeZone: tz }); } catch { /* reject */ }
```

lifted into a reusable `ianaTimezone()` validator in `config/schema-shared.ts`
alongside `intRange`/`numRange`/`port`, so other domains can take it.

Surfaced in the config UI as a timezone picker, not a free-text field.

### 4.2 The day key

```ts
function dayKey(atMs: number, timezone: string): string   // 'YYYY-MM-DD'
```

computed with `Intl.DateTimeFormat` `formatToParts` in the configured zone, or
UTC when unset. Both the spend ledger and the reset are keyed by this string.

**Reset is the calendar day in the daemon's location, UTC when unset.** The
owner accepts the midnight split explicitly: $100 at 23:59 and $100 at 00:00
both go through, and that is tested rather than treated as an edge case to
smooth over.

### 4.3 Changing the timezone does not refill the pools

Every spend record stores its UTC timestamp. Today's totals are **recomputed**
from those timestamps under the current zone rather than carried as a running
counter. Without that, changing the timezone would roll the day over and hand
back a fresh budget — a trivial way around the limit, reachable by anything that
can write daemon config. Timezone changes are recorded in the audit ledger.

---

## 5. Budgets and pools

Three pools, all keyed by day:

| Pool | Covers | Config |
|---|---|---|
| **Item** | The item price. | `budget.dailyItemCents` |
| **Overage** | Only charges that cannot be avoided on an approved purchase: sales tax, mandatory handling or booking fees, and the delivery option actually used. | `budget.dailyOverageCents` |
| **Tolerance** | The shortfall when the overage pool cannot cover even the cheapest delivery — only when `overageTolerance.enabled`. | `budget.overageTolerance.dailyAllowanceCents` |

**What the overage pool does not cover:** expedited shipping beyond what the
ladder in §7 selects, shipping insurance, gift wrap, extended warranties,
priority handling, and anything else offered as an option. Those are purchase
decisions, not delivery costs. A purchase that includes one is treated as an item
price change and re-enters the decision order at step 1.

**Per-purchase ceiling** (`perPurchaseCeiling.enabled`, default **on**) caps a
single purchase's item price independently of what remains in the daily pool. It
is a separate question from the daily budget and both must pass.

**Overage tolerance** (default **off**) ships as a real configurable feature
rather than a bare switch: enabling it without setting
`dailyAllowanceCents` changes nothing, because the allowance is still 0.

### 5.1 Reservations — two concurrent purchases must not both fit

Pools are drawn against by **reserve-then-commit**, not by checking a total at
decision time and charging later. Two purchases evaluated concurrently could each
individually fit the remaining budget and together exceed it; a reservation
closes that.

```ts
interface BudgetReservation {
  readonly id: string;              // the purchaseId
  readonly dayKey: string;
  readonly itemCents: number;
  readonly overageCents: number;
  readonly toleranceCents: number;
  readonly createdAtMs: number;     // UTC
  readonly expiresAtMs: number;
}
```

Taken when the decision order reaches step 3, held across the window, and either
**committed** (charge succeeded) or **released** (vetoed, denied, refused,
charge failed, expired). **On a cluster, exactly one node may act.** `payments.*` config replicates to
every opted-in node (`cluster/config-replication-policy.ts`) so a node that takes
over a handover has the owner's real limits rather than defaults. Today's SPEND
does not replicate — it lives in the payments spend ledger, which is not config —
so a second node acting would start from a clean daily budget and could spend the
day twice. Until the ledger itself replicates, `checkPaymentGates` refuses on any
node that is not the elected payments leader, and `isPaymentsLeader` is a
required input with no default so a caller cannot omit it into a pass.

Reservations are persisted so a daemon restart does not
release money that is mid-flight, and — per the platform rule that anything
persisted across restarts reaps, bounds, validates by content, sweeps
periodically and discloses — they are swept on a timer, capped in count, dropped
when they fail content validation, and the sweep's actions appear in the audit
ledger rather than happening silently.

---

## 6. The decision order

This is the whole capability. It is written once, in
`platform/payments/decide.ts`, as a pure function over a snapshot, so it is
testable without a browser, a card or a clock.

```
0.  GATES  (any failure is terminal — no approval path, no downgrade path)
    0a. payments.enabled, a card configured, a shipping address configured
    0b. TAINT: does the purchase INTENT derive from untrusted content?   → REFUSE
    0c. LINK: did the checkout URL arrive from untrusted content?
        → full link validation against the owner-named merchant, or REFUSE
    0d. The request came from a surface with command authority

1.  ITEM PRICE vs DAILY ITEM BUDGET  (and the per-purchase ceiling if enabled)
    ├─ over  →  ABOVE BUDGET: explicit approval required
    │           ├─ notification undeliverable   →  REFUSE          (owner ruling)
    │           ├─ silence / window expiry      →  DENIED          (owner ruling)
    │           ├─ explicit deny                →  DENIED
    │           └─ explicit approve             →  continue to 2
    └─ within →  continue to 2

2.  UNAVOIDABLE CHARGES + PREFERRED SHIPPING TIER vs OVERAGE POOL
    tax + mandatory fees + shipping(tier)
    ├─ fits at the preferred tier      →  continue to 3
    └─ exceeds  →  SHIPPING LADDER: step down ONE tier at a time
        ├─ a lower tier fits  →  record the step-down, surface it, continue to 3
        └─ nothing fits even at the cheapest
            ├─ overageTolerance enabled and the shortfall fits the allowance
            │                                  →  draw tolerance, record, continue to 3
            └─ otherwise                       →  REFUSE           (owner ruling)

3.  RESERVE the pools

4.  WITHIN BUDGET → VETO WINDOW  (silence PROCEEDS)
    Fired once the final total is known and before payment.
    ├─ silence for windows.vetoMinutes  →  PROCEED
    ├─ explicit acknowledgement         →  PROCEED immediately
    ├─ objection                        →  CANCEL, release, and REPORT
    └─ undeliverable                    →  PROCEED  (owner ruling: under/at
                                           budget items get through)

    Above budget purchases do NOT get a second window: the approval in step 1 is
    itself fired at this same point, with the final total in it (§8.4).

5.  PAY  → 3-D Secure / SCA / CAPTCHA pause handling (§9.6)
6.  COMMIT the reservation, write the audit record
```

**The ladder is always attempted before an overage refusal.** Owner's ruling in
his words:

> "if the notification can't be delivered, under/at budget items get through
> while over budget items do not. however, if it is over budget due to busting
> the overage budget, attempt to downgrade things like shipping. if no downgrade
> is possible, the overbudget item does not go though."

**Note what step 2 does not do:** it does not escalate an exhausted overage pool
to an approval request. The ruling says refuse. An approval-instead-of-refuse
variant was considered and not chosen because the ruling is explicit; it is
listed in Open items only so a later reader knows it was ruled on rather than
overlooked.

---

## 7. Shipping

`shipping.preferredTier: 'normal' | 'fast' | 'fastest'` is **ordinal against what
the checkout actually offers**, not against delivery-day promises. A merchant
offering three options gets them ranked cheapest-first and the preference indexes
into that ranking; a merchant offering two collapses `fast` and `fastest` onto
the same option; a merchant offering one leaves nothing to choose.

The chosen tier's cost draws on the overage pool. When the pool cannot cover it,
**step down one tier at a time until it fits, stopping at the cheapest.** Never
jump straight to the cheapest — the owner asked for one step at a time, and the
difference is real when three tiers cost $15 / $9 / $5 and $9 fits.

A step-down needs no approval, because it is within budget. It is **recorded in
the audit ledger and surfaced in the veto message and the receipt**, because he
must not learn about it from a late package.

**Never add filler items to cross a free-shipping threshold.** This is an
invariant, not a preference: the checkout driver has no verb that adds a line the
owner did not ask for, and `assertCartMatchesRequest` compares the cart's lines
against the request immediately before payment and aborts on any extra line.
There is no free-shipping-threshold logic anywhere in the capability, and its
absence is asserted by a test that greps the payments module for it — the point
being that a later "helpful" addition fails a test rather than shipping.

---

## 8. The two windows

They are **deliberately opposite and must stay that way.**

| | Above budget | Within budget |
|---|---|---|
| What it is | An **approval**. | A **veto**. |
| Silence means | **DENIED** | **PROCEEDS** |
| Undeliverable means | **REFUSE** | **PROCEED** |
| Explicit "yes" | Required to proceed | Short-circuits the wait |
| Explicit "no" | Denies | Cancels and reports |
| Default duration | `windows.approvalMinutes` = 60 | `windows.vetoMinutes` = 10 |

**Why the approval window is an hour.** Denial is the recoverable outcome — he
re-asks and it goes through — so the cost of too-short is friction and the cost
of too-long is a cart holding a price that may drift. An hour survives a meeting
or a commute. It is configurable, and someone who is away for long stretches
should raise it.

Owner's reasoning for the approval side:

> "if i didn't want the approval to expire, I should have just increased the
> limit... puts it directly in the human's hands, never lets automated spending
> happen"

### 8.0 The two state machines

Separate types, separate transition functions, separate terminal sets. Every
terminal state maps to exactly one budget action (`commit` or `release`), so a
window can never end without settling its reservation.

**Approval gate — above budget.**

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
  pending-dispatch ─┼─ dispatch fails on every channel ──▶ denied-undeliverable
                    │                                          │  (release)
                    └─ dispatched ──▶ awaiting-approval        │
                                            │                  │
                     explicit approve ──────┼──▶ approved      │  (hold → pay)
                     explicit deny ─────────┼──▶ denied-explicit  (release)
                     deadline reached ──────┼──▶ denied-timeout   (release)
                     restart past deadline ─┼──▶ denied-timeout   (release, §8.6)
                     total changed ─────────┴──▶ void → re-enter §6 step 1
```

Terminal: `approved`, `denied-explicit`, `denied-timeout`,
`denied-undeliverable`, `void`.
**Every non-`approved` terminal releases.** `silenceMeans: 'denied'`.

**Veto window — within budget.**

```
  pending-dispatch ─┬─ dispatch fails on every channel ──▶ proceeding-undelivered
                    │                                       (commit — owner ruling:
                    │                                        under/at budget gets through)
                    └─ dispatched ──▶ open
                                        │
                     acknowledgement ───┼──▶ proceeding-acknowledged  (commit, immediately)
                     deadline reached ──┼──▶ proceeding-silent        (commit)
                     objection ─────────┼──▶ cancelled                (release + report, §8.5)
                     restart, delivered,┤
                     backfill clean ────┼──▶ proceeding-silent        (commit, §8.6.1)
                     restart, delivered,┤
                     objection in       │
                     backfill ──────────┼──▶ cancelled                (release + report)
                     restart, channel   ┤
                     un-backfillable ───┴──▶ open (that channel only, §8.6.1)
                     total changed ─────────▶ void → re-enter §6 step 1
```

Terminal: `proceeding-undelivered`, `proceeding-acknowledged`,
`proceeding-silent`, `cancelled`, `void`.
**Every `proceeding-*` terminal commits; `cancelled` and `void` release.**
`silenceMeans: 'proceeds'`.

Note the mirror: the approval's undeliverable edge is terminal-and-releasing, the
veto's undeliverable edge is terminal-and-committing. That single pair of edges
is the owner's undeliverable ruling in its entirety, and it is the pair a
unification would flatten.

### 8.1 Guarding the asymmetry

A later round will be tempted to "harmonize" these into one timed-prompt
primitive. That would silently convert every above-budget denial into an
above-budget purchase. The asymmetry is therefore made structural rather than
incidental:

```ts
/** What happens when the window closes with no answer. The two windows must
 *  never share a value. See docs/payments.md §8. */
export type SilenceMeaning = 'denied' | 'proceeds';

export const APPROVAL_GATE = { kind: 'approval', silenceMeans: 'denied'   } as const;
export const VETO_WINDOW   = { kind: 'veto',     silenceMeans: 'proceeds' } as const;
```

- Both constants carry a comment pointing here.
- A test named *the two windows must never agree* asserts
  `APPROVAL_GATE.silenceMeans !== VETO_WINDOW.silenceMeans`, and asserts each
  value individually so a change to either fails with a message naming the
  ruling.
- The two state machines are separate functions. There is no shared
  `openTimedPrompt()` they both call — the duplication is the point.

### 8.2 Delivery is restricted to command-authority surfaces

Approval and veto arrive only over the TUI, the agent terminal, or a channel like
Telegram. **Never email, permanently.**

There is no single command-authority enum in the platform today. There are two
separate mechanisms, deliberately not unified, and this capability uses both:

1. **Content trust** — `platform/security/untrusted-content.ts`:
   `surfaceHasCommandAuthority(surface)` is true only for `'owner-direct'`.
   Note that at this layer `'channel-message'` is *untrusted*, exactly like
   `'email'`. That is about whether text just read can direct the runtime, not
   about whether a human on that channel can answer a question we asked.
2. **Channel identity resolving a pending ask** —
   `platform/daemon/approval-reply.ts`: `parseApprovalReplyVerb(text)` and
   `tryResolveApprovalReplyFromChannel(...)`, gated on
   `ChannelPolicyRecord.allowlistUserIds` (`platform/channels/types.ts`). This is
   what lets the owner reply "approve" in Telegram and have it resolve a broker
   record. It only answers an ask we already raised; it can never manufacture a
   new instruction from channel content.

**Email's exclusion is already structural, not a policy check.** `'email'` is not
a member of `ChannelSurface` (`platform/channels/types.ts`) and not a member of
`SurfaceKind` (`ROUTE_SURFACE_KINDS ∪ PRODUCT_SURFACE_KINDS`, `events/surfaces.ts`).
Email has no `ChannelDeliveryStrategy` at all, and
`verification-expectations.ts` states it outright: *"Email is an input-only
surface with NO command authority."* So the requirement is met by **not wiring
email in**, and the design must never add an email strategy for these prompts.

Belt and braces on top of that structural fact:

```ts
export type CommandAuthorityChannel = 'tui' | 'agent-terminal' | 'telegram';
```

Email is not a member, so routing a payment prompt to it is a compile error.
Config-supplied channel names are parsed into this union and unknown values are
**rejected, not ignored**. A test asserts `'email'` never parses.

### 8.2.2 Answering is not entering — and these must never be merged

Two channel rules live side by side and look similar enough that a later reader
will try to unify them. They answer different questions.

**Attribution, stated precisely**, because an earlier draft of this section got
it wrong and relayed a coordinator decision as an owner ruling:

> **Owner, verbatim, on entry surfaces:**
> *"i need to be able to enter payment details (card info and shipping/billing
> address etc) in the tui too"*
> *"and in the agent - basically ui should expose it in both."*

He named the **TUI and the agent**. He did **not** name the webui. Whether a
card number may be typed into a browser page is a materially different exposure
from typing it at a terminal, and that question is open in front of him.

**Coordinator ruling:** that card details are refused on remote messaging
surfaces, with the reasoning below. Recorded as the coordinator's because no
verbatim owner wording exists for it.

| | Answering | Entering |
|---|---|---|
| The question | May this surface say yes or no to a purchase? | May card details be typed here? |
| Telegram and other live channels | **Yes** — owner's explicit ruling, and it stays | **No** |
| TUI, agent terminal | Yes | **Yes** — the two he named |
| The webui | Yes | **Not yet** — awaiting his ruling |
| Email | Never | Never |

**Remote channels have authority to decide about a purchase. They have no path
for entering the instrument.**

The reason entering is stricter is concrete. A card number typed into Telegram
is **stored on Telegram's servers, in message history nobody here controls or
can erase, and it travelled through their infrastructure before it reached
us**. The same is true of every hosted chat channel. Encryption at rest is
irrelevant to a value already copied somewhere else on its way in — the damage
is complete before any storage decision of ours applies.

An "approve" typed into the same chat carries no such residue: it is one word
about one purchase, it expires, and on its own it authorizes nothing.

**The prompt is itself the harm.** There is deliberately no card-entry flow that
can be started from a non-entry surface (`mayOfferCardEntryFlow`). Asking for a
card number where the answer cannot be accepted is an invitation to type it
there, and the invitation is what puts the number on someone else's server.
Refusing the answer afterwards is too late.

When card-shaped content does arrive on a remote channel anyway, it is refused
without being stored, without being logged, and **without being echoed** — the
refusal travels over the same channel that already stored the message, so
quoting the value, even masked, would write it there a second time. The reply
names the shape that matched, never the value, and tells him to delete the
message and treat the card as exposed.

Implemented in `platform/payments/entry-surface.ts`; asserted in
`test/payments-card-entry-surface.test.ts`, including a test that the refusal
text contains no four-digit run at all, and one that the webui is refused until
he rules.

### 8.2.1 Detecting "undeliverable"

Delivery goes through `ChannelDeliveryRouter.deliver()`
(`platform/channels/delivery-router.ts`), which returns `{ responseId? }` and has
no `ok` flag — **failure is a thrown error**, including `Unsupported channel
delivery target` when no strategy matches. So a bare `deliver()` is not enough to
answer "was this delivered", and the decision order depends on that answer.

The capability therefore uses the retry/classification layer that already exists:
`AutomationDeliveryManager` (`platform/automation/delivery-manager.ts`) with
`calculateRetryDelay`, `classifyDeliveryError` and the
`emitDeliveryQueued/Started/Succeeded/Failed` events. **Undeliverable means every
configured command-authority channel has exhausted its retries with a failure
event**, and that is the condition step 1 of the decision order branches on.

One nuance that matters for a headless daemon: **the TUI is not a delivery
strategy.** It renders in-process; there is no routed channel for it. So a daemon
running with no surface attached and only Telegram configured is undeliverable
the moment Telegram fails — which is exactly the case the owner's ruling is
about.

### 8.3 The window always runs, and presence is not attention

The window runs for its full configured duration regardless of where he is. An
explicit acknowledgement during it short-circuits to immediate; nothing else
does. In particular **no presence, focus, idle or activity signal shortens,
skips or extends it.** Owner's reasoning:

> "this is for situations where the user is multitasking and doesn't look at the
> specific terminal session for an extended period of time"

A test asserts the computed deadline is a function of the configured duration and
the start time only, by driving the same decision with every available
session-activity signal flipped and asserting an identical deadline.

### 8.4 The approval carries the final total

Both windows fire at the same point in the flow: once the final total is known
and before payment. That is what makes the number he approves the number that is
charged.

If the merchant re-prices between the answer and the charge, the answer is void:
the reservation is released and the purchase re-enters the decision order from
step 1 with the new total. An approval is for an amount, not for a cart.

### 8.5 An objection stops and reports

One word cancels. On cancellation the daemon stops before payment, releases the
reservation, deterministically abandons the checkout rather than leaving it half
driven, and **reports what it stopped** — merchant, total, item, and the state it
left the cart in. It never silently abandons a cart.

### 8.6 What each window is built on, and what happens across a restart

**The approval gate reuses `ApprovalBroker`**
(`platform/control-plane/approval-broker.ts`) as-is. It already implements
silence-denies exactly as ruled: `requestApproval({ timeoutMs })` →
`expireApproval()` → status `'expired'` → every waiter resolves
`{ approved: false }`. Its records persist through `PersistentStore`, it has a
`SharedApprovalStatus` lifecycle, and `tryResolveApprovalReplyFromChannel` can
already resolve one from Telegram.

**There is a restart gap in `ApprovalBroker` that this capability must not
inherit.** `start()` reloads persisted records but does **not** re-arm the
`setTimeout` for restored `pending`/`claimed` approvals — `pendingResolvers` is
in-memory and is rebuilt empty. A pending approval whose timer was mid-flight
across a daemon restart sits `'pending'` forever. For a payment that is not a
stale UI row, it is money in limbo. So:

- On daemon start, payment approvals are swept: any restored payment approval
  whose deadline has passed is resolved **denied** and its reservation released;
  any still inside its window is re-armed.
- A test drives a restart across the deadline and asserts the outcome is denied,
  not pending.

**The veto window is built new**, not on `ApprovalBroker`'s timer, because a
deadline that decides "proceed" must survive a crash. It uses a one-shot
automation job — `AutomationAtSchedule` (`{ kind: 'at', at }`) with
`deleteAfterRun: true` via `AutomationManager.createJob()`
(`platform/automation/schedules.ts`, `manager-runtime.ts`) — which is persisted
and reloaded.

### 8.6.1 A window interrupted by downtime is keyed on DELIVERY, not on uptime

**Silence means "he had the chance to object and did not."** Whether our process
was alive is irrelevant to whether he had that chance. An earlier draft of this
design keyed the restart rule on daemon uptime; that was wrong, and re-opening a
window unconditionally is wrong for a specific reason — it re-pings him about
something he deliberately ignored, and a system that repeats itself is one he
stops reading.

So the rule is keyed on whether the notification reached him:

| On restart | Rule |
|---|---|
| Notification **was delivered**, window expired during downtime | **The expiry stands.** Before charging, **backfill each live channel** for messages received while we were down and honour any objection found there. No objection → proceed. **Do not re-notify** — he already saw it. |
| Notification **was never delivered** | §6 governs unchanged: in-budget proceeds, above-budget refuses, and the shipping ladder is attempted before any overage refusal. |
| Channel **cannot be backfilled** for the downtime span | **Re-open the window on that channel only.** For that channel we cannot distinguish silence from an objection we dropped, and only that channel is ambiguous. |

Backfill uses each channel's existing history read. A channel that supports it
(Telegram) is queried for the downtime span before the reservation commits; a
channel with no readable history is treated as un-backfillable and re-opened.
The audit record names which channels were backfilled, which were re-opened, and
what was found.

The same reasoning applies to the approval gate, and lands in the same place by a
different route: an approval that expired resolves **denied** regardless, so a
dropped objection cannot cost money there. Backfill still runs, because an
explicit *approve* found in the backfill is worth honouring rather than making
him ask twice — but only inside the original window, never past it.

The pending state is bounded, content-validated, swept on a timer, and its
recoveries are disclosed rather than silent.

---

## 9. Security boundaries

### 9.1 A payment whose target, amount or item derives from untrusted content is refused outright

No owner-address exemption. No disclose-instead-of-refuse fallback. No approval
path around it. This is the one gate with no downstream branch at all.

Reuses the existing machinery unchanged:

- `platform/security/content-taint.ts` — `findContentTaint(fields, sources, options)`
- `platform/security/untrusted-content.ts` — the process ledger,
  `getProcessUntrustedContentLedger()`, `taintSourcesThisTurn()`
- `platform/security/turn-boundary.ts` — `startTurnForOwnerRequest()`, so "this
  turn" means what it says and automated work does not reset the window

**The payment path calls `findContentTaint` directly.** It does *not* call
`evaluateOutwardEffect`, because that function accepts an `OwnerApproval` that
allows a tainted action through (`untrusted-content.ts`, the
`input.approval && input.approval.action === input.request.action` branch). That
escape hatch is correct for email and wrong for money, and the way to be sure it
cannot be reached is to not be on that code path. A test asserts a payment is
still refused when a valid `OwnerApproval` for the same action is present.

**Which fields are checked, and which deliberately are not.**

Checked — the fields that decide *whether and where* money moves. These come
from the owner or they do not exist:

| Field | Test |
|---|---|
| `merchant` | exact containment (like a recipient address — short, high-signal) |
| `checkoutUrl` | exact containment |
| `item` | the length thresholds |
| `requestedMaxCents` | the length thresholds, when the request states a limit |

Not checked — the merchant's own quoted numbers:

> The price, tax, fees and shipping costs are **read from the merchant** by
> definition. Taint-checking them would refuse every purchase, and a check that
> is permanently tripped gets removed — the exact failure mode
> `content-taint.ts` was written to avoid. The defence for those numbers is not
> taint, it is the **budget**: a page that inflates a price hits the daily item
> budget or the per-purchase ceiling and needs an approval, and the approval
> shows our own re-rendered number (§9.3).

**A deliberate consequence:** "buy me the cheapest X you can find online" is
refused, because the merchant was chosen from page content rather than named by
the owner. The owner names the merchant, or there is no purchase. This is a
feature of the design and is tested as one.

### 9.2 Checkout URLs from untrusted content pass full link validation

Any checkout URL that arrived from untrusted content passes
`validateLinkTarget(rawUrl, authorizedDomain)` before anything is typed —
`platform/security/link-validation.ts`, with its generated public-suffix data
(`public-suffix.ts`). Redirect chains go through `followValidatedRedirects`, so a
link that lands correctly and then 302s away refuses the chain.

`authorizedDomain` is **the merchant the owner named**, which the gate in §9.1
has already established is not page-derived. That closes the loop: the domain we
validate against cannot itself have been chosen by an attacker.

The refusal reasons already distinguish userinfo tricks
(`https://shop.example@evil.example/pay`), non-https schemes, mixed-script
homographs, registrable-domain mismatches and shorteners, and each is reported
by name because a refused checkout is often something the owner finishes by hand.

### 9.3 Approval and veto messages are rendered from structured fields only

If page text can reach the message, an attacker writes what the owner reads on
his phone: *"Approve $12 for coffee?"* attached to a $1,200 order.

So the message is rendered from a closed struct of typed scalars, and there is no
field in it that can carry free text from a page:

```ts
interface PurchaseFacts {
  readonly merchantDomain: string;       // registrableDomain() of the VALIDATED url
  readonly item: OwnerSuppliedText;      // the owner's own words — branded type
  readonly itemMinorUnits: number;
  readonly taxMinorUnits: number;
  readonly feesMinorUnits: number;
  readonly shippingMinorUnits: number;
  readonly totalMinorUnits: number;
  readonly currency: CurrencyCode;       // validated ISO-4217
  readonly cardLast4: string;            // exactly 4 digits
  readonly shippingTier: ShippingTier;
  readonly stepDown: ShippingStepDown | null;
  readonly poolsAfter: PoolSnapshot;     // so a wrong number is visible against the budget
}
```

- **Merchant** is `registrableDomain(host)` computed from the validated URL —
  never the page's own claimed name, which is page text.
- **Item** is the owner's words from the requesting turn, carried in a branded
  `OwnerSuppliedText` that is only constructible from an `owner-direct` turn.
  Assigning page text to it is a compile error. (And if the item description
  only exists on the page, §9.1 has already refused the purchase.)
- **Amounts** are integer minor units parsed from the page and **re-rendered by
  our own formatter**. A page string never passes through. A value that does not
  parse to a plain integer, or that is negative, or whose currency is not a
  validated ISO-4217 code, refuses rather than rendering.
- The message shows the pools so an inflated total is visible next to the budget
  it is eating.

Tested adversarially: the same purchase is driven with injected content in every
page field the driver reads, and the rendered message must be byte-identical to
the clean run.

### 9.4 The audit ledger

Append-only JSONL following the existing
`platform/runtime/telemetry/exporters/local-ledger.ts` pattern — `appendFileSync`,
size-based rotation, retention through `at-rest-persistence.ts` and the
`atRest.*` config.

Every purchase records what, where, how much, which request caused it, and which
pool it drew on, in a form reconcilable against a card statement:

```ts
interface PurchaseAuditRecord {
  purchaseId: string;
  atUtc: string; dayKey: string; timezone: string;
  causedBy: { turnId: string; correlationId: string; surface: string; requestText: OwnerSuppliedText };
  merchantDomain: string; checkoutHost: string;
  item: OwnerSuppliedText;
  amounts: { itemMinorUnits, taxMinorUnits, feesMinorUnits, shippingMinorUnits, totalMinorUnits, currency };
  shipping: { requestedTier, usedTier, stepDown: ShippingStepDown | null };
  pools: { itemDrawCents, overageDrawCents, toleranceDrawCents };
  card: { cardId: string; last4: string; kind: 'virtual' | 'real' };
  decisionPath: readonly DecisionStep[];      // every branch of §6 that was taken
  window: { kind: 'approval' | 'veto' | 'none'; outcome; channelsTried; delivered: boolean };
  outcome: 'completed' | 'refused' | 'denied' | 'cancelled' | 'failed' | 'challenge-abandoned';
  refusalReason: string | null;
  merchantOrderId: string | null;
  authorizationLast4: string | null;
}
```

It never contains a PAN, a CVV, an expiry, or a full authorization code. A test
asserts the serialized record does not contain any configured card material.

### 9.5 The CVV is stored

**Settled by the owner, directly:**

> "we save the cvv, full stop. it is 100% needed for autonomous action."

This is not an open question and the code, the tests and this document do not
treat it as one. What follows is the plain statement of what is kept and what
that exposes — he is entitled to know that — not a hedge on the decision.

Autonomous action is the entire point of the capability. The veto window rules
that an in-budget purchase proceeds on silence, which means it completes with
nobody present. A purchase that pauses to ask a human for a verification code is
an attended purchase; removing the stored CVV would not make the feature safer,
it would make it not exist. See
`docs/decisions/2026-07-27-the-cvv-is-stored.md`.

**How it is held.** The CVV is written to the daemon secret store beside the card
number, AES-256-GCM at rest under `~/.goodvibes/secrets.key`, with
`require_secure` enforced for the payment namespace regardless of the global
`storage.secretPolicy`. It is held in memory only for the duration of a checkout
fill and overwritten after.

**What that exposes, without softening.** This is card verification data at rest,
which PCI DSS 3.2 prohibits storing after authorization for entities in its
scope. A personal daemon holding the owner's own CVV in his own encrypted store
is out of that scope, but not out of danger: anyone who can read
`~/.goodvibes/daemon/secrets.enc` **and** `~/.goodvibes/secrets.key` has the card
number, the expiry, the CVV and the billing address — everything a
card-not-present transaction needs, at any merchant, with no further access to
this machine. Filesystem permissions (0600/0700) and the encryption at rest
defend against a different user on the same host; neither defends against a
process running as the owner. Backups of the home directory carry the whole kit.

**A virtual card bounds that loss and a real card number does not.** This is
guidance about which instrument to provision, not a qualification of the ruling.
With a virtual card the worst case is one number carrying an issuer-enforced
ceiling, killable from an app in a minute. With the real card the worst case is
the card the rent comes out of, and nothing in this software can cap it — the
cap has to live at the issuer. §2.1 is the same argument and this is why it
matters most here.

**The containment requirements are the actual work**, and each is asserted by a
test rather than asserted in prose:

| Requirement | Test |
|---|---|
| Daemon secret tier, never the config file | the write goes through `resolveSecretWriteScope` and lands in the daemon scope |
| Encrypted at rest | the on-disk bytes do not contain the value |
| Never logged | every logger call site in the payments module is checked against the value |
| Never rendered on any surface | no operator method response contains it; `payments.cards.*` returns metadata only |
| Never echoed mid-edit | the settings editor masks it while typing, not only at rest (§10.2) |
| Excluded from every export, diagnostic dump and support bundle | a test that walks a real export payload and a real diagnostic dump and fails if the value appears anywhere in either |

That last row is the one that makes this decision safe to live with, so it is a
real test over real payloads rather than a smoke test.

**`payments.cvvHandling` still ships as a real setting**, defaulting to
`'stored'`. The alternative value `'prompt'` stores nothing and asks on every
purchase. Choosing it **disables unattended purchasing**, and the surface says so
at the moment of selection — `CVV_PROMPT_TRADEOFF_WARNING` in
`platform/payments/index.ts` is the shared string every surface renders — because
a trade-off that large belongs in front of whoever flips the switch, not buried
in a document.

### 9.6 3-D Secure, SCA and CAPTCHA pause cleanly

These pause and hand the owner the exact step, the way the Google console
walkthrough does. **Never loop, never guess, never half-complete an order.**

No CAPTCHA, 3-D Secure, SCA or OTP handling exists anywhere in the SDK today;
this is the first. The shape to copy is `platform/google/{types,console-flow,setup-flow}.ts`:
a discriminated step result carrying a `problem` (what is blocking) and a `fix`
(the exact thing the human must do), with the runner halting on `needs-human`
rather than improvising.

```ts
type CheckoutStepOutcome = 'done' | 'already-done' | 'needs-human' | 'failed';

interface ChallengeStep {
  readonly kind: '3ds' | 'sca' | 'otp' | 'captcha';
  readonly problem: string;          // OUR strings, not page text
  readonly fix: string;              // the exact control he must operate
  readonly url: string | null;       // validated by §9.2 before it is shown
  readonly expiresAtMs: number;
}
```

**Where this deliberately diverges from the Google pattern.** `runGoogleSetupFlow`
resumes by **re-running the whole flow from step 1**, relying on each step
reporting `already-done`. That is safe for console setup and **unsafe for a
checkout**: re-running a payment submission is how a single order becomes two
charges. So the checkout runner is re-entrant in the same shape but every step
that can move money is guarded by an **idempotency key and a live re-read of
order state at the merchant** before it will act. A step that cannot establish
whether it already completed reports `needs-human` and stops. Re-entrancy here
means "safe to call again", never "safe to submit again".

- The browser session is held open; the purchase state machine moves to
  `awaiting-challenge` and stops.
- The owner is notified over a command-authority channel with the exact step.
- No automated attempt is made at any challenge. A CAPTCHA is not solved, an OTP
  is not guessed, a 3-D Secure frame is not clicked through.
- On timeout the order is **abandoned cleanly**, the reservation is released, and
  the outcome is recorded as `challenge-abandoned`.
- Every purchase carries an idempotency key. Payment submission is never blindly
  retried; before any resubmission the daemon re-reads order state at the
  merchant. A half-complete order is reported, never "fixed" by trying again.

---

## 9.7 Three things this capability refuses on purpose

These are refusals by design, not gaps left for later. Each is implemented as an
explicit, named refusal with its own message — never a silent pass and never an
unhandled case that falls through to "proceed".

### 9.7.1 A checkout quoted in another currency

The budget is denominated in one currency. A merchant quoting another one is
**refused**, with a message naming both currencies.

The alternative is converting, and converting means picking a rate. Any rate we
pick is stale by the time the card is charged, because the issuer converts at
its own rate on its own date and adds its own fee. So a converted number shown
in an approval would be a number he did not approve — the exact defect §9.3
exists to prevent — and a budget check against it would be arithmetic on a
guess. Refusing is honest; converting is confident and wrong.

`CurrencyMismatch` carries the budget currency, the quoted currency, and the
suggestion to buy from a merchant that quotes in his currency or to raise it as
a purchase he makes himself.

### 9.7.2 A checkout that enrols a subscription or recurring charge

**Refused.** A daily budget cannot describe a charge that renews unattended next
month. Everything in this design — the pools, the reset, the veto window — is
built around one purchase happening once, and there is no mechanism here that
would notice a renewal, let alone stop one. Enrolling him in something that
charges again later, on a capability whose entire safety story is a daily limit,
would be the most expensive kind of silent hole.

Detection is deliberately conservative and errs toward refusing: recurring-billing
language in the order summary, a subscription line item, a trial-then-charge
term, or a stored-payment-method consent checkbox. A checkout it cannot classify
with confidence is refused rather than attempted — a false refusal costs him a
manual purchase, a false accept costs him a recurring charge nobody is watching.

### 9.7.3 Money coming back does not credit a pool

Refunds, cancellations and chargebacks are **recorded in the audit ledger and do
not credit any pool.**

Crediting would be surprising in the direction that spends money: a refund
landing on day 5 for something bought on day 1 would silently hand back day 5's
budget, so a returned item becomes permission to buy another one that day
without him deciding that. The pools are a rate limit on outward spending, not a
running balance of net worth.

They are still recorded, with the original `purchaseId`, because the ledger's job
is to reconcile against a card statement and a statement contains refunds. A
purchase whose money came back is marked as such and shown that way in the
purchase list.

---

## 10. Surface contract

Operator methods, following `docs/contract-regeneration-recipe.md` end to end
(catalog module → schema → route handler → DirectTransport surface →
`DIRECT_TRANSPORT_COVERAGE` entry → regenerate → gates). Verb tails conform to
the core-verb spec (`packages/contracts/src/core-verbs.ts`); `approve` and `deny`
are already in the `approval-and-routing` exempt category and `cancel` is a core
verb.

| Method | Access | Returns | Built |
|---|---|---|---|
| `payments.budget.status` | `read:payments` | Today's pools, remaining, `dayKey`, timezone, reservation count, whether this node may spend. | yes |
| `payments.cards.list` | `read:payments` | Metadata only: id, label, brand, last4, kind, expiry, declared issuer cap, `materialComplete`. | yes |
| `payments.cards.create` | admin, `write:payments` | Accepts card material; **returns metadata only**. | yes |
| `payments.cards.delete` | admin, `write:payments` | Deletes config metadata and every derived secret, reporting how many were cleared. | yes |
| `payments.purchases.list` | `read:payments` | Audit records. | yes |
| `payments.purchase.approve` / `.deny` | command-authority principal | Answers an above-budget gate. | not yet — the gate runs on `ApprovalBroker` today |
| `payments.purchase.cancel` | command-authority principal | Vetoes an in-budget purchase. | not yet |
| `payments.purchase.status` | `read:payments` | Live state machine position. | not yet |

Settings are not in this list on purpose: they are ordinary daemon-owned config
and travel the existing `config.get`/`config.set` path, which is what makes a
value entered in any surface apply to the daemon (§10.1).

The approve/deny/cancel verbs are the remaining wire work. The state machines,
the settlement rules and the recovery rules they will drive are built and tested
(`platform/payments/windows.ts`); what is missing is the operator methods that
let a surface answer over HTTP rather than through the broker directly.

Plus a `payments.purchase_update` gateway event so surfaces render a live window
rather than polling.

`approve`/`deny`/`cancel` additionally require that the calling principal arrived
over a command-authority surface — an authenticated operator session from the TUI
or agent, or a channel binding whose chat identity is the owner's. Email
principals do not exist for these methods.

**Surface work is UI only:** a payments settings section (budgets, toggles,
timezone picker, shipping preference, channel order), a card entry form that
posts to `payments.cards.create` through a masked input and never echoes or logs,
the approval and veto prompts, and a purchase list backed by the audit ledger.
No surface computes a budget, a ladder step, or a window outcome.

### 10.1 Settings do not go over the operator RPC

Worth stating because it is counter-intuitive: the TUI reads and writes config
through the **in-process `ConfigManager`**, not through `OperatorClient` or
`DirectTransport`. `ConfigManager` routes each key by ownership
(`config-ownership.ts`) to the client, user or **daemon** tier, and the daemon
tier is `~/.goodvibes/daemon/settings.json` — the same file the daemon process
reads. That is why adding `'payments.'` to `DAEMON_OWNED_CONFIG_PREFIXES` is
what makes a setting entered in the TUI apply to the daemon, with no RPC
involved. The webui, having no filesystem, does go over the wire —
`invokeOperator('config.set', { key, value })` in
`goodvibes-webui/src/lib/goodvibes.ts`.

Only the new `payments.*` verbs (purchases, budget status, approve/deny/cancel)
are operator methods, and each needs a `DIRECT_TRANSPORT_COVERAGE` decision in
`test/transport-parity.test.ts` — a real client method or an explicit
`'http-only'`. The gate fails until that decision is made, which is the point.

### 10.2 Settings rows come for free; card entry does not

`buildSettingGroups()` in
`goodvibes-tui/src/input/settings-modal-data.ts` walks `CONFIG_SCHEMA` and builds
a row for every key automatically, deriving the category from the first path
segment. So every scalar in `PaymentsConfig` gets a TUI row and a webui row with
no per-field UI code, and the daemon-owned note is appended automatically by
`daemon-owned-settings-descriptions.ts`.

Card material must **not** use that path. The settings modal's inline editor
echoes the raw edit buffer on screen — `currentSettingValue()` in
`goodvibes-tui/src/renderer/settings-modal.ts` does not special-case a secret key
while it is being edited, so `maskSecretValue()` only masks a value at rest.
Card entry therefore routes through the concealed-input composer
(`goodvibes-tui/src/input/concealed-input.ts`, `maskConcealedText`,
`beginConcealedInputFor`), following `input/provider-key-intake.ts` — which
already prompts "input is masked", keeps the plaintext out of input history and
the transcript, and hands it once to `secretsManager.set(...)`. The webui
equivalent already exists: the write-only `<input type="password">` branch in
`goodvibes-webui/src/components/settings/SettingsField.tsx`, where the stored
value is never round-tripped back into the field.

The TUI-side glue that turns a typed value into a `goodvibes://secrets/...`
reference plus a secret-store write is
`goodvibes-tui/src/config/secret-config.ts` (`buildSecretBackedConfigUpdate`,
`SECRET_CONFIG_KEYS`) and `input/settings-modal-secrets.ts`. The card keys are
added to `SECRET_CONFIG_KEYS`.

### 10.3 The agent terminal cannot answer a broker approval today

The owner ruled that approval and veto arrive over "the TUI, the agent terminal,
or a channel like Telegram". The TUI wires the shared `ApprovalBroker` into its
prompt card (`goodvibes-tui/src/permissions/broker-approval-card.ts`,
`handleBrokerApprovalChange`). **The agent has no equivalent** — its
`PermissionPromptUI` (`goodvibes-agent/src/permissions/prompt.ts`) is
local-foreground-only and imports no broker.

So satisfying the ruling requires porting the broker-approval card into the
agent, and that is Phase 2 scope rather than a pre-existing capability. It is
also the platform rule that a renderer change ports to the agent in the same
round.

### 10.4 Feature flag

The capability registers in the SDK's flag registry —
`platform/runtime/feature-flags/flags.ts` (`FEATURE_FLAGS`) plus a
`FEATURE_SETTINGS_BINDINGS` entry in `feature-settings.ts` binding it to
`payments.enabled`. The TUI and webui settings surfaces pick it up automatically
from `FEATURE_SETTINGS`; neither repo has a separate list.

It ships as a real configurable feature with an explicit default, not a bare
on/off: `defaultState: 'disabled'`, `runtimeToggleable`, and the settings it
gates are the budget and window fields in §3.2, each with its own stated default.

---

## 11. Test plan (adversarial, mandatory)

These are requirements on Phase 2, not suggestions:

1. A purchase whose **merchant** derives from injected content is refused.
2. A purchase whose **amount** derives from injected content is refused.
3. A purchase whose **item** derives from injected content is refused.
4. A tainted purchase is still refused **with a valid `OwnerApproval` present**.
5. An approval message **cannot be influenced by page text** — byte-identical
   rendering across every injected page field.
6. An above-budget purchase with an **undeliverable notification does not
   happen**.
7. An in-budget purchase with an **undeliverable notification does happen**.
8. Silence on an above-budget approval **denies**; silence on an in-budget veto
   **proceeds**; and the two constants are asserted never to agree.
9. The **shipping ladder steps down one tier at a time**, stops at the cheapest,
   and records the step-down in the audit record and the veto message.
10. **No filler item is ever added** — cart lines match the request at payment
    time, and no free-shipping-threshold logic exists in the module.
11. **The day boundary behaves as ruled**, including the midnight split: $100 at
    23:59 and $100 at 00:00 both go through, in the configured zone and in UTC
    when unset.
12. Changing the timezone **does not refill** a spent pool.
13. Two concurrent in-budget purchases cannot both draw the same remaining
    budget.
14. A checkout URL with userinfo, a homograph host, a shortener, or a redirect
    off the authorized registrable domain is refused, each by name.
15. A serialized audit record contains **no card material**.
16. A challenge pause never retries payment and never completes an order.
17. A payment approval whose deadline passes **while the daemon is down**
    resolves denied, not pending — the `ApprovalBroker` re-arm gap in §8.6.
18. A veto window that elapsed entirely while the daemon was down re-opens
    rather than auto-proceeding.
19. `'email'` never parses into `CommandAuthorityChannel`, and no payment prompt
    reaches an email path.
20. Card material entered at a surface never appears in input history, the
    transcript, a log line, or any operator response.

---

## 12. Rulings taken here, and what remains open

### 12.1 Ruled

Recorded so they are not re-litigated. Item 1 is the owner's own ruling and is
closed. The rest were taken under zero-deferrals where he had not ruled, and he
can overturn any of them; none is a coin toss left in the code.

1. **The CVV is stored (§9.5).** Owner ruling, stated directly: *"we save the
   cvv, full stop. it is 100% needed for autonomous action."* Settled and closed
   — see `docs/decisions/2026-07-27-the-cvv-is-stored.md`. `payments.cvvHandling`
   still ships as a real setting defaulting to `'stored'`; selecting `'prompt'`
   disables unattended purchasing and the surface says so at the moment of
   selection.
2. **`windows.approvalMinutes` defaults to 60 (§8).** Denial is the recoverable
   outcome, so too-short costs friction and too-long costs price drift on a held
   cart. An hour survives a meeting or a commute.
3. **A window interrupted by downtime is keyed on DELIVERY, not uptime
   (§8.6.1).** Silence means he had the chance to object and did not; whether our
   process was alive has nothing to do with it. Delivered-then-expired stands,
   with a backfill for objections we might have missed and no re-notification.
   Only an un-backfillable channel re-opens.
4. **Exhausted overage pool refuses rather than escalating to an approval
   (§6 step 2).** The ruling is explicit. Recorded so it is not re-opened by
   accident.
5. **Money defaults are 0 and `enabled` is false (§3.2).** Derived from "default
   to most safe". A freshly configured capability refuses everything until he
   sets amounts.
6. **Another currency, a subscription, and a refund credit are refusals by
   design (§9.7)** — each with its own named refusal and its own reasoning,
   not an unhandled case.
7. **Any configured command-authority channel may answer; first answer wins**,
   and the audit record names which one did. `notifyChannels` orders delivery,
   not the right to reply.

### 12.2 Still open

8. **`daemon.timezone` ownership (§4.1).** Built as a general daemon setting
   because payments should not own the platform's only clock. If another domain
   later wants its own zone, this becomes a default rather than the answer.
9. **Subscription detection is heuristic (§9.7.2).** It reads order-summary
   language and errs toward refusing. It will refuse some one-off purchases that
   merely mention a renewal elsewhere on the page. That trade is deliberate, but
   the false-refusal rate is unknown until it meets real merchants.
10. **Backfill coverage varies by channel (§8.6.1).** Telegram has a readable
    history; a channel without one is always treated as un-backfillable and
    re-opens. The set of channels that can be backfilled will shape how often he
    sees a re-opened window, and that is only measurable in use.

## 13. Related

- `docs/decisions/2026-07-27-daemon-refuses-derived-sends.md` — the taint ruling
  this capability inherits
- `docs/security.md` — `SecretsManager`, storage policies, permission system
- `docs/secrets.md` — the `goodvibes://secrets/...` reference form
- `docs/contract-regeneration-recipe.md` — the procedure for the `payments.*`
  operator namespace
- `platform/security/content-taint.ts`, `untrusted-content.ts`,
  `turn-boundary.ts`, `link-validation.ts`, `public-suffix.ts`
- `platform/control-plane/approval-broker.ts`,
  `platform/daemon/approval-reply.ts` — the approval primitive and its channel
  resolution
- `platform/channels/delivery-router.ts`,
  `platform/automation/delivery-manager.ts` — delivery and undeliverable
  detection
- `platform/automation/schedules.ts` — the one-shot `{ kind: 'at' }` job the veto
  window runs on
- `platform/google/{types,console-flow,setup-flow}.ts` — the pause-and-hand-over
  pattern §9.6 adapts
- `platform/config/{secrets.ts,daemon-secret-keys.ts,config-ownership.ts,credential-status.ts}`
- `platform/runtime/surface-root.ts`,
  `platform/runtime/telemetry/exporters/local-ledger.ts`
