/**
 * The watcher's capability vocabulary: what state it is in, and why.
 *
 * Split out of `ports.ts` because it is the one part of that file that grows
 * every time the watcher learns to tell two failures apart, and `ports.ts` had
 * reached the 800-line cap. Each reason carries the argument for its own state
 * and its own remedy, so the union is mostly prose — which is the point, and
 * also why it does not belong in the middle of a file about ports.
 *
 * `capability.ts` keys two exhaustive records on `InboundCapabilityReason`
 * (state and remedial step), so adding a member here fails the build until
 * both are answered. That is the mechanism that stops a new reason arriving
 * without a state or without a fix.
 *
 * Re-exported from `ports.ts`, which remains the name every consumer imports.
 */

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
  /**
   * degraded: the server refused for a reason about ITSELF rather than the
   * account — a connection limit, a capacity refusal, a temporary fault.
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
   * Distinct from a refused one because the fix is different — the secret is
   * missing rather than wrong — and telling an owner to replace a password he
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
   * directly did not settle it either — so there is no high-water mark to
   * start from.
   *
   * `[UIDNEXT n]` on `EXAMINE` is a SHOULD in RFC 3501, not a MUST, and
   * servers do omit it. That alone is NOT this reason: the watcher derives the
   * mark from a `UID SEARCH` instead, which is the same question asked
   * directly, and carries on. This reason is what remains when the derivation
   * also produces no answer — the mailbox reports messages present and the
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
   * insufficient: the server ANSWERED the fetch and this client could not read
   * the answer, for long enough that retrying has stopped being an answer.
   *
   * Distinct from `fetch-refused`, which is a refusal — a `NO` or a `BAD`, the
   * server declining. This is the opposite shape: the server is cooperating,
   * the two ends do not agree on the wire format, and so every retry produces
   * the same unreadable response. One of those is a permission problem at the
   * provider and one is a protocol problem between us and the provider; an
   * owner sent to check his IMAP access over a malformed FETCH response would
   * find nothing wrong and conclude the daemon is lying to him.
   *
   * A single unreadable answer is NOT this. The cursor stays below the message
   * and the batch is fetched again, because an answer that could not be read
   * is not evidence the message is gone — that retry is the correct behaviour
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
   * insufficient: the daemon's OWN state — the cursor file — cannot be
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
   * usable — an empty section for a message whose own BODYSTRUCTURE declared a
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
