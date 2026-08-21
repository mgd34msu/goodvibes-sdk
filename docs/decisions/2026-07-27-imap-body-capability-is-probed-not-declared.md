# On IMAP, "can I read the mail?" is probed, not declared

**Date:** 2026-07-27
**Status:** Accepted
**Scope:** `packages/sdk/src/platform/email/imap-body-probe.ts`,
`inbound/capability.ts`, `inbound/connection.ts`, `inbound/ports.ts`.
**Implements:** `docs/inbound-email.md` §3.4a, and the "Scope sufficiency
applies to both" subsection of §3.4d.

## The rule this is the IMAP half of

> A connection that authenticates but cannot deliver what the caller needs
> fails **loudly, at connect time, with a named reason and the exact step to
> fix it**. It never returns empty-looking success.

The Gmail source already keeps it. `history-delta.ts` refuses a
`metadata-scope-only` token **before** calling `users.history.list`, because
`gmail.metadata` does authorize that call and Google's own description of the
scope is *"View your email message metadata such as labels and headers, but not
the email body."* A body-less delta cannot satisfy a verification expectation,
so the call is not made and the reason is named.

The IMAP source owed the equivalent and did not have it. `LOGIN` succeeding and
`EXAMINE` succeeding say the account exists and the folder is there. Neither
says the server will hand over what is inside a message.

## Why the Gmail mechanism does not transfer

A scope check is a comparison against a published statement of what a grant
covers. IMAP publishes nothing of the kind:

- There are no scopes. There is a mailbox whose access rights the provider
  decides and never states on the wire.
- `CAPABILITY` describes the SERVER's protocol extensions, not this account's
  permissions. `IDLE`, `UIDPLUS` and `LITERAL+` say nothing about whether this
  login may read a message.
- A provider that permits headers and withholds content answers every command
  with `OK` and returns nothing. From the outside that is a mailbox nobody has
  written to.

The last point is why this is worth a design rather than a defensive `if`. **A
success indistinguishable from a real one is the worst shape a defect can take
in a delivery path**, and a quiet mailbox is what a working mailbox looks like
on a slow day.

So the equivalent of a scope comparison here is EVIDENCE: read one message and
check what came back against what the server itself said was there.

## The two halves, and why one is not enough

### A connect-time probe

After `EXAMINE`, before the connection is handed to the watcher, one existing
message is read: `FETCH n (UID BODYSTRUCTURE)` and
`FETCH n BODY.PEEK[]<0.512>` for the newest message. `BODY.PEEK` so nothing is
marked `\Seen`; `<0.512>` so this never pulls a large message down a connection
that has not yet been declared healthy.

Three things can come back, and they are three different facts:

- **A `NO`/`BAD` that names nothing about itself**, the server refused to hand
  over content. A capability failure. A refusal that the server DID
  characterise (`[LIMIT]`, an auth code, a mailbox code) is re-thrown for the
  existing classifier, because calling Gmail's connection limit "this account
  cannot read bodies" would put a false and very specific explanation in front
  of the owner and stop the watcher over a condition that clears in seconds.
- **An empty section for a message whose own BODYSTRUCTURE declared a text part
  with octets in it**, the same capability failure, and the one a
  refusal-only check misses entirely. This is the quiet-mailbox impostor.
- **Bytes**, demonstrated.

The declared-versus-returned comparison is the whole idea. Without the server's
own declaration there is no way to tell "this message is empty" from "this
server will not show me this message", and that is why the probe fetches
BODYSTRUCTURE alongside the body rather than the body alone.

### A runtime invariant on the first real body

The probe cannot run on an empty mailbox, there is nothing to probe. So the
same comparison runs again on the first body actually fetched. Same function,
`assessFetchedBody`, evaluated at both call sites, so the two places cannot
disagree about what an empty body means.

Both halves are required. The probe alone leaves every empty mailbox unchecked,
and an empty mailbox is precisely a freshly created signup alias.

## The verdicts

Two reasons were added to `InboundCapabilityReason`.

**`bodies-unfetchable` → `insufficient`.** Deliberately NOT a reuse of
`fetch-refused`. That reason means the server said no to handing over message
data, and its remedy points at IMAP access and folder restrictions. This one
means the server said yes and handed over nothing, and its remedy points at
what this account is permitted to READ, the mailbox's access rights, or a
provider app-password/restricted-access setting. Same symptom, different fix,
so a shared reason would send the owner to the wrong screen.

**`bodies-unproven` → `degraded`**, for the empty mailbox. This is the ruling
most worth being able to re-argue later, so here is the trade rather than the
conclusion:

- `insufficient` would refuse to run a watcher on a genuinely empty mailbox.
  That is the common case for a freshly created signup alias, and refusing
  there breaks the exact journey this capability exists to serve.
- `healthy` would claim a capability nobody has demonstrated. That is the same
  shape as the Gmail metadata-scope defect, which also looked like success.
- `degraded` runs, tells the owner it has not yet been able to prove it can
  read message content, and lets the first real message settle it, upgrade or
  condemnation, through the runtime invariant.

Its `fix` says there is nothing to fix, which is honest: the owner cannot make
an empty mailbox prove anything.

The verdict's `detail` carries the server's own wording where the server said
anything, and never a message body and never a credential. That constraint
already existed on `InboundCapabilityVerdict`; it is restated here because a
body-capability failure is the one verdict most tempted to quote the body it
could not read.

## Alternatives rejected

**Infer it from `CAPABILITY`.** There is no atom for it. A server that will not
release message content advertises `IMAP4rev1` and `IDLE` like any other. This
would be a check that always passes.

**Probe by fetching the whole message.** No more informative than 512 bytes for
the question being asked, and it pulls whatever a stranger chose to attach
through a connection not yet declared healthy. The bound is the point.

**Probe with `BODY[]` instead of `BODY.PEEK[]`.** Would mark the owner's mail
read as a side effect of a health check. The entire inbound design is
`EXAMINE` + `BODY.PEEK` so the daemon never changes the mailbox; a probe that
broke that would be a visible change to his mailbox nobody asked for.

**Treat any empty body as a failure.** A message with a legitimately zero-octet
body exists, and stopping a working watcher over one trades a real defect for a
different one. The declared-octets comparison is what makes the check honest,
and it is why "empty" alone is never the test.

**Call the empty-mailbox case `healthy` and rely on the runtime invariant
alone.** The invariant would still catch it on the first message, so the
capability would be correct, but the reported state would have asserted
something unproven in the meantime, and health that overstates is health nobody
can act on. Reporting `degraded` costs an amber light on an empty mailbox and
buys a status line that is true at every moment.

**Fold it into `fetch-refused`.** Covered above: one reason, two remedies, and
the owner gets the wrong one half the time.

**Enforce the runtime invariant inside `fetchMessage` for every caller.**
`ImapClient.fetchMessage` currently leaves a section it could not read empty and
returns the rest, and the interactive mail reader depends on that. Turning it
into a throw for everyone is a breaking change to a shared method, so it is
`enforceBodyReadable`, off by default, and the inbound connection port turns it
on, where an unreadable body is not a cosmetic gap but a verification link
that reads as blank.

## The watcher gap, and its closure

As first written this change stopped at `MailboxConnection`:
`InboundMailboxWatcher.serve()` recorded
`verdictForOpenConnection({ mode, idle })` without the connection's
`bodyCapability`, so the `bodies-unproven` reading reached the connection object
and never the watcher's own state tracker. `watcher.ts` belonged to another
refactor at the time and was left alone deliberately.

That gap is now closed. `serve()` passes the reading:

```ts
this.tracker.record(verdictForOpenConnection({
  mode: this.settings.mode,
  idle,
  body: connection.bodyCapability,
}));
```

Worth recording how little the omission cost to write and how much it hid: with
that one property dropped, every unit test of the probe still passed, the
capability compiled, and an empty mailbox reported `idle-push` / `healthy`, a
green light for a watcher that had never once demonstrated it could read a
message. The check was present, green, and inert. It is now pinned by a test
that asserts the WATCHER's verdict rather than the pure function's, because the
pure function was never the part that was broken.

The `bodies-unfetchable` half needed no watcher change: the connection port
raises before returning a connection, and the existing
`classifyOpenFailure` → `reportTerminal` path carries it to `insufficient`.

## One probe, both command forms

There were briefly TWO probes here, and an earlier revision of this document
argued they had to stay two. They are one now. Recording why, so nobody
re-splits them on the strength of the argument that used to be here.

The two were `probeBodyAccess()`, a single `UID FETCH <uid> BODY.PEEK[TEXT]`
that read any FETCH response at all as success, and `probeBodyReadable()`, a
sequence-addressed `FETCH n (UID BODYSTRUCTURE)` / `FETCH n BODY.PEEK[]` pair
that compared returned bytes against declared octets. The observation that kept
them apart was correct and still is: **neither detection case can be dropped.**

- The **UID-addressed** form is the addressing the real drain uses, so it is
  what catches a server that refuses UID-addressed fetches, at connect, rather
  than on the first message that matters.
- The **declared-versus-returned comparison** is the only thing that catches a
  server which ACCEPTS the fetch and hands over nothing. A refusal-only check
  reads that as success, and from outside it is indistinguishable from a mailbox
  nobody has written to.

What was wrong was the conclusion that two detections need two probes. They are
two properties of one exchange, and one probe can carry both by choosing its
command forms deliberately:

1. `FETCH <exists> (UID BODYSTRUCTURE)`, sequence-addressed, because it is what
   supplies the declaration the comparison needs, and it yields the UID.
2. `UID FETCH <uid> BODY.PEEK[]<0.N>`, **UID-addressed**, because that is the
   drain's own form.

The second used to be a sequence fetch. Making it UID-addressed is the whole of
the merge: the declaration still comes from step 1, the comparison still runs on
step 2, and step 2 now also exercises the addressing the deleted probe existed
to exercise.

**Cost, measured rather than asserted.** Three FETCH round trips per non-empty
connect became two; an empty mailbox cost nothing before and costs nothing now.
`test/probe-roundtrip-count.test.ts` counts them on the wire, so a change that
quietly reintroduces a third fails there rather than being paid on every connect
in silence.

**One vocabulary.** `ImapBodyProbeVerdict` (`probed`/`ok`) and
`ImapBodyReadability` (`readable`/`unproven`/`unfetchable`) described the same
fact in two shapes, and a connection carried both. There is now one
`ImapBodyProbe` with three outcomes, `readable`, `unproven`, `unreadable`, and
`unreadable` carries an `evidence` union naming which of the two ways it was
learned (`withheld`, or `refused` with the server's own wording). One reason
code reaches the owner, `bodies-unfetchable`, because both evidences mean the
same thing to him and carry the same remedy.

One consequence worth naming: a refusal of the probe that no classifier can
place now reports `bodies-unfetchable` rather than `fetch-refused`. Both are
`insufficient` and both are terminal, so nothing changes about whether the
watcher runs, but the remedy the owner reads now points at what the account may
READ rather than at folder and IMAP-access restrictions, which is the more
useful of the two for the case this document exists for. `fetch-refused` remains
the verdict for a fetch that fails during ordinary draining, which
`handleDrainFailure` still classifies through `classifyReadFailure` unchanged.
A refusal the classifier CAN place, `[LIMIT]`, an auth code, a mailbox code, is still re-thrown to `classifyOpenFailure` and never becomes a body verdict.
