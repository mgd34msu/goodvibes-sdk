/**
 * capability-types.ts, the vocabulary for "can this watcher do its job".
 *
 * Split out of `ports.ts`, which holds the whole inbound seam and had eleven
 * lines of headroom under the repository's 800-line source cap. This round adds
 * two capability reasons, `gmail-metadata-only` and
 * `gmail-metadata-notice-only`, and they did not fit.
 *
 * The split is along a real seam rather than at a convenient line number. Three
 * modules already name this vocabulary and nothing else in `ports.ts`:
 * `capability.ts` maps each reason to a state and a remedial step,
 * `capability-policy.ts` decides which reasons
 * `surfaces.email.inbound.onInsufficientCapability: 'notice-only'` can serve,
 * and `terminal-notice.ts` renders a verdict for the owner. Their shared
 * dependency is exactly what moved here.
 *
 * **Every name is re-exported from `ports.ts`**, so no importer changes and
 * `import type { InboundCapabilityReason } from './ports.js'` keeps working.
 * That is deliberate: a mechanical move that also rewrote thirty import sites
 * would bury the two new members in the diff, and this file's contents are
 * otherwise unchanged from where they sat before.
 */

import type { EmailCapabilityFailureNotice } from '../imap-client.js';

/**
 * The watcher's three runtime states.
 *
 *   - `healthy`, doing what it was configured to do.
 *   - `degraded`, running with less than it wanted. Polling because the
 *     server offers no push, or backing off through a reconnect. Expectations
 *     still get satisfied; mail still arrives; it is slower or noisier.
 *   - `insufficient`, it CANNOT do the job: the mailbox will not open, or the
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
  /**
   * degraded: the server refused for a reason about ITSELF rather than the
   * account, a connection limit, a capacity refusal, a temporary fault.
   *
   * Named after what the server actually claimed, not after the commonest
   * cause. Calling a `[SERVERBUG]` a connection limit would put a specific and
   * false explanation in front of the owner, and the detail carries the
   * server's own wording precisely so it does not have to be guessed at.
   */
  | 'server-unavailable'
  /**
   * insufficient: no credential is stored where the daemon reads secrets.
   *
   * Distinct from a refused one because the fix is different, the secret is
   * missing rather than wrong, and telling an owner to replace a password he
   * never stored sends him looking for the wrong thing.
   */
  | 'credentials-missing'
  /** insufficient: the credential was refused. */
  | 'credentials-rejected'
  /** insufficient: signed in, and the mailbox would not open for reading. */
  | 'mailbox-unreadable'
  /** insufficient: the mailbox opened and reported no `UIDVALIDITY`, so no
   *  durable cursor can be kept and a restart could not tell new mail from
   *  old. Running anyway would silently skip or silently repeat. */
  | 'uidvalidity-missing'
  /**
   * insufficient: the mailbox opened, would not say where it ends, and asking
   * directly did not settle it either, so there is no high-water mark to
   * start from.
   *
   * `[UIDNEXT n]` on `EXAMINE` is a SHOULD in RFC 3501, not a MUST, and
   * servers do omit it. That alone is NOT this reason: the watcher derives the
   * mark from a `UID SEARCH` instead, which is the same question asked
   * directly, and carries on. This reason is what remains when the derivation
   * also produces no answer, the mailbox reports messages present and the
   * search names none of them.
   *
   * Distinct from `uidvalidity-missing`, which it otherwise resembles. There,
   * the missing field is derivable from nothing and refusing is the only
   * option. Here the refusal comes after asking, and reporting it as
   * `uidvalidity-missing` would send the owner to check a field that was
   * present and correct.
   *
   * What makes refusing right rather than merely cautious: the alternative is
   * establishing at UID 0, and UID 0 is below every message that exists. The
   * first drain would then search `UID 1:*`, match the entire mailbox, and
   * deliver a year of old mail to the owner's notification channel as new
   * arrivals. Most failures in this list are quiet; this one is loud, wrong,
   * and cannot be recalled once sent.
   */
  | 'mailbox-position-unknown'
  /** insufficient: the mailbox opened and the server refused to hand over
   *  message data, so arrival can be seen and never read. */
  | 'fetch-refused'
  /**
   * insufficient: the Google grant authorizes listing and headers and excludes
   * message bodies (`gmail.metadata`, no body-capable scope), and
   * `onInsufficientCapability` is `refuse-and-notify`.
   *
   * Its own reason rather than `fetch-refused`, because the two are opposite
   * situations: `fetch-refused` is minted from a FAILED envelope fetch, so
   * nothing is readable there, and here everything except the body is. That is
   * the whole reason `notice-only` can mean something on this one reason and
   * nothing on any other, see `capability-policy.ts`.
   */
  | 'gmail-metadata-only'
  /**
   * degraded: the same body-less grant, with `onInsufficientCapability` set to
   * `notice-only`, so arriving mail IS announced from envelope fields alone.
   *
   * `degraded`, not `insufficient`: the source polls and delivers. What it
   * cannot do is satisfy a verification expectation. A separate reason rather
   * than the same one with a different state, because the tracker announces on
   * a change of state OR reason, so switching the policy while the daemon runs
   * tells the owner the behaviour changed.
   */
  | 'gmail-metadata-notice-only'
  /**
   * insufficient: the server ANSWERED the fetch and this client could not read
   * the answer, for long enough that retrying has stopped being an answer.
   *
   * Distinct from `fetch-refused`, which is a refusal, a `NO` or a `BAD`, the
   * server declining. This is the opposite shape: the server is cooperating,
   * the two ends do not agree on the wire format, and so every retry produces
   * the same unreadable response. One of those is a permission problem at the
   * provider and one is a protocol problem between us and the provider; an
   * owner sent to check his IMAP access over a malformed FETCH response would
   * find nothing wrong and conclude the daemon is lying to him.
   *
   * A single unreadable answer is NOT this. The cursor stays below the message
   * and the batch is fetched again, because an answer that could not be read
   * is not evidence the message is gone, that retry is the correct behaviour
   * and it is `reconnecting` while it lasts. This reason is what that retrying
   * escalates to once drains have come back unreadable
   * `MAX_CONSECUTIVE_UNREADABLE_DRAINS` times in a row with no completed drain
   * in between, at which point "it will read next time" has been disproved by
   * the server. Without the escalation the retry is unbounded, and an
   * unbounded retry of a mailbox that can never be read is a login-per-second
   * hot loop against a provider that counts connections.
   */
  | 'fetch-unreadable'
  /**
   * insufficient: the daemon's OWN state, the cursor file, cannot be
   * written, and has not been writable for long enough that waiting is no
   * longer a plausible answer.
   *
   * Nothing about the mail server is wrong here, and that is exactly why it
   * needs its own reason. The cursor is what "this message is handled" is
   * recorded in; a watcher that cannot write it either stops advancing (and
   * re-delivers the same message forever) or advances in memory only (and
   * loses everything at the next restart). Both are silent. A named reason on
   * the local disk is something the owner can act on; `mailbox-unreadable`
   * would send him to the mail provider for a full filesystem.
   */
  | 'local-store-unwritable'
  /**
   * insufficient: the run loop ended with a failure that no other reason
   * describes.
   *
   * The catch-all, and it exists so that "we did not anticipate this" has a
   * state rather than becoming a dead loop with a healthy status. Any throw
   * that escapes the source's own handling lands here, is reported, and stops
   * `running` from reading true for a loop that is not running.
   */
  | 'watcher-stopped-unexpectedly'
  /**
   * insufficient: the server ACCEPTED a body fetch and returned nothing
   * usable, an empty section for a message whose own BODYSTRUCTURE declared a
   * text part with octets in it.
   *
   * Deliberately not `fetch-refused`. That one means the server said no; this
   * one means it said yes and handed over nothing, which is the shape a
   * metadata-only grant takes on a protocol with no scopes to inspect. The
   * remedies differ: a refused fetch points at IMAP access and folder
   * restrictions, this points at what this account is permitted to READ.
   */
  | 'bodies-unfetchable'
  /**
   * degraded: nothing has yet demonstrated that message content can be read,
   * because the mailbox was empty when the connection opened.
   *
   * Not `healthy`, because that would claim a capability nobody has shown; not
   * `insufficient`, because refusing to watch an empty mailbox would break the
   * freshly-created signup alias this capability exists to serve. The watcher
   * runs, says plainly that it has not proven it can read message content, and
   * the first real message settles it either way.
   */
  | 'bodies-unproven';

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
  /** The owner-facing sentence. One per failure, see `capability.ts`. */
  readonly fix: string;
  readonly at: string;
  /**
   * The routable record the email modules produce, when the failure carried
   * one.
   *
   * `ImapOpenError` and `EmailCredentialUnavailableError` both expose it, and
   * `describeEmailCapabilityFailure` reads it off either structurally, so a
   * missing credential and a rejected one reach the owner by one path, and a
   * supervisor does not import both modules to tell them apart. Null for
   * failures raised here rather than there.
   */
  readonly notice: EmailCapabilityFailureNotice | null;
}
