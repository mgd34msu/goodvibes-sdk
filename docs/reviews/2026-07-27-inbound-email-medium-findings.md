# Inbound email — the nine medium findings (M1–M9)

Recorded **2026-07-28**, from the third refutation review against frozen
`c1d3afff`.

**Why this file exists.** These nine lived only in an agent's context and were
referenced in three dispatches without ever being written down. A lane searched
twice — every `.md`, `.txt` and `.json` under `~/Projects`, every inbound
worktree, the review worktree's git log, `~/.goodvibes` — and found nothing,
because there was nothing. Over one night this round had agents die, be paused,
hit usage limits and be resumed; a finding that survives none of those is not a
finding, it is a rumour with a number.

> **A review whose results live only in an agent's context is a review that
> cannot be acted on after that context ends.** Write findings to the repo when
> they are made, not when someone asks for them a third time.

Status is recorded per item. Line numbers are as of `c1d3afff` and several
files have since moved.

---

## M1 — the escaper layer passed newlines on 5 of 6 paths — FIXED
`inbound-notice-channels.ts:33,47-54`. `PLAIN_TEXT_MARKUP_TRIGGER_CHARS`
contained no control characters, so only `escapeNtfyField` stripped them —
including the "fully-neutralized" fallback. Attacker text forged a labelled
line. Not live for inbound mail (the producer stripped at
`inbound-notice.ts:254`) but §11.1 requires payments to become a second
producer, and a `\n` in `itemTitle` forges the amount line. Falsified gate #40.
**Fixed** by moving the strip into `flattenSpans`, so all six paths neutralise.

## M2 — `NoticeField.label` bypassed escaping entirely — FIXED
`inbound-notice-channels.ts:63` interpolated a bare `string`. `title` is spans,
`value` is spans, `label` was not. Not live (labels are hardcoded), no compile
error, no test. **Fixed** — line-neutralised rather than markup-escaped.

## M3 — bare-domain URLs defanged nowhere, LIVE — FIXED
`defangUrlForms` matched only `\w+://` and `\bwww\.`, so `evil.example/verify`
in an attacker-written subject reached Telegram and Slack unmodified. The one
medium that was exploitable as written. **Fixed.**

## M4 — `capability-degraded.missingCapability` rendered `literal` — FIXED, evidence corrected
The cited evidence was **wrong**: `capability.ts:261` is `REASON_FOR_NOTICE`, a
hardcoded map, and `missingCapability` has **zero producers** anywhere. So the
existing test asserting it "daemon-generated, never attacker text" was true by
accident rather than by construction. **Fixed on different grounds**: whoever
wires it will most likely fill it from a server refusal, escaping a phrase we
chose costs nothing visible, and treating a server's phrase as ours costs an
escape hatch.

## M5 — the Gmail source unreachable in the shipped composition — SUPERSEDED
`facade-builtin-channels.ts:52-59` called `composeInboundMail` **without**
`gmail`, so selection always returned IMAP, and forcing `source: 'gmail'`
reported *"no Google credentials have been adopted on this machine"* — false
whenever Google **is** adopted and only the builder is missing. The message was
corrected. **The underlying gap was later found to be larger and is tracked as
its own critical**: `GmailSourceBuilder` has no production constructor at all.

**Correction (2026-08-21, v2.0.19): the critical this row deferred to is now
fixed.** `InboundMailCompositionOptions.gmailReader` is a required field, not
an optional `gmail` builder, and `platform/daemon/facade-builtin-channels.ts`
constructs it via `createDaemonGmailInboundReader` and passes it into
`composeInboundMail`. A composition that stops supplying it stops compiling.
`GoogleApiClient.getProfile()` / `.currentHistoryId()` exist and call
`users.getProfile`, and `isGmailMailbox` now accepts the address that call
returns as direct evidence rather than sniffing the configured IMAP host
string. See `docs/inbound-email.md` §13.12.

## M6 — dead status functions — FIXED
`builtin-runtime.ts:232` `inboundMailStatus()` and `:243` `inboundMailHealth()`
had zero callers repo-wide, so **email never appeared in any health list**.
`InboundMailHealthEntry` already carried `kind: 'email-inbound'`, documented as
discriminating from a channel's entry "in a mixed list" — a list that did not
exist. **Fixed** by widening the aggregate to a discriminated union rather than
widening `ChannelSurface`, which would have handed email the channel family by
inheritance. `telegramIngressStatus()` at `:190` is **still dead** and is not
this round's to fix.

## M7 — three mechanisms with no production caller — FIXED
- `InboundExpectationRegistry.sweep()` had no caller, so the `onExpired`
  handler could **never fire** — §2.3 says an expiry is an outcome, not silence.
- `recheckNow()` had no config-change subscription, so §3.4b's
  re-probe-on-change half was unwired.
- Three settings — `onInsufficientCapability`, `gmailPollSecondsExpecting`,
  `gmailPollSecondsIdle` — were declared, validated, UI-rendered and **read by
  nothing**. A `flags-are-features` violation.

## M8 — persistence hygiene — FIXED
The item this file exists because of. All four parts closed; each verified by a
mutation reverting it in the harmful direction, in
`test/inbound-mail-persistence-hygiene.test.ts`.

- **Bounds are sweep-only, and the sweep is 6-hourly.** `record-store.ts:330`
  is `next: [...records, entry]` — `record()` applies neither `maxRecords` nor
  `retentionMs`; `facade-inbound-mail.ts:262` is
  `housekeeper.start(6 * 60 * 60_000)`. Measured with `maxRecords: 2`: ten
  writes → **ten records on disk**, `list()` serving 2. `supervisor.ts:390`
  computes `retention.records.kept` from the filtered `list()`, so **status
  tells the owner a smaller number than the file holds.**

- **The disclosure log is an unreaped second copy of every expectation.**
  `ExpectationSweepReport.survivors` carries full `VerificationExpectation`
  objects and `housekeeping.ts:113-127` writes the whole report, so every
  recipient alias, service domain and purpose is duplicated into
  `email-inbound-housekeeping.json`, which expiry reaping never touches.
  `listDisclosures()` reads it back with **no content validation** — the one
  persisted structure here violating the rule its own file header states.

- **0644 files, 0755 dir, no fsync, no cross-process safety.**
  `persistent-store.ts:49` writes with no `mode`. No fsync on file or
  directory, so a power loss after rename can leave a zero-length file.
  Orphaned `*.tmp.<pid>.<uuid>` from a crash mid-write is never reaped —
  persisted state with no GC. `writeChain` serializes **per instance**; with
  two daemon processes on one machine, six records written by two writers left
  three on disk.

- **Expectation records had no field length bound** on either path: a 1 MB
  `purpose` validated, and `MAX_OPEN_EXPECTATIONS = 32` bounds count only, so a
  32 MB expectation file was a valid one. **Partially closed since** — `id`,
  `purpose`, `serviceDomain` and `recipientAddress` are now bounded.

**What the fix turned out to be, per part.**

1. `record()` applies both bounds, age first then count, with the same
   oldest-first precedence `sweep()` uses. `email.inbound.status` now reports
   `stored` (counted from the file, malformed rows included) beside `kept`, plus
   `reapedOnWrite` — §9.5 requires a reap to be disclosed, and a write-time reap
   is one no sweep report can itemise.

2. The persisted log is a projection: `survivors` dropped (`retained` already
   carries the count a disclosure needs about what stayed), removals kept but
   capped at 100 with `removedTotal` recording the true number, free text
   bounded, and `listDisclosures()` validating by content.

3. 0600 files / 0700 directories, fsync before the rename and on the directory
   after it, an age-gated sweep for orphaned temp files, and
   `acquireCrossProcessLock` across the whole read-modify-write in all three
   stores. **The single-instance question was answered, not assumed**: the
   daemon is not single-instance by construction — `requirePortAvailable`
   guards only the configured port, the port is configuration, and the store
   paths derive from `$HOME` with no port in them, so two daemons on two ports
   share every file and neither refuses to start. `lifecycle-marker.ts` records
   a pid but is a crash-receipt marker, not a mutex.

4. Two gaps remained and two more were found by writing the test rather than by
   reading for them. Remaining: `noticeFailureReason` (unbounded, and the one
   field on the record a remote server writes — `intake.ts` fills it from
   `delivery.error`) and `InboundLinkVerdict.reason` (unbounded under a 64-entry
   cap, which is an unbounded record). Found: `account` and `mailbox` were
   bounded on the load path and clamped nowhere on the write path, so an
   oversized value was written whole and then failed its own validation on the
   next load — a record built from megabyte fields was 2 MB on disk; and
   `PersistedExpectationStore.replaceAll` did not enforce `maxOpenExpectations`
   at all, which is bullet 1's defect in the neighbouring store.

   **Correction (2026-08-21, v2.0.19): both remaining gaps are now closed.**
   `record-validation.ts` bounds `noticeFailureReason` at
   `MAX_NOTICE_FAILURE_REASON_CHARS = 512` and a link verdict's `reason` at
   `MAX_LINK_REASON_CHARS = 256` (with `MAX_LINK_VERDICTS = 64` unchanged), and
   `account`/`mailbox` are now clamped at write time via `clampRecordScope`
   (`MAX_ACCOUNT_CHARS = 256`, `MAX_MAILBOX_CHARS = 512`), applied identically
   at lookup time so a clamped write still matches a clamped read.

## M9 — redaction shrinkage leaked card digits — FIXED, severity corrected
`record-store.ts:293-304` claimed the overshoot meant a straddling span was
always seen whole. `[redacted:pan]` is 14 chars against a 19-char grouped PAN,
so each redaction **shortens** by 5 and the slice reaches back past the scan
window. The review reported `555555555555444` persisted raw — 15 of 16 digits.
**Measured across 1830 constructions, the worst surviving run is six digits**,
because `redactCardShapes` also matches short runs as security codes and eats
most of a truncated PAN. Real, smaller than reported, and **fixed** by removing
the window entirely: six digits need not be on disk, and no window leaves no
boundary to reason about.
