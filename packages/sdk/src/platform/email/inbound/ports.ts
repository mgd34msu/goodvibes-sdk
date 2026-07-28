/**
 * Everything the inbound-mail watcher is GIVEN rather than reaches for.
 *
 * The watcher is a protocol loop with a clock in it. Left to itself it would
 * hold a real socket, sleep for real minutes, write to a real store and pick
 * real random numbers, and none of those can be asserted on. So each of them
 * arrives as a port: the production wiring supplies the real one, a test
 * supplies one it drives by hand, and the loop itself does not know which it
 * has. No test in this area waits twenty-seven minutes, and none opens a
 * network connection.
 *
 * Two of these deserve their reasoning stated rather than assumed.
 *
 * **The cursor is a port, not a file.** Persistence for the cursor lands in a
 * separate round; the watcher's correctness rule — *the cursor advances only
 * after a message is fully processed* — belongs here, where the processing
 * happens, and is expressible against an interface. So this module declares
 * `MailboxCursorPort` and the watcher calls `advance()` exactly once per
 * message and exactly after `deliver()` resolved. Where the record is written
 * is somebody else's decision.
 *
 * **Nothing here can spawn anything.** The watcher is not handed a
 * `SurfaceAdapterContext`, a session broker, an agent manager or a reply
 * queue, and this file is where that absence is enforceable: it is the whole
 * of the watcher's argument surface. An arriving message can cause exactly the
 * effects the ports below describe — a store write, a delivered notice, a
 * status change — and no others, because there is nothing else to call.
 */
import type { ImapBodyProbe } from '../imap-body-probe.js';

import { IMAP_MAX_FETCH_UIDS } from '../imap-client.js';
import type {
  // `EmailCapabilityFailureNotice` left with `InboundMailTerminalFailure`,
  // which was its only reader here — see `capability-types.ts`.
  ImapClient,
  ImapConnectionReport,
  ImapEnvelope,
  ImapEnvelopeBatch,
} from '../imap-client.js';
import type { ImapConnection, ImapReadOptions } from '../imap-session.js';
import type { CursorResolution, MailboxCursorStore } from './cursor-store.js';
import type { MailboxCursor } from './types.js';

// ---------------------------------------------------------------------------
// Time and chance
// ---------------------------------------------------------------------------

/**
 * The passage of time, as the watcher is allowed to observe it.
 *
 * `sleep` RESOLVES on abort rather than rejecting. A cancelled wait is not a
 * failure — it is the shutdown path and the wake-early path — and making it
 * throw would put a `try` around every timer in the loop and turn a normal
 * event into an error to be classified. Callers re-check `signal.aborted`
 * after every sleep; that check is the contract.
 */
export interface WatcherClock {
  /** Milliseconds since the epoch, for timestamps that are recorded. */
  now(): number;
  /** Resolve after `ms`, or as soon as `signal` aborts, whichever is first. */
  sleep(ms: number, signal?: AbortSignal | undefined): Promise<void>;
}

/**
 * A source of uniform randomness in `[0, 1)`.
 *
 * Injected because backoff jitter is the one part of reconnection whose
 * correctness is a distribution rather than a value: a test that cannot pin
 * the source can only assert the bound, never that the jitter is applied at
 * all, and "the ceiling is respected" is exactly what an unjittered
 * implementation also satisfies.
 */
export type RandomSource = () => number;

/** The real clock. Production wiring; no test should use it. */
export const systemWatcherClock: WatcherClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    // Never hold the process open for a watcher that is otherwise idle.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref();
    }
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  }),
};

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

/**
 * Which mailbox a cursor is for. An account id, never an address.
 *
 * Local because it is a two-field key with no upstream owner, and it is the
 * ONLY cursor shape still declared here — see the note on `MailboxCursorPort`.
 */
export interface MailboxCursorKey {
  readonly account: string;
  readonly mailbox: string;
}

/**
 * What the watcher needs from the persisted cursor: read it, reconcile it,
 * move it.
 *
 * **Shaped so `MailboxCursorStore` satisfies it directly**, with no adapter in
 * between, and pinned below so it stays that way. That is not a stylistic
 * preference — it is the mirror rule applied to a seam that had already
 * drifted without anybody noticing.
 *
 * This port and the store were written in separate lanes, and until this
 * wiring they each declared their own `MailboxCursor`. The two declarations
 * were structurally identical, so everything compiled and no test failed —
 * and underneath, the two had already disagreed on behaviour: the store
 * advances with `Math.max(existing.lastSeenUid, input.lastSeenUid)`, so it
 * never moves a cursor backwards, while the local copy of that update rule in
 * `poll-loop.ts` assigned the new UID unconditionally. Nothing linked them, so
 * nothing could report it. The type is now imported from `types.ts`, the
 * resolution type from `cursor-store.ts`, and the update rule is whatever the
 * store returns rather than a second computation of it.
 */
export interface MailboxCursorPort {
  /** The stored cursor, or null when this mailbox has never been watched. */
  get(account: string, mailbox: string): Promise<MailboxCursor | null>;
  /**
   * Reconcile the stored cursor against what EXAMINE reported, and persist
   * the answer. Never a signal to replay: a first run or a changed
   * `UIDVALIDITY` establishes at the caller's high-water mark.
   */
  resolve(input: {
    readonly account: string;
    readonly mailbox: string;
    readonly serverUidValidity: number;
    readonly currentHighestUid: number;
    readonly currentMessageCount: number;
  }): Promise<CursorResolution>;
  /**
   * Record that everything up to and including `lastSeenUid` is fully
   * processed. Called ONCE PER MESSAGE and only after that message's
   * `deliver()` resolved — a crash between fetch and completion therefore
   * re-delivers, and re-delivery is caught by dedup.
   *
   * Returns the stored cursor so the caller uses the store's arithmetic
   * rather than repeating it.
   */
  advance(input: {
    readonly account: string;
    readonly mailbox: string;
    readonly uidValidity: number;
    readonly lastSeenUid: number;
  }): Promise<MailboxCursor>;
}

/**
 * `true` while `MailboxCursorStore` still satisfies `MailboxCursorPort`.
 *
 * Not `never` for the failure arm: `never` is assignable to everything, so an
 * assertion against it would keep compiling while saying nothing.
 */
export type MailboxCursorStoreMatchesPort = MailboxCursorStore extends MailboxCursorPort
  ? true
  : { readonly drifted: 'MailboxCursorStore no longer satisfies MailboxCursorPort' };

/**
 * The pin. If the store changes a signature, this stops compiling in the
 * ordinary build — rather than the watcher silently taking an adapter's word
 * for where the cursor is.
 */
export type MailboxCursorPortIsPinnedToStore = AssertTrue<MailboxCursorStoreMatchesPort>;

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/**
 * The reading operations the watcher needs from an open mailbox.
 *
 * Narrower than `ImapClient` on purpose: this is a listener, so it can search,
 * fetch envelopes and ask what the server can do. It cannot append, cannot
 * write a flag and cannot select a different mailbox, because none of those
 * appear here.
 *
 * This is a NARROWING rather than a mirror — there is no upstream type with
 * this shape to import — so it is pinned instead: `MailboxReaderMatchesClient`
 * below fails to compile if `ImapClient` stops satisfying it, and
 * `test/types/inbound-reader-matches-client.ts` checks that through the
 * package's public entry the way a consumer would. A narrowing nothing links
 * to its source is the same drift hazard as a copy, just slower.
 */
export interface MailboxReader {
  /** The server's capability atoms, asked for if it did not volunteer them. */
  capabilities(): Promise<readonly string[]>;
  /**
   * Envelope headers for the given UIDs. Every UID asked for is asked for.
   *
   * There is no `limit`, and its absence is the point: the client used to keep
   * only the last N and now refuses a batch above `IMAP_MAX_FETCH_UIDS`
   * instead. Refusing is right — a caller advancing a cursor over a silently
   * shortened result skips the messages it never saw — and it makes batching
   * the CALLER's job, which is why `deltaBatchSize` exists and is clamped.
   */
  fetchEnvelopes(uids: readonly number[]): Promise<ImapEnvelope[]>;
  /**
   * The same fetch, with the responses that could not be read reported.
   *
   * The watcher reads through THIS one and not through `fetchEnvelopes`, and
   * the difference is the whole reason it exists. A list of envelopes cannot
   * express "the server answered for UID 307 and we could not read the answer";
   * it can only fail to contain 307, which is indistinguishable from the server
   * saying 307 is gone. The drain loop used to resolve that ambiguity by
   * advancing the cursor, which turned every unreadable response into a message
   * nobody would ever be told about.
   */
  fetchEnvelopeBatch(uids: readonly number[]): Promise<ImapEnvelopeBatch>;
}

/**
 * `true` while `ImapClient` satisfies `MailboxReader`, and a message otherwise.
 *
 * Deliberately not `never` for the failure case: `never` is assignable to
 * everything, so an assertion written against it would keep compiling while
 * saying nothing — which is the same class of mistake as the mirrored
 * tri-state this whole pin exists because of.
 */
export type MailboxReaderMatchesClient = ImapClient extends MailboxReader
  ? true
  : { readonly drifted: 'ImapClient no longer satisfies MailboxReader' };

/** Compiles only while its argument is exactly `true`. */
type AssertTrue<T extends true> = T;

/**
 * The pin itself.
 *
 * `MailboxReader` is a NARROWING of `ImapClient` rather than a mirror of some
 * upstream type — there is nothing with that shape to import instead — which
 * makes it the one port here that can still drift. If `fetchEnvelopes` gains a
 * parameter or narrows its return, this line stops compiling, and it stops
 * compiling in the ordinary build rather than in a check somebody has to
 * remember to run.
 *
 * It lives in the source, not in `test/types/`, for a concrete reason: that
 * program typechecks the BUILT surface through package-name imports, and
 * `platform/email/inbound` is not a subpath export — a long-lived listener
 * that holds a socket is not part of the mail service's public surface.
 * Reaching it from there would mean either a relative import that drags
 * unbuilt source into a program with no node types, or making the path public
 * to test it.
 *
 * The cost of not having this: the runtime symptom of that drift is a watcher
 * that fetches nothing and reports itself healthy. One commit ago the same
 * class of gap — a hand-written copy of `ImapConnectionReport` whose
 * `supportsIdle: boolean | null` field silently became `undefined` after an
 * upstream rename — made the watcher poll a push-capable server, and the
 * tests failed on the symptom rather than the cause.
 */
export type MailboxReaderIsPinnedToClient = AssertTrue<MailboxReaderMatchesClient>;

/**
 * One open, authenticated, EXAMINEd connection to a mailbox.
 *
 * `wire` is the raw session, needed because IDLE cannot be expressed as "send
 * a command, read its response" and because `UID SEARCH UID n:*` is not on the
 * client's method surface.
 */
export interface MailboxConnection {
  /** Capabilities and mailbox facts as of the moment it opened. */
  readonly report: MailboxOpenReport;
  readonly reader: MailboxReader;
  readonly wire: MailboxWire;
  /**
   * What this connection demonstrated about reading message CONTENT, as
   * opposed to seeing that a message exists.
   *
   * Present because "signed in and the folder opened" answers neither
   * question, and an IMAP server has no scope list to consult instead. A
   * connection that cannot read bodies at all never reaches here — the port
   * raises `ImapBodyCapabilityError` before returning one — so the two
   * outcomes that survive to this field are `readable` and `unproven`, and the
   * second is the empty mailbox that had nothing to read from.
   */
  readonly bodyCapability: ImapBodyProbe;
  /** LOGOUT and release the socket. Never throws. */
  close(): Promise<void>;
}

/**
 * What `open()` reports — the upstream type itself, not a copy of its shape.
 *
 * This was a hand-written mirror, and the mirror is what broke. It carried
 * `supportsIdle: boolean | null` alongside an upstream field that had become a
 * two-case object; after the rename the local field simply read `undefined`,
 * `undefined` is falsy, and the watcher silently polled a server that supports
 * push. Nothing linked the two declarations, so nothing could report the drift
 * — the tests failed twenty minutes later on a symptom, not the cause.
 *
 * The general rule this taught, which applies to every structural protection
 * in this design: a type that makes a wrong state unrepresentable protects
 * only the code that IMPORTS it. A structurally-equivalent local copy is a
 * second declaration of the same idea and can drift silently. So an alias,
 * which keeps this directory's vocabulary while leaving exactly one
 * definition.
 */
export type MailboxOpenReport = ImapConnectionReport;

/** How long a single wire wait may last, and what may cancel it. */
export type MailboxWireReadOptions = ImapReadOptions;

/**
 * The wire operations IDLE is built from — again the upstream type, aliased.
 *
 * The one option worth knowing about at this layer: `sendCommand` takes
 * `retainUntagged: false`, and the IDLE call site passes it. An IDLE is
 * outstanding for twenty-seven minutes and its completion is read for status
 * rather than for lines, so retaining every untagged response that arrives in
 * that window grows a buffer nothing reads. Subscribers are unaffected.
 */
export type MailboxWire = ImapConnection;

/** Opens connections to one mailbox. One call, one fresh connection. */
export interface MailboxConnectionPort {
  open(): Promise<MailboxConnection>;
}

// ---------------------------------------------------------------------------
// What arriving mail is handed to
// ---------------------------------------------------------------------------

/**
 * What ANY source can say about a message it found.
 *
 * Everything the pipeline downstream of a source reads lives here, and nothing
 * here is IMAP-shaped. Expectation matching, taint labelling, dedup, notice
 * rendering and disclosure are written against this base and never switch on
 * `source` at all — that is the whole point of the seam
 * (docs/inbound-email.md §3.4d, and
 * docs/decisions/2026-07-27-inbound-message-is-a-discriminated-union.md).
 */
export interface InboundMessageCommon {
  /** Config account id, not an address. */
  readonly account: string;
  /** The IMAP EXAMINE target, or the Gmail label. Identity of what was watched. */
  readonly mailbox: string;
  readonly from: string;
  readonly subject: string;
  /**
   * The `Date:` header, verbatim.
   *
   * SENDER-WRITTEN, so it is display only. It is never an ordering key and
   * never a windowing key: anything that sorts or windows on this is sorting
   * on a value whoever sent the message chose. The cursor is the ordering
   * authority on both sources — `UIDVALIDITY` + UID on IMAP, `historyId` on
   * Gmail — and the name here is the warning.
   */
  readonly claimedDate: string;
  readonly messageId: string;
  /**
   * Receiver-written delivery evidence addresses, TOP-MOST FIRST. The
   * correlation key.
   *
   * Deliberately a plain `readonly string[]` rather than a `DeliveredRecipient`:
   * the brand is minted downstream, at the matching boundary, by
   * `deliveredRecipientFromDeliveryHeaders` (top-most entry only) or
   * `deliveredRecipientFromAliasMailbox`. A source that could hand the pipeline
   * a pre-branded value could hand it a branded `To:` header, which is exactly
   * the forgery the brand exists to make unrepresentable. Both
   * `ImapEnvelope.deliveredTo` and `GmailMessageBody.deliveredTo` are already
   * ordered top-most-first, so this is a straight carry on both sides.
   */
  readonly deliveredTo: readonly string[];
  /**
   * The `To:` header verbatim, for DISPLAY ONLY. Never evidence: anyone can put
   * any address here, including one we are waiting on.
   */
  readonly unverifiedToHeaderClaim: string;
}

/** One message an IMAP source found above the cursor. */
export interface ImapInboundMessage extends InboundMessageCommon {
  readonly source: 'imap';
  readonly uidValidity: number;
  readonly uid: number;
  /**
   * Headers and delivery evidence with provenance attached. Kept on the
   * variant rather than hoisted into the base: hoisting it would put IMAP back
   * into the common type under a different name. Anything that genuinely needs
   * IMAP specifics (`authenticationResults`, the full `deliveryEvidence` list)
   * narrows to this variant first.
   *
   * The body is NOT fetched by the watcher — the envelope pass is cheap
   * precisely because it is headers only.
   */
  readonly envelope: ImapEnvelope;
  /** Whether this arrived through IDLE push or through the poll fallback. */
  readonly via: 'idle' | 'poll';
}

/** One message a Gmail source found in a `users.history.list` delta. */
export interface GmailInboundMessage extends InboundMessageCommon {
  readonly source: 'gmail';
  /** Gmail's opaque message resource id. Not a number, never coerced to one. */
  readonly resourceId: string;
  /**
   * The delta's high-water mark, a decimal uint64 STRING. Never parsed to a
   * number — see the header of `source-cursor.ts` for the precision loss that
   * causes.
   */
  readonly historyId: string;
  /**
   * The message body. Gmail's history delta carries it; IMAP's envelope pass
   * does not, and that asymmetry is deliberate rather than an oversight — a
   * batch of headers is cheap and a batch of bodies is not, so the IMAP body
   * fetch stays the pipeline's step and is a no-op on this variant.
   *
   * **`''` does not mean "the body was empty."** It means the body is not here.
   * `bodyAvailability` says which of the two produced it; read that first.
   */
  readonly body: string;
  /**
   * Whether `body` is the message's actual body or a stand-in for one that was
   * never fetched.
   *
   * `'metadata-only'` means the grant was `gmail.metadata` — headers
   * authorized, bodies excluded — and `onInsufficientCapability` is
   * `notice-only`, so the message came through `messages.get?format=metadata`.
   *
   * **A `'metadata-only'` message may never satisfy a verification
   * expectation**: the delivery-evidence address that gates a match is a
   * header, so one would otherwise match on evidence nobody read. `intake.ts`
   * enforces that and explains it.
   *
   * Required, not optional. `bunx tsc -b` does not typecheck `test/`, so an
   * optional field left unset would read `undefined`, be falsy, and be treated
   * as a full body — the one direction this must never fail in. `intake.ts`
   * re-checks at run time for the sites the compiler is not looking at.
   */
  readonly bodyAvailability: 'full' | 'metadata-only';
  /**
   * Always `'poll'`. There is no Gmail push on this path: `users.watch` +
   * Pub/Sub needs a public HTTPS endpoint and a GCP topic, which a daemon
   * behind NAT does not have. Narrowed in the type so no surface can render
   * "pushed" for a Gmail message by accident.
   */
  readonly via: 'poll';
}

/**
 * One message a source found, discriminated on which source found it.
 *
 * A union rather than a widened record with `uid?` / `historyId?`: a record
 * that is always half-filled makes "half-filled" and "torn" indistinguishable,
 * and every consumer then invents its own idea of what the missing case means.
 * The union makes the exhaustive switch the compiler's job — the same rule, and
 * the same discriminant, as `InboundSourceCursor` in `source-cursor.ts`.
 */
export type InboundMailboxMessage = ImapInboundMessage | GmailInboundMessage;

/**
 * Where a found message goes.
 *
 * Resolving means the message is HANDLED — matched or found inert, recorded,
 * and its notice dispatched or deliberately suppressed — and the cursor may
 * therefore advance past it. Rejecting means it is not handled, the cursor
 * stays where it was, and the message is fetched again on the next pass. That
 * is the whole of the "no message is lost" property: the sink decides when a
 * message counts as done, and the cursor never runs ahead of that decision.
 */
export interface InboundMailSink {
  deliver(message: InboundMailboxMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/**
 * The capability vocabulary — the watcher's three states, the reasons behind
 * them, a verdict, a transition, and a terminal failure.
 *
 * Moved to `capability-types.ts` and re-exported here unchanged, so every
 * existing `from './ports.js'` import keeps working. It left because this file
 * holds the whole inbound seam and had eleven lines under the 800-line cap,
 * and because three modules — `capability.ts`, `capability-policy.ts` and
 * `terminal-notice.ts` — depend on that vocabulary and on nothing else in here.
 */
export type {
  InboundCapabilityReason,
  InboundCapabilityState,
  InboundCapabilityTransition,
  InboundCapabilityVerdict,
  InboundMailTerminalFailure,
} from './capability-types.js';

// `export … from` re-exports without binding the names locally, and
// `InboundMailObserver` below refers to two of them. Imported as well, so the
// declarations further down read exactly as they did before the move.
import type {
  InboundCapabilityTransition,
  InboundMailTerminalFailure,
} from './capability-types.js';

/** Something worth recording that is not a state change. Never a body. */
export interface InboundMailNote {
  readonly account: string;
  readonly mailbox: string;
  readonly kind:
    | 'cursor-established'
    | 'cursor-reset'
    | 'delta-drained'
    /**
     * The server answered a FETCH in terms this client could not read.
     *
     * Distinct from `delivery-failed` (we read the message and something
     * downstream refused it) and from an expunge (the server said the message
     * is not there). The cursor does not move for this one, so the message is
     * fetched again — and it is reported rather than merely retried, because a
     * response we can never read would otherwise be an invisible standstill.
     */
    | 'fetch-unreadable'
    | 'expunge-observed'
    | 'idle-reissued'
    | 'connection-lost'
    | 'delivery-failed'
    /**
     * The message was recorded and could not be announced, for a reason no
     * retry can clear. The pass COMPLETED — the cursor moves past the message —
     * so nothing else in this stream marks it. Where the condition is surfaced
     * to a person is `notice-health.ts`, which drives the status verb, the
     * health entry and the log; this note is the per-message event underneath
     * that.
     */
    | 'notice-refused'
    /**
     * A store write that ran AFTER the notice had already gone out, and failed.
     *
     * Reported rather than thrown, and the distinction is the whole point: a
     * throw here releases the sink's claim and the message is fetched and
     * announced AGAIN, so failing loudly on this one buzzes the owner's phone a
     * second time for a disk error. What is given up instead is a store write,
     * which is recoverable and which this note is the record of.
     */
    | 'post-notice-write-failed';
  readonly detail: string;
  readonly at: string;
}

/**
 * Where the watcher's observable behaviour goes.
 *
 * Every method optional so the integration round implements only what it
 * routes. Nothing here can start work — these are report sinks, and a report
 * sink that could spawn would be the capability §2.1 removes by type.
 */
export interface InboundMailObserver {
  stateChanged?(transition: InboundCapabilityTransition): void;
  terminalFailure?(failure: InboundMailTerminalFailure): void;
  note?(note: InboundMailNote): void;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The watcher's tunables, already resolved from config into milliseconds.
 *
 * Milliseconds rather than the config file's seconds and minutes, so the loop
 * never converts and a test can pass 5 for something the owner configures in
 * minutes. Reading the inbound settings out of daemon config is the
 * integration round's job, and the keys are declared with the config schema.
 */
export interface InboundWatcherSettings {
  /** Config account id, not an address. */
  readonly account: string;
  /** The EXAMINE target. */
  readonly mailbox: string;
  /** `auto` uses IDLE when the server has it and polls when it does not. */
  readonly mode: 'idle' | 'poll' | 'auto';
  /** Fallback poll interval. Default 120 s. */
  readonly pollIntervalMs: number;
  /**
   * How long one IDLE runs before it is terminated and re-issued.
   *
   * RFC 2177 advises re-issuing at least every 29 minutes; 27 leaves room for
   * a slow round trip without crossing the bound.
   */
  readonly idleReissueMs: number;
  /** The deadline on any single command round trip. Default 15 s. */
  readonly operationTimeoutMs: number;
  /** Reconnect backoff ceiling. Default 5 minutes. */
  readonly maxBackoffMs: number;
  /**
   * The ceiling used after the server refused on its own account.
   *
   * Longer than the ordinary one because none of those conditions is cleared
   * by asking again sooner — a connection limit is held partly by our own
   * connections, and a server fault is somebody else's to fix.
   */
  readonly serverUnavailableBackoffMs: number;
  /** How often an `insufficient` verdict is re-probed. Default 60 minutes. */
  readonly capabilityRecheckMs: number;
  /**
   * How many UIDs are fetched in one FETCH. Default 50, hard-capped at
   * `IMAP_MAX_FETCH_UIDS` because the client refuses a larger batch outright.
   */
  readonly deltaBatchSize: number;
}

/** The advisory bound RFC 2177 states, in milliseconds. */
export const IDLE_REISSUE_ADVISORY_BOUND_MS = 29 * 60_000;

export const DEFAULT_INBOUND_WATCHER_SETTINGS: Omit<
  InboundWatcherSettings,
  'account' | 'mailbox'
> = {
  mode: 'auto',
  pollIntervalMs: 120_000,
  idleReissueMs: 27 * 60_000,
  operationTimeoutMs: 15_000,
  maxBackoffMs: 300_000,
  serverUnavailableBackoffMs: 900_000,
  capabilityRecheckMs: 60 * 60_000,
  deltaBatchSize: 50,
};

/**
 * Fill in the defaults and clamp the two values that have a hard bound.
 *
 * `idleReissueMs` is capped strictly BELOW the 29-minute advisory rather than
 * at it: a re-issue that starts exactly on the bound has already lost the race
 * with a server that applies it, and the point of re-issuing is to be early.
 */
export function resolveWatcherSettings(
  input: Partial<InboundWatcherSettings> & MailboxCursorKey,
): InboundWatcherSettings {
  const merged = { ...DEFAULT_INBOUND_WATCHER_SETTINGS, ...input };
  const reissueCeiling = IDLE_REISSUE_ADVISORY_BOUND_MS - 60_000;
  return {
    ...merged,
    account: input.account,
    mailbox: input.mailbox,
    idleReissueMs: Math.max(1_000, Math.min(merged.idleReissueMs, reissueCeiling)),
    pollIntervalMs: Math.max(1_000, merged.pollIntervalMs),
    // Clamped, not trusted: `fetchEnvelopes` REFUSES a batch above this rather
    // than trimming it, so a batch size configured above the ceiling would not
    // fetch fewer messages — it would fetch none, and the delta would stall
    // behind an error on every pass.
    deltaBatchSize: Math.min(
      IMAP_MAX_FETCH_UIDS,
      Math.max(1, Math.floor(merged.deltaBatchSize)),
    ),
  };
}
