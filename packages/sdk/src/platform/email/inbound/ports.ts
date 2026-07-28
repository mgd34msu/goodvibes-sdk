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

import type { ImapEnvelope } from '../imap-client.js';

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

/** Which mailbox a cursor is for. An account id, never an address. */
export interface MailboxCursorKey {
  readonly account: string;
  readonly mailbox: string;
}

/**
 * How far through a mailbox the daemon has got.
 *
 * `uidValidity` is part of the identity, not a decoration: when the server
 * reports a different one, every UID recorded under the old one names nothing.
 */
export interface MailboxCursor extends MailboxCursorKey {
  readonly uidValidity: number;
  /** The highest UID that has been FULLY processed. */
  readonly lastSeenUid: number;
  readonly updatedAt: string;
}

/** What EXAMINE just said, so the store can reconcile against it. */
export interface MailboxCursorResolveInput extends MailboxCursorKey {
  readonly uidValidity: number;
  /** `UIDNEXT` — the UID the next arriving message will be given. */
  readonly uidNext: number | null;
  /** `EXISTS` — how many messages the mailbox currently holds. */
  readonly exists: number | null;
}

/**
 * How the cursor the watcher is about to work from came to be.
 *
 *   - `stored` — resumed from a persisted record; the ordinary case.
 *   - `established` — first run. The mark is set at the current high-water
 *     mark and the mailbox is NOT backfilled: the daemon starts listening
 *     now, it does not retroactively decide about mail that arrived before it
 *     was asked to.
 *   - `uidvalidity-reset` — the server reports a different `UIDVALIDITY`, so
 *     the mailbox was rebuilt and every stored UID is meaningless. Discarded
 *     and re-established, and disclosed. Deliberately not a replay: notifying
 *     about a year of old mail because a server rebuilt an index is a flood,
 *     not a recovery.
 *   - `discarded` — the stored record failed validation and was dropped
 *     rather than repaired.
 */
export type MailboxCursorOrigin =
  | 'stored'
  | 'established'
  | 'uidvalidity-reset'
  | 'discarded';

export interface MailboxCursorResolution {
  readonly cursor: MailboxCursor;
  readonly origin: MailboxCursorOrigin;
  /** Messages skipped when a mark was newly established. 0 when resumed. */
  readonly skippedMessages: number;
}

/**
 * The persisted cursor, as three operations.
 *
 * `resolve` is separate from `get` because reconciling a stored UID against a
 * freshly reported `UIDVALIDITY` is a decision with a disclosure attached to
 * it, and a watcher that did that arithmetic itself would be re-implementing
 * it in every caller.
 */
export interface MailboxCursorPort {
  /** The stored cursor, or null when this mailbox has never been watched. */
  get(key: MailboxCursorKey): Promise<MailboxCursor | null>;
  /** Reconcile the stored cursor against what EXAMINE reported. */
  resolve(input: MailboxCursorResolveInput): Promise<MailboxCursorResolution>;
  /**
   * Record that everything up to and including `lastSeenUid` is fully
   * processed. Called ONCE PER MESSAGE and only after that message's
   * `deliver()` resolved — a crash between fetch and completion therefore
   * re-delivers, and re-delivery is caught by dedup.
   */
  advance(key: MailboxCursorKey, position: {
    readonly uidValidity: number;
    readonly lastSeenUid: number;
  }): Promise<void>;
}

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
 */
export interface MailboxReader {
  /** The server's capability atoms, asked for if it did not volunteer them. */
  capabilities(): Promise<readonly string[]>;
  /**
   * Envelope headers for the given UIDs.
   *
   * `limit` must be passed as the batch's own length by every caller: the
   * underlying client keeps only the LAST `limit` UIDs, so a default smaller
   * than the batch silently drops the oldest of a delta — and a cursor that
   * then advanced past them would lose exactly the messages a reconnect
   * exists to recover.
   */
  fetchEnvelopes(uids: readonly number[], limit: number): Promise<ImapEnvelope[]>;
}

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
  /** LOGOUT and release the socket. Never throws. */
  close(): Promise<void>;
}

/** What `open()` reports. Structurally `ImapConnectionReport`. */
export interface MailboxOpenReport {
  readonly advertisedCapabilities: readonly string[];
  /**
   * Whether `IDLE` was advertised. `null` means the server said NOTHING about
   * its capabilities, which is not the same as "no" — see `capability.ts`.
   */
  readonly supportsIdle: boolean | null;
  readonly mailbox: {
    readonly name: string;
    readonly exists: number | null;
    readonly uidValidity: number | null;
    readonly uidNext: number | null;
    readonly readOnly: boolean;
  };
}

/** How long a single wire wait may last, and what may cancel it. */
export interface MailboxWireReadOptions {
  /** `null` means no deadline at all; bound the wait with `signal` instead. */
  readonly timeoutMs?: number | null;
  readonly signal?: AbortSignal | undefined;
}

/**
 * The wire operations IDLE is built from. Structurally `ImapConnection` from
 * `imap-session.ts`, restated here so this directory depends on a shape rather
 * than on that file's identity.
 */
export interface MailboxWire {
  onUntagged(listener: (line: string) => void): () => void;
  sendCommand(text: string): Promise<string>;
  sendRawLine(text: string): Promise<void>;
  awaitContinuation(tag: string, options?: MailboxWireReadOptions): Promise<void>;
  awaitTag(tag: string, options?: MailboxWireReadOptions): Promise<string[]>;
  waitForUntagged(
    matches: (line: string) => boolean,
    options?: MailboxWireReadOptions,
  ): Promise<string>;
}

/** Opens connections to one mailbox. One call, one fresh connection. */
export interface MailboxConnectionPort {
  open(): Promise<MailboxConnection>;
}

// ---------------------------------------------------------------------------
// What arriving mail is handed to
// ---------------------------------------------------------------------------

/** One message the watcher found above the cursor. */
export interface InboundMailboxMessage {
  readonly account: string;
  readonly mailbox: string;
  readonly uidValidity: number;
  readonly uid: number;
  /** Headers and delivery evidence. The body is NOT fetched by the watcher. */
  readonly envelope: ImapEnvelope;
  /** Whether this arrived through IDLE push or through the poll fallback. */
  readonly via: 'idle' | 'poll';
}

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
 * The watcher's three runtime states.
 *
 *   - `healthy` — doing what it was configured to do.
 *   - `degraded` — running with less than it wanted. Polling because the
 *     server offers no push, or backing off through a reconnect. Expectations
 *     still get satisfied; mail still arrives; it is slower or noisier.
 *   - `insufficient` — it CANNOT do the job: the mailbox will not open, or the
 *     credential is refused. The watcher does not run, and the owner is told
 *     rather than left with a channel that looks armed and is not.
 *
 * "Cannot" and "not yet" are different, and the difference is load-bearing. A
 * watcher waiting out a reconnect backoff is `degraded`, never `insufficient`:
 * recovery fetches everything above the cursor, so nothing is lost by waiting.
 * Only a capability verdict is `insufficient`.
 */
export type InboundCapabilityState = 'healthy' | 'degraded' | 'insufficient';

/** Why the watcher is in the state it is in. One reason, machine-readable. */
export type InboundCapabilityReason =
  /** healthy: an IDLE connection is held and the server is pushing. */
  | 'idle-push'
  /** healthy: polling because polling is what the owner configured. */
  | 'polling-configured'
  /** degraded: the server does not advertise IDLE, so we poll. */
  | 'polling-no-idle'
  /** degraded: the server refused IDLE at run time, so we poll. */
  | 'polling-idle-refused'
  /** degraded: the server would not say what it supports, so we poll. */
  | 'polling-capability-unknown'
  /** degraded: the socket dropped; waiting out a backoff before retrying. */
  | 'reconnecting'
  /** degraded: the provider's simultaneous-connection limit was hit. */
  | 'connection-limit'
  /** insufficient: the credential was refused. */
  | 'credentials-rejected'
  /** insufficient: signed in, and the mailbox would not open for reading. */
  | 'mailbox-unreadable'
  /** insufficient: the mailbox opened and reported no `UIDVALIDITY`, so no
   *  durable cursor can be kept and a restart could not tell new mail from
   *  old. Running anyway would silently skip or silently repeat. */
  | 'uidvalidity-missing'
  /** insufficient: the mailbox opened and the server refused to hand over
   *  message data, so arrival can be seen and never read. */
  | 'fetch-refused';

/** A state with the evidence for it attached. */
export interface InboundCapabilityVerdict {
  readonly state: InboundCapabilityState;
  readonly reason: InboundCapabilityReason;
  /**
   * Plain-language detail, carrying the SERVER'S OWN wording where the server
   * said anything. Never a message body, never a credential.
   */
  readonly detail: string;
  /** The one remedial step, when there is exactly one. '' when there is not. */
  readonly fix: string;
}

/** A transition between verdicts. Emitted once per transition, never per probe. */
export interface InboundCapabilityTransition {
  readonly account: string;
  readonly mailbox: string;
  readonly from: InboundCapabilityVerdict | null;
  readonly to: InboundCapabilityVerdict;
  readonly at: string;
}

/**
 * A failure that will not clear on its own.
 *
 * Surfaced rather than merely recorded, because silent permanent death is the
 * failure this whole capability exists to eliminate. The supervisor routes it
 * to an authoritative channel with `fix` as the exact step.
 */
export interface InboundMailTerminalFailure {
  readonly account: string;
  readonly mailbox: string;
  readonly reason: InboundCapabilityReason;
  readonly detail: string;
  readonly fix: string;
  readonly at: string;
}

/** Something worth recording that is not a state change. Never a body. */
export interface InboundMailNote {
  readonly account: string;
  readonly mailbox: string;
  readonly kind:
    | 'cursor-established'
    | 'cursor-reset'
    | 'delta-drained'
    | 'expunge-observed'
    | 'idle-reissued'
    | 'connection-lost'
    | 'delivery-failed';
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
   * The ceiling used after a simultaneous-connection refusal.
   *
   * Longer than the ordinary one because that limit is not cleared by asking
   * again sooner — the connections holding it are ours and the provider's, and
   * hammering it only keeps it occupied.
   */
  readonly connectionLimitBackoffMs: number;
  /** How often an `insufficient` verdict is re-probed. Default 60 minutes. */
  readonly capabilityRecheckMs: number;
  /** How many UIDs are fetched in one FETCH. Default 50. */
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
  connectionLimitBackoffMs: 900_000,
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
    deltaBatchSize: Math.max(1, Math.floor(merged.deltaBatchSize)),
  };
}
