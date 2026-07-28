# Inbound email — design

**Status:** design of record. Implementation follows this document.

The daemon could send mail and could read mail *when asked*. Nothing ever asked
on its own, so the mailbox was a capability the agent used while you talked to
it, never a channel that could reach it. The owner replied to an email his agent
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
  mailbox — neither touches IMAP.
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
| An arriving message **satisfies an expectation** an authorized workstream registered in advance | Yes — this is the entire mechanism |
| An arriving message **creates work**, starts a workstream, spawns an agent, or initiates anything | **Never** |
| An arriving message **registers, widens or extends** an expectation | **Never** |
| No expectation matches | The mail is inert: recorded, owner told, nothing else |

An expectation is registered **before** the mail arrives, by the workstream that
already holds authority, scoped to a specific recipient address, a specific
service domain, a specific purpose and a bounded window. This is
`VerificationExpectationBook` in
`packages/sdk/src/platform/google/verification-expectations.ts`, and it is
reused rather than paralleled.

Matching is keyed on `DeliveredRecipient` — the branded type in
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
fields**. The shared adapter path does not merely permit spawning work — it
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
carries `openExpectation`, and now also `hydrateExpectation` — two methods that
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
wrapped or duplicated — the watcher simply cannot name what it does not hold.
`hydrateExpectation` is boot-only: the wiring calls it from the store's recovery
sweep, never the watcher. Enforced by a type-level test and by a source-level
test that no file under `platform/email/inbound/` mentions either method. Three tests hold the line: a runtime own-property assertion (so
a later widening is caught even if it type-checks), a type-level test asserting
`InboundMailContext` is not assignable from anything carrying a spawn field, and
a source-level test asserting no file under `platform/email/inbound/` references
`trySpawnAgent`, `sessionBroker` or `AgentManager`.

**Second, the trap is closed anyway.** `'email'` is added to
`CONVERSATION_GATE_DEFAULT_SURFACES`. This round does not need it — nothing here
reaches `gateSurfaceSpawn` — but leaving a surface name that fails open in a
list whose whole purpose is failing closed is a defect waiting for the next
person who wires email the ordinary way.

`authorizeSurfaceIngress` takes a `surface` union that does not include
`'email'`, and it is **not** widened. That union enumerates surfaces that can
authorize ingress into a conversation. Email cannot, so adding it would be the
exact assumption this section removes.

### 2.2 The expectation mechanism has never actually run

`VerificationExpectationBook` is fully built and thoroughly tested, and
`grep` finds **no production instantiation anywhere in the SDK** — only tests
construct it. The machinery the authority rule depends on is, today, dead code.

So "reuse the existing mechanism rather than inventing a parallel one" also
means *wire it for the first time*, including:

- constructing the book at daemon boot with a real `SurfaceAuthorityProbe`
  backed by `surfaceHasCommandAuthority`, so its own defensive check —
  which refuses to open an expectation if email ever gained command authority —
  stops being dormant;
- giving it the persistence described in §9.2;
- exposing `openExpectation` to authorized workstreams (account signup,
  payments) through the control plane, and exposing it to **nothing** that an
  arriving message can reach.

---

## 3. Real-time delivery

### 3.1 The mechanism, and why

**IMAP IDLE is primary.** Confirmed rather than assumed:

- It is true push. RFC 2177: the server answers `IDLE` with a `+` continuation
  and then sends untagged responses as they occur; the client ends it by
  sending `DONE`.
- It is provider-agnostic — one implementation serves Gmail, Fastmail, a
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
timer well inside that bound (default 27 minutes — see §7), not at 29.

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
  `unavailable: 'no-gmail-scope'` in health — visibly, in the surfaced status —
  and the IMAP IDLE watcher serves the Gmail account instead. Gmail speaks IMAP
  IDLE with an app password, so the account is covered either way.
- It never silently does nothing. A capability that is off must say it is off.

**Gmail `users.watch` + Pub/Sub is rejected, and not built.** Four separate
pieces of setup friction, one of which is disqualifying on its own:

1. It delivers to an HTTPS **push endpoint**. The daemon runs on a home machine
   behind NAT. There is no endpoint to deliver to, and inventing one means
   asking the owner to expose a public URL to run his mail.
2. It needs a GCP project with a Pub/Sub topic and an IAM binding granting
   `gmail-api-push@system.gserviceaccount.com` publish rights.
3. It needs the same restricted Gmail scope as `history.list`, so it inherits
   every problem above and adds infrastructure.
4. The watch registration **expires and must be renewed**, so it adds a
   recurring failure mode whose symptom is silence — the precise failure this
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

**(d) `fetchEnvelopes` reports a sequence number in a field named `uid` — a
live defect, user-reachable today.**
`imap-client.ts:390` sets `uid: seqNum` from the values returned by `SEARCH`.
`email-service.ts:486` feeds it exactly those, and `listInbox` returns them as
`uid`. `email.inbox.read` documents its parameter as *"an IMAP UID: a positive
integer"*, passes it to `readMessage(uid)` → `fetchMessage(uid)` → `UID FETCH`.
So listing a mailbox and then reading from that listing reads **a different
message** whenever a sequence number and a UID differ — which is every mailbox
that has ever had a message deleted. The file's own header explains precisely
why this is wrong (*"a sequence number from then may by now belong to a
different message"*) and the code does it anyway. The 404 text —
*"It may have been moved or deleted since it was listed"* — misattributes the
resulting failure to the mailbox.

This is not incidental to inbound mail. A durable cursor **must** be UID-keyed,
because sequence numbers renumber on every expunge. **Fix:** `UID SEARCH`
instead of `SEARCH`, `UID` added to the FETCH data items, and the real UID
parsed and reported.

**(e) The body preview is attached to the wrong message.** Same code path,
separate defect. `SEARCH` returns sequence numbers in ascending order, so
`seqNums[0]` (`email-service.ts:491`) is the **oldest** match, while
`fetchEnvelopes` keeps `seqNums.slice(-limit)` — the **newest**. The preview
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
  requires no refetch — it cannot produce new mail — but it invalidates any
  in-flight sequence numbers, so any pending sequence-number work is dropped
  rather than reused.
- **Nothing is marked `\Seen`.** `EXAMINE` keeps the mailbox read-only and every
  fetch uses `BODY.PEEK`. Reading the owner's mail must not mark it read behind
  his back. This is also why the cursor cannot be the server's `\Seen` flag —
  see §4.

### 3.4 Reconnection, and the failure modes that actually happen

- **Backoff:** exponential from 1s, doubling to a 5-minute ceiling, with
  full jitter so a provider outage does not produce a synchronized retry storm
  across every mailbox and every restart.
- **A reconnect never loses messages**, because recovery is not "resume the
  stream" — it is "ask what is above the persisted cursor". Whatever arrived
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
one. A separate round is fixing that generally — a credential the daemon needs
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
`users.history.list` — a set that includes `gmail.metadata`. Google's scope
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

- **Gmail API path** — two scope tiers, checked separately. Scopes that
  authorize the history call, and scopes that authorize bodies
  (`gmail.readonly`, `gmail.modify`, `https://mail.google.com/` — *not*
  `gmail.metadata`). History-capable but not body-capable refuses **before**
  making the call.
- **IMAP path** — `open()` reports a typed capability record rather than
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
| `healthy` | Full capability | Running, IDLE or polling |
| `degraded` | Reduced but still serving its purpose — e.g. no `IDLE`, so polling | **Running.** Expectations still work |
| `insufficient` | Cannot read the mailbox, or cannot fetch bodies | **Not running** |

**Ruling: `insufficient` refuses and notifies. It does not silently degrade.**
`surfaces.email.inbound.onInsufficientCapability` defaults to
`'refuse-and-notify'`; `'notice-only'` exists as a deliberate, configured
downgrade and is never entered automatically.

The reasoning, since this rejects the more accommodating option:

1. **An expectation that can never be satisfied is worse than no expectation.**
   The signup workstream would wait out its entire window and then report "no
   verification mail arrived" — which is false. It would send the owner to check
   his mailbox when the problem is his grant, and the mailbox will look fine.
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
  connection is **not** insufficient — recovery fetches everything above the
  cursor, so the expectation is still satisfiable and must not be failed.
  Only a capability verdict fails an expectation.
- **Re-probed on a timer** (`capabilityRecheckMinutes`, default 60) and on
  config change, so the owner fixing his scopes does not require a restart to
  take effect. Not a tight retry loop.
- **Notified once per transition**, not once per probe. A recurring alarm about
  a condition the owner already knows about trains him to ignore the channel
  this capability depends on.

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
poll surfaces do — `{ mode: 'idle' | 'polling' | 'inactive', reason, running }`
— which `getStatus()` folds into the standard `ChannelStatusSnapshot`
(`state: 'healthy' | 'degraded' | 'disabled'`, `enabled`, `accountId`,
`metadata`) so it appears in channel health and the doctor report alongside
every other surface.

**It registers as a `ClusterConsumerGate`.** Clustering defaults off, but when
the owner opts in, two nodes both holding an IDLE connection to the same mailbox
would both fetch and both notify — the same message announced twice, from a
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
  meaningless — the mailbox was recreated. The cursor is discarded and
  re-established at the current high-water mark, and the event is disclosed to
  the owner. It deliberately does **not** replay the mailbox: re-notifying about
  a year of old mail because a server rebuilt an index is not recovery, it is a
  flood.
- **First run establishes the mark; it does not backfill.** A newly enabled
  mailbox sets `lastSeenUid` to the current highest UID and reports how many
  messages it skipped. The daemon starts listening now; it does not
  retroactively decide about mail that arrived before it was asked to.
- **The cursor advances only after a message is fully processed** — matched,
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
the owner is mid-request would refuse his outward action on the basis of a
message that no turn read, no model saw, and nobody asked for. That is worse
than the bug the taint round is fixing: it makes any stranger with the owner's
address able to disable his agent's outward actions on demand, by sending mail.

So the rule is:

> **The turn ledger records a body when a turn reads it, never when the daemon
> receives it.**

Concretely:

- The watcher writes arriving mail to its own durable **inbound record store**,
  which is not the turn ledger and has no watermark.
- `ledger.record()` is called from where it is called today —
  `EmailService.listInbox` / `readMessage`, inside a turn that asked — and from
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
("nothing routed it in — that is the keyboard"). Inbound email is routed in, so
it must always supply an origin, and that origin must carry
`ownerDirect: false` explicitly rather than relying on its source name being
absent from a list. Stated as a requirement in §10.

### 5.2 Every message body is untrusted content

Labelled at the boundary via `labelUntrustedContent`, `surface: 'email'`,
`origin: 'email:<domain> (claimed)'` — keeping the existing wording, which
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
  `expectation.serviceDomain` — exact for `'login'`, subdomain-tolerant via
  `hostMatchesServiceDomain` for `'signup'` — by `extractVerification`, which
  yields at most one artifact and refuses with `'link-host-mismatch'` rather
  than returning a link from the wrong host.
- **A link in mail that matched nothing** has no authorized domain to be
  validated *against*, because no workstream declared one. It is therefore
  never resolved, never followed, and never actioned. It is rendered to the
  owner as its registrable domain plus a refusal reason where one applies, so
  he can see what was in his mail without the daemon having touched it.

---

## 6. Dedup

Inbound mail can reach the pipeline twice: an IDLE wake and a fallback poll can
overlap; a crash between fetch and cursor-advance re-delivers; a reconnect
refetches above the cursor.

`InboundMessageDedup` from `platform/adapters/inbound-dedup.ts` is reused as-is
— it is already bounded (2048 entries), already TTL-expiring (10 minutes),
already order-pruned, and its `claim()` contract is exactly right. The key is
built with the existing `inboundDedupKey(surface, scope, messageId)`:

```
inboundDedupKey('email', `${account}:${mailbox}`, `${uidValidity}:${uid}`)
```

The **UID under its `UIDVALIDITY`** is the identity, not the `Message-ID`
header. `Message-ID` is written by the sender: two different messages can carry
the same one, which would let a sender suppress a later message by colliding
with an earlier one. The UID is assigned by the receiving server and the
`UIDVALIDITY` qualifier keeps it unambiguous across a mailbox rebuild.

The module-scoped default TTL of 10 minutes is too short here — a crash-restart
cycle can exceed it — so the email adapter constructs its own
`InboundMessageDedup` instance with an email-appropriate TTL (§7) rather than
sharing `ntfyInboundDedup`.

---

## 7. Owner notice

New mail the owner should know about is delivered where he actually is. The
existing entry point is
`DaemonSurfaceDeliveryHelper.deliverSurfaceNotice(binding, text)` — and it takes
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
  can appear on the owner's phone then an attacker chooses what he reads there.
- **Subject and sender are attacker-written too**, so they are sanitized, not
  trusted: newlines and control characters removed (a subject containing
  `\n\nApproved: yes` must not render as two lines), length-capped, and never
  interpolated into anything the receiving surface parses as markup or as a
  command.
- **Links appear as registrable domain plus verdict**, never as clickable URLs
  the daemon assembled from message text.
- **The delivery address is shown**, because for a per-signup alias it is the
  single most useful fact — it says which account this is about, from evidence
  the sender could not forge.

### 7.1 Which fields are attacker-chosen — the audit

A defect found in review makes the case for doing this as a list rather than by
intuition. `deliveredTo` was given weaker sanitization than the subject line, on
the reasoning that a delivery header "cannot be forged by the sender". The
header cannot be forged — the receiving server stamps it truthfully — but what
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
| `deliveredTo` domain | our own domain | Ours — but escaped anyway, at no cost |
| `outcome.purpose` | the registering workstream | **Attacker-chosen unless drawn from a fixed vocabulary.** A signup flow that lifted a service name off a web page is passing untrusted text through an authorized caller |
| `outcome.serviceDomain` | expectation, validated | Validated ASCII hostname. Escaped anyway |
| `outcome.reason` | refusal | Ours **only if** it is a fixed enum member. Any reason quoting a server's wording is attacker-chosen |
| `links[].host` | extracted + validated | Registrable domain, hostname-shaped. Escaped anyway |
| `receivedAt` | **our clock** | Ours — **and this is load-bearing.** `ImapEnvelope.date` is `extractHeader(raw, 'Date')`, a string the sender wrote. The notice timestamp must come from our own receipt time, never from that header |
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
`untrusted` spans per its own syntax — **escapes, not strips**, so
`[Approved](https://evil.example)` reaches the owner as that exact literal text
rather than as a link or as mangled spaces. He sees what the mail actually said,
and it does nothing.

Why this is the right shape:

- **The producer cannot get it wrong**, because it never holds a channel-format
  string. Forgetting to escape is not a mistake that can be made in the wrong
  place; the only code that turns spans into text is the code that knows the
  syntax.
- **Adding a channel is a bounded, visible task** — implement one escaper —
  rather than an invisible widening of a shared character set.
- **Untrusted-ness travels with the value.** A field passed through three
  functions is still tagged `untrusted` at the end.

**Discord masked links are what make this required rather than precautionary**,
and it was verified rather than assumed. `[text](url)` **does** render in
bot-sent messages, webhook messages and embeds. It does **not** render in
messages a human types into the client — a trade-off Discord made specifically
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

### 7.3 Make the unsafe value unconstructible, not merely validated

The strongest defence produced in this round deserves a name, because it is a
better class of protection than sanitizing and it generalizes well past email.

`receivedAt` is a branded `ReceiptTimestamp` whose only constructor takes a real
`Date` the daemon observed. A sender's `Date:` header is a `string`, so it
cannot be passed — not "is rejected by validation", but **has no path into the
type at all**. The check cannot be forgotten, because there is nowhere to forget
it.

The codebase already had one instance, and it is the reason the expectation
mechanism can be trusted at all: `DeliveredRecipient` does not export its brand
symbol, so a value can only originate from the mailbox actually fetched from or
a delivery header the receiving agent stamped. No quantity of sender-written
text produces one.

Stated so it gets reused:

> Where an attacker-supplied value could be mistaken for an observed one, do not
> validate the attacker's version — make it **impossible to construct**. Give
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

`deliverSurfaceNotice(binding, text)` takes a plain string and stays as it is;
the channel renderer runs immediately before it. Until every channel has an
escaper, the fallback renderer emits **plain text with all markup neutralized**
— the conservative behavior, chosen explicitly rather than inherited.

Routing is configurable (§8). The default is the owner's existing notice route
binding, so this inherits whatever he already uses rather than introducing a
second notion of "where to find me".

`deliverSurfaceNotice` refuses with a typed reason
(`no-route-binding`, `surface-delivery-disabled`, `no-deliverable-target`,
`delivery-failed`, …). A refused notice is **recorded in the inbound store with
its reason** and surfaced in health. Mail that arrived and could not be
announced is a fact the owner gets to see, not a dropped promise.

---

## 8. Configuration

Daemon-owned config, under `surfaces.email.inbound.*`, sitting alongside the
existing `surfaces.email.*` connection settings so one account is configured
once. Every setting is a real, meaningful control — not an enable/disable pair
wearing a feature's clothes.

| Key | Type | Default | Why this default |
|---|---|---|---|
| `surfaces.email.inbound.enabled` | boolean | **`false`** | Reading the owner's mail continuously is not a thing to start doing without being asked. Off until configured, then on. |
| `surfaces.email.inbound.accounts` | list | `[]` | Which configured mailboxes are watched. A list, not a boolean, because one address for signups and another for the owner's real mail is the expected shape. |
| `surfaces.email.inbound.mode` | `'idle' \| 'poll' \| 'auto'` | **`'auto'`** | `auto` uses IDLE when the server advertises it and polls when it does not. A user should not have to know what his provider supports. |
| `surfaces.email.inbound.pollIntervalSeconds` | number | **`120`** | The fallback path only. Two minutes is responsive enough for a verification mail and far below any provider's rate limit. Range 30–3600. |
| `surfaces.email.inbound.idleReissueMinutes` | number | **`27`** | RFC 2177 advises re-issuing at least every 29; 27 leaves room for a slow round trip without crossing the bound. Range 5–29, capped at 29 by validation. |
| `surfaces.email.inbound.reconnect.maxBackoffSeconds` | number | **`300`** | Five minutes bounds the worst-case silence after a provider outage while not retrying a dead server every second. |
| `surfaces.email.inbound.notice.route` | route binding \| `'default'` | **`'default'`** | Inherits the owner's existing notice routing. A second place to configure "where to reach me" is a second place to get it wrong. |
| `surfaces.email.inbound.notice.mode` | `'all' \| 'expected-only' \| 'none'` | **`'all'`** | He asked to be told about mail. `expected-only` exists for a high-volume mailbox; `none` is available and disclosed, but silence is not a default. |
| `surfaces.email.inbound.expectationWindowMinutes` | number | **`15`** | Matches `DEFAULT_VERIFICATION_WINDOW_MS` already shipped. Range 1–60, hard-capped by the existing `MAX_VERIFICATION_WINDOW_MS`. |
| `surfaces.email.inbound.dedupTtlMinutes` | number | **`60`** | Must exceed a restart cycle, or a crash re-delivers as a duplicate. An hour covers the auto-update restart. |
| `surfaces.email.inbound.retentionDays` | number | **`30`** | How long inbound records are kept before reaping. Long enough to explain "why did I get that message", short enough to bound the store. |
| `surfaces.email.inbound.maxRecords` | number | **`5000`** | The hard bound. Whichever of age or count binds first, wins. |
| `surfaces.email.inbound.capabilityRecheckMinutes` | number | **`60`** | How often a mailbox reporting insufficient capability is re-probed (§3.4b). Fixing a scope must not require a daemon restart, and must not produce a tight retry loop. Range 5–1440. |
| `surfaces.email.inbound.onInsufficientCapability` | `'refuse-and-notify' \| 'notice-only'` | **`'refuse-and-notify'`** | §3.4b. `notice-only` is a deliberate downgrade in which expectations can never be satisfied — so signup and order confirmation stop working — and is never entered automatically. |

**Every default above is mine, not the owner's, and needs his confirmation** —
fourteen of them now, counting the two capability settings —
`flags-are-features` requires an explicit per-flag ruling. They are listed here
rather than buried in a schema file so he can rule on them as a set. The two
most likely to be argued: `enabled: false` (the alternative is a daemon that
starts reading mail on upgrade, which is not a decision an upgrade should make)
and `notice.mode: 'all'` (the alternative silently drops the case he complained
about).

### 8.1 How it is declared, and what each surface needs

Declared once, in a schema domain file, in the hand-rolled
`ConfigSettingDefinition` format the rest of the config uses (there is no zod):
`key`, `type`, `default`, `description`, plus `enumValues` / `intRange(min,max)`
for validation. The existing `surfaces.email.*` connection settings already live
in `config/schema-domain-daemon-mailbox.ts`, so the inbound keys join them
there and flow through `schema-domain-surfaces.ts` into `CONFIG_SCHEMA`.

Because `'surfaces.'` is already in `DAEMON_OWNED_CONFIG_PREFIXES`, these keys
are daemon-owned automatically — no ownership edit, and the TUI's
daemon-owned-note enrichment picks them up for free.

What each surface needs, verified rather than assumed:

- **TUI** — nothing. `buildSettingGroups` walks `CONFIG_SCHEMA` and derives the
  category from `key.split('.')[0]`, which is already `surfaces`.
- **Agent** — nothing. Same derivation in `settings-modal.ts`; the `surfaces`
  category and its `CATEGORY_INFO` sentence already exist.
- **webui** — one build step. The browser bundle cannot import the node-only
  config barrel, so it reads a checked-in snapshot generated by
  `scripts/generate-config-schema.ts`. Bump the SDK dependency and run
  `bun run config-schema:generate`. `config-schema:check` is wired into
  `bun run build`, so a schema change without regeneration fails the build
  rather than shipping a settings screen missing the new fields.

"Surfaced in every surface" is therefore mostly free — but *mostly free* is not
*done*, and each of the three is opened and confirmed rather than assumed, since
a setting the owner cannot find is a setting he does not have.

---

## 9. Persisted state and the recovery rule

Three things outlive a restart, and the owner's directive is that anything
persisted across restarts **reaps, bounds, validates by content, sweeps
periodically, and discloses**. Each is specified against all five.

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
`resolveSurfaceDirectory(homeDirectory, 'daemon', …)` — the surface-scoped
storage mechanism, not a hand-built path.

### 9.1 The cursor store

| Rule | How |
|---|---|
| Reaps | Cursors for accounts no longer in config are dropped on load. |
| Bounds | One record per (account, mailbox); the file cannot grow with traffic. |
| Validates by content | On load every field is re-validated: `uidValidity` must be a positive integer, `lastSeenUid` a **non-negative** integer (zero is the honest value for a first run against an empty mailbox, and requiring positivity would make a freshly-established cursor fail its own validation on the very next load), `updatedAt` a parseable ISO date, `mailbox` a non-empty string. A record failing any check is **discarded, not repaired** — a corrupt cursor silently coerced to `0` would replay the entire mailbox. Discarded cursors re-establish at the high-water mark and are disclosed. |
| Sweeps | On load, and on config change. |
| Discloses | `email.inbound.status` reports every cursor with its mailbox, position and age. |

### 9.2 The expectation store — and a decision that overrides the existing one

`VerificationExpectationBook` is in-memory today, deliberately: *"an expectation
is a 15-minute grant, and a grant that survives a restart is a grant nobody
remembers issuing."* That reasoning is sound and I am overriding its conclusion,
narrowly, for a reason that did not exist when it was written:

**The daemon auto-restarts.** It checks for updates hourly and restarts itself
at idle. An account signup begun at 14:58 with a restart at 15:00 loses its
expectation, and the verification mail then arrives inert — the exact failure
this entire round exists to eliminate, caused by our own update mechanism.

The override is narrow and keeps what the original reasoning protects:

- Expectations persist **with their original absolute `expiresAt`**. A restored
  expectation never gets a fresh window. Restarting cannot extend a grant, which
  is what "a grant nobody remembers issuing" was guarding against.
- Anything already expired is **reaped on load**, before it can match anything.
- Records are validated by content on load: `id`, `serviceDomain`,
  `recipientAddress` and `purpose` re-validated by the same functions
  `openExpectation` uses, `authority` must read exactly `'evidence-only'`, and
  `expiresAt - openedAt` must not exceed `MAX_VERIFICATION_WINDOW_MS`. A record
  failing any check is discarded. **A file on disk cannot mint an expectation
  the live API would have refused.**
- `MAX_OPEN_EXPECTATIONS = 32` is enforced on load, not only on open.
- Swept on load and on the periodic sweep; `sweepExpired` already exists.
- Disclosed: open expectations are listed in status, with their recipient,
  purpose and remaining window.

### 9.3 The inbound record store

Bounded by both `retentionDays` and `maxRecords`, whichever binds first, swept
on a periodic timer and on load. Records hold structured fields — sender,
subject, delivery evidence, link verdicts, outcome — and a **bounded body
excerpt**, capped at the same 20,000 characters the ledger uses, so the store
cannot become an unbounded copy of the mailbox. Every field re-validated on
load; unparseable records dropped. Disclosed through status and through the
config UI, which states plainly what is retained and for how long — the owner
should not have to read source to learn his daemon keeps a month of his mail's
metadata.

---

## 10. What this needs from the taint round

Stated as requirements rather than hopes, because they are load-bearing:

1. **The turn watermark must advance on owner input, not process start.** The
   in-flight `startTurnForOwnerInput` does this. Without it, one inbound message
   read in a turn refuses every outward action until the process restarts, and
   with inbound mail arriving continuously that is permanent.
2. **Inbound email must never be owner-direct.** `inputOriginIsOwnerDirect`
   returns `true` for `origin === undefined`. Every inbound-mail-originated
   invocation must therefore pass an origin with `ownerDirect: false` set
   explicitly, never omit it.
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

**Provenance, stated plainly: this is a coordinator ruling, not an owner
quote.** The owner's ruling it enforces is his own — card details are entered
only at a local terminal or the webui, never over a remote messaging channel.
What follows is the daemon-side enforcement of that.

The payments round built the outbound half in `goodvibes-agent`: no card-entry
prompt is offered toward a remote surface, and outbound card-shaped content is
refused before reaching a provider. It reported the **inbound** half as not
implementable there, and verified rather than asserted it — the agent is
adopt-only, has no inbound channel path at all, `no-inbound-consumers.test.ts`
fails the build if one is added, and `unified-inbox.ts` marks the seam as
awaiting a daemon contract. That is correct, and it lands the inbound gate here.

**The requirement.** A message arriving on any remote messaging channel that
carries card-shaped content is refused. Not stored — it never reaches the
payments store, config, or any secret tier. Not logged, not transcribed, not
placed in a notice body: nowhere it can be read later. The refusal reply names
only the matched **shapes**, never the digits, matching the precedent the agent
round set outbound. And no card-entry prompt is ever offered on a remote
channel, because **prompting is itself the harm** — it invites him to type a
card number into Telegram, where it lands in a third party's history nobody can
erase.

**The distinction a later reader will try to collapse, so it is written in these
terms:** approvals and vetoes for purchases **do** work over remote channels —
that is the owner's explicit ruling and it stays. Remote surfaces have authority
to **say yes or no about a purchase**; they have **no path for entering the
instrument**. Authority over a decision is not a channel for a secret. These two
must not be unified.

#### Where the check goes

`SurfaceActions.authorizeSurfaceIngress`
(`platform/daemon/surface-actions.ts:179`) — the single shared hook that all
nineteen remote adapter call sites already pass through. The file argues for
this placement itself, having put work-proposal and approval-reply consumption
there *"on the shared ingress hook every surface adapter already calls — which
is what makes agreement answerable over whatever channel the proposal went out
on, with no per-adapter wiring"*.

Per-surface would be wrong for the reason the agent round learned firsthand: a
fix applied per-adapter leaves the other seventeen open.

**It runs first** — before `evaluateIngress`, before proposal-reply resolution,
before approval-reply resolution. Everything downstream may store, log or
transcribe, so the check must precede all of it.

One consequence, deliberate: a message that would have been an approval or a
veto is refused if it carries card shapes. **The refusal reply is always
delivered**, even though the content is dropped — this is the one case where
silence would do harm, because an unheard objection inside a veto window
elapses into a completed purchase. He is told immediately, on the same channel,
and can resend without the digits.

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
§7.3 again: the digits are not something a caller must remember not to log —
they are not reachable from the result at all. A refusal message composed from
findings is structurally incapable of quoting a card number.

Rules:

- **`pan`** — a run of 13–19 digits after stripping internal spaces and hyphens,
  passing the Luhn check. Luhn alone is the discriminator; a known issuer prefix
  is deliberately **not** additionally required, since that would miss valid
  cards from less common networks. The trade is asymmetric and decided
  accordingly: a false positive costs one refused message with a clear
  explanation, while a false negative puts a real card number into a third
  party's message history permanently.
- **`security-code`** and **`expiry`** — never refused on shape alone. Three or
  four bare digits, and `MM/YY`, are far too common, and refusing them would
  make the channel unusable. They count only in card context (`cvv`, `cvc`,
  `security code`, `card`, `expiry`) or alongside a `pan` finding.

A message is refused if any `pan` is found, or if a `security-code` or `expiry`
finding occurs in card context.

#### This applies to inbound mail too, and that is a finding about this design

The inbound record store (§9.3) persists a **bounded body excerpt for thirty
days**. A card number in an email would therefore be written to disk and kept —
by this round's own machinery, in a store this round introduced. Nobody asked
for that and it is exactly the exposure this section exists to prevent.

Email is not gated the way remote channels are: mail is not refused for
containing digits, because order confirmations legitimately carry long numbers
and refusing them would break the consumer this capability exists to serve. The
answer is **redaction, not refusal**. `detectCardShapes` runs over the excerpt
before it is persisted and matched spans are replaced. The message is still
recorded, still notified, still able to satisfy an expectation; only the digits
fail to reach disk.

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
   is silence-means-proceed, so a notice that misleads him for ten minutes
   spends his money. Here, a misleading notice is merely misleading.
2. **Money is attached.** A rendered link in a purchase notice is a phishing
   target the owner has already been primed to trust, because he is expecting a
   message about a purchase he authorized.
3. **The total is the one field he checks.** An item title carrying markup can
   restyle, obscure or visually displace the amount in the same message —
   Telegram will happily bold, strike through, or spoiler-tag whatever it is
   handed. The number he reads must not be positionable by the merchant.

So the payments round needs: the same `StructuredNotice` and per-channel
escaper, `merchantName` and `itemTitle` tagged `untrusted`, and the amount
emitted as a `literal` span that no untrusted span can be interleaved with.
A test asserting a merchant name containing markup cannot alter how the total
renders.

## 11.2 Consumers

The payments capability is a consumer, not a peer: order confirmations and
delivery notices arrive by mail. It gets them through the **expectation**
mechanism — a purchase that was approved registers an expectation scoped to the
merchant's domain before checkout completes — and never through a scan of
arriving mail for order-shaped text. The asymmetry that matters and must not be
collapsed: payments **approvals never travel by email** (owner ruling), while
order *confirmations* may arrive by email as evidence of something already
authorized. Confirming is not approving.

---

## 12. Test plan — every one of these is a gate

Each test is written to fail without its fix, and that failure is verified
before the fix lands.

| # | Behaviour | Vehicle |
|---|---|---|
| 1 | Mail arriving with a registered expectation satisfies it | Fake IMAP server, expectation opened first |
| 2 | Mail arriving with no expectation is inert — no spawn, no work, notice only | Fake server; asserts the notice fired and nothing else did |
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
| 38 | Per-channel escapers cover their own syntax | Telegram MarkdownV2, Discord mentions, Slack `<url\|text>`, HTML entities, ntfy header newline — one case each |
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
   alternative — asking the owner to complete Google's restricted-scope
   verification and annual security assessment to read his own mail — is the
   highest-friction option available.
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

## 14. Related

- `docs/payments.md` — a consumer of this capability.
- `docs/decisions/2026-07-27-daemon-refuses-derived-sends.md` — the outward-send
  refusal this ingest path feeds.
- `docs/security.md` — untrusted content and link validation.
