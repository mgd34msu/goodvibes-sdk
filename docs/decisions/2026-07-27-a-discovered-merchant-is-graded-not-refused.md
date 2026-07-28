# A discovered merchant is graded, not refused

**Date:** 2026-07-27
**Status:** Accepted (owner override of a shipped design decision)
**Applies to:** the payment capability, `docs/payments.md` §9.1 and §9.1.1

## What changed, and why this record exists

The taint gate refused any purchase whose merchant came from page content, and
`docs/payments.md` documented that refusal **as a feature**, tested as one:

> "buy me the cheapest X you can find online" is refused, because the merchant
> was chosen from page content rather than named by the owner. The owner names
> the merchant, or there is no purchase. This is a feature of the design and is
> tested as one.

The owner overrode it. This record exists because a later reader will find a
relaxed money gate and a deleted "this is a feature" paragraph, and that pattern
normally means someone worked around a safeguard. It was not worked around. It
was ruled on, and the ruling is narrower than it looks.

## His rulings, verbatim, in the order he gave them

> "the taint gate is wrong. if i tell you to buy the cheapest X you find online,
> you will 1) find it, 2) show it to me, and then 3) alert me prior to purchasing
> if it is not a major retailer - use your best judgement on what you consider a
> major retailer"

> "2 and 3 are basically the same step"

> "if the place we're buying isn't what the average person would consider a major
> retailer, silence means denial of purchase"

> "even smaller specialty retailers like microcenter would be considered major,
> unlike something like www.jeffsgadgets.biz"

> "something of a grey area is Ebay - i would allow buy it now purchases on Ebay,
> but only if the seller has a solid reputation from selling, not just buying"

> "even etsy is fine, mainly because they have consumer protections. so yeah, use
> judgement in situations like ebay, try to buy from established retailers --
> even established online-only retailers like redbubble etc, but be wary of
> storefronts like jeffsgadgets.biz"

## The distinction the old design missed

**Who initiates** and **who chooses the merchant** are two different questions.
The old gate answered both with one rule and refused both cases.

"Buy the cheapest X you can find" is *his* instruction. The item is his, the
intent is his, the budget is his — only the storefront was found on a page.
Refusing that does not stop an attack; it stops the feature, and it leaves the
actual risk (money going somewhere with no recourse) unaddressed, because a
merchant *he* names is not automatically one he can get his money back from.

## What did not move

**Content-initiated purchases are refused absolutely.** An email or a web page
saying "buy X from Y" cannot start a purchase, name a merchant, or set an amount.
There is **no owner-approval escape hatch** on this gate, for the reason the
payment path has always argued: the approval is exactly the step an injection is
trying to reach.

Two properties defend it:

- The payment path calls `findContentTaint` **directly** and never
  `evaluateOutwardEffect`, whose `OwnerApproval` branch would let a tainted
  action through. A test passes a valid `OwnerApproval` for the same action and
  asserts refusal anyway.
- The refusal is **structural, not textual**. The test that guards it uses a
  ledger whose content does not overlap any intent field, so the only thing that
  can refuse it is the origin rule — a text-match refusal would let the
  structural rule be deleted while the test still passed.

`item` and `requestedMax` are still always checked. They come from him or the
purchase does not exist.

## How the type carries it

`merchantDiscovered` exists only on `OwnerOriginIntent`, never on
`ContentOriginIntent`. "A discovered merchant is permissible only on an
owner-origin intent" is therefore a fact the compiler enforces, not a rule a
later edit can forget to check.

## The standard: recourse, not recognisability

The organizing principle is **recourse**. He named it when he said Etsy is fine
"mainly because they have consumer protections", and that established
online-only retailers like Redbubble count. Recognisability was the proxy;
recourse is the thing it stood for.

`jeffsgadgets.biz` fails not because it is small or obscure but because **there
is nobody to go to.** Micro Center qualifies at two dozen stores; Redbubble
qualifies with no stores at all.

## Judgement against a profile — NOT a curated list

The first implementation shipped a hardcoded allowlist of retailer domains. He
rejected it:

> "i didn't fucking say make a list of retailers, i said retailers matching that
> profile."

He is right, and the list was wrong on its own terms as well as against his
instruction:

- It **fails closed on every established retailer nobody enumerated.** A real
  merchant with real recourse would be treated exactly like `jeffsgadgets.biz`
  for the sole reason of being absent from a file.
- It requires permanent maintenance and rots silently.
- It is the same shape as the site-specific adapters this platform already
  rejected — scaffolding that thinks for the model instead of letting the model
  think.

So the mechanism is judgement against the profile, and the list is **deleted**,
not demoted. A fast-path cache was considered and dropped: purchases are
infrequent and already sit inside a checkout flow with a human notification
window, so it would buy nothing measurable while creating a second source of
truth that can disagree with the judgement and rot exactly as the allowlist
would have.

## The safety argument rests entirely on the judgement's INPUT

Two things look similar and are not:

- **Reading the page to decide whether it looks legitimate** — injectable, and
  still banned. A storefront built to look trustworthy is trivial to produce.
- **Judging a validated registrable domain against what is known about the
  world** — not page-derived at all. The domain comes from the URL that passed
  link validation and is reduced by `registrableDomain()`. Whether that retailer
  is established is a fact about the world, not a claim the page makes.

The earlier reasoning banned runtime judgement wholesale. That was sound
reasoning applied to the wrong input.

`MerchantJudgeInput` therefore has **exactly one field**, `registrableDomain`.
That is the structural guarantee: page content cannot reach the judgement
because the type has nowhere to put it. A test asserts the port is called with
exactly that key set, driving it with a hostile `sellerIdentity` and
seller-controlled reputation figures present in the merchant record.

If a future change wants to widen that input, that is a signal to stop.

## Uncertainty resolves to not-major

Unchanged and load-bearing. A judgement that is not confident has the same
effect on spending as a negative one. The cost of asking about a real retailer
is one message he answers; the cost of the reverse is money spent somewhere he
never approved.

## The owner's overrides stay authoritative

`payments.majorRetailersAdditional` and `payments.majorRetailersExcluded` beat
the judgement in both directions. An exclusion short-circuits before the judge
is consulted at all. Additions remain his alone — nothing learned, nothing
inferred from a page, nothing added by an agent — because anything that could
argue itself onto that list could buy from itself unattended.

## eBay: per-listing, and auctions refused structurally

**Auctions are refused as a structural impossibility, not a policy preference.**
The flow he designed is: know the final total → notify him → run the window →
pay. An auction has no final total until it ends, so that flow cannot execute at
all. This is recorded explicitly because "make auctions configurable" is an
obvious-looking future request, and it is not a configuration question. Best
Offer and any unconfirmable format fall under the same reasoning.

**Reputation is read seller-side only**, because eBay's headline score mixes
buying and selling and a large number can have been earned entirely by buying.
Defaults ≥98% positive as a seller and ≥100 seller ratings, both configurable.

The check is a **ratchet**: it may only ever make the outcome stricter. No
reputation figure promotes a domain that was not already recognised. Unreadable
figures, or figures from a seller-controlled region of the page rather than
eBay's own widget, mean not-major and he is asked. If the region cannot be told
apart, the figure is unreadable.

## Recourse must survive the checkout

Matching is on the validated registrable domain **that takes the card**. An
established retailer that hands off to a payment page on an unrelated registrable
domain no longer carries the protection the qualification rested on — that is
not-major, and the notification says why.

## What a later reader must not "clean up"

- **The absolute content-origin refusal.** It looks like a special case of the
  taint check. It is not, and it must not be routed through
  `evaluateOutwardEffect` for consistency.
- **The auction refusal**, into a configurable policy.
- **The curated list**, into anything that learns, scores or infers.
- **`merchantDiscovered` living only on the owner-origin type**, into a plain
  boolean field on a unified intent type.

## Where it lives

- `platform/payments/taint-gate.ts` — origin rule, conditional field checks
- `platform/payments/merchant-recourse.ts` — the criterion, the judge port, the
  config seam (`merchantPolicyFromConfig`)
- `platform/payments/marketplace-listing.ts` — the eBay per-listing conditions
- `platform/payments/message.ts` — `renderPurchaseNotice`, the single send site
- `test/payments-merchant-recourse.test.ts` — the rulings as tests
- `docs/payments.md` §9.1, §9.1.1 — the full design
