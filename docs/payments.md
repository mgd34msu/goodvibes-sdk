# Payments: design

**Status:** implemented. This document is the design of record.
**The behaviors recorded here are contractual. Do not revise them silently.**
Choices made under zero-deferrals where no owner ruling existed are listed in
§12.1 as rulings taken, with their reasoning, so they can be overturned
deliberately rather than discovered.

A card turns a successful prompt injection from "sends an email" into "buys
something". The platform has just spent a round hardening against exactly that
(`docs/decisions/2026-07-27-daemon-refuses-derived-sends.md`), and this
capability is the one place where that hardening has to hold with money on the
other side of it. Read the security section before the feature sections.

---

## 1. Where it lives

The SDK owns the capability, the daemon serves it, surfaces are wiring and UI
only. Two rules set that split:

- The agent, the TUI and the webui exist to expose different parts of the SDK to
  a user interface. None of them owns a part of the capability.
- The daemon has every ability the capability offers.

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

**Recommendation (not a blocker):** configure a virtual card, an issuer-minted
number with a hard spend cap set at the issuer, rather than the real card.

The reason is where the limit lives. A budget enforced by this software is
enforced by code that a bug, a misconfiguration or a successful injection can
get past. A cap set at the issuer is enforced by the issuer: it holds when the
daemon is wrong, when it is compromised, and when it is not running at all. And
the blast radius of a leaked virtual number is one card that can be killed in an
app, not the card the owner's rent comes out of.

So the design supports both, prefers one:

- `payments.cards[].kind: 'virtual' | 'real'`
- A virtual card records `issuerCapMinorUnits` as a **declared** fact, the
  daemon cannot verify it, so it is shown to the owner as "you told us this"
  and never treated as an enforcement layer of ours.
- Configuring a `real` card surfaces the recommendation once, records the
  acknowledgement, and proceeds. It is not blocked.

---

## 3. Storage tiers

### 3.1 Secret tier: card material

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
adapter pattern, `createCredentialStatusProvider()` in
`config/credential-status.ts`, which returns
`{ configured, usable, source, scope, secure, overriddenByEnv }` and never a
value. `payments.cards.list` returns metadata only: `id`, `label`, `brand`,
`last4`, `kind`, `expiryMonth`/`expiryYear` (needed to warn on expiry),
`issuerCapMinorUnits`, `addedAt`, and `materialComplete`.

`materialComplete` is the per-card completeness signal: a boolean on the same
`payments.cards.list` row saying whether every required secret field is
present, without revealing any of them, so a surface can render "CVV not set"
without the daemon ever emitting one. There is no separate `payments.card.status`
method; the completeness check rides the list response rather than a call of
its own.

### 3.2 Config tier: settings

Daemon-owned config, following the `atRest.*` worked example exactly: a
`PaymentsConfig` interface in `schema-types-payments.ts`, `paymentsConfigDefaults`
and `paymentsConfigSettings` in `schema-domain-payments.ts`, both wired
into `schema.ts`, and `'payments.'` added to `DAEMON_OWNED_CONFIG_PREFIXES`.
Persisted to the daemon tier (`~/.goodvibes/daemon/settings.json`) through
`ConfigManager.set()` → `persistDaemonKey`.

```ts
interface PaymentsConfig {
  /** Master switch. Nothing in this capability runs while false. */
  enabled: boolean;                         // default false

  defaultCardId: string;                    // default ''

  /** ISO-4217. What every amount below and every checkout is checked against. */
  currency: string;                         // default 'USD'

  billingAddress: PostalAddress;            // default: all fields ''
  shippingAddress: PostalAddress;           // default: all fields ''

  // Every amount below is written the way you would say it: 100 is a hundred,
  // 19.99 is nineteen ninety-nine, in whatever `currency` is set to.
  budget: {
    /** The item price is checked against this. */
    dailyItem: number;                      // default 0
    /** Unavoidable charges only: tax, mandatory fees, delivery. */
    dailyOverage: number;                   // default 0
    perPurchaseCeilingEnabled: boolean;     // default TRUE  (owner ruling)
    /** The most any single purchase may come to. */
    perPurchaseCeiling: number;             // default 0
    overageToleranceEnabled: boolean;       // default FALSE (owner ruling)
    /** The third pool, drawn on only after the delivery ladder bottoms out. */
    overageToleranceDailyAllowance: number; // default 0
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

  /**
   * Comma-separated, parsed by `readNotifyChannels()`. Ordered. Email is not
   * expressible here; see §8.2.
   */
  notifyChannels: string;                   // default ''

  cvvHandling: 'stored' | 'prompt';         // default 'stored' (ruled), see §9.5

  /** Owner-named domains the merchant judge must treat as established. */
  majorRetailersAdditional: string;         // default '', comma-separated
  /** Owner-named domains the merchant judge must never treat as established. */
  majorRetailersExcluded: string;           // default '', comma-separated

  /** The eBay per-listing seller-reputation bar; see §9.1.1. */
  ebayMinSellerFeedbackCount: number;       // default 100
  ebayMinSellerPositivePercent: number;     // default 98
}
```

Card metadata (`payments.cards[]`: id, label, brand, last4, kind, issuer cap)
lives in config; card material lives in secrets. The two are joined by `cardId`.

**Every money default is `0`, and `enabled` defaults to `false`.** The rule for
defaults in this domain: each one takes the safest available value, and only an
affirmative change by the user moves it.

Zero is the safest number here. The capability can be fully configured and still
buys nothing until an amount is set affirmatively, and a refusal against a zero
budget reads "the daily item budget is 0, set one" rather than failing obscurely.

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
`resolveSurfaceDirectory`, `requireSurfaceRoot`), no hand-built paths.

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

Currently inlined directly in the `daemon.timezone` key's `validate` callback
in `config/schema-domain-daemon-location.ts`, duplicating the same check
`day.ts`'s `isValidTimezone` also runs independently, rather than the single
reusable `schema-shared.ts` validator this section once called for. That is a
small piece of unfinished cleanup, not a behavioral gap: both copies reject the
same inputs today.

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
back a fresh budget, a trivial way around the limit, reachable by anything that
can write daemon config. Timezone changes are recorded in the audit ledger.

---

## 5. Budgets and pools

Three pools, all keyed by day:

| Pool | Covers | Config |
|---|---|---|
| **Item** | The item price. | `budget.dailyItem` |
| **Overage** | Only charges that cannot be avoided on an approved purchase: sales tax, mandatory handling or booking fees, and the delivery option actually used. | `budget.dailyOverage` |
| **Tolerance** | The shortfall when the overage pool cannot cover even the cheapest delivery, only when `overageToleranceEnabled`. | `budget.overageToleranceDailyAllowance` |

**What the overage pool does not cover:** expedited shipping beyond what the
ladder in §7 selects, shipping insurance, gift wrap, extended warranties,
priority handling, and anything else offered as an option. Those are purchase
decisions, not delivery costs. A purchase that includes one is treated as an item
price change and re-enters the decision order at step 4a.

**Per-purchase ceiling** (`perPurchaseCeilingEnabled`, default **on**) caps a
single purchase's item price independently of what remains in the daily pool. It
is a separate question from the daily budget and both must pass.

**Overage tolerance** (default **off**) ships as a real configurable feature
rather than a bare switch: enabling it without setting
`overageToleranceDailyAllowance` changes nothing, because the allowance is still 0.

### 5.1 Reservations: two concurrent purchases must not both fit

Pools are drawn against by **reserve-then-commit**, not by checking a total at
decision time and charging later. Two purchases evaluated concurrently could each
individually fit the remaining budget and together exceed it; a reservation
closes that.

```ts
interface BudgetReservation {
  readonly id: string;              // the purchaseId
  readonly dayKey: string;
  readonly itemMinorUnits: number;
  readonly overageMinorUnits: number;
  readonly toleranceMinorUnits: number;
  readonly createdAtMs: number;     // UTC
  readonly expiresAtMs: number;
}
```

Taken when the decision order reaches step 3, held across the window, and either
**committed** (charge succeeded) or **released** (vetoed, denied, refused,
charge failed, expired). An approved above-budget purchase is reserved the same
way: `admitApprovedItemOverdraw()` widens the daily limit by exactly the
approved shortfall before `BudgetLedger.reserve()` runs, so the reservation
succeeds against a pool sized for the lower ceiling without the underlying
`budget.dailyItem` setting itself ever changing. It is a no-op when nothing
needs raising.

**On a cluster, exactly one node may act.** `payments.*` config replicates to
every opted-in node (`cluster/config-replication-policy.ts`), so a node that
takes over a handover has the configured limits rather than defaults. Today's
SPEND does not replicate: it lives in the payments spend ledger, which is not
config, so a second node acting would start from a clean daily budget and could
spend the day twice.

Until the ledger itself replicates, `checkPaymentGates` refuses on any node that
is not the elected payments leader, and `isPaymentsLeader` is a required input
with no default so a caller cannot omit it into a pass.

Reservations are persisted so a daemon restart does not
release money that is mid-flight, and, per the platform rule that anything
persisted across restarts reaps, bounds, validates by content, sweeps
periodically and discloses, they are swept on a timer, capped in count, dropped
when they fail content validation, and the sweep's actions appear in the audit
ledger rather than happening silently.

The two numbers behind that are `RESERVATION_TTL_MS` (4 hours) and
`MAX_RESERVATIONS` (256). Four hours is deliberately longer than the longest
window this capability opens, so a reservation never expires out from under a
purchase that is still legitimately waiting on an answer, while still being
short enough that a crashed purchase does not hold budget hostage for a whole
day. The count cap is a bound on the persisted file, not a limit anyone is
expected to reach in ordinary use.

---

## 6. The decision order

The budget arithmetic at the center of this, item price against the daily
pools and the shipping ladder, is written once, in `platform/payments/decide.ts`,
as a pure function over a snapshot, so it is testable without a browser, a card
or a clock. The full sequence around it, gates, taint, the checkout URL, who
takes the card, extraction, the cart, the recurring-charge check, the decision,
the reservation and the one notification, is orchestrated in `checkout-flow.ts`'s
`runCheckout()`, and the numbering below follows that function's own steps
rather than an idealized order, because the two have diverged before and this
document exists so they cannot again without someone noticing.

```
0.  GATES  (any failure is terminal, no approval path, no downgrade path)
    0a. payments.enabled is on                                          → REFUSE
    0b. ORIGIN: did CONTENT initiate this purchase?                     → REFUSE
        (absolute, no approval path; §9.1)
    0c. LEADER: is this node the one elected to serve payments?         → REFUSE
        (§5.1; required, never defaulted)
    0d. a usable card is configured                                    → REFUSE
    0e. a shipping address is configured                                → REFUSE

    TAINT: do `item` / `requestedMax` derive from untrusted content?     → REFUSE
    `merchant` / `checkoutUrl` too, unless the OWNER asked us to find
    the merchant (`merchantDiscovered`), in which case they are graded
    below rather than refused

    LINK: did the checkout URL arrive from untrusted content?
    → full link validation, or REFUSE (§9.2)

    RECOURSE: grade the merchant on the validated registrable domain that
    takes the card (§9.1.1), before any money math, so a listing that could
    never be bought at all, an eBay auction, a Best Offer, stops here rather
    than after a budget question that could never have applied to it
    ├─ the listing itself is structurally unbuyable  → REFUSE (§9.1.1)
    ├─ recourse established                          → the window will be a VETO
    └─ anything else                                 → the window will be an APPROVAL
    Either condition escalates and nothing downgrades: a recognised retailer
    buys no leniency on an over-budget purchase. The grade decided here is
    used later, once the total is known (step 6).

1.  EXTRACT: page strings become integers we parsed                     → REFUSE
    on anything that does not parse to a plain, non-negative integer

2.  CART: the cart holds what the owner asked for and nothing else      → REFUSE
    (`assertCartMatchesRequest`; §7)

3.  RECURRING: a subscription or recurring charge is refused outright   → REFUSE
    (§9.7.2)

4.  DECIDE, on our own parsed integers (`decide.ts`)
    a currency mismatch or a zero daily-item budget refuse immediately (§9.7.1);
    otherwise:

4a. ITEM PRICE vs DAILY ITEM BUDGET  (and the per-purchase ceiling if enabled)
    ├─ over  →  ABOVE BUDGET, needs explicit approval, continue to 5
    └─ within →  continue to 5

4b. UNAVOIDABLE CHARGES + PREFERRED SHIPPING TIER vs OVERAGE POOL
    tax + mandatory fees + shipping(tier)
    ├─ fits at the preferred tier      →  continue to 5
    └─ exceeds  →  SHIPPING LADDER: step down ONE tier at a time
        ├─ a lower tier fits  →  record the step-down, surface it, continue to 5
        └─ nothing fits even at the cheapest
            ├─ overageTolerance enabled and the shortfall fits the allowance
            │                                  →  draw tolerance, record, continue to 5
            └─ otherwise                       →  REFUSE           (owner ruling)

5.  RESERVE the pools, before the owner is asked anything. A needs-approval
    purchase would fail an ordinary reservation, that is what over budget
    means, so its reservation is taken against the item limit raised by
    exactly this purchase's own shortfall (`admitApprovedItemOverdraw`; §5.1),
    holding the money for the length of the window. Denied, silent or
    undeliverable releases it in full; nothing about `budget.dailyItem` itself
    changes.

6.  THE ONE NOTIFICATION, sent once, here, because this is the first point
    both halves of what the owner needs to see are known: what was chosen and
    what it will actually cost. Same content either way; the grade from step
    0d decides only what SILENCE means.

    VETO  (within budget, recourse established), silence PROCEEDS
    ├─ silence for windows.vetoMinutes  →  PROCEED
    ├─ explicit acknowledgement         →  PROCEED immediately
    ├─ objection                        →  CANCEL, release, and REPORT
    └─ undeliverable                    →  PROCEED  (owner ruling: under/at
                                           budget items get through)

    APPROVAL  (above budget OR no recourse established), silence DENIES
    ├─ silence for windows.approvalMinutes  →  DENIED
    ├─ explicit approve                     →  continue to 7
    ├─ explicit deny                        →  DENIED
    └─ undeliverable                        →  REFUSE

    There is only ever one window per purchase: the total it carries is
    already final (§8.4).

7.  APPLY the shipping tier the ladder chose, FILL the address and then the
    card, and SUBMIT, journalled before the click so a restart can tell
    "not submitted" from "possibly submitted" (§9.6)
8.  RECORD: commit the reservation, write the audit record, and report
    whether the submission was verified or merely sent (§9.4)
```

**The ladder is always attempted before an overage refusal.** The ruling has four
parts:

1. When the notification cannot be delivered, a purchase at or under budget goes
   through.
2. When the notification cannot be delivered, a purchase over budget does not.
3. When the excess is in the overage budget rather than the item price,
   downgrade first, shipping being the usual thing to downgrade.
4. When no downgrade brings the purchase inside the pools, the over-budget
   purchase does not go through.

**Note what step 4b does not do:** it does not escalate an exhausted overage pool
to an approval request. The ruling is refuse. An approval-instead-of-refuse
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
jump straight to the cheapest: the ladder moves one step at a time, and the
difference is real when three tiers cost $15 / $9 / $5 and $9 fits.

A step-down needs no approval, because it is within budget. It is **recorded in
the audit ledger and surfaced in the veto message and the receipt**, because the
owner must not learn about it from a late package.

**Never add filler items to cross a free-shipping threshold.** This is an
invariant, not a preference: the checkout driver has no verb that adds a line the
owner did not ask for, and `assertCartMatchesRequest` compares the cart's lines
against the request immediately before payment and aborts on any extra line.
There is no free-shipping-threshold logic anywhere in the capability, and its
absence is asserted by a test that greps the payments module for it, the point
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

**Why the approval window is an hour.** Denial is the recoverable outcome, the
owner re-asks and it goes through, so the cost of too-short is friction and the
cost of too-long is a cart holding a price that may drift. An hour survives a
meeting or a commute. It is configurable, and someone who is away for long
stretches should raise it.

**Why the approval expires at all**, rather than waiting indefinitely:

- Wanting a purchase to complete without an answer is a request for a higher
  limit, not for a longer approval. Raising `budget.dailyItem` or the
  per-purchase ceiling is the supported way to get it.
- An expiring approval puts the above-budget decision directly in a human's
  hands.
- Above-budget spending never happens automatically.

### 8.0 The two state machines

Separate types, separate transition functions, separate terminal sets. Every
terminal state maps to exactly one budget action (`commit` or `release`), so a
window can never end without settling its reservation.

**Approval gate, above budget.**

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
                     total changed ─────────┴──▶ void → re-enter §6 step 4a
```

Terminal: `approved`, `denied-explicit`, `denied-timeout`,
`denied-undeliverable`, `void`.
**Every non-`approved` terminal releases.** `silenceMeans: 'denied'`.

**Veto window, within budget.**

```
  pending-dispatch ─┬─ dispatch fails on every channel ──▶ proceeding-undelivered
                    │                                       (commit, owner ruling:
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
                     total changed ─────────▶ void → re-enter §6 step 4a
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
  `openTimedPrompt()` they both call, the duplication is the point.

### 8.2 Delivery is restricted to command-authority surfaces

Approval and veto arrive only over the TUI, the agent terminal, or a channel like
Telegram. **Never email, permanently.**

There is no single command-authority enum in the platform today. There are two
separate mechanisms, deliberately not unified, and this capability uses both:

1. **Content trust**, `platform/security/untrusted-content.ts`:
   `surfaceHasCommandAuthority(surface)` is true only for `'owner-direct'`.
   Note that at this layer `'channel-message'` is *untrusted*, exactly like
   `'email'`. That is about whether text just read can direct the runtime, not
   about whether a human on that channel can answer a question we asked.
2. **Channel identity resolving a pending ask**, `platform/daemon/approval-reply.ts`: `parseApprovalReplyVerb(text)` and
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

### 8.2.2 Answering is not entering, and these must never be merged

Two channel rules live side by side and look similar enough that a later reader
will try to unify them. They answer different questions.

**Where each rule comes from, stated precisely**, because an earlier draft of
this section got it wrong and relayed a coordinator decision as an owner ruling:

- **Owner ruling, the first two entry surfaces.** Payment details, meaning card
  material and the shipping and billing addresses, must be enterable in the
  **TUI** and in the **agent**. The UI exposes entry in both.
- **Owner ruling, the webui.** Card entry is available in the webui as well.
  That question was decided as a two-option choice with the browser exposure
  stated on its face: a PAN on a browser page, form autofill, password managers,
  browser history, and XSS in this project's own UI. The option chosen was
  "Card entry in webui too", and it carried the six browser-side conditions in
  §8.2.3. Those conditions are part of the ruling, not a gloss added afterwards.
- **Coordinator ruling, remote messaging surfaces.** Card details are refused
  there, for the reasoning below. Recorded as the coordinator's because there is
  no owner ruling behind it.

| | Answering | Entering |
|---|---|---|
| The question | May this surface say yes or no to a purchase? | May card details be typed here? |
| Telegram and other live channels | **Yes**, an explicit owner ruling, and it stays | **No** |
| TUI, agent terminal | Yes | **Yes**, the first two entry surfaces ruled on |
| The webui | Yes | **Yes**, a direct owner ruling, with the conditions in §8.2.3 |
| Email | Never | Never |

**Remote channels have authority to decide about a purchase. They have no path
for entering the instrument.**

The reason entering is stricter is concrete. A card number typed into Telegram
is **stored on Telegram's servers, in message history nobody here controls or
can erase, and it travelled through their infrastructure before it reached
us**. The same is true of every hosted chat channel. Encryption at rest is
irrelevant to a value already copied somewhere else on its way in, the damage
is complete before any storage decision of ours applies.

An "approve" typed into the same chat carries no such residue: it is one word
about one purchase, it expires, and on its own it authorizes nothing.

**The prompt is itself the harm.** There is deliberately no card-entry flow that
can be started from a non-entry surface (`mayOfferCardEntryFlow`). Asking for a
card number where the answer cannot be accepted is an invitation to type it
there, and the invitation is what puts the number on someone else's server.
Refusing the answer afterwards is too late.

When card-shaped content does arrive on a remote channel anyway, it is refused
without being stored, without being logged, and **without being echoed**, the
refusal travels over the same channel that already stored the message, so
quoting the value, even masked, would write it there a second time. The reply
names the shape that matched, never the value, and tells the owner to delete the
message and treat the card as exposed.

Implemented in `platform/payments/entry-surface.ts`; asserted in
`test/payments-card-entry-surface.test.ts`, including a test that the refusal
text contains no four-digit run at all.

### 8.2.3 The conditions attached to webui card entry

A browser adds attack surface a terminal does not, which is why these arrived
with the ruling rather than after it. Each is a requirement with a test, and the
list ships from the SDK as `WEBUI_CARD_ENTRY_CONDITIONS` so a surface cannot
quietly implement a weaker version.

| Condition | Why |
|---|---|
| Posted over the **authenticated daemon channel** | The same path as any other secret; nothing bespoke for card material. |
| **Never in a URL**, no query parameter, fragment, or path segment | URLs reach browser history, referrer headers and server logs, none of which this system controls. |
| **Never rendered back after entry**, no response returns the value, no field repopulates from the server | A rendered value reaches the DOM and anything reading it, and a repopulated field is a read path. |
| **`autocomplete="off"`** on every card field | Keeps the browser from retaining it. |
| **No password-manager capture**, the fields must not present as ones a manager offers to save | A manager copies the value into storage this system does not control and cannot clear. |
| **No value retained in DOM state**, cleared from component state after submit | State surviving navigation outlives the submit that needed it. |

Asserted the same way the CVV containment is: a test walks real output and fails
if a card field appears in any URL or comes back in any response body.

### 8.2.1 Detecting "undeliverable"

Delivery goes through `ChannelDeliveryRouter.deliver()`
(`platform/channels/delivery-router.ts`), which returns `{ responseId? }` and has
no `ok` flag, **failure is a thrown error**, including `Unsupported channel
delivery target` when no strategy matches. So a bare `deliver()` is not enough to
answer "was this delivered", and the decision order depends on that answer.

The capability answers that with its own notifier rather than the platform's
retry-and-classify delivery layer. `createChannelPaymentNotifier`
(`platform/payments/notice-delivery.ts`) makes exactly **one** attempt per
configured channel, catches whatever `deliver()` throws, and records
`{ channel, delivered, backfillable }` for each. There is deliberately no
retry here: a purchase notice that failed to send is information the window
needs right away, and a retry loop would push the decision past the point
where the total it is asking about is still valid. **Undeliverable means every
configured command-authority channel's single attempt failed**, and that is
the condition step 4a's window branches on.

One nuance that matters for a headless daemon: **the TUI is not a delivery
strategy.** It renders in-process; there is no routed channel for it. So a daemon
running with no surface attached and only Telegram configured is undeliverable
the moment Telegram fails, which is exactly the case the owner's ruling is
about.

### 8.3 The window always runs, and presence is not attention

The window runs for its full configured duration regardless of where the owner
is. An explicit acknowledgement during it short-circuits to immediate; nothing
else does. In particular **no presence, focus, idle or activity signal shortens,
skips or extends it.**

The window exists for the case where the user is multitasking and does not look
at that specific terminal session for an extended period. A signal that the
session is open, focused or busy says nothing about whether the message was
read, so no such signal is allowed to shorten the wait.

A test asserts the computed deadline is a function of the configured duration and
the start time only, by driving the same decision with every available
session-activity signal flipped and asserting an identical deadline.

### 8.4 The approval carries the final total

Both windows fire at the same point in the flow: once the final total is known
and before payment. That is what makes the number the owner approves the number
that is charged.

If the merchant re-prices between the answer and the charge, the answer is void:
the reservation is released and the purchase re-enters the decision order from
step 4a with the new total. An approval is for an amount, not for a cart.

### 8.5 An objection stops and reports

One word cancels. On cancellation the daemon stops before payment, releases the
reservation, deterministically abandons the checkout rather than leaving it half
driven, and **reports what it stopped**, merchant, total, item, and the state it
left the cart in. It never silently abandons a cart.

### 8.6 What each window is built on, and what happens across a restart

**Correction (2026-08-21, v2.0.19): neither window is built on `ApprovalBroker`
or on a persisted automation job today, and neither survives a daemon
restart yet.** This section originally described a restart-safe design; what
follows is what the current code actually does, and where the gap between the
two still is.

Both windows run through the same port, `PaymentNotifier.awaitAnswer()`
(`platform/payments/notice-delivery.ts`), called inline from `runCheckout()`
while the `payments.checkout.begin` call that started the purchase is still
open. There is no separate use of `ApprovalBroker`
(`platform/control-plane/approval-broker.ts`) anywhere in the payments module,
and no use of `AutomationManager.createJob()` or `AutomationAtSchedule` either.
The wait for an answer lives on the stack of that one call, not in a persisted
record.

`ApprovalBroker` itself does now re-arm restored timers on `start()`
(`rearmRestoredTimers()`, added to close exactly the restart gap this section
used to describe), so a *tool-permission* approval built on the broker is
restart-safe. That fix does not reach payments, because payments never routes
through the broker in the first place.

**What this means for a restart today:** the in-flight `runCheckout()` call
is still abandoned when the process dies, but the interruption no longer
lingers. Registering the payment verbs runs `recoverInterruptedCheckouts()`
to completion before any handler attaches, so no new checkout can start
while the sweep reads the journal, and a record live in the current process
is never treated as interrupted. Recovery settles every remaining record by
its phase verdict. A checkout that had not submitted releases its budget
hold, closes its record, and tells the owner what happened, with the message
following the actual release result (a hold that did not survive the restart
is reported as no longer held, not as released). A checkout that stopped at
the point of submitting keeps its hold and its record, so a restart cannot
buy the same thing twice. A `submitted` record is closed only after its
purchase record is verified on the ledger; the submit flush is ordered after
the record write for exactly this reason, and a journal entry whose record
is missing is kept and reported honestly rather than declared recorded.

When a window opens, its per-channel delivery report, its deadline, and its
kind are persisted with the journal record. A restart therefore applies
`recoverInterruptedWindow`'s real delivery-keyed rules (§8.6.1): a delivered
notice whose window elapsed settles under expiry-stands with its backfillable
channels named; a delivered notice on a channel that cannot be re-read
reports the re-open rule for that channel; a report where nothing was
delivered, or a legacy record with no report at all, settles conservatively
by refusal. The interrupted purchase itself can never resume after a restart,
so every branch releases the hold and charges nothing; what the rules decide
is what the owner is told and which channels still owe a read. A record
recovery keeps notifies the owner once, ever; the notice is stamped back
through the journal.

Card material on a page that outlived the process is the composition's to
clear: recovery calls a composition-supplied cleanup hook for checkouts
interrupted while arming the payment, typed so payments code receives no
browser authority, and without the hook it tells the owner plainly that it
cannot reach the page rather than claiming a cleanup it did not perform.

### 8.6.1 A window interrupted by downtime is keyed on DELIVERY, not on uptime

**The rule that follows is `recoverInterruptedWindow()`'s design, verified
against its own unit tests and applied by boot recovery to every interrupted
window whose record carries a persisted delivery report. Records without one
settle conservatively by refusal. See §8.6.**

**Silence means the owner had the chance to object and did not.** Whether our
process was alive is irrelevant to whether that chance existed. An earlier draft
of this design keyed the restart rule on daemon uptime; that was wrong, and
re-opening a window unconditionally is wrong for a specific reason: it re-pings
the owner about something deliberately ignored, and a system that repeats itself
is one people stop reading.

So the rule is keyed on whether the notification arrived:

| On restart | Rule |
|---|---|
| Notification **was delivered**, window expired during downtime | **The expiry stands.** Before charging, **backfill each live channel** for messages received while we were down and honour any objection found there. No objection → proceed. **Do not re-notify**, it was already seen. |
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
the owner ask twice, but only inside the original window, never past it.

The pending state is bounded, content-validated, swept on a timer, and its
recoveries are disclosed rather than silent.

---

## 9. Security boundaries

### 9.1 Who may initiate a purchase, and who may choose the merchant

These are two different questions, and they are ruled differently. This section
used to conflate them, refusing any purchase whose merchant came from page
content, and documenting that as a feature. That blanket taint gate on the
merchant was overruled as wrong.

On an owner-initiated request of the form "buy the cheapest X you find online",
the required behaviour is:

1. Find the item.
2. Show it to the owner.
3. Alert the owner before purchasing when the merchant is not a major retailer.

What counts as a major retailer is a judgement call, and §9.1.1 is the standard
that judgement is made against.

**What did not move: who initiates.** A content-initiated purchase is refused
outright. An email or a web page saying "buy X from Y" cannot start a purchase,
cannot name a merchant, and cannot set an amount. No owner-address exemption, no
disclose-instead-of-refuse fallback, **no approval path around it**, this is the
one gate with no downstream branch at all, because the approval is exactly the
step an injection is trying to reach.

**What relaxed: who chooses the merchant**, on an owner-initiated purchase. "Buy
the cheapest X you can find" is the owner's own instruction, so the item and the
intent came from the owner and only the storefront was found on a page. That now
proceeds, with the merchant graded by the standard in §9.1.1 into a veto or an
approval.

The distinction is carried in the **type**, not checked at runtime.
`merchantDiscovered` exists only on `OwnerOriginIntent`, so "a discovered
merchant is permissible only on an owner-origin intent" is a fact the compiler
enforces rather than a rule a later edit can forget.

Reuses the existing machinery unchanged:

- `platform/security/content-taint.ts`, `findContentTaint(fields, sources, options)`
- `platform/security/untrusted-content.ts`, the process ledger,
  `getProcessUntrustedContentLedger()`, `taintSourcesThisTurn()`
- `platform/security/turn-boundary.ts`, `startTurnForOwnerRequest()`, so "this
  turn" means what it says and automated work does not reset the window

**The payment path calls `findContentTaint` directly.** It does *not* call
`evaluateOutwardEffect`, because that function accepts an `OwnerApproval` that
allows a tainted action through (`untrusted-content.ts`, the
`input.approval && input.approval.action === input.request.action` branch). That
escape hatch is correct for email and wrong for money, and the way to be sure it
cannot be reached is to not be on that code path. A test asserts a payment is
still refused when a valid `OwnerApproval` for the same action is present.

**Which fields are checked, and which deliberately are not.**

**Always checked**, these come from the owner or the purchase does not exist. A
page that supplies the thing to buy, or the ceiling to buy it under, is
initiating a purchase whatever else is true:

| Field | Test |
|---|---|
| `item` | the length thresholds |
| `requestedMax` | the length thresholds, when the request states a limit |

**Conditionally checked**, only when *the owner named the merchant*, because then
it has to have come from the owner. When `merchantDiscovered` is set, the
storefront came off a page by design, and grading it (§9.1.1) rather than
refusing it is the safeguard:

| Field | Test |
|---|---|
| `merchant` | exact containment (like a recipient address, short, high-signal) |
| `checkoutUrl` | exact containment |

Not checked, the merchant's own quoted numbers:

> The price, tax, fees and shipping costs are **read from the merchant** by
> definition. Taint-checking them would refuse every purchase, and a check that
> is permanently tripped gets removed, the exact failure mode
> `content-taint.ts` was written to avoid. The defence for those numbers is not
> taint, it is the **budget**: a page that inflates a price hits the daily item
> budget or the per-purchase ceiling and needs an approval, and the approval
> shows our own re-rendered number (§9.3).

### 9.1.1 The merchant standard: recourse, not recognisability

When the owner initiates a purchase and we find the storefront, the merchant is
**graded**, and the grade decides only one thing, **what silence means**.

The rule: when the place taking the card is not what the average person would
consider a major retailer, silence means the purchase is denied. Smaller
specialty retailers do count as major, Micro Center among them; a storefront
like `www.jeffsgadgets.biz` does not.

| Grade | Window | Silence |
|---|---|---|
| Recourse established | veto | **proceeds** |
| Anything else | approval | **denies** |

**The organizing principle is recourse.** Recognisability was only ever the
proxy, and the real test shows through in why Etsy counts: consumer protections.
The standard that follows from it:

- Buy from established retailers. Established online-only retailers such as
  Redbubble qualify on the same footing as ones with stores.
- Etsy qualifies, mainly because the platform carries consumer protections.
- Cases like eBay take judgement rather than a blanket yes, and the eBay rules
  below are that judgement written down.
- Be wary of storefronts like `jeffsgadgets.biz`; they do not qualify.

A merchant qualifies when there is a real path to remedy if the purchase goes
wrong, platform buyer protection, an established returns process, an accountable
business with something to lose. `jeffsgadgets.biz` fails not because it is small
or obscure but because **there is nobody to go to**. Micro Center qualifies at two
dozen stores and Redbubble qualifies with no stores at all, because both are real
businesses with real policies. Size and physical presence are weak evidence, not
the test.

**One notification, not two.** Showing the find and alerting before purchase are
the same step, so they collapse into one message, sent once, when the item is
chosen and the final total is known, before payment.

Both branches carry identical content: what was found, the validated registrable
domain, the item, and the total re-rendered from our own parsed integers (§9.3).
The grade changes only what silence means, and the message states which mode it
is in and what happens if nobody answers. `renderPurchaseNotice` is the single
send site, a selection between the two existing windows, not a third message
type.

**The notification names the recourse, not the verdict.** "Etsy, buyer protection
applies" is something the owner can evaluate; "on your approved list" sends them
off to check a list. When it goes to approval it reads as a checkpoint, not an
accusation about the seller: buying there may be exactly what was wanted, and all
we are saying is that we ask rather than assume.

**Where "use judgement" lives: it is at runtime, made by a model, over exactly
one input.** An earlier version of this capability shipped a hardcoded
allowlist of retailer domains, and that was rejected outright: the requirement
was retailers *matching the profile*, not a list of retailers, and a list fails
closed on every established retailer nobody thought to enumerate. See
`docs/decisions/2026-07-27-a-discovered-merchant-is-graded-not-refused.md` for
the full correction. What ships instead is `createModelMerchantJudge`
(`platform/payments/merchant-judge-model.ts`), a helper-model call made through
`MerchantJudgePort`, invoked from `classifyMerchant` for every domain the owner
has not already added or excluded.

The safety argument does not rest on avoiding runtime inference. It rests on
what reaches the judge. `MerchantJudgeInput` has **exactly one field**,
`registrableDomain`, computed from the URL that already passed link
validation, never page content.

No page title, seller name, review count, product description or trust badge
is ever assembled into the prompt, because every one of those is written by
the party whose trustworthiness is the question, and a judgement made over
them is a judgement the attacker writes. The criterion the model is asked is
`MERCHANT_RECOURSE_CRITERION`, a fixed string this repository ships, not
something derived per request. A test asserts the port is called with exactly
the key set `['registrableDomain']`, so widening that input is a broken test,
not a silent regression.

Judgement replaced the list rather than sitting alongside it: there is no
cache and no fast-path table of obviously-established domains. Purchases are
infrequent and already sit inside a checkout flow with a human notification
window, so a cache would buy nothing measurable and would cost a second
source of truth that can disagree with the judge and rot exactly as the old
allowlist would have.

**Every failure mode resolves to not-major.** A disabled helper, no route
configured, a timeout, a malformed answer, prose where JSON was asked for, or
a verdict word the parser does not recognise, all produce
`{ qualifies: false, confident: false }`, which turns into an approval window
where silence denies. That direction is deliberate: being unable to judge a
legitimate small retailer costs the owner one question answered in a second;
treating an unjudgeable domain as established costs a silent purchase from a
storefront nobody vouched for. A model outage must never make spending more
automatic.

The judge returns a free-text `recourse` phrase in its own words, for example
"established electronics retailer with a returns process" or "marketplace
with buyer protection", rendered to the owner so the notification names the
recourse rather than a verdict, and an optional `marketplace` classification,
one of `'none'`, `'buyer-protection'` (the Etsy case, major outright once the
marketplace policy allows it) or `'per-seller'` (the eBay case, gated further
by the listing check below). There is no fixed enum of qualifier categories
beyond that: the specific phrasing is the model's, not a tag picked from a
closed list.

**Default is not-major.** Anything the judge does not confidently qualify asks
the owner. There is no benefit of the doubt, because the fallback is not
refusal, it is asking. Treating a real retailer as unqualified costs one
message and one answer; the reverse costs money spent somewhere with no way to
get it back.

**The list is owner-editable and nothing learns its way onto it.**
`payments.majorRetailersAdditional` and `payments.majorRetailersExcluded` take
comma-separated registrable domains. No page, agent or inference adds an entry, a page that could argue itself onto the list could buy from itself unattended.

**Recourse must survive the checkout.** Matching is on the validated registrable
domain **that takes the card**. If an established retailer hands off to a payment
page on an unrelated registrable domain, the protection the qualification rested
on may not follow it, that is not-major, and the notification says why.

#### eBay is per-listing, not per-domain

eBay is a grey area, and it is ruled this way: Buy It Now purchases are allowed
on eBay, but only when the seller has a solid reputation earned from **selling**,
not from buying.

ebay.com is necessary and not sufficient. Two conditions, both required, in
`payments/marketplace-listing.ts`:

**1. Fixed price only. Auctions are refused structurally, not by policy toggle.**
The flow is: know the final total → notify the owner → run the window → pay. An
auction has no final total until it ends, so that flow *cannot execute at all*,
this is a structural impossibility, not a preference that could be configured
away. Bidding is also an open-ended commitment rather than a purchase.
The same reasoning covers Best Offer and any listing whose format we could not
confirm as fixed-price.

**2. Reputation earned selling.** eBay's headline feedback score combines buying
and selling, so a large number can have been earned entirely by buying. Only the
seller-side figures count: **≥98% positive as a seller and ≥100 seller ratings**
by default, configurable via `payments.ebayMinSellerPositivePercent` and
`payments.ebayMinSellerFeedbackCount`.

Reading a page here is acceptable only because the figures are rendered by
**eBay**, on a domain already validated, in eBay's own feedback widget, not by
the seller. It is nonetheless built as a **ratchet**:

- It may only ever make the outcome **stricter**. It can move a listing to
  approval-required and can never move one the other way. No reputation figure
  promotes a domain that was not already recognised.
- **Unreadable means not-major.** Missing, ambiguous, or an unexpected page shape
  all fail closed and the owner is asked.
- A figure from a **seller-controlled** region of the page is never accepted, and
  if the region cannot be told apart, the figure is unreadable.

The worst case a hostile listing can achieve is being sent for the owner's
approval, which is where an unrecognised seller was going anyway.

#### The config seam

`merchantPolicyFromConfig(config)` is the **only** mapping from `PaymentsConfig`
to the merchant policy. Every consumer, the daemon's checkout path, the
control-plane handlers, a surface previewing a decision, calls it rather than
reading the keys itself. A second copy of that mapping is how a renamed key
silently degrades a purchase gate to its defaults while still looking configured.
Note that **no config value can make this decision more permissive**: the knobs
add domains the owner vouches for, remove domains the owner does not, and move
the eBay seller bar.

### 9.2 Checkout URLs from untrusted content pass full link validation

Any checkout URL that arrived from untrusted content passes
`validateLinkTarget(rawUrl, authorizedDomain)` before anything is typed, `platform/security/link-validation.ts`, with its generated public-suffix data
(`public-suffix.ts`). Redirect chains go through `followValidatedRedirects`, so a
link that lands correctly and then 302s away refuses the chain.

**What `authorizedDomain` is depends on who chose the merchant**, and the two
cases close the loop differently:

- **The owner named it.** `authorizedDomain` is that named merchant, which §9.1
  has already established is not page-derived. The domain we validate against
  cannot itself have been chosen by an attacker.
- **We discovered it.** The domain *was* chosen from page content, so validation
  alone cannot vouch for it and does not pretend to. It still does its real job, proving the URL we are about to open is the domain it claims to be, catching
  userinfo tricks, homographs and redirect chains. **Whether that domain deserves
  the card is a separate question, answered by §9.1.1**, and an unrecognised one
  goes to an approval the owner must answer. Link validation establishes
  identity; the merchant standard establishes recourse. Neither substitutes for
  the other.

In both cases the registrable domain that survives validation is the one shown in
the notification and the one the recourse test is applied to, so what the owner
is told, what is graded, and what takes the card are the same string.

The refusal reasons already distinguish userinfo tricks
(`https://shop.example@evil.example/pay`), non-https schemes, mixed-script
homographs, registrable-domain mismatches and shorteners, and each is reported
by name because a refused checkout is often something the owner finishes by hand.

### 9.3 Approval and veto messages are rendered from structured fields only

If page text can reach the message, an attacker writes what the owner reads on
their phone: *"Approve $12 for coffee?"* attached to a $1,200 order.

So the message is rendered from a closed struct of typed scalars, and there is no
field in it that can carry free text from a page:

```ts
interface PurchaseFacts {
  readonly merchantDomain: string;       // registrableDomain() of the VALIDATED url
  readonly item: OwnerSuppliedText;      // the owner's own words, a branded type
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
  readonly destination: string | null;   // the stored shipping address, rendered for the notice
}
```

- **Merchant** is `registrableDomain(host)` computed from the validated URL, never the page's own claimed name, which is page text.
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
- **Destination** is the owner's own stored shipping address, rendered by
  `renderDestination`, never anything the checkout page supplied. It is `null`
  when no shipping address is on the order.

Tested adversarially: the same purchase is driven with injected content in every
page field the driver reads, and the rendered message must be byte-identical to
the clean run.

### 9.3.1 Every merchant-derived string is attacker-chosen

The approval and veto notices carry text a merchant page controls into a message
the owner reads on their phone and answers under a ten-minute clock, with money
attached. That is the inbound-mail notice defect (SDK `140cbcb4`) with a charge
on the end of it.

The reasoning that produced that defect is the part to keep in view: the field
was sanitized for control characters only because *the sender cannot forge which
mailbox received the mail*. True about the mailbox, false about the local part in
front of the `@`, which under catch-all or plus-addressing is whatever the sender
typed. **A field is not safe because part of its provenance is verified.**

So every one of these is treated as attacker-chosen and neutralised before it can
reach any channel: item title, merchant display name, seller name,
shipping-option labels, promotional text, currency strings, and any merchant text
quoted back inside a refusal reason.

| Rule | How |
|---|---|
| Merchant identified by **validated domain**, not display name | `registrableDomain()` of the validated checkout URL. A page can call itself anything. `isPlainHostname` asserts the value really is a computed hostname; anything else renders as "(merchant identity unavailable)" rather than being printed. |
| Amounts **re-rendered from our parsed integers** | `formatMinorUnits` throws on a non-integer rather than rendering something plausible, so a merchant string can never become the number the owner reads. |
| Markup and mention syntax **neutralised at the source** | `security/notice-text.ts`, `sanitizeNoticeField` for attacker text, `sanitizeOwnerNoticeField` where underscore is worth keeping. |
| Owner-authored text sanitized **too** | `OwnerSuppliedText` is a compile-time guarantee, and a compile-time guarantee does not survive a call site that threads provenance wrongly. |

**Where per-channel escaping lives.** Two layers, deliberately split:

- **Source (SDK, `notice-text.ts`)**, neutralise the *union* of trigger
  characters across Telegram MarkdownV2, Slack mrkdwn, Discord markdown, ntfy and
  a bare terminal. The SDK does not know which route a notice will take, so it
  does not guess; this is the layer that has to hold regardless of destination.
- **Delivery (channel adapter)**, whatever escaping that specific wire format
  requires, owned by the code that knows the format.

Neutralising the union at the source is not a substitute for correct per-channel
escaping. It is what stops a missing escape in one adapter from becoming a
clickable link in a message about money.

Tested as attacks rather than as formatting, in
`test/payments-notice-injection.test.ts`: a merchant name carrying a markdown
link, a mention and a fake "Approved" affordance must arrive inert. Four of the
five production cases were confirmed to fail with the sanitisation reverted, and
the trigger set is proved load-bearing by dropping one character at a time, dropping `(` lets `[Approved](https://evil.example)` survive even with `[`
removed, which is why both are in the set rather than relying on one.

### 9.4 The audit ledger

Append-only JSONL following the existing
`platform/runtime/telemetry/exporters/local-ledger.ts` pattern, `appendFileSync`,
size-based rotation, retention through `at-rest-persistence.ts` and the
`atRest.*` config.

Every purchase records what, where, how much, and which pool it drew on, in a
flat row reconcilable against a card statement. The real interface,
`PurchaseRecord` (`platform/payments/purchase-record.ts`), is simpler than an
earlier draft of this section described, and every amount on it is an integer
this daemon parsed, never merchant text:

```ts
interface PurchaseRecord {
  purchaseId: string;
  atUtc: string; dayKey: string; timezone: string;
  merchantDomain: string;
  item: string;
  currency: string;
  itemMinorUnits: number; taxMinorUnits: number; feesMinorUnits: number;
  shippingMinorUnits: number; totalMinorUnits: number;
  shippingTierRequested: string; shippingTierUsed: string; steppedDown: boolean;
  itemPoolDraw: number; overagePoolDraw: number; tolerancePoolDraw: number;
  cardLast4: string;
  windowKind: string; windowOutcome: string; answeredBy: string | null;
  outcome: string;             // e.g. 'purchased', 'submitted-unverified', or a refusal code
  refusalReason: string | null;
  merchantOrderId: string | null;
  refundedAt: string | null;   // set later, when a refund correlates to this row; see §9.7.3
  merchantRecognised: boolean; // the §9.1.1 verdict, so the ledger can reconstruct why one
                                // purchase asked and another did not
  merchantQualifier: string | null;
  merchantDiscovered: boolean; // named by the owner, or found while browsing
}
```

There is no `causedBy` (turn, correlation id or request text), no
`decisionPath`, and no `authorizationLast4`; none of those are tracked today.
`outcome` is not the closed enum an earlier draft of this section listed.
Two values matter beyond the obvious refusal codes: `'purchased'`, when the
submission was verified against the merchant's own response, and
`'submitted-unverified'`, when the order was sent but the daemon could not
confirm it went through, committed conservatively against a double-spend
rather than retried. §9.6 covers when each applies.

It never contains a PAN, a CVV, an expiry, or a full authorization code, only
`cardLast4`. A test asserts the serialized record does not contain any
configured card material.

### 9.4.1 Mail correlates a purchase, it does not gate one

When a store's confirmation email arrives, the owner should read "this is the
order you approved" rather than an unrelated receipt they have to place
themselves. `correlatePurchaseMail` (`platform/payments/order-correlation.ts`)
recognises that connection, but it authorizes nothing, and that distinction
mattered enough to design around deliberately.

An earlier draft treated this like `google/verification-expectations.ts`,
registering an expectation the way a signup registers one for a verification
link. That was the wrong instrument: a verification link lets an agent
complete an action, so it must be requested in advance, tied to an address
minted for that one purpose, and expired aggressively. An order confirmation
is invoice-shaped, arrives at the owner's real address, and authorizes
nothing by existing. So correlation needs no registration, no interception and
no expiry, only a lookup against purchase records already being written.

Matching runs on **our own record**, never on the mail's claims. The sender's
registrable domain is compared against the registrable domain computed from
the validated checkout URL, so `order-update.example.com` matches a purchase
at `www.example.com`, a different registrable domain never does, and a
message claiming a merchant we never bought from correlates to nothing.

Only `'purchased'` and `'submitted-unverified'` outcomes are eligible, because
both mean the submit actually reached the driver. `'submitted-unverified'` is
included deliberately, since a confirmation email inside the correlation
window is the strongest available signal that an unverified submission went
through. A match never rewrites the stored record; it only recognises it.
Two purchases at the same merchant on the same day within the window,
`CONFIRMATION_WINDOW_MS`, six hours, produce an `'ambiguous'` result rather
than a guess, and the caller reports that ambiguity rather than picking one.
`renderConfirmationReport` (`platform/payments/message.ts`) renders the
follow-up from these structured, neutralized fields alone, never the email
body.

### 9.5 The CVV is stored

**The CVV is saved, full stop. It is required for autonomous action.** That is a
settled owner ruling.

It is not an open question, and the code, the tests and this document do not
treat it as one. What follows is the plain statement of what is kept and what
that exposes, which the owner is entitled to know, not a hedge on the decision.

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
scope. A personal daemon holding the owner's own CVV in the owner's own encrypted
store is out of that scope, but not out of danger.

Anyone who can read `~/.goodvibes/daemon/secrets.enc` **and**
`~/.goodvibes/secrets.key` has the card number, the expiry, the CVV and the
billing address, everything a card-not-present transaction needs, at any
merchant, with no further access to this machine. Filesystem permissions
(0600/0700) and the encryption at rest defend against a different user on the
same host; neither defends against a process running as the owner. Backups of
the home directory carry the whole kit.

**A virtual card bounds that loss and a real card number does not.** This is
guidance about which instrument to provision, not a qualification of the ruling.
With a virtual card the worst case is one number carrying an issuer-enforced
ceiling, killable from an app in a minute. With the real card the worst case is
the card the rent comes out of, and nothing in this software can cap it, the
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
at the moment of selection, `CVV_PROMPT_TRADEOFF_WARNING` in
`platform/payments/index.ts` is the shared string every surface renders, because
a trade-off that large belongs in front of whoever flips the switch, not buried
in a document.

### 9.6 3-D Secure, SCA and CAPTCHA pause cleanly

These pause and hand the owner the exact step, the way the Google console
walkthrough does. **Never loop, never guess, never half-complete an order.**

The real type, `CheckoutChallenge` (`platform/payments/checkout-page.ts`), is
smaller than an earlier draft of this section sketched:

```ts
interface CheckoutChallenge {
  readonly kind: '3d-secure' | 'captcha' | 'otp' | 'unknown';
  /** Plain words this code wrote. Never merchant text. */
  readonly step: string;
  readonly url: string;
}
```

**The submission is attempted exactly once, never retried, and the reservation
stays held until the ambiguity is resolved by a human.** There is no
idempotency key and no automated re-read of order state at the merchant; the
safety property comes from never submitting a second time, not from being
able to tell two submissions apart afterward. `runCheckout()` journals the
purchase to `'submit-pending'` immediately before the click, because that
flush is what lets a restart later tell "not submitted" from "possibly
submitted": everything before it is unambiguously not submitted, and from
there until a response is seen, the daemon cannot know, and a record caught in
that phase is reported to the owner rather than resubmitted.

Two distinct outcomes follow a submit attempt:

- **Refused before the click reached the merchant** (`CheckoutSubmitRefused`,
  a typed refusal, an untrusted-effect guard, a stale page reference): nothing
  was sent, so the reservation is released in full and the outcome is
  `'submit-not-attempted'`.
- **Genuine ambiguity**, any other failure while awaiting the merchant's
  response to a submit that may have reached them: the reservation stays
  reserved, nothing is retried, and the outcome is `'challenge-abandoned'`
  with a message telling the owner to check their order history at that
  merchant by hand.

When the merchant instead answers with a challenge, 3-D Secure, a CAPTCHA, a
one-time code, the reservation stays held and the flow returns the challenge
to the caller with `step` naming what is blocking in this code's own words,
never merchant text. No automated attempt is made at solving it: a CAPTCHA is
not solved, an OTP is not guessed, a 3-D Secure frame is not clicked through.

**When a submit runs its course with no challenge, the outcome is still one
of two things, not a single "it worked."** If the merchant's own response
confirms the order, the record's `outcome` is `'purchased'`. If the submit
completed but nothing confirmed it, the record says `'submitted-unverified'`
rather than claiming a purchase indistinguishable from a confirmed one, and
every surface that renders the result, the purchase report, the ledger row,
mail correlation, carries that distinction through rather than rounding it up
to success. `renderPurchaseReport` (`platform/payments/message.ts`) is what
turns this into the sentence the owner reads: "Bought it" only when verified,
"submitted the order, but I could not confirm it went through" otherwise.

---

## 9.7 Three things this capability refuses on purpose

These are refusals by design, not gaps left for later. Each is implemented as an
explicit, named refusal with its own message, never a silent pass and never an
unhandled case that falls through to "proceed".

### 9.7.1 A checkout quoted in another currency

The budget is denominated in one currency. A merchant quoting another one is
**refused**, with a message naming both currencies.

The alternative is converting, and converting means picking a rate. Any rate we
pick is stale by the time the card is charged, because the issuer converts at
its own rate on its own date and adds its own fee. So a converted number shown
in an approval would be a number the owner did not approve, the exact defect §9.3
exists to prevent, and a budget check against it would be arithmetic on a
guess. Refusing is honest; converting is confident and wrong.

`CurrencyMismatch` carries the budget currency, the quoted currency, and the
suggestion to buy from a merchant that quotes in the budget's currency, or to
handle the purchase by hand instead.

### 9.7.2 A checkout that enrols a subscription or recurring charge

**Refused.** A daily budget cannot describe a charge that renews unattended next
month. Everything in this design, the pools, the reset, the veto window, is
built around one purchase happening once, and there is no mechanism here that
would notice a renewal, let alone stop one. Enrolling the owner in something that
charges again later, on a capability whose entire safety story is a daily limit,
would be the most expensive kind of silent hole.

Detection is deliberately conservative and errs toward refusing: recurring-billing
language in the order summary, a subscription line item, a trial-then-charge
term, or a stored-payment-method consent checkbox. A checkout it cannot classify
with confidence is refused rather than attempted, a false refusal costs one
manual purchase, a false accept costs a recurring charge nobody is watching.

### 9.7.3 Money coming back does not credit a pool

Refunds, cancellations and chargebacks are **recorded in the audit ledger and do
not credit any pool.**

Crediting would be surprising in the direction that spends money: a refund
landing on day 5 for something bought on day 1 would silently hand back day 5's
budget, so a returned item becomes permission to buy another one that day
without the owner deciding that. The pools are a rate limit on outward spending,
not a running balance of net worth.

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
| `payments.checkout.begin` | command-authority principal | Runs the whole flow, §6 steps 0 through 8, in one call, including waiting out the window; returns the final `PurchaseRecord` outcome, a refusal, a cancellation or a challenge. | yes |
| `payments.checkout.fillCard` | command-authority principal | Types the stored card into an already-open checkout page. | yes |
| `payments.purchase.approve` / `.deny` | command-authority principal | Answers an above-budget gate. | not yet |
| `payments.purchase.cancel` | command-authority principal | Vetoes an in-budget purchase. | not yet |
| `payments.purchase.status` | `read:payments` | Live state machine position. | not yet |

Seven verbs are built and published (`./platform/payments`, since 1.19.0):
the five above plus the two checkout verbs. `payments.checkout.begin` is
long-running by construction, it does not return until the window it opens
resolves or the whole purchase is decided, because the window itself is
awaited inline inside `runCheckout()` rather than parked in a broker a
separate call could later answer (§8.6). That is also the practical reason the
next three rows are not yet built: there is no operator-method surface today
for a second call to answer a window that the first call is still holding
open on its own stack.

Settings are not in this list on purpose: they are ordinary daemon-owned config
and travel the existing `config.get`/`config.set` path, which is what makes a
value entered in any surface apply to the daemon (§10.1).

The approve/deny/cancel/status verbs are the remaining wire work, and they are
not a thin layer over what already exists. Today, the only way an open window
resolves before its deadline is a reply arriving over a configured channel and
being matched to the pending purchase by `PaymentReplySource.waitForAnswer()`
(`platform/payments/notice-delivery.ts`), the same port `payments.checkout.begin`
is blocked on.

Building these verbs means giving the TUI and the agent terminal a way to
answer that does not depend on being the same connection that opened the
checkout, which in turn means the window can no longer simply live on one
call's stack. That is a real design change, not just new routes, and it is the
same change that would make §8.6's restart recovery reachable.

A `payments.purchase_update` gateway event, so surfaces render a live window
rather than polling, would need the same change and does not exist yet either.

`approve`/`deny`/`cancel` additionally require that the calling principal arrived
over a command-authority surface, an authenticated operator session from the TUI
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
tier is `~/.goodvibes/daemon/settings.json`, the same file the daemon process
reads. That is why adding `'payments.'` to `DAEMON_OWNED_CONFIG_PREFIXES` is
what makes a setting entered in the TUI apply to the daemon, with no RPC
involved. The webui, having no filesystem, does go over the wire, `invokeOperator('config.set', { key, value })` in
`goodvibes-webui/src/lib/goodvibes.ts`.

Only the new `payments.*` verbs (purchases, budget status, approve/deny/cancel)
are operator methods, and each needs a `DIRECT_TRANSPORT_COVERAGE` decision in
`test/transport-parity.test.ts`, a real client method or an explicit
`'http-only'`. The gate fails until that decision is made, which is the point.

### 10.2 Settings rows come for free; card entry does not

`buildSettingGroups()` in
`goodvibes-tui/src/input/settings-modal-data.ts` walks `CONFIG_SCHEMA` and builds
a row for every key automatically, deriving the category from the first path
segment. So every scalar in `PaymentsConfig` gets a TUI row and a webui row with
no per-field UI code, and the daemon-owned note is appended automatically by
`daemon-owned-settings-descriptions.ts`.

Card material must **not** use that path. The settings modal's inline editor
echoes the raw edit buffer on screen, `currentSettingValue()` in
`goodvibes-tui/src/renderer/settings-modal.ts` does not special-case a secret key
while it is being edited, so `maskSecretValue()` only masks a value at rest.
Card entry therefore routes through the concealed-input composer
(`goodvibes-tui/src/input/concealed-input.ts`, `maskConcealedText`,
`beginConcealedInputFor`), following `input/provider-key-intake.ts`, which
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

### 10.3 Neither the TUI nor the agent terminal has a payment-specific answer path yet

Approval and veto are meant to arrive over the TUI, the agent terminal, or a
channel like Telegram (§8.2). The TUI's `ApprovalBroker` prompt card
(`goodvibes-tui/src/permissions/broker-approval-card.ts`) exists, but it
answers ordinary tool-permission asks; nothing in it or in the agent's
`PermissionPromptUI` (`goodvibes-agent/src/permissions/prompt.ts`) is wired to
a payment window, because payments does not route through `ApprovalBroker` at
all (§8.6). A reply arriving today only resolves a window over a channel
`PaymentReplySource` reads, in practice Telegram; there is no TUI or
agent-terminal affordance yet that calls anything, because there is no
operator method for it to call (§10).

So the remaining work is not porting a broker card, it is building the
`payments.purchase.approve`/`.deny`/`.cancel` verbs themselves and a TUI/agent
surface that calls them, which is the same gap §10 and §8.6 already name.

### 10.4 The master switch is a plain config key, not the SDK's flag registry

**Correction (2026-08-21, v2.0.19):** this section previously said the
capability registers in `platform/runtime/feature-flags/flags.ts`
(`FEATURE_FLAGS`) with a `FEATURE_SETTINGS_BINDINGS` entry in
`feature-settings.ts`. Neither file mentions payments anywhere today. Gating
is simpler than that: `checkPaymentGates` reads `payments.enabled` as an
ordinary daemon config boolean (`readPaymentsEnabled` in
`platform/payments/payments-config.ts`), default `false`, the same way every
other field in §3.2 is read. There is no separate feature-flag registration to
keep in sync, and no `defaultState`/`runtimeToggleable` metadata beyond the
config default itself.

The safety property this section was trying to describe still holds by a
simpler route: `enabled` defaults to `false`, nothing in this capability runs
until it is turned on, and turning it on is a config write like any other
payments setting (§3.2).

---

## 11. Test plan (adversarial, mandatory)

These are requirements on the capability's remaining wire work (§10), not
suggestions:

1. A purchase whose **merchant** derives from injected content is refused.
2. A purchase whose **amount** derives from injected content is refused.
3. A purchase whose **item** derives from injected content is refused.
4. A tainted purchase is still refused **with a valid `OwnerApproval` present**.
5. An approval message **cannot be influenced by page text**, byte-identical
   rendering across every injected page field.
6. An above-budget purchase with an **undeliverable notification does not
   happen**.
7. An in-budget purchase with an **undeliverable notification does happen**.
8. Silence on an above-budget approval **denies**; silence on an in-budget veto
   **proceeds**; and the two constants are asserted never to agree.
9. The **shipping ladder steps down one tier at a time**, stops at the cheapest,
   and records the step-down in the audit record and the veto message.
10. **No filler item is ever added**, cart lines match the request at payment
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
    resolves denied, not pending, the `ApprovalBroker` re-arm gap in §8.6.
18. A veto window that elapsed entirely while the daemon was down re-opens
    rather than auto-proceeding.
19. `'email'` never parses into `CommandAuthorityChannel`, and no payment prompt
    reaches an email path.
20. Card material entered at a surface never appears in input history, the
    transcript, a log line, or any operator response.

---

## 12. Rulings taken here, and what remains open

### 12.1 Ruled

Recorded so they are not re-litigated. Items 1 and 8–11 are owner rulings and are
closed. The rest were taken under zero-deferrals where no owner ruling existed;
any of them can be overturned by the owner, and none is a coin toss left in the
code.

1. **The CVV is stored (§9.5).** Owner ruling: the CVV is saved, full stop,
   because it is required for autonomous action. Settled and closed, see
   `docs/decisions/2026-07-27-the-cvv-is-stored.md`. `payments.cvvHandling`
   still ships as a real setting defaulting to `'stored'`; selecting `'prompt'`
   disables unattended purchasing and the surface says so at the moment of
   selection.
2. **`windows.approvalMinutes` defaults to 60 (§8).** Denial is the recoverable
   outcome, so too-short costs friction and too-long costs price drift on a held
   cart. An hour survives a meeting or a commute.
3. **A window interrupted by downtime is keyed on DELIVERY, not uptime
   (§8.6.1).** Silence means the owner had the chance to object and did not;
   whether our process was alive has nothing to do with it. A notification that
   was delivered and then expired stands, with a backfill for objections we might
   have missed and no re-notification. Only an un-backfillable channel re-opens.
4. **Exhausted overage pool refuses rather than escalating to an approval
   (§6 step 2).** The ruling is explicit. Recorded so it is not re-opened by
   accident.
5. **Money defaults are 0 and `enabled` is false (§3.2).** Derived from the
   safest-default rule. A freshly configured capability refuses everything until
   the amounts are set.
6. **Another currency, a subscription, and a refund credit are refusals by
   design (§9.7)**, each with its own named refusal and its own reasoning,
   not an unhandled case.
7. **Any configured command-authority channel may answer; first answer wins**,
   and the audit record names which one did. `notifyChannels` orders delivery,
   not the right to reply.
8. **A discovered merchant is graded, not refused (§9.1, §9.1.1).** Owner
   ruling, overriding this document's earlier position that "buy the cheapest X
   you can find" was refused by design: the blanket taint gate on the merchant
   was wrong. On an **owner-initiated** purchase, the merchant and checkout URL
   may derive from page content; the merchant standard then decides whether
   silence proceeds or denies. See
   `docs/decisions/2026-07-27-a-discovered-merchant-is-graded-not-refused.md`.
9. **Content-initiated purchases remain refused absolutely (§9.1).** Unchanged
   by the above, and the reason it is safe: what relaxed is *who chooses the
   merchant*, never *who initiates*. There is still no owner-approval escape
   hatch on this gate.
10. **The standard is recourse, not recognisability (§9.1.1).** Etsy is admitted
    mainly because the platform carries consumer protections, which makes
    recognisability evidence rather than the test. Established online-only
    retailers qualify with no physical stores.
11. **eBay is per-listing, with auctions refused structurally (§9.1.1).** Not a
    policy toggle: an auction has no final total, so the notify-then-pay flow
    cannot execute. Seller-side reputation only, and the check may only ever make
    the outcome stricter.

### 12.2 Still open

12. **`daemon.timezone` ownership (§4.1).** Built as a general daemon setting
    because payments should not own the platform's only clock. If another domain
    later wants its own zone, this becomes a default rather than the answer.
13. **Subscription detection is heuristic (§9.7.2).** It reads order-summary
    language and errs toward refusing. It will refuse some one-off purchases that
    merely mention a renewal elsewhere on the page. That trade is deliberate, but
    the false-refusal rate is unknown until it meets real merchants.
14. **Backfill coverage varies by channel (§8.6.1).** Telegram has a readable
    history; a channel without one is always treated as un-backfillable and
    re-opens. The set of channels that can be backfilled will shape how often a
    re-opened window shows up, and that is only measurable in use.
15. **eBay account age is not checked (§9.1.1).** `minAccountAgeDays` exists in
    `MarketplaceListingThresholds` and defaults to `null`, meaning no check. eBay
    does not expose a member-since date in a place that can be read reliably and
    attributed to eBay rather than the seller, and a threshold that silently
    failed closed on every listing would make the whole eBay path unusable while
    looking like a working check. The lever is built and off; turning it on needs
    a trustworthy source for the figure first.
16. **The shipped retailer list is a starting point, not a survey.** It covers
    the classes named in the ruling and the obvious members of each. Absence is
    not a judgement about a seller, it only means we ask. The list will need real
    use to find the retailers actually bought from, and
    `majorRetailersAdditional` is how the owner adds them without a release.

## 13. Related

- `docs/decisions/2026-07-27-daemon-refuses-derived-sends.md`, the taint ruling
  this capability inherits
- `docs/decisions/2026-07-27-a-discovered-merchant-is-graded-not-refused.md`, the owner's override of the blanket merchant refusal, and the recourse standard
  that replaced it
- `docs/decisions/2026-07-27-payment-windows-are-deliberately-opposite.md`, why
  the two windows must never be unified into one primitive
- `docs/security.md`, `SecretsManager`, storage policies, permission system
- `docs/secrets.md`, the `goodvibes://secrets/...` reference form
- `docs/contract-regeneration-recipe.md`, the procedure for the `payments.*`
  operator namespace
- `platform/security/content-taint.ts`, `untrusted-content.ts`,
  `turn-boundary.ts`, `link-validation.ts`, `public-suffix.ts`
- `platform/control-plane/approval-broker.ts`,
  `platform/daemon/approval-reply.ts`, the approval primitive and its channel
  resolution
- `platform/channels/delivery-router.ts`,
  `platform/automation/delivery-manager.ts`, delivery and undeliverable
  detection
- `platform/automation/schedules.ts`, the one-shot `{ kind: 'at' }` job the veto
  window runs on
- `platform/google/{types,console-flow,setup-flow}.ts`, the pause-and-hand-over
  pattern §9.6 adapts
- `platform/config/{secrets.ts,daemon-secret-keys.ts,config-ownership.ts,credential-status.ts}`
- `platform/runtime/surface-root.ts`,
  `platform/runtime/telemetry/exporters/local-ledger.ts`
