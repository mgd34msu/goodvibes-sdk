# Inbound email — design

**Status:** design of record. Implementation follows this document.

The daemon could send mail and could read mail *when asked*. Nothing ever asked
on its own, so the mailbox was a capability the agent used while you talked to
it, never a channel that could reach it. The owner replied to an email the agent
sent and got nothing back, because nothing was listening.

This document specifies the listener.

Read §5 before the feature sections. Inbound mail is the highest-volume
untrusted-content path the daemon has, and it arrives while nobody is watching.

---

## 1. What was actually missing

Verified against the tree at `1.18.1`, not inferred:

- Email is not among the eighteen inbound surfaces in
  `packages/sdk/src/platform/adapters/`. Google **Chat** is there; Gmail is not.
- No interval, poller, subscription or scheduled inbox check exists in
  `platform/email/` or `platform/google/`. `EmailService` opens a socket per
  call and closes it. The only `setInterval`s that mention "inbox" are the
  facade's surface-reply queue and the fleet registry's in-process agent
  mailbox, neither touches IMAP.
- `platform/email/imap-client.ts` lists `IDLE / NOTIFY push` under
  "Not supported (document boundaries)".

So this is not a bug in a delivery path. There was no delivery path.

---

## 2. The authority rule — settled, not up for redesign

Email has **no command authority**.
`surfaceHasCommandAuthority('email')` returns false and stays false;
`AuthoritySurface` grants command authority to `'owner-direct'` alone.

The distinction that makes inbound mail buildable without breaking that:

| | May it happen? |
|---|---|
| An arriving message **satisfies an expectation** an authorized workstream registered in advance | Yes, this is the entire mechanism |
| An arriving message **creates work**, starts a workstream, spawns an agent, or initiates anything | **Never** |
| An arriving message **registers, widens or extends** an expectation | **Never** |
| No expectation matches | The mail is inert: recorded, owner told, nothing else |

An expectation is registered **before** the mail arrives, by the workstream that
already holds authority, scoped to a specific recipient address, a specific
service domain, a specific purpose and a bounded window. This is
`VerificationExpectationBook` in
`packages/sdk/src/platform/google/verification-expectations.ts`, and it is
reused rather than paralleled.

Matching is keyed on `DeliveredRecipient`, the branded type in
`platform/google/delivery-evidence.ts` whose brand symbol is not exported, so
no value can be fabricated outside that module, and whose three constructors
accept only the mailbox actually fetched from or the top-most
`Delivered-To`/`X-Original-To` stamped by the receiving delivery agent. The
`To:` header is never a correlation key; it is carried as
`unverifiedToHeaderClaim` for display and nothing reads it for a decision.

### 2.1 The spawn capability is removed structurally, not guarded

Every existing adapter is handed a `SurfaceAdapterContext`
(`platform/adapters/types.ts`), and that context supplies `trySpawnAgent`,
`queueSurfaceReplyFromBinding` and `publishConversationFollowup` as **required
fields**. The shared adapter path does not merely permit spawning work, it
hands every adapter the means as part of its argument.

Worse, there is a live trap waiting for anyone who wires email through that
path. The spawn decision for channel surfaces is made by `gateSurfaceSpawn`
(`daemon/surface-conversation-gate.ts`), which classifies inbound text as
conversation-or-work and, for gated surfaces, *proposes* work rather than
starting it. Whether a surface is gated is decided by `isGatedSurface()` against
`CONVERSATION_GATE_DEFAULT_SURFACES` (`agents/conversation-gate.ts`), which
lists fourteen surfaces and **does not include `'email'`**. Its fallback rule
gates *unknown* surfaces, but `'email'` passed explicitly is a known non-TUI
string, so it lands in the `else` branch and is **not gated**. An email adapter
written the ordinary way, passing `surface: 'email'`, would let any message that
reads as a work request spawn an agent immediately, skipping propose-and-wait.

A comment saying "email must not call this" is not a boundary. Neither is a
runtime `if`. Two independent things close it:

**First, the capability is absent from the type.** The inbound-mail watcher is
never given a `SurfaceAdapterContext` at all. It is given a purpose-built
context carrying only what reading mail requires:

```ts
export interface InboundMailContext {
  readonly configManager: { get(key: string): unknown };
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'> | undefined;
  readonly transport: EmailTransportPort;
  readonly expectations: ExpectationMatcher;   // NOT the book — see below
  readonly records: InboundMailStore;
  readonly cursors: MailboxCursorStore;
  readonly deliverOwnerNotice: (text: string) => Promise<SurfaceNoticeDelivery>;
  readonly now: () => Date;
}
```

There is no `trySpawnAgent` to call, no `sessionBroker` to submit to, and no
`queueSurfaceReplyFromBinding` to reply through. The compiler rejects the call,
not a reviewer.

**The same narrowing applies to expectations, and my first draft got it wrong.**
It handed the inbound path the whole `VerificationExpectationBook`. That book
carries `openExpectation`, and now also `hydrateExpectation`, two methods that
insert. Holding it would make inbound code structurally able to register an
expectation, which is precisely what §2 forbids and precisely the mistake this
section refuses to allow for `trySpawnAgent`. Same principle, and it nearly went
through on the very rule the round exists to enforce.

So the inbound path holds a match-only view:

```ts
export interface ExpectationMatcher {
  matchCandidate(input: VerificationMatchInput): VerificationMatchResult;
  // deliberately absent: openExpectation, hydrateExpectation,
  // and every other method that inserts, widens or extends.
}
```

`VerificationExpectationBook` satisfies this structurally, so nothing is
wrapped or duplicated, the watcher simply cannot name what it does not hold.
`hydrateExpectation` is boot-only: the wiring calls it from the store's recovery
sweep, never the watcher. Enforced by a type-level test and by a source-level
test that no file under `platform/email/inbound/` mentions either method. Three tests hold the line: a runtime own-property assertion (so
a later widening is caught even if it type-checks), a type-level test asserting
`InboundMailContext` is not assignable from anything carrying a spawn field, and
a source-level test asserting no file under `platform/email/inbound/` references
`trySpawnAgent`, `sessionBroker` or `AgentManager`.

**Second, the trap is closed anyway.** `'email'` is added to
`CONVERSATION_GATE_DEFAULT_SURFACES`. This round does not need it, nothing here
reaches `gateSurfaceSpawn`, but leaving a surface name that fails open in a
list whose whole purpose is failing closed is a defect waiting for the next
person who wires email the ordinary way.

`authorizeSurfaceIngress` takes a `surface` union that does not include
`'email'`, and it is **not** widened. That union enumerates surfaces that can
authorize ingress into a conversation. Email cannot, so adding it would be the
exact assumption this section removes.

### 2.2 The expectation mechanism has never actually run

`VerificationExpectationBook` is fully built and thoroughly tested, and
`grep` finds **no production instantiation anywhere in the SDK**, only tests
construct it. The machinery the authority rule depends on is, today, dead code.

So "reuse the existing mechanism rather than inventing a parallel one" also
means *wire it for the first time*, including:

- constructing the book at daemon boot with a real `SurfaceAuthorityProbe`
  backed by `surfaceHasCommandAuthority`, so its own defensive check, which refuses to open an expectation if email ever gained command authority, stops being dormant;
- giving it the persistence described in §9.2;
- exposing `openExpectation` to authorized workstreams (account signup,
  payments) through the control plane, and exposing it to **nothing** that an
  arriving message can reach.

### 2.3 Registration is an explicit verb, and it did not exist

§2.2 said the book had never been instantiated. It was worse than that, and the
gap made the whole capability inert: **nothing ever registered an expectation.**
Verified, `openExpectation` has no production call site anywhere in
`packages/sdk/src`, and `new VerificationExpectationBook` appears only in tests.

So the chain was: a signup begins, nothing records what is being waited for,
the mail arrives, the matcher correctly finds no expectation, and the message is
correctly treated as unexpected and does nothing. Every part worked. The middle
was missing, which is the same failure shape as a notice that is rendered and
never sent.

**Ruling: registration is an explicit verb the model calls before submitting the
signup form.** Not inference, and not a
watcher that detects a signup and opens one on the workstream's behalf.

The reasoning is the part to build to. An expectation created by inference is
created **by content**, the page being filled in, or a heuristic reading of it.
That inverts the authority model this entire document rests on. Expectations
must be created by the already-authorized workstream, in advance, or
"mail may satisfy an expectation but may never create work" is decorative
rather than structural. A verb makes the authorization explicit and auditable:
the model was already authorized to do the work, it declares what it is about to
expect, and the daemon holds the record. The same shape as
`payments.checkout.fillCard`, the model orchestrates, the daemon holds the
privileged state.

Three verbs, in the email catalog family:

| Verb | Why it exists |
|---|---|
| `email.expectation.open` | Declares the service domain, the purpose and the recipient address, with a window defaulting to `expectationWindowMinutes` and hard-capped by `MAX_VERIFICATION_WINDOW_MS`. Returns a handle. A caller cannot exceed the ceiling by asking |
| `email.expectation.list` | Disclosure. §9 requires persisted state to say what it holds |
| `email.expectation.cancel` | A signup abandoned before submission must not leave an expectation sitting until expiry |

The constraints are unchanged and all of them are structural rather than
documented: the inbound path holds a match-only `ExpectationMatcher` and cannot
reach these verbs; matching stays keyed on `DeliveredRecipient` and never on the
`To:` header; and an expectation that passes its window **fails with a named
reason and is reported** through the same observer path §3.4b uses for terminal
failures, rather than lapsing into silence.

---

## 3. Real-time delivery

### 3.1 The mechanism, and why

**IMAP IDLE is primary.** Confirmed rather than assumed:

- It is true push. RFC 2177: the server answers `IDLE` with a `+` continuation
  and then sends untagged responses as they occur; the client ends it by
  sending `DONE`.
- It is provider-agnostic, one implementation serves Gmail, Fastmail, a
  self-hosted Dovecot, and the owner's actual provider, whatever it is.
- It works over the authentication already shipped. The client's `open()` does
  `AUTHENTICATE XOAUTH2` when the password starts with `Bearer ` and `LOGIN`
  otherwise; IDLE needs neither changed.
- It needs no public endpoint, no cloud project, and no inbound port on a home
  network.

RFC 2177, verbatim: *"clients using IDLE are advised to terminate the IDLE and
re-issue it at least every 29 minutes to avoid being logged off"*, because
*"The server MAY consider a client inactive if it has an IDLE command running,
and if such a server has an inactivity timeout it MAY log the client off
implicitly at the end of its timeout period."* So the watcher re-issues on a
timer well inside that bound (default 27 minutes, see §7), not at 29.

**Adaptive polling is the fallback**, not a second-class citizen: it runs when
the server does not advertise `IDLE` in its `CAPABILITY`, when `IDLE` is
refused, and while the connection is down. Backoff is exponential with jitter
and a ceiling, because a mail server that just refused us is not helped by
being asked faster.

**Gmail `users.history.list` is built, and is inert under the shipped OAuth
grant.** This is the finding that changes the plan, and it is stated plainly
rather than discovered later:

> `setup-plan.ts` requests exactly one scope,
> `https://www.googleapis.com/auth/calendar.events`, and
> `REQUIRED_SERVICES = ['calendar-json.googleapis.com']`. There is no Gmail
> scope in the grant at all. `GoogleApiClient`'s `listMessages`/`getMessage`
> exist in code but are structurally unauthorized today. The module's own doc
> says mail is reached over IMAP/SMTP with an app password, *"which is not an
> OAuth grant at all and sits entirely outside the verification regime."*

Gmail read scopes are **restricted** scopes: Google gates them behind app
verification and an annual third-party security assessment. Requiring the owner
of a home daemon to complete that is the highest-friction option available, and
the standing tiebreaker is least friction. So:

- `users.history.list` **is implemented**, as `historyListDelta()` on the Google
  path, because the brief asks for it and because it is the right call the day a
  Gmail scope exists.
- It is **capability-gated on the granted scope set**, checked at runtime
  against the token's actual scopes rather than assumed.
- When no Gmail scope is present it reports
  `unavailable: 'no-gmail-scope'` in health, visibly, in the surfaced status, and the IMAP IDLE watcher serves the Gmail account instead. Gmail speaks IMAP
  IDLE with an app password, so the account is covered either way.
- It never silently does nothing. A capability that is off must say it is off.

**Gmail `users.watch` + Pub/Sub is rejected, and not built.** Four separate
pieces of setup friction, one of which is disqualifying on its own:

1. It delivers to an HTTPS **push endpoint**. The daemon runs on a home machine
   behind NAT. There is no endpoint to deliver to, and inventing one means
   asking the owner to expose a public URL just to receive mail.
2. It needs a GCP project with a Pub/Sub topic and an IAM binding granting
   `gmail-api-push@system.gserviceaccount.com` publish rights.
3. It needs the same restricted Gmail scope as `history.list`, so it inherits
   every problem above and adds infrastructure.
4. The watch registration **expires and must be renewed**, so it adds a
   recurring failure mode whose symptom is silence, the precise failure this
   whole round exists to eliminate.

It also buys nothing IDLE does not already deliver: both are push, both are
sub-second, and only one of them works for a mailbox that is not Gmail.

### 3.2 What must be fixed first — the IMAP client cannot hold a connection

IDLE is not a new method on the existing client. Four blockers are in the way,
all verified by reading the code:

**(a) A new session object is constructed for every command.**
`ImapClient.session()` (`imap-client.ts:583`) returns
`new ImapSession(...)` on every call, and every public method calls it. Two
consequences: `ImapSession.buffer` is reset to `''`, discarding any bytes
already received and not yet consumed; and `tagCounter` restarts at zero, so
every command in the connection's life is issued as tag `A0001`. Under strict
request/response this mostly survives. With an `IDLE` in flight and a second
command issued, two live commands share one tag. **Fix:** one `ImapSession` per
connection, constructed in `open()` and held.

**(b) Nothing reads the socket between commands.**
`readTaggedResponse` attaches `data`/`error`/`close` listeners and removes them
in `cleanup()`. Outside a command there is no listener, and the untagged
`* n EXISTS` that IDLE exists to receive has nobody to receive it. **Fix:** a
persistent line reader owning the socket for the connection's lifetime, with a
subscriber list, so tagged-command collection and untagged-event dispatch read
the same stream instead of competing for it.

**(c) Every read has a 15-second timeout.**
`IMAP_DEFAULT_TIMEOUT_MS = 15_000` applies to `readUntil` and
`readTaggedResponse` alike. An IDLE that must wait up to 27 minutes in silence
times out 108 times over. **Fix:** IDLE uses a separate long-read path with no
per-read deadline, bounded instead by the re-issue timer and by a liveness check
(§3.4).

**(d) `fetchEnvelopes` reports a sequence number in a field named `uid`, a
live defect, user-reachable today.**
`imap-client.ts:390` sets `uid: seqNum` from the values returned by `SEARCH`.
`email-service.ts:486` feeds it exactly those, and `listInbox` returns them as
`uid`. `email.inbox.read` documents its parameter as *"an IMAP UID: a positive
integer"*, passes it to `readMessage(uid)` → `fetchMessage(uid)` → `UID FETCH`.

So listing a mailbox and then reading from that listing reads **a different
message** whenever a sequence number and a UID differ, which is every mailbox
that has ever had a message deleted. The file's own header explains precisely
why this is wrong (*"a sequence number from then may by now belong to a
different message"*) and the code does it anyway. The 404 text, *"It may have
been moved or deleted since it was listed"*, misattributes the resulting failure
to the mailbox.

This is not incidental to inbound mail. A durable cursor **must** be UID-keyed,
because sequence numbers renumber on every expunge. **Fix:** `UID SEARCH`
instead of `SEARCH`, `UID` added to the FETCH data items, and the real UID
parsed and reported.

**(e) The body preview is attached to the wrong message.** Same code path,
separate defect. `SEARCH` returns sequence numbers in ascending order, so
`seqNums[0]` (`email-service.ts:491`) is the **oldest** match, while
`fetchEnvelopes` keeps `seqNums.slice(-limit)`, the **newest**. The preview
fetched from the oldest message is then attached to `messages[0]`, a different
message, under a comment calling it "the newest message"; `recordIngest`
attributes that text to the wrong sender too. **Fix:** select the preview target
from the same bounded, ordered set the envelopes come from.

### 3.3 The IDLE loop

One long-lived connection per configured mailbox, in a new node-only module
`platform/email/imap-idle.ts` (protocol and policy) with its socket supplied by
the existing `EmailTransportPort`, matching the module's standing rule that
nothing importing `email/index.js` drags `node:tls` in behind it.

```
connect → authenticate → EXAMINE mailbox → CAPABILITY check
  ├─ no IDLE advertised ─────────────────────────► adaptive poll loop
  └─ IDLE advertised
       issue "IDLE", await "+" continuation
       read untagged responses until one of:
         · EXISTS / RECENT       → send DONE, drain, fetch delta, re-IDLE
         · EXPUNGE / VANISHED    → send DONE, reconcile cursor, re-IDLE
         · re-issue timer fires  → send DONE, drain, re-IDLE
         · socket error / close  → reconnect with backoff
         · shutdown requested    → send DONE, LOGOUT, close
```

Correctness details that are easy to get wrong and are therefore specified:

- **`DONE` is not a tagged command.** It is a bare line answering the server's
  continuation request. The tagged completion that follows belongs to the
  original `IDLE` tag, and the reader must match it to that tag rather than
  allocating a new one.
- **Untagged responses may arrive at any time, including during the `DONE`
  handshake.** Anything received between sending `DONE` and reading the tagged
  completion is real and is processed, not discarded.
- **`EXISTS` is a mailbox total, not a delta.** `* 12 EXISTS` means the mailbox
  now holds 12 messages; it does not mean message 12 is new, and it does not say
  how many arrived. The count is a *wake-up*, never a message identity. The
  actual delta is always fetched by `UID SEARCH UID <cursor+1>:*`.
- **`EXPUNGE` renumbers everything above it.** This is precisely why the cursor
  is UID-keyed and why `EXISTS` is not treated as arithmetic. An `EXPUNGE`
  requires no refetch, it cannot produce new mail, but it invalidates any
  in-flight sequence numbers, so any pending sequence-number work is dropped
  rather than reused.
- **Nothing is marked `\Seen`.** `EXAMINE` keeps the mailbox read-only and every
  fetch uses `BODY.PEEK`. Reading the owner's mail must not silently mark it
  read. This is also why the cursor cannot be the server's `\Seen` flag, see §4.

### 3.4 Reconnection, and the failure modes that actually happen

- **Backoff:** exponential from 1s, doubling to a 5-minute ceiling, with
  full jitter so a provider outage does not produce a synchronized retry storm
  across every mailbox and every restart.
- **A reconnect never loses messages**, because recovery is not "resume the
  stream", it is "ask what is above the persisted cursor". Whatever arrived
  while the socket was down is above the cursor and is fetched on reconnect.
  This is the property the design is built around and the one §9 tests directly.
- **Liveness, not just connectedness.** A silently-dead TCP connection reads as
  a healthy IDLE forever. The re-issue timer doubles as the liveness probe: if
  a re-issue does not complete its round trip within the operation timeout, the
  connection is treated as dead and rebuilt.
- **Too many simultaneous connections.** Gmail permits 15 concurrent IMAP
  connections and the existing `EmailService` opens a *fresh* connection per
  request, on top of the one the watcher holds permanently. That error is
  therefore an expected condition, not an outage: it backs off on a longer
  ceiling and reports `degraded` with the provider's own wording, rather than
  hammering a limit that hammering cannot clear.
- **Authentication failure is terminal, not transient.** A rejected credential
  is retried once (to absorb a token that expired mid-connection and can be
  refreshed) and then stops, reports `failed` with the reason, and waits for a
  configuration change. Retrying a bad password on a backoff loop is how an
  account gets locked.
- **A timeout is not a rejection.** A `LOGIN` that is never answered is a
  network stall, not a bad credential, and classifying it by the phase it
  timed out in would make it terminal and stop the watcher retrying forever.
  Terminal classification is reserved for an actual server refusal (`NO` /
  `BAD`) and for a credential string that cannot be sent at all.
- **A terminal state is announced, not merely recorded.** A watcher that stops
  permanently because the credential was genuinely rejected says so on an
  authoritative channel, naming the exact step to fix it. Silent permanent
  death is the failure this entire round exists to eliminate: an inbox that
  looks quiet while verification mail piles up behind a locked door.

### 3.4c Credentials are read at daemon scope

The watcher runs in the daemon, so it reads credentials at **daemon scope**,
and it does not fall back to a surface-local store.

This is not hypothetical. The owner hit a live failure where the daemon
reported no email capability at all, because `/google adopt` in the agent wrote
credentials to the agent's own secret store while the daemon reads a different
one. A separate round is fixing that generally, a credential the daemon needs
is written at daemon scope regardless of which surface captured it.

A fallback that searches a surface-local store would paper over exactly that
bug, and would do it invisibly: the daemon would work on the machine where the
agent happened to run and fail everywhere else, for reasons nobody could see.
So a credential absent at daemon scope is a **capability failure with a named
reason** (§3.4a), reported as such, not a cue to go looking elsewhere.

### 3.4a Capability sufficiency is a precondition, not a Gmail detail

A defect caught in review generalizes into a rule for the whole inbound path,
so it is stated here rather than left in one module.

The Gmail delta path originally gated on scopes that authorize
`users.history.list`, a set that includes `gmail.metadata`. Google's scope
documentation describes that scope as *"View your email message metadata such as
labels and headers, but not the email body."* So a metadata-only token passed
the gate, the call succeeded, and the result was `ok: true` with every body
empty. **A success indistinguishable from a real one is the worst shape a defect
can take in a delivery path**, and it is worse here than almost anywhere,
because the mailbox going quiet is exactly what a working mailbox looks like on
a slow day.

The rule:

> A connection that authenticates but cannot deliver what the caller needs
> fails **loudly, at connect time, with a named reason and the exact step to
> fix it**. It never returns empty-looking success.

This is a **precondition of the inbound path**, evaluated before the watcher
reports healthy, not a per-provider check:

- **Gmail API path**, two scope tiers, checked separately. Scopes that
  authorize the history call, and scopes that authorize bodies
  (`gmail.readonly`, `gmail.modify`, `https://mail.google.com/`, *not*
  `gmail.metadata`). History-capable but not body-capable refuses **before**
  making the call.
- **IMAP path**, `open()` reports a typed capability record rather than
  returning `void` and letting "connected" stand in for "can read this mailbox":
  whether `IDLE` is advertised (which decides push vs poll), whether
  `EXAMINE <mailbox>` actually succeeded, the `UIDVALIDITY` it reported, and a
  clear distinction between *authentication rejected*, *mailbox does not exist*,
  and *connected and readable*. The server's own wording is carried into the
  failure reason where it gave one.

### 3.4b What happens when capability is insufficient at runtime

Setup-time validation is not enough. Scopes get revoked, app passwords get
rotated, mailboxes get renamed, and all of that happens long after setup while
the daemon is running unattended.

Three runtime states, all distinct and all surfaced in health:

| State | Meaning | Watcher |
|---|---|---|
| `healthy` | Full capability, **including polling the owner explicitly configured** | Running, IDLE or polling |
| `degraded` | Reduced in a way the owner did not choose, e.g. IDLE unavailable, so *falling back* to polling | **Running.** Expectations still work |
| `insufficient` | Cannot read the mailbox, cannot fetch bodies, or cannot keep a durable cursor | **Not running** |

**Configured polling is `healthy`, not `degraded`** (reason
`polling-configured`). A permanent amber light on a working configuration the
owner deliberately chose is the same alarm fatigue the notify-once rule exists
to prevent, a health indicator that is always yellow is one nobody reads.
*Fallback* polling stays `degraded`, because that genuinely is a reduced state
nobody asked for. The distinction is between "this is what you chose" and
"this is less than you asked for".

**`uidvalidity-missing` is an `insufficient` reason.** A server that answers
`EXAMINE` without reporting `UIDVALIDITY` cannot support the durable cursor §4
depends on, so after a restart the watcher would either silently skip messages
or silently redeliver them. Both are invisible, and both are worse than
refusing. It refuses.

**A missing `UIDNEXT` is derived, not assumed, and never assumed to be zero.**
`[UIDNEXT n]` on `EXAMINE` is a SHOULD in RFC 3501, not a MUST, and servers omit
it. The high-water mark was computed as `(status.uidNext ?? 1) - 1`, so an
absent `UIDNEXT` established the cursor at UID 0, below every message that
exists. The first drain then searched `UID 1:*`, matched the whole mailbox, and
delivered every message in it to the owner's notification channel as new mail.

The note it had just emitted said the opposite in three clauses at once
("Listening from UID 0 onwards", "*n* message(s) already in the mailbox were not
read", "starts listening now rather than backfilling"). The `uid-validity-changed`
arm was worse still: "A rebuilt server index is not a reason to re-announce a
year of old mail", followed by re-announcing a year of old mail.

This is **not** resolved the way `uidvalidity-missing` is, and the difference is
the point. Nothing can supply a missing `UIDVALIDITY`, so refusing is the only
option there. `UIDNEXT` is one core `UID SEARCH` away.

So the watcher asks `UID SEARCH UID 1:*`, the same question put directly,
through the same `searchAboveCursor` the drain already uses, and takes the
highest answer as the mark and the count of answers as the skipped total. The
count comes from the search rather than `EXISTS` because a server terse enough
to omit `UIDNEXT` may omit `EXISTS` too, and `exists ?? 0` would then make the
note claim nothing was skipped while skipping several. Refusing instead would
take inbound mail away from every conforming-but-terse server over a field the
RFC never required.

Two things are refused rather than derived:

- **A search that fails** is classified exactly as the drain classifies one. A
  refused `SEARCH` is a reconnect, never a capability verdict (§13.1), so a
  hiccup on the first connection cannot permanently disable a mailbox.
- **A search that succeeds while naming nothing**, on a mailbox whose own
  `EXISTS` says it holds messages, is a contradiction with no trustworthy mark
  behind it. That is `mailbox-position-unknown`, an `insufficient` reason of its
  own rather than `uidvalidity-missing`, which would send the owner to check a
  field that was present and correct.

And whichever path runs, **the cursor note describes what actually happened**,
including that the mark was reached by asking. A note that contradicts the
behaviour is worse than no note.

The question lives in `mailbox-position.ts`, on the seam `poll-loop.ts` already
sits on: that file knows how to ask the server what arrived and returns a
report, and the watcher decides what a failed drain *means* for the capability
verdict. `resolveMailboxStartPosition` is the same split applied to the position
question, it knows the protocol and not the verdict vocabulary, and returns a
discriminated `MailboxStartPosition` so that "we could not establish a position"
cannot be read as a position.

The split was forced by the 800-line cap, which `watcher.ts` sat exactly on.
That is the cap doing its job rather than an inconvenience: the file had
accumulated a second responsibility, and the grandfather list is for violations
that predate the gate, not for new growth.

**"The watcher does not run" means the connection is closed, not merely that
reading stopped.** This distinction cost a real defect, and is written down
because it reads as pedantry right up until it bites.

A `fetch-refused` or `uidvalidity-missing` verdict is reached *while the socket
is still open*, and putting the hour-long re-check wait right there is the
obvious thing to do. Doing so holds one of the provider's connections, one of
Gmail's fifteen, for a full hour, on behalf of a mailbox the daemon has already
decided it cannot read. That is the same limit pressure the `connection-limit`
verdict exists to absorb, applied by us, against every other mailbox, for
nothing.

So a verdict is **reported where it is found**, and the wait happens in the run
loop **after the connection is closed**. The general rule, which applies to
every long wait this design introduces:

> A state that means "not working" must release what working required. If it
> does not, it is not that state, it is the same work, holding the same
> resources, with the reporting changed.

**Ruling: `insufficient` refuses and notifies. It does not silently degrade.**
`surfaces.email.inbound.onInsufficientCapability` defaults to
`'refuse-and-notify'`; `'notice-only'` exists as a deliberate, configured
downgrade and is never entered automatically.

The reasoning, since this rejects the more accommodating option:

1. **An expectation that can never be satisfied is worse than no expectation.**
   The signup workstream would wait out its entire window and then report "no
   verification mail arrived", which is false. It would send the owner to check
   the mailbox when the problem is the grant, and the mailbox will look fine.
2. **Automatic degradation reintroduces the exact defect one level up.** We just
   removed a silent partial capability from the Gmail gate; adding a silent
   partial capability to the surface that consumes it would be the same bug with
   a wider blast radius.
3. **Least friction is not "keep running in a broken mode."** It is one message
   naming what is missing and the step that fixes it. A daemon that quietly
   half-works costs more of the owner's time than one that says
   "this grant is metadata-only; inbound email needs `gmail.readonly`."

Consequences that make the refusal honest rather than merely safe:

- **Opening an expectation against an `insufficient` mailbox is refused at open
  time**, with that reason. The signup workstream learns immediately instead of
  after fifteen minutes of silence.
- **Expectations already open when capability is lost are failed with a named
  reason**, not left to expire. This is the "cannot silently sit unsatisfied"
  requirement, and expiry is not an acceptable substitute for it: expiry means
  *nothing came*, and this is *we can no longer look*.
- **"Cannot" and "not yet" are different.** A watcher in backoff after a dropped
  connection is **not** insufficient, recovery fetches everything above the
  cursor, so the expectation is still satisfiable and must not be failed.
  Only a capability verdict fails an expectation.
- **Re-probed on a timer** (`capabilityRecheckMinutes`, default 60) and on
  config change, so fixing the scopes does not require a restart to take
  effect. Not a tight retry loop.
- **Notified once per transition**, not once per probe. A recurring alarm about
  a condition the owner already knows about trains the owner to ignore the
  channel this capability depends on.

### 3.4d Two sources behind one interface — Gmail is first-class

Verification mail arriving on a Google mailbox did not work, because the watcher
was IMAP-only. A user who had already adopted Google credentials would still be
asked to find an IMAP host, a username and an app password to get real-time
inbound **for a mailbox the daemon can already read**. That is friction we
invented, in the middle of the exact journey this capability exists to serve.

**Ruling: Gmail is a first-class inbound source, and the preferred one when
Google credentials are present.**

The watcher takes a **mail source**, not an IMAP connection:

```ts
export type SourceLatency =
  | { readonly kind: 'push' }
  | { readonly kind: 'poll'; readonly worstCaseMs: number };

export interface InboundMailSource {
  readonly kind: 'imap' | 'gmail-history';
  /** Connect and report capability (§3.4a). Never returns empty-looking success. */
  start(signal: AbortSignal): Promise<InboundCapabilityVerdict>;
  /** Run until aborted, delivering to the sink. Push or poll is the source's business. */
  run(signal: AbortSignal): Promise<void>;
  /** Disclosed to the owner, so "real-time" is never claimed for polling. */
  readonly latency: SourceLatency;
  stop(): Promise<void>;
}
```

Some of the seam already exists. `InboundMailSink`, `MailboxCursorPort`,
`InboundMailObserver` and `InboundCapabilityVerdict` are source-agnostic; only
`MailboxConnectionPort`, `MailboxReader` and `MailboxWire` are IMAP-shaped.
**Expectation matching, taint labelling, dedup, notice rendering, cursor
persistence and owner disclosure are written once and serve both sources.**

**Correction, this paragraph originally listed `InboundMailboxMessage` among
the source-agnostic types, and that was wrong.** As shipped it carries
`uidValidity: number`, `uid: number` and `envelope: ImapEnvelope`, three
IMAP-specific fields. A Gmail message has an opaque message id, a `historyId`
that is a decimal uint64 string, and no UID or `UIDVALIDITY` at all.

The error was mine and it was avoidable: I read the *export list* and inferred
from the name rather than reading the fields. So the message becomes a
discriminated union on source, exactly as the cursor does, see
`docs/decisions/2026-07-27-inbound-message-is-a-discriminated-union.md`. Widening
it with optional fields was rejected for the same reason it was rejected for the
cursor: a record that can be half-filled is a record that will be.

- **IMAP source**, IDLE, wrapping the existing watcher.
- **Gmail source**, `collectHistoryDelta` over `users.history.list`, already
  built, with the two-tier scope gate already landed.

#### Selection is automatic

Google adopted **and** the configured mail account is a Gmail account ⇒ the
Gmail source. Otherwise ⇒ IMAP. **Adopting Google should be the entire setup**;
no setting has to be found for the common case.

`surfaces.email.inbound.source`, `'auto' | 'gmail' | 'imap'`, default
**`'auto'`**, exists so either can be forced, per the rule that every flag
ships as a real configurable feature. But the default requires no configuration
at all when Google is already connected.

#### What each source costs, stated honestly

| Source | Mechanism | Worst-case delay |
|---|---|---|
| IMAP | IDLE, **true push** | Sub-second; bounded by the 27-minute re-issue sweep if a push is ever missed |
| Gmail | `users.history.list`, **polling** | The poll interval. Nothing faster is possible on this path |

**Gmail is not real-time and this design does not call it that.** It is polling
with a latency floor, and the number is disclosed rather than dressed up. For a
verification link during a signup, a few seconds is fine, and an honest number
is worth more than a marketing word.

The interval is **adaptive**, because the two situations have genuinely
different needs:

| Setting | Default | Why |
|---|---|---|
| `surfaces.email.inbound.gmailPollSecondsExpecting` | **5** | An expectation is open, a signup is mid-flight and someone is waiting. Worst case ~5s. `history.list` costs 2 quota units against a daily budget in the billions, so this is free in practice. Range 2–60 |
| `surfaces.email.inbound.gmailPollSecondsIdle` | **60** | Nothing is pending, so there is nobody to keep waiting. Range 10–3600 |

The owner's real journey, sign up, wait for verification mail, complete it, runs on the fast interval, and the daemon is not polling every five seconds for
the rest of the week.

#### The cursor is a discriminated union, not a widened record

Gmail's cursor is a `historyId`, not `UIDVALIDITY` + `lastSeenUid`. Rather than
overload the numeric fields, a `historyId` is a uint64 and does not reliably
fit a JS number, the persisted cursor discriminates on source, so an
IMAP-shaped cursor and a Gmail-shaped one cannot be confused or half-filled.

The recovery rule is the same on both sides, which is the useful part.
**`resync-required`** from Gmail, a 404 on an expired `historyId`, means
exactly what a **`UIDVALIDITY` change** means for IMAP: the stored position is
meaningless, so discard it, re-establish at the current high-water mark,
disclose it, and **do not replay the mailbox**. One rule, two sources, no second
implementation of "what to do when we lost our place".

#### A message that was not read is never stepped over

`history.list` names message ids and `messages.get` fetches them, two calls,
with a gap in between. Every failed fetch used to be dropped alike:

```ts
for (const id of collected.ids) {
  const fetched = await deps.getMessage(id);
  if (fetched.ok) messages.push(fetched.value);   // every failure read as "deleted"
}
```

The comment above that line named one cause (a message deleted in the interim)
while the code applied it to all of them, and a `GoogleApiResult` failure covers
429, 500/503, 401/403 and transport faults. So a rate-limited fetch produced
`ok: true` with zero messages, the source advanced its cursor to the delta's
`historyId`, and, because **Gmail's history is a forward-only log**, those
records could never be requested again. The verification email was never read,
never announced, never recorded, and the verdict said `healthy`.

That is the identical ambiguity `ImapEnvelopeBatch.unreadable` exists to remove
on the IMAP side, and it does more damage here: on IMAP the message stays in the
mailbox and a later search finds it, whereas a `historyId` stepped over is gone
for good. So it is fixed with the same shape rather than a second one.
`GmailHistoryDelta` carries `unreadable: readonly GmailFetchProblem[]`, and the
classification is deliberately narrow in the safe direction:

| What happened | Answer | Cursor |
|---|---|---|
| Fetched | in `messages` | may advance |
| **404**, deleted between `history.list` and `messages.get` | dropped | may advance |
| Anything else, 429, 5xx, 401/403, transport fault | in `unreadable` | **must not advance** |

Only 404 drops. Every status that is not recognised is retried rather than
dropped, because each status added to the drop list is a new way for mail still
sitting in the owner's mailbox to become unreachable, while leaving a genuinely
permanent status out costs only a delta that retries under a verdict that has
stopped saying healthy, visible, bounded, recoverable.

`ok: true` is kept rather than failing the whole delta, and that is deliberate
too: a partly-readable delta hands on what it read. Withholding a verification
email we *did* fetch because a sibling message was rate-limited would be the
same silence by a different route. The position simply does not move, the whole
delta is fetched again, and dedup suppresses the duplicates, the same trade
already made for a refused delivery.

#### `users.watch` + Pub/Sub remains rejected as primary

Unchanged, for the reason in §3.1: it needs a public HTTPS endpoint and a GCP
Pub/Sub topic, which is wrong for a daemon on someone's own machine behind NAT.
Recorded here as the path to **true push on Gmail** if that ever becomes wanted, it is the only way to get sub-second Gmail delivery, and the trade is
infrastructure the owner does not have.

#### Scope sufficiency applies to both

§3.4a is not a Gmail detail. Both sources refuse rather than deliver
empty-bodied messages that read as a quiet mailbox, and both name a remedy the
owner can act on. **But they do not detect it at the same moment, and this
paragraph originally claimed they did.**

| | Gmail | IMAP |
|---|---|---|
| What is checked | granted scopes | whether the server hands over message data |
| When | **before the first call**, scopes are declarative | **on the first fetch**, `fetch-refused` |
| Verdict | `insufficient`, `gmail-metadata-only` | `insufficient`, `fetch-refused` |
| Envelope fields still readable? | **yes**, headers are authorized | **no**, the envelope fetch is what failed |

That last row is why `surfaces.email.inbound.onInsufficientCapability:
'notice-only'` applies to the Gmail column and to nothing else. It reads
`gmail-metadata-only` rather than borrowing IMAP's `fetch-refused` for exactly
that reason: the two are opposite situations, and a policy that had to tell them
apart while both were called `fetch-refused` could not.

The asymmetry is the protocol, not laziness. A Gmail token *states* what it may
do, so it can be checked against nothing. IMAP has no equivalent declaration, `CAPABILITY` does not say "you may fetch bodies from this mailbox", and
permission is discovered only by asking for data. On an **empty mailbox there is
nothing to ask for**, so a universal connect-time body probe does not exist.

What follows matters for the journey this capability serves: during a signup the
first fetch **is** the verification mail, so an expectation is already open when
the refusal is found. §3.4b already covers the outcome, expectations open when
capability is lost are **failed with a named reason**, never left to expire, so
the owner is told the truth either way, simply slightly later on IMAP than on
Gmail.

**Closing most of the gap:** when the mailbox is non-empty at connect, one
`BODY.PEEK` of a single envelope at the highest UID answers the question before
any expectation is opened, at the cost of one round trip per connection. That is
the honest version of "connect-time" for IMAP, available whenever there is
anything to probe, and impossible when there is not.

### 3.5 Where it plugs in — the supervisor model, not the webhook model

There are two lifecycle shapes in the adapter family, and email must use the
second:

1. **Webhook adapters** (slack, discord, google-chat, msteams, …) are plain
   `handle<X>SurfaceWebhook(req, context)` functions with no lifecycle at all,
   dispatched by path through `ChannelPluginRegistry.handleInbound`.
2. **Poll/socket adapters** (Telegram `getUpdates`, ntfy's long-lived
   subscription, Slack Socket Mode, Discord Gateway) are stateful supervisors
   with `start()` / `stop()` / `status`, owned by `BuiltinChannelRuntime` and
   armed at boot.

IMAP has no inbound HTTP request, so email is model 2.
`TelegramIngressSupervisor` (`channels/telegram/ingress.ts`) is the structural
analog to follow, down to the details that matter: it advances its persisted
offset **only after** each update finishes processing, so a crash mid-batch
replays rather than loses. That is exactly the cursor rule in §4, already proven
in this codebase.

`InboundMailSupervisor` therefore exposes the same status triple the other
poll surfaces do, `{ mode: 'idle' | 'polling' | 'inactive', reason, running }`, which `getStatus()` folds into the standard `ChannelStatusSnapshot`
(`state: 'healthy' | 'degraded' | 'disabled'`, `enabled`, `accountId`,
`metadata`) so it appears in channel health and the doctor report alongside
every other surface.

**It registers as a `ClusterConsumerGate`.** Clustering defaults off, but when
the owner opts in, two nodes both holding an IDLE connection to the same mailbox
would both fetch and both notify, the same message announced twice, from a
capability whose entire value is being told exactly once. The existing gate
(`daemon/facade-cluster.ts`, `registerDaemonClusterSurfaces`) already solves
this for every other consuming surface: one node consumes, the others stand by
and take over on failover. Email uses it rather than reinventing it.

---

## 4. The cursor

`EXAMINE` + `BODY.PEEK` means the daemon never marks anything `\Seen`, so
`SEARCH UNSEEN` would return the same messages forever and "have I handled
this?" cannot be asked of the server. The daemon keeps its own answer.

Per mailbox, persisted:

```ts
interface MailboxCursor {
  readonly account: string;        // config account id, not an address
  readonly mailbox: string;        // the EXAMINE target
  readonly uidValidity: number;    // from the EXAMINE response
  readonly lastSeenUid: number;    // highest UID fully processed
  readonly updatedAt: string;      // ISO 8601
}
```

- **`UIDVALIDITY` is part of the key, not a field to ignore.** When a server
  reports a different `UIDVALIDITY` than the stored one, every stored UID is
  meaningless, the mailbox was recreated. The cursor is discarded and
  re-established at the current high-water mark, and the event is disclosed to
  the owner. It deliberately does **not** replay the mailbox: re-notifying about
  a year of old mail because a server rebuilt an index is not recovery, it is a
  flood.
- **First run establishes the mark; it does not backfill.** A newly enabled
  mailbox sets `lastSeenUid` to the current highest UID and reports how many
  messages it skipped. The daemon starts listening now; it does not
  retroactively decide about mail that arrived before it was asked to.
- **The cursor advances only after a message is fully processed**, matched,
  recorded, and notice dispatched or deliberately suppressed. A crash between
  fetch and completion re-delivers, and re-delivery is caught by dedup (§6), so
  the failure mode is a duplicate suppressed rather than a message lost.

---

## 5. Ingest, and the one thing that must not be got wrong

### 5.1 Arrival is not ingest

This is the load-bearing ruling of the whole design and it is the interaction
with the taint work running in parallel.

The untrusted-content ledger is **one instance per process**
(`getProcessUntrustedContentLedger()`), scoped to a turn by a watermark that
`startTurn()` advances. `evaluateOutwardEffect` refuses an outward action when
anything was ingested since that watermark.

A background watcher recording ingest **at arrival** would write into whatever
turn window happens to be open at that moment. An email arriving at 03:00 while
the owner is mid-request would refuse that outward action on the basis of a
message that no turn read, no model saw, and nobody asked for.

That is worse than the bug the taint round is fixing: it lets any stranger who
knows the owner's address disable the agent's outward actions on demand, by
sending mail.

So the rule is:

> **The turn ledger records a body when a turn reads it, never when the daemon
> receives it.**

Concretely:

- The watcher writes arriving mail to its own durable **inbound record store**,
  which is not the turn ledger and has no watermark.
- `ledger.record()` is called from where it is called today, `EmailService.listInbox` / `readMessage`, inside a turn that asked, and from
  nowhere new.
- The owner notice is rendered from structured fields only (§7), so telling the
  owner mail arrived never ingests the body into a turn.
- Expectation matching reads the body, but it is a **pure comparison** that
  emits a decision, not conversational text; it records the *outcome* in the
  inbound store, not the body into the turn ledger.

**What this needs from the taint round:** confirmation that
`startTurnForOwnerInput` is the only path that advances the watermark, and that
inbound mail is never treated as owner-direct. Its
`inputOriginIsOwnerDirect(origin)` returns true when `origin === undefined`
("nothing routed it in, that is the keyboard"). Inbound email is routed in, so
it must always supply an origin, and that origin must carry
`ownerDirect: false` explicitly rather than relying on its source name being
absent from a list. Stated as a requirement in §10.

### 5.2 Every message body is untrusted content

Labelled at the boundary via `labelUntrustedContent`, `surface: 'email'`,
`origin: 'email:<domain> (claimed)'`, keeping the existing wording, which
already names the sender domain as a claim rather than a fact.

### 5.3 Links

Every link in every inbound message runs through
`platform/security/link-validation.ts`: https-only, no userinfo, no IP-literal
host, no non-standard port, mixed-script/homograph refusal after punycode
decoding, registrable-domain comparison via the generated public-suffix
snapshot, known-redirector detection, and hop-by-hop revalidation through
`followValidatedRedirects`.

The expected/unexpected distinction already exists and is not reinvented:

- **A link in mail that matched an expectation** is validated against
  `expectation.serviceDomain`, exact for `'login'`, subdomain-tolerant via
  `hostMatchesServiceDomain` for `'signup'`, by `extractVerification`, which
  yields at most one artifact and refuses with `'link-host-mismatch'` rather
  than returning a link from the wrong host.
- **A link in mail that matched nothing** has no authorized domain to be
  validated *against*, because no workstream declared one. It is therefore
  never resolved, never followed, and never actioned. It is rendered to the
  owner as its registrable domain plus a refusal reason where one applies, so
  the owner can see what arrived without the daemon having touched it.

---

## 6. Dedup

**The cursor is the first line of defence. Dedup is the second, and its job is
narrower than this section originally claimed.**

That original claim, that "a reconnect refetches above the cursor" and dedup
catches the repeat, is **false**, and it was found by making a vacuous test
real. The test asserted the watcher redelivers on a plain re-wake and dedup
suppresses it. It passed while waiting on a cursor advance the *first* delivery
had already satisfied, so the second pass never ran. Made real, it failed: the
watcher **does not redeliver on a re-wake at all**. Once UID 102 is processed
the cursor sits at 102, the next search is `UID SEARCH UID 103:*`, and the only
thing returned is 102 via the inverted-range quirk (§13.1), which is filtered
above the cursor. A reconnect correctly finds nothing.

Stating it correctly matters beyond tidiness: **a design document claiming a
guard exists for a case that cannot occur is how the guard gets deleted by the
next person who checks.**

So dedup covers exactly two things:

1. **The failure path**, a message claimed and then not successfully processed.
2. **Genuinely concurrent passes**, an IDLE wake and a fallback poll overlapping
   on the same message.

`InboundMessageDedup` from `platform/adapters/inbound-dedup.ts` is reused, already bounded (2048 entries), already TTL-expiring, already order-pruned, and
its `claim()` contract is right.

**One method was added to it: `release()`.** §6 originally said "as-is", and this
is not as-is, so the deviation is recorded rather than absorbed. The alternative
was a second in-flight cache inside the sink doing the same job as the first, the mirror pattern this document has removed four times, and the one that
already produced a silently-disabled push mode. One mechanism with an honest
interface beats two that agree by convention.

**Why `release()` is load-bearing, and it is the subtlest point in this
section.** `claim()` records the key *before* the work runs, that ordering is
what stops two concurrent deliveries both running the pipeline. The same
ordering means a failure between claim and completion leaves the key **claimed**,
so the retry is suppressed as a duplicate of an attempt that never finished.

The failure mode is therefore **silence, not a duplicate**: the owner's
verification mail vanishes with nothing reporting it. For a capability whose
entire purpose is announcing that mail arrived, that is strictly worse than the
duplicate storm the guard was written to prevent.

A claim-then-fail therefore releases and rethrows, so the cursor stays below the
message and the next pass genuinely retries. The key is built with the existing
`inboundDedupKey(surface, scope, messageId)`:

```
// IMAP
inboundDedupKey('email', `${account}:${mailbox}`, `imap:${uidValidity}:${uid}`)
// Gmail
inboundDedupKey('email', `${account}:${mailbox}`, `gmail:${resourceId}`)
```

The **UID under its `UIDVALIDITY`** is the identity, not the `Message-ID`
header. `Message-ID` is written by the sender: two different messages can carry
the same one, which would let a sender suppress a later message by colliding
with an earlier one. The UID is assigned by the receiving server and the
`UIDVALIDITY` qualifier keeps it unambiguous across a mailbox rebuild.

**Ruling: the dedup identity is per-source, and is always the value the
receiving server assigned.** Gmail has no UID and no `UIDVALIDITY`; its
server-assigned identity is the message resource id, which is stable for the
life of the message and is not something a sender writes. So the identity is
`gmail:<resourceId>` there, and the two are prefixed so they can never collide
in the shared key space, a bare `${uidValidity}:${uid}` and a bare resource id
are both opaque strings, and an unprefixed collision between them would suppress
a real message with no way to notice.

`Message-ID` is refused on **both** sources for the same reason, and the reason
is worth restating for Gmail specifically: it would be the only identity
available that looks source-agnostic, which makes it the tempting choice
precisely where it is least safe.

The email adapter constructs its own `InboundMessageDedup` instance rather than
sharing `ntfyInboundDedup`, so one surface's traffic cannot evict another's
under the shared entry cap.

**Correction: this cache is in-memory, and the TTL never covered a restart.**
The original text here, and the comment in `sink.ts`, and the "correctness
floor" comment on `dedupTtlMs()`, and the `dedupTtlMinutes` row in §8, all said
the window "must exceed a restart cycle" and that "an hour covers the
auto-update restart". That was structurally false at every setting.
`InboundMailSupervisor.runStart()` builds a fresh `createInboundMailDedup(...)`,
and `runStart()` is what a process restart, a config change and a cluster-gate
handoff all reach. A restart does not expire the claim; it destroys the object
holding it. A floor guarding a property the mechanism cannot provide at any
value is a floor guarding nothing, so the config key's stated basis is corrected
too.

What the window genuinely covers is the two cases listed above, an IDLE wake
overlapping a fallback poll, and a retry after a failed pass, both of which
happen inside one process, seconds apart. The value is therefore generous rather
than load-bearing.

**What covers the restart is the record store.** The sequence the false claim
was written for is real: UID 205 is announced, the daemon's hourly auto-update
restarts it before the cursor advance lands, the cursor is still at 204, and the
message comes back into an empty cache. The durable answer already existed, the inbound record store is keyed by the identity the receiving server assigned
and says what happened to the notice, so `intake.ts` asks `findByMessage`
whether this exact message was already announced before announcing it, and a
record reading `delivered` suppresses the second notice.

Persisting the dedup cache itself was the alternative, and it is the worse one.
The claim is taken BEFORE the work, so a durable claim that survives a crash
suppresses the retry and the message is lost silently, the failure this section
already rules is worse than a duplicate. Persisting only on success narrows the
window to "notice sent, completion not yet durable", which is exactly the window
the record store closes, using state that already reaps, bounds, validates by
content, sweeps and discloses (§9.3) rather than a fourth store that would need
all five rules written again.

Every path where the record store cannot answer, a discarded file, a reaped
record, a record still at `pending`, leads to announcing. That is deliberate:
the failure direction has to be the duplicate, never the silence.

---

## 7. Owner notice

New mail the owner should know about is delivered wherever the owner actually
is. The existing entry point is
`DaemonSurfaceDeliveryHelper.deliverSurfaceNotice(binding, text)`, and it takes
a **plain string**, which is the hazard.

So the SDK owns a renderer, `platform/email/inbound-notice.ts`, and the adapter
calls `deliverSurfaceNotice` **only** with the renderer's output:

```ts
renderInboundMailNotice(input: {
  readonly senderDisplay: string;        // sender's registrable domain + local part, sanitized
  readonly subject: string;              // truncated, control chars and newlines stripped
  readonly deliveredTo: DeliveredRecipient | null;
  readonly outcome: InboundOutcome;      // matched-expectation | inert | refused-link | ...
  readonly links: readonly ValidatedLinkSummary[];  // registrable domains + verdicts only
  readonly receivedAt: string;
}): string
```

The rules the renderer enforces, and which its tests assert:

- **No raw body text ever reaches the notice.** Not truncated, not quoted, not
  "just the first line". The body is the thing an attacker writes; if any of it
  can appear on the owner's phone then an attacker chooses what is read there.
- **Subject and sender are attacker-written too**, so they are sanitized, not
  trusted: newlines and control characters removed (a subject containing
  `\n\nApproved: yes` must not render as two lines), length-capped, and never
  interpolated into anything the receiving surface parses as markup or as a
  command.
- **Links appear as registrable domain plus verdict**, never as clickable URLs
  the daemon assembled from message text.
- **The delivery address is shown**, because for a per-signup alias it is the
  single most useful fact, it says which account this is about, from evidence
  the sender could not forge.

### 7.1 Which fields are attacker-chosen — the audit

A defect found in review makes the case for doing this as a list rather than by
intuition. `deliveredTo` was given weaker sanitization than the subject line, on
the reasoning that a delivery header "cannot be forged by the sender". The
header cannot be forged, the receiving server stamps it truthfully, but what
it truthfully stamps is **the envelope recipient the sender chose**, and this
design runs on per-signup aliases, which means catch-all or plus-addressing,
which means the local part is the sender's to pick. Mail addressed to
`[Approved](https://evil.example)@ourdomain.com` rendered a clickable attacker
link in the owner's notice, on the one row the notice exists to make
trustworthy.

The lesson generalizes: **an address is not safe because part of it is
verified.** Every field is attacker-chosen until a specific reason says
otherwise, and the reason is written down.

| Field | Origin | Verdict |
|---|---|---|
| `subject` | `Subject:` header | **Attacker-chosen.** Sender writes it verbatim |
| `senderDisplay` | `From:` header | **Attacker-chosen.** Display name is free text |
| `deliveredTo` local part | envelope recipient | **Attacker-chosen** under catch-all/plus-addressing |
| `deliveredTo` domain | our own domain | Ours, but escaped anyway, at no cost |
| `outcome.purpose` | the registering workstream | **Attacker-chosen unless drawn from a fixed vocabulary.** A signup flow that lifted a service name off a web page is passing untrusted text through an authorized caller |
| `outcome.serviceDomain` | expectation, validated | Validated ASCII hostname. Escaped anyway |
| `outcome.reason` | refusal | Ours **only if** it is a fixed enum member. Any reason quoting a server's wording is attacker-chosen |
| `links[].host` | extracted + validated | Registrable domain, hostname-shaped. Escaped anyway |
| `receivedAt` | **our clock** | Ours, **and this is load-bearing.** `ImapEnvelope.date` is `extractHeader(raw, 'Date')`, a string the sender wrote. The notice timestamp must come from our own receipt time, never from that header |
| `authenticationResults` | receiving server | Only the top-most is beyond the sender's reach; carries no authority anywhere and is escaped if shown |

Two of those rows are ones nobody would have guessed: an address, and a
timestamp.

### 7.2 Escaping belongs to the channel, not to the producer

The renderer as first specified returned **one string for every channel**. That
is the architectural error underneath the defect above, and fixing the character
set does not fix it.

A single trigger-character set has to be the union of what is dangerous on every
channel the notice might reach. Telegram MarkdownV2 reserves
`_*[]()~`>#+-=|{}.!`; Discord adds `@everyone`/`@here`; Slack uses `<url|text>`
and `<!channel>`; an HTML notice needs entity escaping instead; ntfy carries
plain text but puts fields in HTTP headers, where a newline is the injection.
A set tuned for one is silently wrong on another, and it goes wrong **the day a
channel is added**, in a module nobody edited.

Stripping is also lossy in the wrong direction: the owner sees a mangled subject
and cannot tell whether the mail said that or we did.

So the producer emits **structure**, and each channel escapes at the last
moment:

```ts
export type NoticeSpan =
  | { readonly kind: 'literal'; readonly text: string }    // our words, safe by construction
  | { readonly kind: 'untrusted'; readonly text: string }; // someone else's, escaped by the channel

export interface NoticeField {
  readonly label: string;                    // always ours
  readonly value: readonly NoticeSpan[];
}

export interface StructuredNotice {
  readonly title: readonly NoticeSpan[];
  readonly fields: readonly NoticeField[];
}
```

`renderInboundMailNotice` returns a `StructuredNotice`. Each channel's delivery
path owns a `renderNotice(notice: StructuredNotice): string` that escapes
`untrusted` spans per its own syntax, **escapes, not strips**, so
`[Approved](https://evil.example)` reaches the owner as that exact literal text
rather than as a link or as mangled spaces. The owner sees what the mail
actually said, and it does nothing.

Why this is the right shape:

- **The producer cannot get it wrong**, because it never holds a channel-format
  string. Forgetting to escape is not a mistake that can be made in the wrong
  place; the only code that turns spans into text is the code that knows the
  syntax.
- **Adding a channel is a bounded, visible task**, implement one escaper, rather than an invisible widening of a shared character set.
- **Untrusted-ness travels with the value.** A field passed through three
  functions is still tagged `untrusted` at the end.

**Discord masked links are what make this required rather than precautionary**,
and it was verified rather than assumed. `[text](url)` **does** render in
bot-sent messages, webhook messages and embeds. It does **not** render in
messages a human types into the client, a trade-off Discord made specifically
to stop people hiding malicious URLs behind innocent text.

The daemon delivers over the bot and webhook paths, which are precisely the
paths where masked links work. So bracket and paren escaping is not
cheap-if-unneeded insurance; it is the control that stops a mail sender's chosen
text from arriving in the owner's Discord as a clickable link reading whatever
they want. It is documented as necessary, with the finding beside it, because
**an escaper that looks optional gets deleted by the next person tidying up**.

Noted and deliberately **not** relied on: Discord runs its own filter that
blocks a URL appearing in the *text* portion of a masked link. That is their
mitigation, not a contract with us; it can change without notice, and it does
not cover the general case of arbitrary attacker-chosen display text. Our
escaping stands on its own.

Sources: `https://github.com/discord/discord-api-docs/issues/6096`,
`https://gist.github.com/matthewzring/9f7bbfd102003963f9be7dbcf7d40e51`.

#### The per-channel mapping is set by the send path, not by the channel's capabilities

**Correction, and it is mine.** This section originally mapped Telegram to
MarkdownV2 escaping. Verified against the code: `telegram/api.ts` `sendMessage`
posts `chat_id`, `text`, `disable_web_page_preview` and an optional
`message_thread_id`, **no `parse_mode`**, and `parse_mode` appears nowhere in
`packages/sdk/src` outside this module's own comments.

With `parse_mode` omitted Telegram performs **no entity parsing**. So
MarkdownV2 escaping would inject literal backslashes into the owner's notice, `Confirm your account\.`, making it harder to read while preventing nothing.
The mapping described what Telegram *can* do rather than what this codebase
*asks it to do*.

**What Telegram actually needs is different, not less.** With no `parse_mode`
the live vectors are the ones markdown escaping never touches:

- **Client-side auto-linkification of bare URLs.** An `https://evil.example`
  sitting in an attacker-written **subject** becomes clickable in the client
  with no markup involved. §7 already requires *links* to render as registrable
  domain plus verdict; this closes the same hole for URLs embedded in free text.
- **`@username` mentions**, auto-linked to profiles. `breakMentionForms`
  already covers this.

So the Telegram path neutralizes bare URL forms and mention forms inside
`untrusted` spans, and does not escape markup. **The comment at that mapping
must name the trigger for change:** if `parse_mode` is ever added to
`sendMessage`, the escaper becomes required and the plain path becomes wrong.

Verified per channel, from the send path rather than the channel's
documentation:

| Channel | Send path | Treatment |
|---|---|---|
| Discord | `payload.content`, always parses markdown, no opt-in | **Escape.** Masked links render on bot and webhook paths |
| Slack | body lands in a `{ type: 'mrkdwn' }` block | **Escape.** `mrkdwn` is interpreted |
| Telegram | `sendMessage` with **no `parse_mode`** | **Neutralize URL and mention forms.** Do not escape markup |
| html / ntfy | not yet traced | **Unmapped.** If ntfy's title goes in an HTTP header the injection is a newline, not markup, a different defence |

The general rule, which is the durable part:

> A channel's escaping is decided by **how this codebase sends to it**, not by
> what the platform is capable of parsing. Read the send call before choosing a
> defence, and record the send-site fact that justifies the choice.

#### Bare URL auto-linking needed handling on every channel, not just Telegram

The ruling above said Telegram needs URL defanging *because* it has no
`parse_mode`. That was too narrow, and the correction came from a test written
to prove a property disproving it instead: a "no surface emits the raw live
form" assertion failed on **Slack**.

`escapeSlackMrkdwn` handles `&<>` and `` *_~` `` and leaves `https://`
untouched, and Slack mrkdwn linkifies it. The same is true of Discord, of ntfy
clients, and of the plain-text fallback. **None of them need markup to make a
URL tappable.** §7 requires links to reach the owner as a registrable domain
plus a verdict, so a live URL sitting in an attacker-written subject contradicts
that on **every** surface, not only the one where it was first noticed.

Defanging is therefore composed at the **channel dispatch**, so a newly added
escaper cannot forget it, and repeated in the plain-text fallback because that
path does not go through the dispatch. Same structural-over-conventional rule as
the producer never holding a channel-format string: the safe thing happens
because there is no path around it.

#### A specific handler must be a superset of the fallback, never a substitute

ntfy, a **mapped** surface, was receiving weaker treatment than an
**unmapped** one. Its escaper stripped control characters, while the plain-text
fallback also broke mention forms. So recognising a surface actively reduced its
protection.

That inverts the purpose of the mapping table, and it is a defect that hides
indefinitely, because a mapped surface *looks* handled, the table is the very
thing a reviewer checks to confirm coverage.

> **Being recognised must never mean being protected less.** A per-channel
> handler adds to the fallback's neutralisation; it never replaces it. Any
> mapping that can be weaker than no mapping is a hole shaped like a feature.

Markdown is still deliberately left alone on ntfy, and for a send-site reason
rather than an oversight: `publish()` sets Title, Priority, Tags and Click with
no Markdown header, so `*bold*` is inert there and escaping it would mangle what
the owner reads.

### 7.3 Make the unsafe value unconstructible, not merely validated

The strongest defence produced in this round deserves a name, because it is a
better class of protection than sanitizing and it generalizes well past email.

`receivedAt` is a branded `ReceiptTimestamp` whose only constructor takes a real
`Date` the daemon observed. A sender's `Date:` header is a `string`, so it
cannot be passed, not "is rejected by validation", but **has no path into the
type at all**. The check cannot be forgotten, because there is nowhere to forget
it.

The codebase already had one instance, and it is the reason the expectation
mechanism can be trusted at all: `DeliveredRecipient` does not export its brand
symbol, so a value can only originate from the mailbox actually fetched from or
a delivery header the receiving agent stamped. No quantity of sender-written
text produces one.

Stated so it gets reused:

> Where an attacker-supplied value could be mistaken for an observed one, do not
> validate the attacker's version, make it **impossible to construct**. Give
> the observed value a brand whose only constructor takes the observation
> itself.

Candidates wherever this design reaches: an observed receipt time versus a
claimed `Date:`; a delivery-verified recipient versus a claimed `To:`; a
validated registrable domain versus a claimed link host. **And in payments,
which is a consumer of this work: a merchant's claimed total must not be
constructible as our validated total.** Same defect shape, money attached.

Sanitizing is still the right tool for text that must be displayed. Branding is
for values that carry authority, where the answer is not "clean it" but "you
cannot have this from there".

#### A structural guarantee only holds if consumers import the type

This one was learned the expensive way, in the round that built the watcher, and
it applies to every structural protection in this document.

The IDLE tri-state was deliberately made unignorable: `report.idle` is
`{ known: true; supported: boolean } | { known: false }`, so `if
(report.idle.supported)` does not compile and "the server said nothing" cannot
be silently read as "no". That guarantee held exactly as designed, in the module
that declared it.

The watcher had **hand-written its own `boolean | null` mirror** of the same
concept rather than importing the type. After the rename, its mirror read
`undefined`, `undefined` is falsy, and the watcher **silently polled a
push-capable server**, precisely the defect the two-case shape exists to
prevent, reintroduced by copying the shape instead of importing it. Its own
tests caught it, as "Timed out waiting for: IDLE command number 1".

So the rule:

> A type that makes a wrong state unrepresentable protects only the code that
> imports it. A structurally-equivalent local mirror is not equivalent, it is a
> second declaration of the same idea that can drift, and it will drift silently,
> because nothing links the two.

**Three separate defects tonight came from this one root**, which is why it is
stated as a rule rather than an anecdote:

1. A hand-written `boolean | null` mirror of the IDLE tri-state read `undefined`
   as falsy, and the watcher silently polled a push-capable server.
2. Two lanes each declared a structurally-identical `MailboxCursor`. Everything
   compiled while the store clamped with `Math.max` and the poll loop assigned
   unconditionally, so a late write would have dragged the high-water mark
   backwards and **re-announced every message between the two marks**.
3. `SurfaceAuthorityProbe` typed its parameter `string`, which made the **real**
   predicate structurally **unassignable**, a function accepting only
   `AuthoritySurface` cannot stand where one accepting any `string` is required.
   Passing the genuine check therefore required wrapping it in a shim. That is
   part of *why* §2.2's defensive check had never run: it could not have. The
   type carried a comment naming `src/agent/surface-authority.ts`, a path that
   does not exist, while the predicate lives in
   `platform/security/untrusted-content.ts`, a drifted type under a comment
   citing a file that was never there.

**So where a narrowed view is needed, project it from the real declaration
rather than restating it.** `ExpectationMatcher` began as a hand-authored
interface and described a method the book does not have, it omitted the
required `now`, so every caller through it would have been type-checked against
fiction. As `Pick<VerificationExpectationBook, 'matchCandidate'>` it **cannot
drift, because there is nothing to keep in sync.**

> Narrowing by projection (`Pick`, `Omit`) beats narrowing by restatement. A
> restated interface is a second declaration wearing the word "narrow".

Applies equally to `ReceiptTimestamp`, `ValidatedRegistrableDomain`,
`DeliveredRecipient`, `CardShapeFinding` and `ExpectationMatcher`. Where a
boundary matters, consumers import the declaration; they do not restate it. A
port interface that must stay structurally compatible with a real type should
say so and be pinned by a type-level test, not maintained by hand in two places.

`deliverSurfaceNotice(binding, text)` takes a plain string and stays as it is;
the channel renderer runs immediately before it. Until every channel has an
escaper, the fallback renderer emits **plain text with all markup neutralized**, the conservative behavior, chosen explicitly rather than inherited.

Routing is configurable (§8). The default is the owner's existing notice route
binding, so this inherits whatever route is already in use rather than
introducing a second notion of "where to find me".

`deliverSurfaceNotice` refuses with a typed reason
(`no-route-binding`, `surface-delivery-disabled`, `no-deliverable-target`,
`delivery-failed`, …). A refused notice is **recorded in the inbound store with
its reason** and surfaced in health. Mail that arrived and could not be
announced is a fact the owner gets to see, not a dropped promise.

---

## 8. Configuration

Daemon-owned config, under `surfaces.email.inbound.*`, sitting alongside the
existing `surfaces.email.*` connection settings so one account is configured
once. Every setting is a real, meaningful control, not an enable/disable pair
wearing a feature's clothes.

| Key | Type | Default | Why this default |
|---|---|---|---|
| `surfaces.email.inbound.enabled` | boolean | **`false`** | Reading the owner's mail continuously is not a thing to start doing without being asked. Off until configured, then on. |
| `surfaces.email.inbound.accounts` | list | `[]` | Which configured mailboxes are watched. A list, not a boolean, because one address for signups and another for the owner's real mail is the expected shape. |
| `surfaces.email.inbound.mode` | `'idle' \| 'poll' \| 'auto'` | **`'auto'`** | `auto` uses IDLE when the server advertises it and polls when it does not. A user should not have to know what their provider supports. |
| `surfaces.email.inbound.pollIntervalSeconds` | number | **`120`** | The fallback path only. Two minutes is responsive enough for a verification mail and far below any provider's rate limit. Range 30–3600. |
| `surfaces.email.inbound.idleReissueMinutes` | number | **`27`** | RFC 2177 advises re-issuing at least every 29; 27 leaves room for a slow round trip without crossing the bound. Range 5–29, capped at 29 by validation. |
| `surfaces.email.inbound.reconnect.maxBackoffSeconds` | number | **`300`** | Five minutes bounds the worst-case silence after a provider outage while not retrying a dead server every second. |
| `surfaces.email.inbound.notice.route` | route binding \| `'default'` | **`'default'`** | Inherits the owner's existing notice routing. A second place to configure "where to reach me" is a second place to get it wrong. |
| `surfaces.email.inbound.notice.mode` | `'all' \| 'expected-only' \| 'none'` | **`'all'`** | Being told about arriving mail is the point of the capability. `expected-only` exists for a high-volume mailbox; `none` is available and disclosed, but silence is not a default. |
| `surfaces.email.inbound.expectationWindowMinutes` | number | **`15`** | Matches `DEFAULT_VERIFICATION_WINDOW_MS` already shipped. Range 1–60, hard-capped by the existing `MAX_VERIFICATION_WINDOW_MS`. |
| `surfaces.email.inbound.dedupTtlMinutes` | number | **`60`** | How long one process remembers a message it handled, so an overlapping poll or a retried pass does not process it twice. In-memory only: a restart destroys the cache rather than expiring it, so no value here prevents a restart-crossing duplicate, the record store does that (§6). Seconds would cover what this covers; the default is generous, not load-bearing. |
| `surfaces.email.inbound.retentionDays` | number | **`30`** | How long inbound records are kept before reaping. Long enough to explain "why did I get that message", short enough to bound the store. |
| `surfaces.email.inbound.maxRecords` | number | **`5000`** | The hard bound. Whichever of age or count binds first, wins. |
| `surfaces.email.inbound.capabilityRecheckMinutes` | number | **`60`** | How often a mailbox reporting insufficient capability is re-probed (§3.4b). Fixing a scope must not require a daemon restart, and must not produce a tight retry loop. Range 5–1440. |
| `surfaces.email.inbound.onInsufficientCapability` | `'refuse-and-notify' \| 'notice-only'` | **`'refuse-and-notify'`** | §3.4b. `notice-only` is a deliberate downgrade in which expectations can never be satisfied, so signup and order confirmation stop working, and is never entered automatically. It applies to **one** condition: a Google `gmail.metadata` grant, where headers are authorized and bodies are not. Every other insufficient reason leaves no envelope fields to announce, so `notice-only` behaves as `refuse-and-notify` there and the verdict says which is in force (§13.11). |

**Every default above is chosen by this design and needs owner confirmation**,
fourteen of them now, counting the two capability settings; `flags-are-features`
requires an explicit per-flag ruling. They are listed here rather than buried in
a schema file so they can be ruled on as a set.

The two most likely to be argued:

- `enabled: false`. The alternative is a daemon that starts reading mail on
  upgrade, which is not a decision an upgrade should make.
- `notice.mode: 'all'`. The alternative silently drops the case this whole
  capability exists to fix, mail arriving with nothing listening for it.

### 8.1 How it is declared, and what each surface needs

Declared once, in a schema domain file, in the hand-rolled
`ConfigSettingDefinition` format the rest of the config uses (there is no zod):
`key`, `type`, `default`, `description`, plus `enumValues` / `intRange(min,max)`
for validation. The existing `surfaces.email.*` connection settings already live
in `config/schema-domain-daemon-mailbox.ts`, so the inbound keys join them
there and flow through `schema-domain-surfaces.ts` into `CONFIG_SCHEMA`.

Because `'surfaces.'` is already in `DAEMON_OWNED_CONFIG_PREFIXES`, these keys
are daemon-owned automatically, no ownership edit, and the TUI's
daemon-owned-note enrichment picks them up for free.

What each surface needs, verified rather than assumed:

- **TUI**, nothing. `buildSettingGroups` walks `CONFIG_SCHEMA` and derives the
  category from `key.split('.')[0]`, which is already `surfaces`.
- **Agent**, nothing. Same derivation in `settings-modal.ts`; the `surfaces`
  category and its `CATEGORY_INFO` sentence already exist.
- **webui**, one build step. The browser bundle cannot import the node-only
  config barrel, so it reads a checked-in snapshot generated by
  `scripts/generate-config-schema.ts`. Bump the SDK dependency and run
  `bun run config-schema:generate`. `config-schema:check` is wired into
  `bun run build`, so a schema change without regeneration fails the build
  rather than shipping a settings screen missing the new fields.

"Surfaced in every surface" is therefore mostly free, but *mostly free* is not
*done*, and each of the three is opened and confirmed rather than assumed, since
a setting the owner cannot find is a setting the owner does not have.

---

## 9. Persisted state and the recovery rule

Three things outlive a restart. Anything persisted across restarts **reaps,
bounds, validates by content, sweeps periodically, and discloses**. These
behaviors are contractual. Do not revise them silently. Each of the three stores
below is specified against all five rules.

The pattern is not invented here. `platform/devices/device-grants.ts` states
this exact five-rule directive in its header and implements it, with
`platform/devices/device-housekeeping.ts` composing it. All three stores below
follow that shape rather than a new one:

- a `*Policy` object of bounds with exported defaults;
- a standalone `validate*(value: unknown): T | null` that re-checks every field
  and returns `null` for a torn record instead of throwing or repairing;
- a `sweep()` that recomputes every removal from a freshly-read snapshot and
  returns an **itemised report**;
- a housekeeper calling `sweep('recovery')` at load and `sweep('periodic')` on
  an `unref()`'d interval, persisting a bounded disclosure log.

All three live under `~/.goodvibes/daemon/`, addressed through
`ShellPathService.resolveUserPath('daemon', name)`, the mechanism the daemon
composition root actually uses (`daemon/facade-inbound-mail.ts`), not a
hand-built path.

**This paragraph named `resolveSurfaceDirectory(homeDirectory, 'daemon', …)`
for most of the round.** §13.3 item 3 recorded the discrepancy and this section
was left uncorrected, so the document catalogued an error it went on repeating, which is worse than never noticing, because the catalogue implies it was
handled.

### 9.1 The cursor store

| Rule | How |
|---|---|
| Reaps | Cursors for accounts no longer in config are dropped on load. |
| Bounds | One record per (account, mailbox); the file cannot grow with traffic. |
| Validates by content | On load every field is re-validated: `uidValidity` must be a positive integer, `lastSeenUid` a **non-negative** integer (zero is the honest value for a first run against an empty mailbox, and requiring positivity would make a freshly-established cursor fail its own validation on the very next load), `updatedAt` a parseable ISO date, `mailbox` a non-empty string. A record failing any check is **discarded, not repaired**, a corrupt cursor silently coerced to `0` would replay the entire mailbox. Discarded cursors re-establish at the high-water mark and are disclosed. |
| Sweeps | On load, and on config change. |
| Discloses | `email.inbound.status` reports every cursor with its mailbox, position and age. |

### 9.2 The expectation store — and a decision that overrides the existing one

`VerificationExpectationBook` is in-memory today, deliberately: *"an expectation
is a 15-minute grant, and a grant that survives a restart is a grant nobody
remembers issuing."* That reasoning is sound and I am overriding its conclusion,
narrowly, for a reason that did not exist when it was written:

**The daemon auto-restarts.** It checks for updates hourly and restarts itself
at idle. An account signup begun at 14:58 with a restart at 15:00 loses its
expectation, and the verification mail then arrives inert, the exact failure
this entire round exists to eliminate, caused by our own update mechanism.

The override is narrow and keeps what the original reasoning protects:

- Expectations persist **with their original absolute `expiresAt`**. A restored
  expectation never gets a fresh window. Restarting cannot extend a grant, which
  is what "a grant nobody remembers issuing" was guarding against.
- Anything already expired is **reaped on load**, before it can match anything.
- Records are validated by content on load, by the same functions
  `openExpectation` uses: `authority` must read exactly `'evidence-only'`;
  `openedAt` must **not be in the future**; the window must be at least
  `MIN_VERIFICATION_WINDOW_MS` and at most `MAX_VERIFICATION_WINDOW_MS`;
  `serviceDomain` must be a **registrable domain** by the public-suffix data, a bare TLD like `com` and a multi-label public suffix like `co.uk` are both
  refused; and `purpose`, `serviceDomain`, `recipientAddress` and `id` are
  length-bounded. A record failing any check is discarded.

  **This list is what the section originally claimed, and it was not true when
  written.** The window check was a *delta only*, neither timestamp compared to
  the present, so a record dated `openedAt: 2999-01-01` with a 30-minute delta
  validated, survived the sweep and hydrated, while a live grant can never
  exceed an hour.

  And `serviceDomain` had no hostname validation at all, so `"com"` passed **on
  the load path and on the live `email.expectation.open` verb alike**, and
  `hostMatchesServiceDomain`'s `endsWith('.' + registered)` turned it into a
  wildcard. The full chain was executed: planted record → hydrates →
  unsolicited mail from an unrelated sender → `matched` → a verification link
  returned from the attacker's host. **One permanent wildcard-TLD grant from one
  edit of a 0644 file.**

  The claim *"a file on disk cannot mint an expectation the live API would have
  refused"* is therefore **earned, not assumed**, and it was still false for
  `id` after the first hardening pass, which bounded three fields and left the
  fourth, so thirty-two 1 MB ids re-persisted a 32 MB well-formed file. A
  guarantee stated in a design document is a hypothesis until something tries to
  break it.
- `MAX_OPEN_EXPECTATIONS = 32` is enforced on load, not only on open.
- Swept on load and on the periodic sweep; `sweepExpired` already exists.
- Disclosed: open expectations are listed in status, with their recipient,
  purpose and remaining window.

### 9.3 The inbound record store

Bounded by both `retentionDays` and `maxRecords`, whichever binds first, swept
on a periodic timer and on load. Records hold structured fields, sender,
subject, delivery evidence, link verdicts, outcome, and a **bounded body
excerpt**, capped at the same 20,000 characters the ledger uses, so the store
cannot become an unbounded copy of the mailbox. Every field re-validated on
load; unparseable records dropped. Disclosed through status and through the
config UI, which states plainly what is retained and for how long, because the
owner should not have to read source to learn that the daemon keeps a month of
mail metadata.

### 9.4 Hygiene of the files themselves

Four things the five rules imply about a FILE rather than about a record, each
of which was unmet and is now closed. Exercised by
`test/inbound-mail-persistence-hygiene.test.ts`, where every assertion reads the
file rather than a store's own read method, a read that filters is what hid
three of these four.

**Bounds apply at write, not only at the sweep.** `record()` applied neither
`maxRecords` nor `retentionMs`, both were the sweep's job, and the sweep runs
every six hours. Measured with `maxRecords: 2`, ten writes put ten records on
disk while `list()` served two. Worse, `email.inbound.status` computed
`retention.records.kept` from that filtered read, so the owner was told a
smaller number than the file held: a bound reported by the very filter that
concealed it not being applied.

Both bounds now apply on every write, by the same age-then-count precedence the
sweep uses. The disclosure reports two numbers rather than redefining one, `kept`
is what a read serves, `stored` is what the file holds, and **the gap between
them is itself the disclosure**: records past their window that no write or sweep
has reached yet.

A write-time reap cannot appear in any sweep report, so `reapedOnWrite` counts
it. §9's fifth rule is that a reap is disclosed, and that applies to reaping this
code does as much as to reaping it describes. The same gap in
`PersistedExpectationStore.replaceAll`, which capped nothing at all, is closed
the same way.

The periodic sweep still matters: a store nothing writes to still ages, and a
retention lowered in config takes effect on the next pass.

**The disclosure log obeys the rules it records.** It carried
`ExpectationSweepReport.survivors` whole, duplicating every recipient alias,
service domain and purpose into `email-inbound-housekeeping.json`, which expiry
reaping never touched; and `listDisclosures()` read it back with no content
validation at all.

What is persisted now is a projection:

- **Survivors are dropped.** `retained` carries the count, and a count is what a
  disclosure needs about what stayed. Naming them is retention, not disclosure.
- **Removals are kept**, because the removed *are* the disclosure, but capped at
  100 with `removedTotal` carrying the true number.
- **Every entry is validated field by field on load**, with a torn one dropped
  rather than served.

It is bounded by age as well as by count. Twenty entries looks like five days on
a daemon sweeping four times a day, but that cap reaps by ARRIVALS, and a mailbox
that goes quiet has none, so the twentieth entry would otherwise be the last one
written and stay forever. The live in-process report still carries the survivors,
because the boot-time hydrate reads them from it; they stop at the disk boundary.

**Modes, durability, and orphaned temporaries.** `PersistentStore` wrote 0644
files into a 0755 directory with no fsync anywhere. These files hold recipient
aliases, the services an agent signed up at and retained body excerpts, and
nothing but the daemon reads them.

So they are written 0600 into a 0700 directory, set at create time on the
temporary, which a rename carries, so an existing 0644 file heals on its next
write without a separate chmod pass.

The temporary is fsynced before the rename and the directory after it, because
`rename` is atomic against other processes but says nothing about power loss:
the failure it left behind was a zero-length file, which is indistinguishable
from a corrupt one.

A `*.tmp.<pid>.<uuid>` left by a process killed mid-write is reclaimed by a later
write, by AGE rather than by the liveness of the pid in its name, because pids
are recycled. The count is disclosed in the housekeeping summary, for the same
reason `reapedOnWrite` exists.

**One writer at a time, across processes, is enforced rather than assumed.**
Writes were serialized per store INSTANCE, and an instance is as narrow as the
object holding it: six records written by two writers left three on disk, with
no error on either side.

It is tempting to record that as an accepted boundary on the grounds that the
daemon runs one process per machine, **and that premise does not hold.**
`requirePortAvailable` refuses a start only when the CONFIGURED PORT is already
bound; the port is configuration (`resolveHostBinding`); and the store paths are
`shellPaths.resolveUserPath('daemon', …)`, derived from `$HOME` with no port in
them. Two daemons on two ports under one home directory therefore share every one
of these files and neither refuses to start. `lifecycle-marker.ts` records a pid
and a `running` state, but it is a crash-receipt marker, not a mutex: a second
start reads it, writes a receipt and proceeds.

So the three stores take `acquireCrossProcessLock` around the whole
read-modify-write. That is the advisory lock the checkpoint and push-subscription
stores already use, reused rather than reinvented, so the hard parts
(populated-before-published, single-winner takeover, release-only-your-own,
staleness by pid *and* mtime, reclamation of its own staging litter) are already
answered. Pinned by a test that spawns two real OS processes: twelve writes by
two processes leave twelve records.

---

## 10. What this needs from the taint round

Stated as requirements rather than hopes, because they are load-bearing:

1. **The turn watermark must advance on owner input, not process start.**
   **Satisfied.** `security/turn-boundary.ts` shipped
   `startTurnForOwnerRequest(explicitUserRequest, ledger)`, which resets the
   window only when `explicitUserRequest === true`. Without it, one inbound
   message read in a turn refuses every outward action until the process
   restarts, and with inbound mail arriving continuously that is permanent.

2. **Inbound email must never be owner-direct.** **Satisfied, by a different
   mechanism from the one this requirement was written against. The
   requirement as originally worded must not now be implemented, because it
   names a function that does not exist.**

   It asked for every inbound-mail invocation to pass an origin carrying
   `ownerDirect: false` explicitly, because `inputOriginIsOwnerDirect` was
   understood to return `true` for `origin === undefined`, "nothing routed it
   in, that is the keyboard". Verified by grepping all of
   `packages/sdk/src`: `inputOriginIsOwnerDirect`, `startTurnForOwnerInput` and
   `ownerDirect` appear **nowhere**. The taint round did not ship that shape.

   What shipped keys on an explicit boolean the caller must pass, so there is
   no absence to be misread as the keyboard and no origin list to keep in sync.
   Owner-direct is something a caller must now *assert* rather than something
   inbound mail must remember to *deny*, which is the safer direction. The only
   obligation left on this round is the trivial one: an arrival path never
   passes `explicitUserRequest: true`.

3. **No ingest recording off-turn.** §5.1. The two rounds must not both add
   `ledger.record()` calls to the arrival path.

File ownership while both rounds are live: the taint round owns
`security/untrusted-content.ts`, `security/turn-boundary.ts`,
`security/index.ts`, `core/orchestrator.ts`, `events/turn.ts` and the browser
files. This round touches none of them. This round owns `platform/email/*`,
the new `platform/adapters/email/`, `google/verification-expectations.ts` and
the config schema. Neither list overlaps.

---

## 11. Consumers

### 11.0 Card-shaped content arriving on a remote channel is refused

**Card details are entered only at a local terminal or the webui, never over a
remote messaging channel.** That behavior is contractual. Do not revise it
silently. What follows is the daemon-side enforcement of it.

The payments round built the outbound half in `goodvibes-agent`: no card-entry
prompt is offered toward a remote surface, and outbound card-shaped content is
refused before reaching a provider. It reported the **inbound** half as not
implementable there, and verified rather than asserted it, the agent is
adopt-only, has no inbound channel path at all, `no-inbound-consumers.test.ts`
fails the build if one is added, and `unified-inbox.ts` marks the seam as
awaiting a daemon contract. That is correct, and it lands the inbound gate here.

**The requirement.** A message arriving on any remote messaging channel that
carries card-shaped content is refused:

- **Not stored.** It never reaches the payments store, config, or any secret
  tier.
- **Not logged, not transcribed, not placed in a notice body**, nowhere it can
  be read later.
- **The refusal reply names only the matched shapes**, never the digits,
  matching the precedent the agent round set outbound.
- **No card-entry prompt is ever offered on a remote channel**, because
  **prompting is itself the harm**: it invites the owner to type a card number
  into Telegram, where it lands in a third party's history nobody can erase.

**The distinction a later reader will try to collapse, so it is written in these
terms:** approvals and vetoes for purchases **do** work over remote channels,
and that stays. Remote surfaces have authority to **say yes or no about a
purchase**; they have **no path for entering the instrument**. Authority over a
decision is not a channel for a secret. These two must not be unified, and that
separation is contractual. Do not revise it silently.

#### Where the check goes

`SurfaceActions.authorizeSurfaceIngress`
(`platform/daemon/surface-actions.ts:179`), the single shared hook that all
nineteen remote adapter call sites already pass through. The file argues for
this placement itself, having put work-proposal and approval-reply consumption
there *"on the shared ingress hook every surface adapter already calls, which
is what makes agreement answerable over whatever channel the proposal went out
on, with no per-adapter wiring"*.

Per-surface would be wrong for the reason the agent round learned firsthand: a
fix applied per-adapter leaves the other seventeen open.

**It runs first**, before `evaluateIngress`, before proposal-reply resolution,
before approval-reply resolution. Everything downstream may store, log or
transcribe, so the check must precede all of it.

One consequence, deliberate: a message that would have been an approval or a
veto is refused if it carries card shapes. **The refusal reply is always
delivered**, even though the content is dropped, this is the one case where
silence would do harm, because an unheard objection inside a veto window
elapses into a completed purchase. The owner is told immediately, on the same
channel, and can resend without the digits.

#### Detection, and the shape of its result

```ts
export type CardShapeKind = 'pan' | 'security-code' | 'expiry';

export interface CardShapeFinding {
  readonly kind: CardShapeKind;
  readonly startIndex: number;
  readonly length: number;
  // Deliberately no value, text or digits field — see below.
}

export function detectCardShapes(text: string): readonly CardShapeFinding[];
```

The finding carries **position and kind, never the matched characters**. This is
§7.3 again: the digits are not something a caller must remember not to log, they are not reachable from the result at all. A refusal message composed from
findings is structurally incapable of quoting a card number.

Rules:

- **`pan`**, 13–19 digits, passing the Luhn check. Luhn alone is the
  discriminator; a known issuer prefix is deliberately **not** additionally
  required, since that would miss valid cards from less common networks. The
  trade is asymmetric and decided accordingly: a false positive costs one
  refused message with a clear explanation, while a false negative puts a real
  card number into a third party's message history permanently.

  **This rule originally read "a run of 13–19 digits after stripping internal
  spaces and hyphens", and that is not implementable, it misses cards.** A
  separator-joined run is not one number. Taking the maximal run whole welds
  `4111111111111111 07/29` into an eighteen-digit string that fails Luhn, so a
  card pasted with its expiry after it, the single most likely way a person
  sends one, **was not detected at all**. The implementation caught this in its
  own tests.

  So a run is analysed as a **sequence of digit groups**: each single group of
  13–19, the whole run, and contiguous group windows where every group is 4–6
  digits. The 4-digit floor is load-bearing: without it,
  `555 123 4567 555 987 6543` yields six Luhn candidates and refuses a message
  containing two phone numbers roughly half the time.

  Deliberately **not** caught: a card buried inside a longer unbroken digit
  string, e.g. 25 solid digits containing a valid 16. Sliding a window at digit
  granularity would fire on about one in ten arbitrary tracking numbers. The
  threat model is the owner pasting their own card, not an adversary evading the
  check.
- **`security-code`** and **`expiry`**, never refused on shape alone. Three or
  four bare digits, and `MM/YY`, are far too common, and refusing them would
  make the channel unusable. They count only in card context (`cvv`, `cvc`,
  `security code`, `card`, `expiry`) or alongside a `pan` finding.

A message is refused if any `pan` is found, or if a `security-code` or `expiry`
finding occurs in card context.

#### This applies to inbound mail too, and that is a finding about this design

The inbound record store (§9.3) persists a **bounded body excerpt for thirty
days**. A card number in an email would therefore be written to disk and kept, by this round's own machinery, in a store this round introduced. Nobody asked
for that and it is exactly the exposure this section exists to prevent.

Email is not gated the way remote channels are: mail is not refused for
containing digits, because order confirmations legitimately carry long numbers
and refusing them would break the consumer this capability exists to serve. The
answer is **redaction, not refusal**. `detectCardShapes` runs over the excerpt
before it is persisted and matched spans are replaced. The message is still
recorded, still notified, still able to satisfy an expectation; only the digits
fail to reach disk.

**The subject is redacted too, and this paragraph originally missed it.** The
subject is persisted in the same record *and* rendered to the owner in the
notice, the same exposure through a second field, and the more visible one.
Redacting it requires re-clamping to the field's length limit, because a
redaction marker is longer than the three digits it replaces, and an
over-length subject fails `validateInboundMailRecord` on load, which discards
**the whole record**, turning a redaction into a lost message.

#### One adapter does not pass through this hook, on purpose

The nineteen call sites are pinned by an enumeration test, so a new adapter
that skips `authorizeSurfaceIngress` fails rather than shipping ungated.

`adapters/github/index.ts` is a recorded exception: it never calls
`authorizeSurfaceIngress` at all, going from an HMAC-verified webhook body
straight to `trySpawnAgent`. It is not gated here, because it is not a remote
messaging channel, no `ChannelPolicyDecision`, no owner-facing reply channel to
deliver a refusal on, and its content is issue and pull-request text rather than
something the owner types. It is named in the enumeration test so this is a
decision on the record rather than an oversight.

Separately, and outside this round: that GitHub webhook content reaches
`trySpawnAgent` without passing the shared ingress hook at all means it also
bypasses the conversation gate. That is worth its own look by whoever owns the
GitHub integration.

### 11.1 Cross-round requirement for payments

§7.1 and §7.2 apply to the payments notices with more force than they apply
here, and this is raised as a requirement on that round rather than a
suggestion.

Payments already rules that approval and veto messages are rendered from
structured fields and never from page text. That ruling is right and it is not
sufficient, because "structured field" is where this defect lived: the merchant
name and the item title **are** structured fields, and both are lifted straight
off a merchant's web page. They are as attacker-chosen as an email subject.

Three things make it worse there than here:

1. **The owner acts on it under time pressure.** The veto window's whole design
   is silence-means-proceed, so a notice that misleads for ten minutes spends
   real money. Here, a misleading notice is merely misleading.
2. **Money is attached.** A rendered link in a purchase notice is a phishing
   target the owner has already been primed to trust, because a message about an
   authorized purchase is exactly what is expected.
3. **The total is the one field the owner checks.** An item title carrying
   markup can restyle, obscure or visually displace the amount in the same
   message, and Telegram will happily bold, strike through, or spoiler-tag
   whatever it is handed. The number the owner reads must not be positionable by
   the merchant.

So the payments round needs: the same `StructuredNotice` and per-channel
escaper, `merchantName` and `itemTitle` tagged `untrusted`, and the amount
emitted as a `literal` span that no untrusted span can be interleaved with.
A test asserting a merchant name containing markup cannot alter how the total
renders.

## 11.2 Consumers

The payments capability is a consumer, not a peer: order confirmations and
delivery notices arrive by mail. It gets them through the **expectation**
mechanism, a purchase that was approved registers an expectation scoped to the
merchant's domain before checkout completes, and never through a scan of
arriving mail for order-shaped text. The asymmetry that matters and must not be
collapsed: payments **approvals never travel by email**, while order
*confirmations* may arrive by email as evidence of something already authorized.
Confirming is not approving. That separation is contractual. Do not revise it
silently.

---

## 12. Test plan — every one of these is a gate

Each test is written to fail without its fix, and that failure is verified
before the fix lands.

| # | Behaviour | Vehicle |
|---|---|---|
| 1 | Mail arriving with a registered expectation satisfies it | Fake IMAP server, expectation opened first |
| 2 | Mail arriving with no expectation is inert, no spawn, no work, notice only | Fake server; asserts the notice fired and nothing else did |
| 3 | An arriving message cannot register an expectation | Body containing register-shaped text; book unchanged |
| 4 | An arriving message cannot widen an expectation | Mail for domain B against an expectation for domain A |
| 5 | An arriving message cannot extend a window | Expired expectation + mail; `expired`, not renewed |
| 6 | IDLE drop reconnects without losing messages | Server drops mid-IDLE; mail delivered while down; asserts it arrives after reconnect |
| 7 | Duplicates are not double-delivered | Same UID via IDLE and poll; one delivery |
| 8 | The cursor survives restart | Store round-trip; resumes above `lastSeenUid` |
| 9 | The cursor is bounded and validated | Corrupt/oversized/stale records discarded, not repaired |
| 10 | `UIDVALIDITY` change discards rather than replays | Changed value; no flood |
| 11 | The email adapter has no spawn capability | Runtime own-property assertion + type-level test |
| 12 | Notices render only from structured fields | Body with injected instructions; absent from output |
| 13 | Subject newlines/control chars cannot forge notice lines | Subject with `\n` and control characters |
| 14 | `Message-ID` collision cannot suppress a message | Two messages, same `Message-ID`, different UIDs; both delivered |
| 15 | Arrival does not taint an open turn | Watcher ingest during a turn; `evaluateOutwardEffect` still allows |
| 16 | Expectations reload with original expiry, never a fresh window | Persisted record; remaining window unchanged |
| 17 | An on-disk expectation the live API would refuse is discarded | Over-long window, bad authority field |
| 18 | 29-minute re-issue happens before the bound | Fake server asserting `DONE`/`IDLE` timing |
| 19 | `UID SEARCH`/`UID FETCH` return real UIDs, not sequence numbers | Fake server where they differ |
| 20 | Body preview is attached to the message it came from | Fake server, multi-message search |
| 21 | Backoff is bounded and jittered; auth failure is terminal | Injected clock |
| 22 | `history.list` reports unavailable rather than silently no-op'ing | Token without a Gmail scope |
| 23 | No file under the inbound path references a spawn capability | Source-level assertion |
| 24 | `'email'` is in `CONVERSATION_GATE_DEFAULT_SURFACES` | `isGatedSurface('email')` is true |
| 25 | The expectation book is instantiated in production with a real authority probe | Boot wiring assertion |
| 26 | Only one cluster node consumes a mailbox | Two supervisors, one gate |
| 27 | The cursor advances only after processing completes | Failure injected between fetch and notice; message redelivered, not skipped |
| 28 | Settings appear in TUI, agent and webui | Per-surface assertion, including the webui snapshot check |
| 29 | A body-incapable grant refuses before calling, and never returns empty-bodied success | Metadata-only token; assert refusal, not an empty delta |
| 30 | A missing mailbox, a rejected credential and a readable mailbox are three distinct outcomes | Fake IMAP server, three scripts |
| 31 | Opening an expectation against an insufficient mailbox is refused at open time | Not left to expire fifteen minutes later |
| 32 | Capability lost mid-window fails open expectations with a named reason | Distinct from expiry, which means "nothing came" |
| 33 | A watcher in reconnect backoff does NOT fail expectations | "Not yet" is not "cannot" |
| 34 | Insufficient capability notifies once per transition, not once per probe | Repeated probes, one notice |
| 35 | The inbound path cannot register or hydrate an expectation | Type-level + source-level assertion (§2.1) |
| 36 | The producer cannot emit a channel-formatted string | `renderInboundMailNotice` returns `StructuredNotice`; type-level test |
| 37 | Each channel escapes rather than strips | `[Approved](https://evil)` arrives as that literal text, not a link and not mangled |
| 38 | Per-channel escapers cover their own syntax | Telegram MarkdownV2, Discord mentions, Slack `<url\|text>`, HTML entities, ntfy header newline, one case each |
| 39 | An untrusted span cannot reach output unescaped on any channel | Table-driven across every registered escaper |
| 40 | A channel with no escaper falls back to fully-neutralized plain text | Not to the raw string |
| 41 | The notice timestamp comes from our clock, not the `Date:` header | Sender-supplied date differs from receipt time |
| 42 | An expectation purpose lifted from untrusted text is escaped | Not trusted for being supplied by an authorized caller |
| 43 | A plausible card number on a remote channel is refused | Luhn-valid 13–19 digit run |
| 44 | The refused value is absent from config, secrets and the payments store | Asserted against each tier, not inferred |
| 45 | The refused value is absent from logs and transcript | Capture both; assert no digit substring |
| 46 | The refusal reply contains none of the digits | Names shapes only |
| 47 | `CardShapeFinding` cannot carry the matched characters | Type-level test |
| 48 | The gate runs before policy, proposal and approval resolution | Ordering assertion in `authorizeSurfaceIngress` |
| 49 | A refusal is still delivered when the message would have been a veto | Silence would elapse into a purchase |
| 50 | All nineteen remote adapter call sites are covered by the shared hook | Source-level enumeration, not per-adapter tests |
| 51 | Bare 3–4 digits and a bare `MM/YY` are NOT refused | False-positive guard; channel stays usable |
| 52 | A card number in an email is redacted before the excerpt is persisted | Mail still recorded and still satisfies its expectation |

---

## 13. Rulings taken here

Made under zero-deferrals so implementation was not blocked. The owner can
overturn any of them.

1. **Gmail `users.watch` + Pub/Sub is not built.** §3.1.
2. **`users.history.list` is built but scope-gated and inert today.** §3.1. The
   alternative, asking the owner to complete Google's restricted-scope
   verification and annual security assessment in order to read their own mail,
   is the highest-friction option available.
3. **Expectations persist, with their original absolute expiry.** §9.2.
   Overrides a documented decision, for a reason that post-dates it.
4. **The spawn capability is removed by type, not guarded by check.** §2.1.
5. **Arrival is not ingest.** §5.1. The single most consequential decision here.
6. **Dedup identity is `UIDVALIDITY:UID`, not `Message-ID`.** §6.
7. **All fourteen defaults in §8.** Listed together for a single ruling.
8. **Insufficient capability refuses and notifies; it never silently
   degrades.** §3.4b. `notice-only` exists but is only ever entered by
   configuration.
9. **Escaping belongs to the channel, not the producer.** §7.2. The producer
   emits `StructuredNotice`; each channel escapes its own syntax. This replaces
   the single-string renderer, which was mine and was wrong.
10. **Every notice field is attacker-chosen until a written reason says
    otherwise.** §7.1. Including addresses, and including timestamps.
11. **Four numeric ranges** chosen without design guidance and needing the same
    confirmation as the defaults: `maxBackoffSeconds` `[10,3600]`,
    `dedupTtlMinutes` `[5,1440]`, `retentionDays` `[1,365]`,
    `maxRecords` `[100,100000]`.
12. **Luhn alone decides a `pan`, without requiring a known issuer prefix.**
    §11.0. Chosen because the trade is asymmetric: a false positive costs one
    refused message, a false negative costs a permanent card number in someone
    else's message history.
13. **Card shapes in email are redacted, not refused.** §11.0. Refusing mail for
    containing long digit runs would break order confirmations, which are the
    consumer this capability exists to serve.
14. **Configured polling reports `healthy`; only fallback polling is
    `degraded`.** §3.4b.
15. **`uidvalidity-missing` refuses rather than running without a durable
    cursor.** §3.4b.
16. **Dedup identity is per-source and always server-assigned**, prefixed
    `imap:` / `gmail:` so the two opaque forms cannot collide. §6. `Message-ID`
    is refused on both sources, and is most tempting exactly where it is least
    safe, Gmail, where it is the only identity that looks source-agnostic.
17. **The found message is a discriminated union on source**, not a widened
    record and not a synthesised UID.
    `docs/decisions/2026-07-27-inbound-message-is-a-discriminated-union.md`.
    §3.4d's claim that `InboundMailboxMessage` was "already source-agnostic"
    was verified wrong by reading it: it carries `uidValidity`, `uid` and
    `ImapEnvelope`.
18. **IMAP body capability is probed, not declared.** One `BODY.PEEK` at
    connect on a non-empty mailbox, before any expectation is opened. An empty
    mailbox reports `{ probed: false }`, **visible in status and distinct from
    probed-ok, but it does NOT change the health verdict.**

    *Corrected.* This ruling previously said an empty mailbox reports
    `degraded`/`bodies-unproven`, and cited a decision record
    (`2026-07-27-imap-body-capability-is-probed-not-declared.md`) that **did not
    exist in the tree at the time**, a fifth instance of §13.2, this time citing
    a document rather than a symbol. That record has since landed from a
    parallel line of work and the path now resolves. The implementing round
    flagged the contradiction instead of guessing, which is why it surfaced.

    `degraded` is wrong here, and for a reason stronger than the one originally
    given: **an empty mailbox is the primary case, not an edge case.** A fresh
    per-signup alias is empty by definition, so every new signup would start
    permanently amber and stay there until its first message. That is the same
    alarm-fatigue argument already settled for configured polling, a health
    indicator that is always yellow is one nobody reads, and it would fire on
    exactly the journey this capability exists to serve.

    Honesty is preserved without the alarm: the unprobed state is *disclosed*
    rather than *escalated*. And nothing is lost, because the reactive path
    still catches a refusal on the first real message, failing the open
    expectation with a named reason under §3.4b. The owner is told at the moment
    it matters, rather than warned before there is anything to warn about.
19. **Externally-sourced calendar event content is untrusted content**, on the
    same read-time-not-arrival-time rule as mail, and the calendar agenda sort
    is deliberately NOT given the mail fix.
    `docs/decisions/2026-07-27-calendar-start-sort-is-not-the-defect.md`.
20. **A message that was not read is never stepped over, on either source.**
    §3.4d. "The message is gone" and "we could not read it" are separated at the
    point they are produced, and only the first lets a cursor move. On IMAP that
    is `ImapEnvelopeBatch.unreadable`; on Gmail it is
    `GmailHistoryDelta.unreadable`, one shape rather than two, because a
    forward-only `historyId` stepped over is unreachable rather than merely
    delayed. Only a 404 counts as gone; every unrecognised status is retried.
21. **A missing `UIDNEXT` is derived from `UID SEARCH`, never assumed to be
    zero.** §3.4b. It is a SHOULD, not a MUST, and servers omit it; establishing
    at 0 replays the entire mailbox as new mail. Deliberately NOT ruling 15's
    answer, a missing `UIDVALIDITY` is derivable from nothing, whereas this is
    one core command away. Refusal is reserved for the case where asking also
    fails to answer: `mailbox-position-unknown`, its own reason rather than
    `uidvalidity-missing`. The cursor note states which way the mark was
    reached; **a note that contradicts the behaviour is worse than no note.**

### 13.1 Protocol quirks that cost real defects, recorded so they are not relearned

- **`UID SEARCH UID 105:*` returns 104** when 104 is the highest UID present.
  RFC 3501 ranges are unordered pairs, so the range inverts rather than being
  empty. Trusting the result verbatim redelivers the newest message on every
  pass, forever. Results are filtered above the cursor, once, in one place.
- **`[UIDNEXT n]` on `EXAMINE` is a SHOULD, not a MUST.** `parseMailboxStatus`
  types it `number | null` for that reason. Read through a `?? 1` it becomes the
  mark 0, which is below every message that exists, and the next `UID SEARCH`
  matches the whole mailbox, a full replay to the owner's notification channel,
  under a note claiming nothing was backfilled. Derived from `UID SEARCH UID
  1:*` instead; see §3.4b.
- **A refused `FETCH` is `insufficient`; a refused `SEARCH` is only a
  reconnect.** Search refusals are routinely transient, and stopping for an hour
  over one turns a hiccup into silence.
- **The IDLE re-issue also runs a cheap `UID SEARCH` sweep**, one per 27
  minutes. It closes the hole where a push was never sent, or was sent while
  nothing was listening. Push is an optimization over polling, never a guarantee
  to be trusted alone.
- **`fetchEnvelopes(uids, limit)` keeps only the last `limit` UIDs**, default
  20, silently. A caller handing it a larger delta and then advancing a cursor
  skips everything dropped. Being fixed at source; recorded because the shape of
  the bug, a truncating default feeding a cursor, will recur elsewhere.
- **An untagged line arriving BETWEEN IDLE rounds is lost.** After one round's
  subscription is released and before the next `IDLE` is issued, nobody is
  waiting on the socket. This is **not a defect**, the next `EXISTS` or the
  27-minute re-issue sweep picks the message up, but it is a real property of
  the transport, and it is written down because someone will otherwise
  rediscover it as a bug and "fix" it by widening a listener that has nothing to
  hand its lines to. It is also the concrete reason the sweep is not redundant
  with push: **push is an optimisation over polling, never a guarantee.**

### 13.2 Errors found in this document, and the one cause behind them

Recorded because the cause is more useful than the corrections, and because a
design document that hides its own defects teaches the next reader to trust it
more than it deserves.

1. **§10 required every inbound invocation to pass `ownerDirect: false`.**
   `inputOriginIsOwnerDirect`, `startTurnForOwnerInput` and `ownerDirect` exist
   nowhere in `packages/sdk/src`. The taint round shipped
   `startTurnForOwnerRequest(explicitUserRequest)`, which returns false unless
   the argument is exactly `true`, so it fails closed and there is no absence
   to misread. Implementing the requirement as written meant coding against an
   API that does not exist.
2. **§6 ruled the dedup identity as `UIDVALIDITY:UID`.** Gmail has neither.
   Written before Gmail became a source and never revisited when it did.
3. **§3.4d called `InboundMailboxMessage` source-agnostic.** It carries
   `uidValidity`, `uid` and `ImapEnvelope`.

**The common cause: each was asserted from something other than the code it
described.** The first from another round's *uncommitted working-tree diff*,
read early and never re-checked after that round landed, the draft I read did
have the hazard I wrote up; the shipped version had inverted it. The second from
a rule that was true when written and was never re-derived when a second source
was added. The third from an export list and a type's *name*, without opening
the declaration.

This is the same failure this round kept catching in implementation work, copying a shape instead of importing it, mirroring a tri-state, trusting a
description over a definition. It applies to design documents identically, and
arguably worse: an implementation error fails a test, while a design error gets
built.

> A requirement that names a function, a field or a type is a claim about the
> code, and it decays. Re-verify it against the code at the moment it is handed
> to someone to implement, not at the moment it was written.

**A fourth instance, committed while citing this very rule.** I reported that
`method-catalog-email.ts` declared no `required` arrays, because grepping it for
the word `required` returned only a comment. The implementing round read the
code instead: `objectSchema(properties, required = [], options)` takes it
**positionally**, so `email.inbox.read` has always declared
`objectSchema({ uid: NUMBER_SCHEMA }, ['uid'])`, and the catalog and the handlers
already agreed exactly. There was no defect. I had invented one and dispatched
it as work.

> **Absence of a grep hit is not absence of the thing.** A negative grep proves a
> string is missing and nothing more. Before reporting that something is not
> declared, read the declaration site and the signature it is passed to.

Knowing the failure mode did not prevent repeating it, in the same message that
cited it. That is the honest lesson: this rule is not self-executing, and the
only thing that actually catches the class is opening the file.

### 13.3 A further six, found by implementing the document

Reported by the lane that built the supervisor, and each verified before being
recorded here. They are listed because §13.2's whole point is that a document
which hides its own defects earns more trust than it deserves.

1. **§2.1's `InboundMailContext` does not exist.** `grep` across `packages/` and
   `test/` finds no `interface` or `type` by that name, only prose referring to
   it. So of the three guards §2.1 claims, **one shipped**: the source-level ban
   (`test/platform-email-inbound-backoff.test.ts`, "no file under
   platform/email/inbound references a spawn capability"). The runtime
   own-property assertion and the type-level non-assignability test do not
   exist. §2.1's second half **did** ship, `'email'` is in
   `CONVERSATION_GATE_DEFAULT_SURFACES`.
2. **§3.5's "folds into the standard `ChannelStatusSnapshot`" is impossible.**
   That type's `surface` field is `ChannelSurface`, which has no `'email'`, and
   widening it is exactly what the `ManagedSurface` ruling forbids. The two
   instructions contradicted each other; the constraint won, via
   `Omit<ChannelStatusSnapshot, 'surface' | 'accountId'> & {…}`.
3. **§9 names `resolveSurfaceDirectory(homeDirectory, 'daemon', …)`; the daemon
   composition root reaches storage through `ShellPathService.resolveUserPath`.**
   Same `~/.goodvibes/daemon/` destination, different named mechanism. The
   implementation follows the composition root rather than the document.
4. **§7.3's own rule was violated in shipped code.** `InboundNoticeStatus` was a
   hand-written mirror of `SurfaceNoticeRefusal` missing `empty-text` and
   `unsupported-delivery-surface`, so a notice refused for either was
   **discarded by `validateInboundMailRecord` on the next load**, and "mail
   arrived and could not be announced" vanished at restart. The section
   forbidding restated types was itself undermined by a restated type.
5. **§9.3 never says no Gmail message can be recorded at all.**
   `validateInboundMailRecord` requires `uidValidity` and `uid` as positive
   integers, which a Gmail message has neither of, so on the source automatic
   selection makes primary, nothing is ever persisted. Same root as §13.2's
   dedup-identity error, never carried into the record store. Being fixed.
6. **§8's `notice.route: 'default'` names a concept the platform does not
   have.** There is no owner-notice-route key and no route-manager notion of a
   default. See below.

#### The `default` notice route — an interpretation, flagged as one

`default` is implemented as **the most recently seen route binding** (highest
`lastSeenAt`): the channel the owner last actually reached the daemon on. With
no bindings at all it resolves to `null`, the notice is refused as
`no-route-binding`, recorded, and disclosed, **never sent somewhere invented.**

This is a reading, not a specification, and it is the one place in this round
where an interpretation was chosen rather than found. Two things make it safe
enough to ship pending a ruling: it can only ever resolve to a channel the owner
demonstrably uses, and the resolved route is **disclosed in
`email.inbound.status`**, so where notices will go is answerable before one is
sent rather than discovered when one arrives somewhere unexpected.

The alternative, a real `owner notice route` concept, is the better answer and
is a larger change than this round. Recorded for a ruling.

### 13.4 Four more, found by trying to kill the watcher

Reported by the lane that hardened the lifecycle, each reproduced before being
recorded. All four are the SAME defect this capability exists to eliminate, *the watcher dies permanently while reporting healthy*, reached by four
different routes, which is the part worth writing down: the document states the
rule in §3.4b and then leaves four paths that break it.

1. **"A verdict is reported where it is found" says nothing about a throw that
   never becomes a verdict.** `poll-loop.ts` calls the cursor store's `advance`
   outside every `try`, deliberately, a store write is not a protocol failure, and the rejection unwound the whole stack into a supervisor
   `.catch(() => undefined)`. One transient `ENOSPC` ended inbound mail forever
   with `email.inbound.status` still reporting a healthy IDLE. The document's
   three states describe conditions the watcher *concludes*; it needed a rule
   for conditions it merely *suffers*. Now: an unexpected throw is caught,
   classified transient or permanent, retried on backoff or escalated to a named
   `insufficient` reason (`local-store-unwritable`), and reported. `running`
   never reads true for a loop that has exited.
2. **§9's "a torn record is discarded, not repaired" was written about records
   and not about files.** `PersistentStore.load()` throws on unparseable JSON,
   and none of the three stores caught it, so one bad byte in the cursor file
   disabled the record sweep, the expectation sweep, `start()`, AND
   `email.inbound.status`, the disclosure verb failing in exactly the state it
   exists to disclose. The rule is now applied at file granularity
   (`loadOrDiscard`), one store's failure cannot stop another's sweep, and the
   discard is named per store in the status snapshot.
3. **§3.4b's "announced, not merely recorded" had no implementation.** The
   once-per-transition tracker existed, the notice port was in the same
   function, and the only consumer of `terminalFailure` was `logger.error`, the
   round's own "rendered and never sent" shape, in the one place meaning no mail
   will ever arrive again. Terminal failures now go to the owner through
   `deliverStructuredNotice`, rendered from structured fields (our reason and
   fix `literal`, the server's own wording `untrusted`, per §7.1), once per
   transition, re-armed by any recovery.
4. **§3.4b's "fixing the scopes does not require a restart" was untrue of
   anything the owner can see.** The supervisor wrote `status` only in the
   `insufficient` direction, so an hourly re-probe that cleared a rejected
   credential left `status` saying `inactive` and `health()` saying `degraded`
   for a watcher that was reading mail again. Both directions are written now.

### 13.5 A test can be correct, green, and about something else

The nine vacuous tests catalogued in §13.7 were all tests that passed **for the
wrong reason**. This is a different and harder failure, found by auditing the
harness rather than the code, and it is the one that let a broken capability
sit under 8356 green tests.

`test/platform-email-imap-fetch.test.ts:742-744` emits a folded literal with a
**trailing UID**, the exact wire shape that breaks the watcher, and asserts
the subject parses. **It passes, and it is correct.**

It passes because it drives `fetchMessage`, which parses via
`extractFetchSection` (`imap-client.ts:560`). The watcher uses
`fetchEnvelopes`, which parses via `parseFetchHeaders` + `parseFetchUids`
(`imap-client.ts:482-483`). Two paths, one tested, and the tested one works.

So a reader asking "do we handle trailing UIDs?" finds that test, sees green,
and stops. **Coverage for one path reads as coverage for the capability.**

Measured against the real `ImapClient.fetchEnvelopes`:

| Server shape | Result |
|---|---|
| Bare lines, UID first, *what the harness emits* | `count=1  subject="Real subject"` |
| `{N}` literal, UID **before** BODY | `count=1  subject=""`, announced with no sender, no subject, no delivery evidence |
| `{N}` literal, UID **after** BODY | `count=0`, treated as an expunge, **cursor advances past it** |

Every test in the tree exercising `fetchEnvelopes` uses the first shape
(`fake-imap-mailbox.ts:219-222`, `platform-email-imap-uid.test.ts:92`,
`platform-email-imap-delivery-recipient.test.ts:55`). And **there are no direct
unit tests of `parseFetchHeaders` or `parseFetchUids` at all**, so neither
parser has coverage independent of a fake server, and a single harness gap
became zero coverage.

Two rules worth carrying:

> **A test proves something about the path it drives, not about the capability
> it is named after.** Before treating a green test as coverage, check which
> function it actually reaches.

> **The acceptance question for a fix is not "does it work" but "does the
> harness now fail if the defect returns."** A correct fix under a harness that
> cannot reproduce the defect leaves the regression unguarded, which is the
> state that produced this section.

Also confirmed **not** defects, recorded so nobody re-investigates: header
folding is implemented correctly (RFC 5322 unfolding, `imap-headers.ts:70-77`);
sequence-number-is-not-UID and the inverted `n:*` search range are both
deliberately emulated by the harness, which are the two things it does better
than most.

### 13.6 The capability did not work against a real server, and 8356 tests said it did

Not an error in this document, an error the document could not catch, because
every claim it makes about the IMAP read is correct and the code underneath
still could not read what an IMAP server sends. Recorded because the *cause* is
the reusable part, and because "the tests pass" was, for a while, the whole of
the evidence that inbound mail worked.

**What the wire actually looks like.** `BODY[HEADER.FIELDS ...]` comes back as a
`{N}` literal (RFC 3501 §4.3): a byte count on the end of the line, then exactly
that many bytes. `ImapSession` handles it correctly and hands the response up
with the payload welded onto the line that announced it. Separately, `UID FETCH`
makes the server add a `UID` data item (§6.4.8) **wherever it likes**, before
the body section or after it. Two shapes, both conformant, both in the wild:

    * 3 FETCH (UID 307 BODY[HEADER.FIELDS (…)] {58}…)
    * 3 FETCH (BODY[HEADER.FIELDS (…)] {58}… UID 307)

**Two defects, different severities.**

1. **UID first.** `parseFetchHeaders` tested whether the text after `* n FETCH `
   began with `(` and discarded it when it did. Against a folded literal that
   text is `(UID 307 BODY[…] From: a@b.test…`, so the header block went out
   with the data items it was welded to. An envelope **was** produced, with
   `from`, `subject`, `date` and `messageId` all empty strings and no delivery
   evidence. The message is delivered and announced: a notice naming nobody,
   about nothing, that expectation matching cannot correlate.
2. **UID last.** `parseFetchUids` searched only `line.slice(0, indexOf('BODY'))`
   of the start line, and on this shape the UID is not on that line at all, it
   is on the line that closes the response. No UID, so no envelope, so the UID
   was simply missing from the fetch result.

**And the third defect, which is the one that loses mail.** `poll-loop.ts` could
not tell *"the server says this UID is gone"* from *"we could not read a response
for it"*. Both arrive as an absence from the result, and it resolved the
ambiguity by advancing the cursor, reporting the drain `complete`. Defect 2
therefore did not surface as an error; it surfaced as a mailbox whose every
message looked expunged, silently skipped, permanently. Absence of an envelope
is now two distinct facts: `fetchEnvelopeBatch` returns the responses it could
not read alongside the ones it could, an expunge still advances, and an
unreadable answer holds the cursor, is reported through the observer as
`fetch-unreadable`, and is fetched again.

**The cause, which is the point.** `test/_helpers/fake-imap-mailbox.ts` wrote
header blocks as ordinary response lines, the one shape no server produces and
the only shape the broken readers could parse. Every test that touched
`fetchEnvelopes` went through that helper, so the coverage was real, extensive,
and entirely of a fiction. A nearby test (`platform-email-imap-fetch.test.ts`)
**did** emit a literal with a trailing UID and passed, which made the gap look
closed, it drives `fetchMessage`, which parses through a different function
that was always correct. Coverage of one path reads as coverage of the
capability.

Neither parser had a direct unit test. A dozen lines asserting what
`parseFetchUids` returns for a five-line fixture would have caught both defects
with no harness at all, and the absence of those lines is why a shape gap in one
helper became zero coverage for the read the whole capability depends on. The
fake now emits byte-counted literals, takes `uidPosition`, answers in sequence
order rather than the order asked, and carries non-ASCII subjects so the literal
arithmetic is exercised for real.

### 13.7 The nine vacuous tests, recorded so they can be re-checked

A refutation review found these. They lived only in that review's report, and a
later confirmation pass **could not re-check them because the list was not in
the repo**, §13.5 cross-referenced "the nine vacuous tests" and no such
enumeration existed anywhere in the tree. A finding that exists only in a
transcript is a finding that expires. They are recorded here so the next pass
can verify each one rather than take my word for it.

| # | Test | Why it cannot fail |
|---|---|---|
| V1 | `inbound-mail-supervisor.test.ts:386` "recovery sweep runs before the source starts" | `getLastReport()` is read **after** `start()` resolves, so the sweep has run either way. Reverse the order and it still passes. The probe must read inside `onStart` |
| V2 | `inbound-mail-expectation-registry.test.ts:158` "the matcher carries no way to insert" | Asserts `reachable.has('matchCandidate') === true` and `Object.keys(x).length >= 0`, **neither says anything about absence**. This is gate #11's runtime own-property assertion and gate #35, and it asserts nothing |
| V3 | `platform-email-inbound-gmail-source.test.ts:409` "no source module imports an expectation registry" | Haystack is `lines.filter(l => l.startsWith('import '))`, so a multi-line import contributes only `import {`, the `from './x.js'` line is excluded. Multi-line is the dominant style in those very files |
| V4 | `inbound-mail-housekeeping.test.ts:130` "start(0) is a no-op rather than a busy loop" | `expect(() => start(0)).not.toThrow()`. Delete the guard and `setInterval(fn, 0)` still does not throw, **the test passes with the busy loop installed** |
| V5 | `platform-email-inbound-gmail-source.test.ts:379` | Terminates in `expect(true).toBe(true)`. A hang-gate, not an assertion |
| V6 | `inbound-mail-dedup-redelivery.test.ts:234` "a suppressed duplicate still advances the cursor" | Touches no cursor. The suppression half is real; the cursor half is untested. Misnamed |
| ~~V7~~ | ~~`inbound-mail-supervisor.test.ts:530`~~ | **STRUCK, the row was wrong.** `expect('surface' in health).toBe(false)` is an ordinary runtime own-property check over a real object, and adding `surface: 'email'` to `describeInboundMailHealth` reddens it. The test is sound |
| V8 | `surface-card-gate.test.ts:518` | Real data, but the check is per-**file** ("contains both strings somewhere"), not per-call-site. A file with one gated and one ungated spawn passes |
| V9 | `inbound-email-config-schema.test.ts` | Tests that three settings can be *set*. Nothing asserts they take effect, and nothing reads them, coverage illusion for gate #28 |

**Gates in §12 with no corresponding test at all:** 11, 14, 15, 25, 28, 31, 32,
33, 35 (type half), 36 (type half), 52 (second half).

Two are worth naming. **#14** is *unconstructible* in the harness:
`fake-imap-mailbox.ts` mints `Message-ID: <uid-N@example.test>` per UID, so a
collision cannot be built, and the gate can never be satisfied as written.

**#25**, "the expectation book is instantiated in production with a real
authority probe, **boot wiring assertion**", is uncovered, but the cause stated
in the first version of this row was wrong and is corrected here.
`composeInboundMail` **is** driven, at
`inbound-mail-lifecycle-failures.test.ts:528`. That test asserts terminal-notice
routing and nothing else, and `facade-inbound-mail.ts` builds the registry
without passing `authority` at all, relying on the constructor default, so the
gate's second half, "with a real authority probe", had nothing observing it.

The correction matters because "nothing imports the file" and "the file is
imported and this property is not asserted" call for opposite fixes.

> A defect list is only as durable as the place it is written down. Findings
> that live in a report are re-found; findings that live in the repo are fixed.
>
> And a written-down finding is a claim to be re-checked, not a fact. Two of the
> eleven entries above were wrong, V7 was not vacuous, and #25's stated cause
> was not the real one. A list kept so findings do not expire will preserve
> mistakes just as faithfully.

#### Closing three of them required building the mechanism first

Gates 31, 32 and 33 had no test **because they had no production mechanism**.
`expectation-registry.ts` took no capability input of any kind, and
`ExpectationExpiryReport.reason` was the closed union `'window-elapsed'`.

**33 was the sharpest, and its shape is the one to remember.** Since nothing
*could* fail an expectation for capability loss, gate 33, "a watcher in
reconnect backoff does NOT fail expectations", could not be violated. An
unfalsifiable gate is strictly worse than an untested one: an untested gate is a
known hole, while an unfalsifiable one reads as a guarantee, and a test written
over it passes on the first run and every run after, proving only that the
mechanism it describes does not exist.

The registry now takes an `ExpectationCapabilityProbe`. `open()` refuses at open
time against an `insufficient` verdict, so a signup workstream learns
immediately instead of after fifteen minutes of silence it cannot tell from "the
service never sent it". `capabilityChanged(verdict)` fails open expectations
with `reason: 'capability-lost'`, a second reason beside `window-elapsed`,
because "nothing came" and "we could no longer look" have opposite fixes and one
of them sends the owner hunting for a message that may well have been delivered.
And it fails **nothing** for a `degraded` verdict: a reconnect fetches
everything above the cursor, so "not yet" is not "cannot". Gate 33 is now
falsifiable, mutating that predicate from `state !== 'insufficient'` to
`state === 'healthy'` reddens three tests.

### 13.8 A mutation that does not redden proves nothing until you prove the mutation landed

Mutation testing is how §13.5 and §13.7 were found, and it has a failure mode of
its own that nearly produced a false finding here.

Converting the last four fake servers to emit real `{N}` literals, four
mutations were tried against the parser to confirm the new coverage bites:

| Mutation | Result |
|---|---|
| `return []` from the parser | all four redden, **blunt**, proves only that the parser is reached |
| drop the trailing-UID append at the close | all four **stay green** |
| strip the UID capture from `CONTINUATION_END` | all four **stay green**, and so does the wire-shapes suite |
| scan for UID only **before** the section marker | **all four redden** |

The middle two look exactly like coverage gaps. They are not. Probing the parser
directly showed the UID still came back correctly under the second, **the
mutation did not remove the behaviour**, so it demonstrated nothing about the
tests. The probe for the third was itself wrong: it hand-built the response array
without a `{N}`, so it never entered the folded path being mutated.

Only the fourth reproduces the original `parseFetchUids` defect, and under it the
failures are precisely one shape's worth, 14 of 42 and 3 of 9, which is the
trailing shape and nothing else.

> **A mutation that fails to redden means EITHER the test is weak OR the mutation
> missed, and the two are indistinguishable until you prove the mutation actually
> changed the behaviour.** Probe the mutated code directly before concluding
> anything about the tests over it.

This is the same trap as §13.5 one level up. There, a green test was read as
coverage for a capability it did not exercise. Here, a green test under a
mutation would have been read as *absence* of coverage that was in fact present.
Both come from treating a test result as evidence about something the test never
touched.

#### The inverse: a mutation in the SAFE direction hides the defect it is testing for

§13.8 above is about a mutation that fails to redden and looks like a coverage
gap. There is an inverse, and it was hit while fixing the terminal-notice
announcer.

The obvious mutation for "is the once-per-transition latch tested?" is to delete
the latch. Delete it, and the tests **pass**, because removing a latch produces
*more* sends, and more sends is the safe direction for a notice. So
"delete it and see" would have reported the guard as covered while the real
defect, the latch being set **before** the send, so a refused delivery latched
a notice the owner never got, sat untouched underneath it.

> A mutation must move the behaviour toward the **failure being guarded
> against**, not merely away from the current implementation. Deleting a guard
> tests whether the guard is reachable. Only inverting it toward the harm tests
> whether the guard is *right*.

Two other rules earned in the same fix:

- **A log line that reports a local variable must not be worded as a report
  about the world.** The announcer logged `announced: announced !== key`, a
  statement about a local, phrased as a statement about the owner. Even with the
  latch moved, that line would still have lied. Three faults occupied those same
  lines: the latch, the discarded result, and the log's wording.
- **A port that cannot say whether it delivered will eventually be assumed to
  have delivered.** `send` was typed `Promise<unknown>`, which is what made the
  defect writable. Typed as `Promise<InboundNoticeDelivery>`, a caller that
  ignores the outcome no longer compiles.

And the detail worth the most: **the correct pattern already existed one file
away.** `intake.ts` uses the same port for arriving mail and was always right, it awaits, branches on `delivery.delivered`, and records `no-route-binding`
honestly. The announcer diverged from it on the strength of its own comment,
*"its result is deliberately unread"*. That comment was the defect's rationale
rather than its description, which is the most dangerous shape a comment can
take: it does not merely fail to describe the code, it **justifies** it.

### 13.9 Three more, and all three are the same rule applied one step further along

A refutation pass over the finished capability confirmed three defects. What
makes them worth recording together is that every one of them is a rule this
document had already stated, applied to one collaborator and not to the one
beside it.

**The notice was sent before the record was written.** §13.5's round fixed the
*consume* ordering on the rule "a pass either completes, or it leaves the book
exactly as it found it". The notice is the step in that handler that genuinely
cannot be undone, a message on the owner's phone is not retractable, and the
rule was not applied to it.

So: `notices.send` ran, `records.record` threw (ENOSPC, a read-only state
directory), the intake threw, the sink released its claim, the cursor stayed put,
and the next pass **announced the same message again**. Every pass; five
redeliveries produced five notices and zero records. Dedup could not suppress any
of it, because releasing the claim is exactly how the retry is enabled, so the
guard against duplicate notices was the mechanism producing them.

The fix is the ordering: the record goes first, in a new `pending` state,
because it is the step that can fail; the notice goes last. Two corollaries came
with it and both are load-bearing.

> **Everything that can fail goes in front of the irreversible step, and nothing
> after it may throw.** A throw after the send releases the claim and
> re-announces, so the second record write and the `consumeMatch` are attempted,
> reported through the observer on failure, and swallowed. What that gives up is
> named rather than glossed: a record left at `pending` (disclosed) and a grant
> left open (bounded by its own window, disclosed by `onExpired`). Both are
> recoverable and announce themselves. A duplicate notice is neither.

> **Writing before an irreversible step means the write must be idempotent by
> the thing's own identity.** `record()` appended, so every retried pass would
> have added a row and `email.inbound.status` would have reported five arrivals
> where the phone buzzed once. It now upserts on the message key, the mailbox
> plus the id the receiving server assigned, keeping the existing record id.

**The dedup cache was in-memory and three places said otherwise.** §6, `sink.ts`
and `dedupTtlMs()` all asserted the TTL "must outlast a restart cycle". The
cache is rebuilt inside `runStart()`, so a restart destroys it rather than
expiring it, and no value made the claim true. Corrected in all four places
(the §8 table row included), and the property the comments wanted is now
delivered by the mechanism that can: the intake asks the record store whether
this exact message was already announced. The reasoning for choosing that over
persisting the cache is in §6, a durable claim taken *before* the work
converts a duplicate into silence, which is the trade this document already
ruled the wrong way round.

> **A comment that justifies code rather than describing it is the shape to
> distrust**, §13.8 already recorded this for the announcer's "deliberately
> unread", and it recurred here verbatim. Both times the comment named a
> property the code did not have, and both times it was the comment that stopped
> anyone checking.

**A structural notice refusal was invisible.** The retryable/permanent split is
right and was deliberately chosen: retrying `no-route-binding` forever would pin
the cursor on a message that fails identically on every pass. But "not retried"
was implemented as "return normally", and returning normally is
indistinguishable from success everywhere upstream, the cursor advanced, the
supervisor reported `idle`, and the health entry reported `healthy` while every
message that arrived was announced to nobody. The same class as §3.4b's terminal
failure ending at a log line, one seam further along.

Two triggers reached it, and the second is the one worth naming: `listBindings()`
returns `[]` whenever the `route-binding` feature gate is off, so an unrelated
flag turned inbound mail into a recorder, reporting as a fresh install that had
simply never connected a channel.

`notice-health.ts` latches the condition, counts the messages going unannounced
under it, logs once per condition rather than once per message, and drives
`status.reason`, the health entry (`degraded`) and a `noticeDelivery` field on
`email.inbound.status`. `RouteBindingManager.isRouteBindingEnabled()` is public
so the gate-off case can name itself.

> **A refusal that cannot be announced through the broken path must still be
> announced.** `terminal-notice.ts` reaches the owner by sending a notice;
> that is unavailable here, because the thing being reported IS the notice route
> refusing, and a notice about it would be refused identically. The honest
> surfaces are the ones that do not depend on the broken path, the status verb,
> the health entry, the log, and all three are driven rather than one.

> **`healthy` must mean the capability is doing its job, not that its socket is
> open.** Every input `describeInboundMailHealth` was built from described the
> connection to the mail server, and all of them were satisfied while nothing
> was being delivered. That is the same fault the function's own docstring
> already criticised in `ChannelStatusSnapshot`, computed from configuration
> rather than from behaviour, reproduced one field short.

### 13.10 A predicate with two answers cannot say "I do not know yet"

`MailboxCursorStore`'s reap rule asks an injected predicate whether an account
is still configured. It returned `boolean`, so a caller that could not yet
answer, config not loaded, manager mid-reload, account list a promise that has
not settled, had to pick one of two answers, and both are wrong:

- answering `false` reaps the stored cursor. The next `resolve()` then answers
  **`first-run` at the mailbox's current high-water mark**, so every message
  between the discarded position and that mark is *skipped*, not replayed,
  skipped, and the owner is told the mailbox started fresh, which is exactly
  what a genuine first run looks like. Seeded at UID 900 against a mailbox at
  1500, that is six hundred messages nobody ever sees and no line anywhere
  saying so.
- answering `true` keeps cursors for accounts that really were removed, which is
  a bounded leak the count cap already handles.

The defect was **latent**: the one production caller builds its predicate from
an account it has already resolved, so the empty-configured-set trigger is
avoided by construction. That is not protection, it is luck about the current
call site, an account-id rename reaches the same path, and nothing in the
predicate's shape stops the next caller from guessing.

The answer type is now `boolean | 'unknown'`, `'unknown'` keeps the cursor, and
`CursorSweepReport.unresolvedAccounts` counts what was kept for a reason nobody
could confirm, because a retained cursor that nothing justified is persisted
state held for an unknown reason, and a count that never falls to zero is a
caller that can never answer.

> **Absence of an answer must never be representable as an answer of absence.**
> A two-valued predicate forces every caller who does not know to lie, and the
> caller who lies in the safe-looking direction is the one that loses data.

The same reasoning is why the capability probe in §13.7 treats `null`, nothing
has probed yet, as permission to proceed rather than as a failure. Three
answers, in both places, for the same reason.

### 13.11 Settings that ship configured and read by nothing

`surfaces.email.inbound.gmailPollSecondsExpecting`, `.gmailPollSecondsIdle` and
`.onInsufficientCapability` each had a schema row, a documented default, a
validated range, daemon-owned scope and a user-facing description, and no
consumer anywhere in `packages/sdk/src`. Two of them were *named in doc comments*
beside the fields they are supposed to fill (`GmailMailSourceDeps.pollExpectingMs`
and `pollIdleMs`), which is what made them look wired.

The two Gmail keys are now read, and the reason they were not is §13.12: the
only constructor that takes them had no production call site at all. They are
filled in `composeInboundMail`, and the effect, both intervals read back off a
running Gmail source, the short one after an expectation is opened, is asserted
in `test/inbound-mail-gmail-reachability.test.ts`.

`onInsufficientCapability` is now read too, and closing it needed a path built
before the key could honestly be wired. `notice-only` promises to keep announcing
arriving mail from envelope fields alone, and nothing could do that: on IMAP,
`fetch-refused` is minted from a *failed* envelope fetch, so when it fires there
are no envelopes, and every other `insufficient` reason is "cannot log in",
"cannot open the mailbox" or "cannot keep a cursor". Wiring the key without the
path would have made the settings UI offer a behaviour the daemon answered with
silence, the V9 failure below with a switch on it.

The one condition where mail can be seen arriving without being readable is a
Google `gmail.metadata` grant: headers are authorized, bodies are not. So
`GoogleApiClient.readMessageMetadata` issues `messages.get?format=metadata`,
`collectHistoryDelta` takes that path under `onMetadataOnlyGrant:
'fetch-metadata'` and returns a delta whose `bodies` field reads
`withheld-metadata-only`, and `intake.ts` routes those messages to the
`capability-degraded` notice outcome, which had existed, been rendered and been
tested with **zero producers**.

Two consequences are load-bearing rather than incidental:

- **A metadata-only message can never satisfy a verification expectation.**
  `matchCandidate` gates on the delivery-evidence address and nothing else, and
  that address is a *header*, so a metadata-only message would otherwise match an
  open expectation and consume it on evidence nobody read, the verification link
  lives in the body that was never fetched. The intake therefore does not consult
  the expectation book at all on that path.
- **`notice-only` degrades to `refuse-and-notify` on every other reason, and says
  so.** `resolveInboundCapabilityPolicy` (`capability-policy.ts`) owns that rule
  and returns the sentence, which rides on the capability verdict's `detail` and
  reaches the owner through the status line and the terminal notice. An owner who
  set `notice-only` and then heard nothing would conclude no mail arrived, when
  what happened is that the setting could not apply.

This is the failure mode §13.7's V9 row describes, one level up: the schema half
of the coverage is thorough enough that the missing half does not show. A
setting is not a feature until something reads it, per the standing
`flags-are-features` rule that every flag ships as a real configurable feature.

`inbound-email-config-schema.test.ts` scans production sources for a *read* of
each key (inside a `get(...)` or `readNumberSetting(...)` call, not a mention in
prose) and fails if the set of unread keys is anything other than the named
inert list. Wiring one reddens it, which forces an effect assertion to be written
rather than the key quietly joining the "tested" pile, which is exactly what
happened when the two Gmail keys were wired.

### 13.12 The Gmail source was complete, tested, exported and never constructed

`GmailMailSource` shipped finished. `createInboundMailSourceFactory` took a
`GmailSourceBuilder`, `composeInboundMail` accepted an optional `gmail` field,
and its comment read "Supplied by a composition that has an adopted Google
credential." **No such composition existed.** `deps.gmail` was `undefined` on
every machine, `create()` answered `null` for `kind: 'gmail'`, and
`selectionFacts` reported `googleAdopted: options.gmail !== undefined`, permanently false.

The consequence was not a degraded Gmail path; it was no Gmail path. An owner
with Google adopted and IMAP never configured got an inactive supervisor whose
status read "no Google credentials have been adopted on this machine", sending
them to look for a credential that was already there.

Everything else on the inbound path, the cursor, backoff, dedup, expectations
and the notice route, sat on the IMAP branch that account never used.

Three things kept it invisible:

  - **Every test that exercised the Gmail arm handed the factory a builder.**
    That is precisely the shape production lacked, so the suite was green over
    the one condition that mattered.
  - **`GoogleApiClient` had no way to produce a `currentHistoryId`.** It exposed
    no profile call, which the source's own comment recorded, so the missing
    wiring had a true-sounding excuse attached to it.
  - **`mailAccountIsGmail` was read off the configured IMAP host.** On a machine
    with Google adopted and no IMAP at all it answered `false`, so even a wired
    Gmail arm would not have been selected under `auto`.

All three are closed. `GoogleApiClient.getProfile()` / `.currentHistoryId()`
call `users.getProfile`, whose `historyId` is documented as "the ID of the
mailbox's current history record", the right value for a path that establishes
without backfilling. `createDaemonGmailInboundReader` resolves the adopted
credential in the daemon tier, exactly as `createDaemonCalendarGatewayService`
does. `isGmailMailbox` accepts the address `users.getProfile` returns as direct
evidence, keeping the IMAP-host test for the case where both are configured.

The Gmail reader option on `composeInboundMail` is **required**, not optional.
An unfilled optional field is indistinguishable from a machine with no Google
account, and that indistinguishability is the whole defect; a required provider
that ANSWERS `unavailable` with a reason carries the same information and cannot
be silently dropped, because `createBuiltinChannelRuntime` stops compiling.
That compile error is the gate, a test could go inert the same way the code
did.

### 13.13 The load-bearing false comment, and the merge-resolution variant

This round kept finding the same thing, often enough to be worth naming as a
class rather than as four incidents. In each case a comment did not merely fail
to describe the code: it **justified or protected** the thing it described, and
that is what stopped anyone checking it.

The two instances inside this document's own scope, both fixed here:

- `terminal-notice.ts`'s *"its result is deliberately unread"*, §13.8 already
  records this one. The sentence was the defect's rationale, not its
  description.
- `sink.ts`, `dedupTtlMs()`, §6 and the §8 table all asserting the dedup TTL
  "must outlast a restart cycle", a property the mechanism cannot provide at
  any value, protecting a config floor that guarded nothing (§13.9).

Two more of the same class arrived elsewhere in the round and are recorded here
by class rather than by detail, since they were found and fixed outside this
document's scope: an API file claiming to be produced by a generator that does
not exist, and a design document citing a decision record that does not exist.
Both were verified by whoever fixed them, not by me, so they are named as
instances and not described further.

**The variant worth its own name is the one that came from a merge resolution
rather than from authorship.** `record-store.ts` carried *"Not reachable today:
`intake.ts` passes `body: ''`"*. That was accurate against the tree the scan-
window fix was written for, and false against the tree it landed in, because the
Gmail body arm merged in between, the IMAP envelope pass sends `''`, a Gmail
history delta sends the real body. Nothing about the line changed; the tree
moved under it. The code the comment called unreachable was executing while the
suite was green, and `inbound-mail-intake.test.ts` had been driving a card
number through it the whole time.

> **A reachability claim is a claim about the whole tree, and the tree moves
> under it. Verify it; never inherit it.** A kept comment carries the same
> obligation as a kept line of code, and a merge resolution is exactly where
> that obligation is easiest to skip, because nothing in the conflict marks the
> sentence as needing re-checking.

The direction of this one is why it was worth a commit rather than a tidy-up: it
told the next reader the multi-span leak was theoretical, when a Gmail message
carrying several card shapes would have hit it in production on the source
automatic selection prefers once Google is adopted. And it read as licence to
relax the double pass later, on the grounds that nothing exercises it.

That harm is no longer only argued. `inbound-mail-card-redaction.test.ts` builds
a body whose second card straddles the removed scan window; measured against the
windowed implementation it put **eleven readable digits** of that card on disk,
and restoring the window reddens that test and only that test. The single-span
straddle test that already existed passes under the same mutation, which is what
shows the old coverage genuinely missed this shape rather than merely overlapping
it.

> **When a comment's claim is the thing in dispute, the fix is a test, not
> better wording.** Correcting "not reachable" to "reachable" leaves the next
> reader with two sentences and no evidence. A case that reddens when the guard
> is removed settles it.

## 14. Related

- `docs/payments.md`, a consumer of this capability.
- `docs/decisions/2026-07-27-daemon-refuses-derived-sends.md`, the outward-send
  refusal this ingest path feeds.
- `docs/security.md`, untrusted content and link validation.
