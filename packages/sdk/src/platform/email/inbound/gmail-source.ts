/**
 * gmail-source.ts — Gmail as a first-class inbound source
 * (docs/inbound-email.md §3.4d).
 *
 * A user who has already adopted Google credentials should not have to find an
 * IMAP host, a username and an app password to get inbound mail for a mailbox
 * the daemon can already read. So `users.history.list` becomes a source behind
 * the same seam IMAP sits behind, delivering the same messages to the same
 * sink, and expectation matching, taint labelling, dedup, notice rendering and
 * owner disclosure are written once for both.
 *
 * Three things about this file are load-bearing.
 *
 * **It is polling, and it says so.** There is no push available here:
 * `users.watch` + Pub/Sub needs a public HTTPS endpoint and a GCP topic, which
 * a daemon on someone's own machine behind NAT does not have. `latency`
 * therefore always answers `poll`, and it answers with the interval CURRENTLY
 * IN FORCE rather than a constant — a five-second worst case while a signup is
 * mid-flight and a sixty-second one when nothing is pending are different
 * promises, and a status line that showed the wrong one would be describing a
 * mode the daemon is not in.
 *
 * **A body-less grant is a refusal, never a quiet mailbox.** `gmail.metadata`
 * authorizes `users.history.list` and excludes the message body — Google's own
 * scope description says "but not the email body". A delta fetched under it
 * would come back `ok` with every body empty, which is indistinguishable from
 * a mailbox on a slow day and is the worst shape a defect can take in a
 * delivery path. `collectHistoryDelta` already refuses before making the call;
 * this file maps that refusal onto an `insufficient` verdict carrying Google's
 * own remedy, and stops polling until the grant changes. It never delivers a
 * body-less message and never reports an empty success in its place.
 *
 * **The position never moves past a message that was not read.** Gmail's
 * history is a forward-only log: records at or below a `startHistoryId` are
 * never returned again, so a cursor that advances over an unfetched message
 * does not postpone it, it makes it permanently unreachable — silently, and
 * under a `healthy` verdict, which is the worst shape this delivery path can
 * take. `collectHistoryDelta` separates a message that is GONE (deleted
 * between `history.list` and `messages.get`) from one we FAILED TO FETCH (a
 * rate limit, a server fault, a refused token, a dead socket) and reports the
 * second in `GmailHistoryDelta.unreadable`. This file refuses to advance while
 * that is non-empty. It is the same rule, on the same contract, that
 * `ImapEnvelopeBatch.unreadable` gives the IMAP drain — one idea, expressed
 * twice only where the identifier differs.
 *
 * **Losing our place is the same event on both sources.** A 404 on a
 * `startHistoryId` that aged out of Gmail's retention window means exactly what
 * a changed `UIDVALIDITY` means: the stored position names nothing. It goes
 * through `MailboxCursorStore.resolveGmail`, which is the same
 * establish-at-the-current-high-water-mark path `uid-validity-changed` uses —
 * discard, re-establish, disclose, and do NOT replay the mailbox. There is one
 * implementation of that rule and this file does not add a second.
 *
 * What this file cannot do
 * ────────────────────────
 * It cannot open, hydrate, widen or extend an expectation. Whether one is open
 * arrives as an INJECTED PREDICATE — a function returning a boolean — and
 * nothing that could create an expectation is imported here, which is §2.1's
 * structural removal of the spawn capability applied to the other capability an
 * arriving message must never reach. A source that could register what it is
 * waiting for could decide, by content, what to wait for.
 */

import {
  CapabilityStateTracker,
  capabilityVerdict,
  errorText,
  stateForReason,
} from './capability.js';
import { anySignal } from './any-signal.js';
import type { MailboxCursorStore } from './cursor-store.js';
import { DEFAULT_INBOUND_WATCHER_SETTINGS } from './ports.js';
import type {
  GmailInboundMessage,
  InboundCapabilityVerdict,
  InboundMailNote,
  InboundMailObserver,
  InboundMailSink,
  InboundMailTerminalFailure,
  WatcherClock,
} from './ports.js';
import { isHistoryId } from './source-cursor.js';
import type { InboundMailSource, SourceLatency } from './source.js';
import type { GmailMessageBody, GoogleApiFailure, GoogleApiResult } from '../../google/api-client.js';
import {
  collectHistoryDelta,
  type GmailHistoryDelta,
  type HistoryDeltaDeps,
  type HistoryDeltaUnavailable,
} from '../../google/history-delta.js';

/**
 * "Is somebody waiting on a message right now?"
 *
 * A plain predicate, injected. Deliberately NOT the expectation registry, not
 * a narrowed view of it, and not anything that transitively imports it: the
 * registry can open an expectation, and a type that names it would let this
 * file be handed the thing it must not have. The caller — the supervisor, which
 * is already authorized — answers the question.
 */
export type ExpectationPresence = () => boolean;

/**
 * The cursor operations the Gmail source needs, projected off the real store.
 *
 * A `Pick` rather than a hand-written interface, and that is the rule this
 * round keeps re-learning rather than a preference. Two structurally-identical
 * `MailboxCursor` declarations in separate lanes had already drifted in
 * BEHAVIOUR — one clamped with `Math.max`, the other assigned unconditionally —
 * while everything still compiled. A `Pick` cannot drift from what it picks,
 * and if `resolveGmail` gains an argument this stops compiling in the ordinary
 * build.
 *
 * Note what is absent: `resolve` and `advance`, the IMAP pair. A `historyId`
 * cannot say which UIDs are done, so a Gmail source holding them could only
 * misuse them.
 */
export type GmailCursorPort = Pick<
  MailboxCursorStore,
  'getGmail' | 'resolveGmail' | 'advanceGmail'
>;

export interface GmailMailSourceDeps {
  /** Config account id, not an address. */
  readonly account: string;
  /** The watched Gmail label, e.g. `INBOX`. Keyed the same way an IMAP mailbox is. */
  readonly mailbox: string;
  /** Scopes, one history page, one message — the same narrow I/O `collectHistoryDelta` takes. */
  readonly history: HistoryDeltaDeps;
  /**
   * The mailbox's CURRENT `historyId`, as Google sent it.
   *
   * Injected rather than called here, so this file stays free of any Google
   * client: it is handed I/O, exactly as `history` is. The composition fills it
   * with `GoogleApiClient.currentHistoryId()`, which reads
   * `users.getProfile().historyId` — "the ID of the mailbox's current history
   * record", Google's own words for the field, and the reason that call is the
   * right one for a path that establishes without backfilling. Needed on
   * exactly two paths, both of which establish rather than replay: a first run,
   * and a `resync-required` recovery.
   */
  readonly currentHistoryId: () => Promise<GoogleApiResult<string>>;
  readonly cursors: GmailCursorPort;
  readonly sink: InboundMailSink;
  readonly clock: WatcherClock;
  /** Injected; see `ExpectationPresence`. */
  readonly expectationOpen: ExpectationPresence;
  /** `surfaces.email.inbound.gmailPollSecondsExpecting`, in milliseconds. */
  readonly pollExpectingMs: number;
  /** `surfaces.email.inbound.gmailPollSecondsIdle`, in milliseconds. */
  readonly pollIdleMs: number;
  /** How long an `insufficient` verdict waits before re-probing. Defaults to the watcher's 60 minutes. */
  readonly capabilityRecheckMs?: number | undefined;
  readonly observer?: InboundMailObserver | undefined;
}

export class GmailMailSource implements InboundMailSource {
  readonly kind = 'gmail-history' as const;

  private readonly deps: GmailMailSourceDeps;
  private readonly tracker: CapabilityStateTracker;
  private readonly pollExpectingMs: number;
  private readonly pollIdleMs: number;
  private readonly capabilityRecheckMs: number;
  private readonly halt = new AbortController();
  private terminal: InboundMailTerminalFailure | null = null;

  constructor(deps: GmailMailSourceDeps) {
    this.deps = deps;
    // Floored rather than range-checked: the 2-60 s and 10-3600 s ranges belong
    // to the config schema that declares those keys, and restating them here
    // would be a second set of bounds that can disagree with the first. This
    // floor only catches a value no configuration can produce.
    this.pollExpectingMs = Math.max(1_000, Math.floor(deps.pollExpectingMs));
    this.pollIdleMs = Math.max(1_000, Math.floor(deps.pollIdleMs));
    this.capabilityRecheckMs = Math.max(
      1_000,
      Math.floor(deps.capabilityRecheckMs ?? DEFAULT_INBOUND_WATCHER_SETTINGS.capabilityRecheckMs),
    );
    this.tracker = new CapabilityStateTracker({
      account: deps.account,
      mailbox: deps.mailbox,
      clock: deps.clock,
      observer: deps.observer,
    });
  }

  /**
   * The interval in force: fast while something is being waited for, slow when
   * nothing is.
   *
   * The predicate is asked every time rather than sampled once, because an
   * expectation opening is exactly the moment the answer has to change — a
   * signup starts mid-run and the next wait is the short one.
   */
  get intervalMs(): number {
    return this.deps.expectationOpen() ? this.pollExpectingMs : this.pollIdleMs;
  }

  /** Always polling, always the interval in force. Never the word "real-time". */
  get latency(): SourceLatency {
    return { kind: 'poll', worstCaseMs: this.intervalMs };
  }

  /** The current verdict, for a supervisor folding this into channel status. */
  get verdict(): InboundCapabilityVerdict {
    return this.tracker.current
      ?? capabilityVerdict('reconnecting', 'The Gmail source has not asked Google anything yet.');
  }

  /** Non-null once a verdict only a changed grant can clear has been reached. */
  get terminalFailure(): InboundMailTerminalFailure | null {
    return this.terminal;
  }

  /**
   * Establish the position and answer with a capability verdict.
   *
   * On Gmail, unlike IMAP, capability is DECLARATIVE: the token states what it
   * may do, so a body-less grant is caught before the first delta is fetched
   * rather than on the first message. That asymmetry is the protocol, and it is
   * why an insufficient verdict here can be trusted to mean "this will not work
   * at all" rather than "the first fetch failed".
   */
  async start(signal: AbortSignal): Promise<InboundCapabilityVerdict> {
    const combined = anySignal([signal, this.halt.signal]);
    try {
      return await this.pollOnce(combined.signal);
    } finally {
      combined.dispose();
    }
  }

  /**
   * Poll until aborted.
   *
   * Sleeps FIRST: `start()` has already made one pass, and asking again
   * immediately would spend a call to learn what was just learned. An
   * `insufficient` verdict waits `capabilityRecheckMs` instead of the poll
   * interval — a grant does not change in five seconds, and re-asking on the
   * poll interval would turn a refusal into a request loop.
   */
  async run(signal: AbortSignal): Promise<void> {
    const combined = anySignal([signal, this.halt.signal]);
    try {
      while (!combined.signal.aborted) {
        await this.deps.clock.sleep(this.waitMs(), combined.signal);
        if (combined.signal.aborted) return;
        try {
          await this.pollOnce(combined.signal);
        } catch (error) {
          // A store write or an injected dependency that threw. Not a
          // capability verdict — nothing about the grant is known to have
          // changed — so it is degraded, disclosed, and tried again.
          this.record(capabilityVerdict('reconnecting', errorText(error)));
          this.note('delivery-failed', `The Gmail poll did not complete: ${errorText(error)}`);
        }
      }
    } finally {
      combined.dispose();
    }
  }

  /** Stop polling. Safe to call twice, and safe to call before `start`. */
  async stop(): Promise<void> {
    this.halt.abort();
    await Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // One pass
  // -------------------------------------------------------------------------

  private waitMs(): number {
    return this.tracker.state === 'insufficient' ? this.capabilityRecheckMs : this.intervalMs;
  }

  private async pollOnce(signal: AbortSignal): Promise<InboundCapabilityVerdict> {
    if (signal.aborted) return this.verdict;

    const cursor = await this.deps.cursors.getGmail(this.deps.account, this.deps.mailbox);
    if (cursor === null) return this.establish(false);

    const result = await collectHistoryDelta(this.deps.history, {
      startHistoryId: cursor.historyId,
      labelId: this.deps.mailbox,
      historyTypes: ['messageAdded'],
    });

    if (result.ok) return this.deliver(result.value, signal);
    if ('unavailable' in result) {
      // The stored position aged out of Gmail's retention window. Same event as
      // a changed UIDVALIDITY, same resolution path, and no replay.
      if (result.unavailable === 'resync-required') return this.establish(true);
      return this.refuse(result);
    }
    return this.record(this.transientVerdict(result));
  }

  /**
   * Establish the position at the current high-water mark, for a first run or
   * after a `resync-required`.
   *
   * Never backfills on either path. A newly watched label starts listening now
   * rather than retroactively deciding about mail that arrived before it was
   * asked to, and an expired cursor is not an invitation to re-announce a week
   * of old mail because Google rotated its history window.
   */
  private async establish(afterExpiry: boolean): Promise<InboundCapabilityVerdict> {
    const fresh = await this.deps.currentHistoryId();
    if (!fresh.ok) return this.record(this.transientVerdict(fresh));
    if (!isHistoryId(fresh.value)) {
      // Refused rather than persisted: the store would reject it anyway, and
      // an invalid position written and dropped on the next load looks exactly
      // like having a position while having none.
      return this.record(capabilityVerdict(
        'server-unavailable',
        `Google answered with ${JSON.stringify(fresh.value)} where a decimal historyId was expected, `
        + 'so no position could be established.',
      ));
    }

    const resolution = await this.deps.cursors.resolveGmail({
      account: this.deps.account,
      mailbox: this.deps.mailbox,
      currentHistoryId: fresh.value,
      historyExpired: afterExpiry,
    });

    if (resolution.kind === 'history-expired') {
      this.note('cursor-reset',
        `Google reported the stored history position ${resolution.previous?.historyId ?? '(unknown)'} `
        + 'is outside the range it still keeps, so every record below it names nothing. The position '
        + `was re-established at historyId ${resolution.cursor.historyId}; mail already in the label `
        + 'is not replayed. An aged-out history window is not a reason to re-announce old mail.');
    } else if (resolution.kind === 'first-run') {
      this.note('cursor-established',
        `Listening from historyId ${resolution.cursor.historyId} onwards. Mail already in `
        + `'${this.deps.mailbox}' is not read: the daemon starts listening now rather than backfilling.`);
    }
    return this.record(capabilityVerdict('polling-configured', this.pollingDetail()));
  }

  /**
   * Hand a delta's messages to the sink, then move the cursor.
   *
   * The cursor moves ONCE, after the last message, and this differs from the
   * IMAP path on purpose. There, each UID is its own position, so the cursor
   * can advance per message. A delta's `historyId` is one position for the
   * whole batch: advancing to it after the first message would put the cursor
   * above messages two onwards, and a crash there would lose them silently.
   * So a refused delivery leaves the whole delta above the cursor and it is
   * fetched again — dedup turns the re-delivery into a suppressed duplicate,
   * which is the failure this design chooses.
   *
   * A delta carrying `unreadable` entries takes the same exit for the same
   * reason. Those are messages Google named and would not hand over, and on a
   * forward-only history log the cursor moving past them is not a delay, it is
   * a permanent loss. The one case that DOES let the position move is a
   * message deleted between `history.list` and `messages.get`, and
   * `collectHistoryDelta` has already removed those — nothing here has to
   * re-decide it.
   */
  private async deliver(
    delta: GmailHistoryDelta,
    signal: AbortSignal,
  ): Promise<InboundCapabilityVerdict> {
    for (const message of delta.messages) {
      if (signal.aborted) return this.verdict;
      try {
        await this.deps.sink.deliver(this.toInboundMessage(message, delta.historyId));
      } catch (error) {
        this.note('delivery-failed',
          `Message ${message.id} was not processed, so the history position stays where it was and `
          + `the whole delta will be fetched again: ${errorText(error)}`);
        // Deliberately no backoff. The stated worst case is the poll interval,
        // and stretching the interval because a sink refused would make that
        // number untrue — the sink's problem is not a reason to notice the
        // NEXT message later.
        return this.verdict;
      }
    }

    if (delta.unreadable.length > 0) {
      // Messages this delta named and Google would not hand over. NOT messages
      // that are gone — `collectHistoryDelta` has already separated those out
      // and dropped them. These are still in the mailbox, and Gmail's history
      // is forward-only, so advancing to `delta.historyId` here would put the
      // cursor above records that can never be requested again. That is the
      // whole defect: the verification email nobody is ever told about, under
      // a `healthy` verdict.
      //
      // So the position stays exactly where it was and the delta is fetched
      // again on the next pass — the same choice the delivery-failure path
      // above makes, for the same reason, with dedup absorbing the duplicates
      // among whatever DID come back this time.
      this.note('fetch-unreadable', this.unreadableDetail(delta));
      return this.record(this.transientVerdict(this.firstUnreadableFailure(delta)));
    }

    await this.deps.cursors.advanceGmail(
      { account: this.deps.account, mailbox: this.deps.mailbox },
      { historyId: delta.historyId },
    );
    if (delta.messages.length > 0) {
      this.note('delta-drained',
        `${String(delta.messages.length)} message(s) delivered; history position advanced to `
        + `${delta.historyId}.`);
    }
    return this.record(capabilityVerdict('polling-configured', this.pollingDetail()));
  }

  /**
   * What the owner is told when a delta could not be fully read.
   *
   * Says the three things that decide whether this needs acting on: how many
   * messages were unread, that the position did NOT move, and Google's own
   * words for why. The count of what was delivered is included because a
   * partly-read delta is a different situation from one that read nothing, and
   * a note that omitted it would read like a total outage during a single
   * rate-limited fetch.
   */
  private unreadableDetail(delta: GmailHistoryDelta): string {
    const reasons = [...new Set(delta.unreadable.map((problem) => problem.detail))].join('; ');
    const ids = delta.unreadable.map((problem) => problem.id).join(', ');
    return `${String(delta.unreadable.length)} message(s) in this delta could not be fetched `
      + `(${ids}): ${reasons}. An answer we could not read is not evidence the message is gone, `
      + `so the history position stays at the value it already had rather than advancing to `
      + `${delta.historyId}, and the whole delta is fetched again. `
      + `${String(delta.messages.length)} message(s) in the same delta were delivered and are `
      + 'suppressed as duplicates when it is re-fetched.';
  }

  /**
   * The first unreadable entry, as the `GoogleApiFailure` `transientVerdict`
   * already knows how to classify.
   *
   * The FIRST rather than a summary, because the verdict turns on the status
   * and a synthesised "several things went wrong" would carry no status to
   * turn on — a 401 and a 429 need opposite answers (a new grant versus
   * waiting), and collapsing them would pick neither.
   *
   * `fix` is carried through rather than blanked, because `transientVerdict`
   * reads it directly on the `credentials-rejected` branch. Blanked, a token
   * refused mid-delta would reach the owner as "your mail has stopped" with no
   * remedial step attached — which is this file's own failure mode (`refuse`
   * carries Google's `problem` and `fix` verbatim for exactly this reason)
   * reproduced on the neighbouring path.
   */
  private firstUnreadableFailure(delta: GmailHistoryDelta): GoogleApiFailure {
    const first = delta.unreadable[0];
    return {
      ok: false,
      status: first?.status ?? null,
      problem: first?.detail ?? 'A message in the delta could not be fetched.',
      fix: first?.fix ?? '',
    };
  }

  /**
   * A grant that cannot do the job: refuse, name it, and say what fixes it.
   *
   * `problem` and `fix` are carried VERBATIM from `history-delta.ts`, which
   * quotes Google's own scope descriptions. Rewriting them here would be a
   * second explanation of the same condition, and the two would drift.
   *
   * The two reasons are distinct on purpose — the state tracker announces on a
   * change of state OR reason, so collapsing them into one would mean a token
   * that lost its last body scope, leaving only `gmail.metadata`, produced no
   * new announcement at all.
   */
  private refuse(result: HistoryDeltaUnavailable): InboundCapabilityVerdict {
    // `InboundCapabilityReason` has no Gmail-scope member and this round does
    // not own `ports.ts`, so the two conditions are mapped onto the nearest
    // existing reasons that carry the right STATE and the right meaning:
    // `mailbox-unreadable` for "signed in and this mailbox cannot be read at
    // all", `fetch-refused` for "readable, and message data is withheld". The
    // detail and the fix are Gmail's own words either way, so nothing the owner
    // reads is IMAP-flavoured. Flagged for two purpose-built reasons.
    const reason = result.unavailable === 'no-gmail-scope' ? 'mailbox-unreadable' : 'fetch-refused';
    const verdict: InboundCapabilityVerdict = {
      state: stateForReason(reason),
      reason,
      detail: result.problem,
      fix: result.fix,
    };
    // The tracker's own answer to "was this a transition", so the owner is told
    // once per transition and not once per probe.
    const announced = this.tracker.record(verdict);
    const failure: InboundMailTerminalFailure = {
      account: this.deps.account,
      mailbox: this.deps.mailbox,
      reason,
      detail: result.problem,
      fix: result.fix,
      at: new Date(this.deps.clock.now()).toISOString(),
      // No `EmailCapabilityFailureNotice`: that record is minted by the IMAP
      // error types, and inventing one here would claim a provenance this
      // failure does not have.
      notice: null,
    };
    this.terminal = failure;
    if (announced) {
      try {
        this.deps.observer?.terminalFailure?.(failure);
      } catch {
        // A notification route that throws must not become a second failure.
      }
    }
    return verdict;
  }

  /**
   * An ordinary API failure, classified by what Google answered.
   *
   * A refused credential is `insufficient` — nothing clears it but a new grant.
   * A rate limit or a server fault is `degraded`: it is "not yet", not
   * "cannot", and the delta is still above the cursor when it clears.
   */
  private transientVerdict(failure: GoogleApiFailure): InboundCapabilityVerdict {
    if (failure.status === 401 || failure.status === 403) {
      return {
        state: stateForReason('credentials-rejected'),
        reason: 'credentials-rejected',
        detail: failure.problem,
        fix: failure.fix,
      };
    }
    if (failure.status === 429 || (failure.status !== null && failure.status >= 500)) {
      return capabilityVerdict('server-unavailable', failure.problem);
    }
    return capabilityVerdict('reconnecting', failure.problem);
  }

  private toInboundMessage(message: GmailMessageBody, historyId: string): GmailInboundMessage {
    return {
      source: 'gmail',
      account: this.deps.account,
      mailbox: this.deps.mailbox,
      from: message.from,
      subject: message.subject,
      // Sender-written, so display only, and never an ordering key — the
      // historyId is the ordering authority on this source.
      claimedDate: message.date,
      // The `Message-ID` header, which Gmail's `messages.get` mapping does not
      // extract today. Left empty rather than filled with the opaque resource
      // id: §6 refuses `Message-ID` as an identity on BOTH sources, so putting
      // the server-assigned id in the sender-written field would make one field
      // mean two different things and would tempt a consumer into treating it
      // as an identity. The identity is `resourceId`, below.
      messageId: '',
      deliveredTo: message.deliveredTo,
      unverifiedToHeaderClaim: message.to,
      resourceId: message.id,
      historyId,
      body: message.body,
      via: 'poll',
    };
  }

  private pollingDetail(): string {
    const seconds = Math.round(this.intervalMs / 1000);
    return `Gmail has no push available to a daemon behind NAT, so new mail is found by asking `
      + `every ${String(seconds)} second${seconds === 1 ? '' : 's'}.`;
  }

  /** Record a verdict and return it, so call sites read as one expression. */
  private record(verdict: InboundCapabilityVerdict): InboundCapabilityVerdict {
    this.tracker.record(verdict);
    return verdict;
  }

  private note(kind: InboundMailNote['kind'], detail: string): void {
    try {
      this.deps.observer?.note?.({
        account: this.deps.account,
        mailbox: this.deps.mailbox,
        kind,
        detail,
        at: new Date(this.deps.clock.now()).toISOString(),
      });
    } catch {
      // An observer that throws must not stop the mail being read.
    }
  }
}
