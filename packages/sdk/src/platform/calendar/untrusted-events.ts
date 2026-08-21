/**
 * untrusted-events.ts, externally-sourced calendar event content is untrusted
 * content, with the same shape mail already uses.
 *
 * ## What was missing
 *
 * A calendar event's summary, description, location and attendee names are
 * written by whoever sent the invitation. That is the same class of input as a
 * message body or a web page: text an outsider chose, arriving in a runtime
 * that can also send, buy and change settings. Until this module existed no
 * file under `platform/calendar/` mentioned untrusted content, taint or the
 * ledger at all, so an inviter's words entered the process carrying no marking,
 * and `evaluateOutwardEffect` could not see them when deciding whether an
 * outward action was composed from something a stranger wrote.
 *
 * See docs/decisions/2026-07-27-calendar-start-sort-is-not-the-defect.md, which
 * ruled that the risk in a calendar is ACTION, not ordering, and named this.
 *
 * ## Arrival is not ingest, the rule this module is shaped around
 *
 * `docs/decisions/2026-07-27-arrival-is-not-ingest.md` applies here unchanged
 * and is the reason this module exports a recorder rather than calling one.
 *
 * A calendar subscription is polled on a TIMER. Nobody is watching, and the
 * poll happens whenever the interval says so. The turn ledger is one instance
 * per process, scoped by a watermark that `startTurn()` advances, so a
 * recording made at the moment a feed body arrives lands in whatever turn
 * happened to be open, and would refuse that turn's outward action on the
 * basis of an event no turn read and nobody asked for. Anyone who knew the feed
 * URL, or could get an event onto a calendar the owner subscribes to, would own
 * a remote off switch for his agent's outward actions.
 *
 * So: **every call site of `recordCalendarEventIngest` is a READ.**
 * `SubscriptionStore.readEvents()` / `readAllEvents()` record; the plain
 * accessors `events()` / `allEvents()` do not, because a consumer already
 * calls `events()` from a timer-driven refresh to count what arrived; and
 * `refresh()` / `applyFetch()`, which are arrival, record nothing, and must
 * not start.
 * The same rule puts the gateway's recording in `listEvents` / `getEvent` /
 * `exportIcs` / `importIcs`, each of which runs because a turn asked.
 *
 * ## Why the recorder is injected instead of imported
 *
 * Exactly as `EmailService` does it (`platform/email/email-service.ts`,
 * `recordUntrustedIngest`): this package reaches for no ledger of its own, so
 * it stays pure and testable and a caller cannot accidentally record into a
 * different session's ledger. The daemon binds the real process ledger in
 * `control-plane/routes/calendar-composition.ts`, which is where the
 * `'calendar-event'` literal below is type-checked against `UntrustedSurface`.
 *
 * ## What this module does NOT do
 *
 * It does not decide display order, clamp a start time, or de-prioritise
 * anything. An invite legitimately changes where a meeting lands in an agenda;
 * the accepted decision record rejected touching the sort. This module labels
 * provenance and records reads. Nothing here can initiate work, and nothing
 * under `platform/calendar/` may gain a path that can, see
 * `test/security-calendar-trust.test.ts`'s source scan, which fails if one
 * appears.
 */

/**
 * Where a batch of event content came from.
 *
 * Carried explicitly rather than sniffed from the events, because the origin of
 * an event is a fact about the transport that delivered it, and an event's own
 * fields are written by the party this module exists to distrust.
 */
export type CalendarEventProvenance =
  /** An .ics body handed to `calendar.ics.import`. */
  | { readonly kind: 'ics-import' }
  /** A CalDAV collection on the operator's own server. */
  | { readonly kind: 'caldav'; readonly calendarId: string }
  /**
   * A subscribed feed URL the daemon polls.
   *
   * The URL arrives ALREADY MASKED. A Google/Outlook "secret address" feed URL
   * grants read access to the calendar, so it is secrets-adjacent and the
   * ledger, which surfaces into refusal text an operator reads, must not
   * carry the raw value. `SubscriptionStore.maskFeedUrl` owns the masking.
   */
  | { readonly kind: 'subscription'; readonly name: string; readonly maskedUrl: string }
  /** An authenticated provider account (Google Calendar, Microsoft Graph). */
  | {
      readonly kind: 'provider';
      readonly provider: 'google' | 'microsoft';
      readonly calendarLabel?: string | undefined;
    };

/**
 * The fields of one event that an outsider writes.
 *
 * Structural on purpose: `CalendarEvent`, `MergedCalendarEvent`,
 * `CalendarGatewayEventSummary`, the CalDAV parser's `ParsedICalEvent` and
 * Google's `CalendarEventRecord` are five shapes for the same thing, and this
 * module has no business preferring one of them.
 */
export interface UntrustedCalendarEventFields {
  readonly summary?: string | undefined;
  readonly location?: string | undefined;
  readonly description?: string | undefined;
  /** Attendee display names or addresses, as the source supplied them. */
  readonly attendees?: readonly string[] | undefined;
  /**
   * The organizer as the source CLAIMED it, an address or a display name.
   *
   * A useful label for a reader, never an identity check. Nothing verifies that
   * the party named here sent the invitation, exactly as nothing verifies a
   * `From:` header.
   */
  readonly organizer?: string | undefined;
  /**
   * True only when the SOURCE ITSELF states the owner organized this event,
   * Google's `organizer.self`, Graph's `isOrganizer`, both read-only and both
   * relative to the calendar the copy appears on.
   *
   * Absent or false means external. That default direction is deliberate: an
   * event that says nothing about who organized it is treated as somebody
   * else's, which fails towards recording rather than towards silence.
   */
  readonly organizerIsOwner?: boolean | undefined;
}

/**
 * The recording callback, declared structurally so this package imports no
 * ledger. `surface` is the literal `'calendar-event'`; the composition root
 * hands the result to `UntrustedContentLedger.record`, and that assignment is
 * what ties this literal to `UntrustedSurface` at compile time.
 */
export type CalendarUntrustedIngestRecorder = (ingest: {
  readonly surface: 'calendar-event';
  readonly origin: string;
  readonly at: string;
  /**
   * The event text that was read.
   *
   * Without it the guard downstream can only ask "has this process read a
   * calendar", which in a daemon is permanently true and therefore decides
   * nothing. With it, an outward action can be checked for DERIVATION from the
   * invitation, which is the threat: an instruction planted in an event title
   * or description that a summary then repeats into a send.
   */
  readonly content?: string | undefined;
}) => void;

/**
 * Whether this event's content came from outside the owner.
 *
 * Ruled, not inferred:
 *
 *  - An **.ics import** and a **subscribed feed** are external
 *    unconditionally. Both are a body handed in from elsewhere, and neither
 *    carries any statement about who the account is.
 *  - A **provider** event is external unless the provider itself says the
 *    owner organized it (`organizer.self`, `isOrganizer`).
 *  - A **CalDAV** collection is the owner's OWN server, holding both his own
 *    entries and invitations delivered to him, so it is narrowed the same way
 *    a provider account is: external unless the caller established that the
 *    organizer is the configured account. It used to be unconditional, which
 *    meant the owner reading his own calendar recorded an ingest and every
 *    later outward action in that turn was refused, `evaluateOutwardEffect`
 *    is called by `createUntrustedContentPort` with no `content` at all, so
 *    port consumers take the coarse "any origin -> refuse" branch and no
 *    derivation check ever runs.
 *
 * `organizerIsOwner` must come from configuration or from the provider, never
 * from event content the caller has not checked against configuration.
 * Anything absent or unmatched stays external: the default fails towards
 * recording.
 */
export function calendarEventIsExternallySourced(
  provenance: CalendarEventProvenance,
  event: UntrustedCalendarEventFields,
): boolean {
  switch (provenance.kind) {
    case 'ics-import':
    case 'subscription':
      return true;
    case 'caldav':
    case 'provider':
      return event.organizerIsOwner !== true;
  }
}

/**
 * Strip a `mailto:` prefix and surrounding whitespace from an organizer value.
 *
 * Exported so the CalDAV gateway compares an ORGANIZER against the configured
 * account through the SAME normalisation the origin string is built with, a
 * second, slightly different copy of this is how the two would drift.
 */
export function organizerLabel(organizer: string | undefined): string {
  const trimmed = (organizer ?? '').trim();
  if (trimmed.length === 0) return '';
  return trimmed.replace(/^mailto:/i, '').trim();
}

/**
 * True when a claimed ORGANIZER is the owner's own configured identity.
 *
 * Case-insensitive after `organizerLabel`, because mailbox comparison is
 * case-insensitive in practice and an ICS writer may upper-case the scheme or
 * the local part. Both sides must be non-empty: an unset owner identity, or an
 * event with no organizer, is NOT a match, so the exemption cannot fire on
 * "nothing configured" or "nobody named".
 *
 * The owner identity handed in must come from CONFIGURATION. A caller that
 * passed a value read out of event content would be letting the invitation
 * declare itself trusted.
 */
export function organizerIsOwnerIdentity(
  organizer: string | undefined,
  ownerIdentity: string | undefined,
): boolean {
  const claimed = organizerLabel(organizer).toLowerCase();
  const owner = organizerLabel(ownerIdentity).toLowerCase();
  if (claimed.length === 0 || owner.length === 0) return false;
  return claimed === owner;
}

/**
 * Where this event came from, in a form a person can read, prefixed `calendar:`
 * so a refusal listing several origins says which kind each one was.
 *
 * The inviter wins when the source named one, because "content from
 * alice@example.invalid (claimed organizer)" is the sentence a reader can act
 * on. Otherwise the transport is named: the subscription (masked), the CalDAV
 * collection, the provider calendar, or the .ics import.
 */
export function calendarEventOrigin(
  provenance: CalendarEventProvenance,
  event: UntrustedCalendarEventFields,
): string {
  const organizer = organizerLabel(event.organizer);
  if (organizer.length > 0) return `calendar:${organizer} (claimed organizer)`;
  switch (provenance.kind) {
    case 'ics-import':
      return 'calendar:an imported .ics file';
    case 'caldav':
      return `calendar:CalDAV collection ${provenance.calendarId}`;
    case 'subscription':
      return `calendar:subscription '${provenance.name}' at ${provenance.maskedUrl}`;
    case 'provider': {
      const label = provenance.calendarLabel?.trim();
      return label !== undefined && label.length > 0
        ? `calendar:${provenance.provider} calendar '${label}'`
        : `calendar:${provenance.provider} calendar`;
    }
  }
}

/**
 * The retained text of one event: every field an inviter writes, and nothing
 * else. Ids, hrefs and timestamps are excluded, they are ours or the server's,
 * and putting them here would make ordinary machine-generated strings look like
 * derivation the moment an outward action mentioned an event id.
 */
export function calendarEventIngestText(event: UntrustedCalendarEventFields): string {
  const parts: string[] = [];
  const push = (value: string | undefined): void => {
    const trimmed = (value ?? '').trim();
    if (trimmed.length > 0) parts.push(trimmed);
  };
  push(event.summary);
  push(event.location);
  push(event.description);
  push(organizerLabel(event.organizer));
  for (const attendee of event.attendees ?? []) push(attendee);
  return parts.join('\n');
}

/**
 * Record that a turn read externally-sourced event content.
 *
 * CALL THIS FROM A READ. Never from a poll, a refresh, a webhook receipt, or
 * anything else that runs because time passed rather than because someone
 * asked, see the module header.
 *
 * One entry per event rather than one per batch: origins are per-inviter, and
 * collapsing a list into "the calendar" would lose the name of the party whose
 * text an outward action turns out to repeat. Events that are not externally
 * sourced, and events whose readable fields are all empty, record nothing,
 * there is no exposure to record.
 */
export function recordCalendarEventIngest(input: {
  readonly record: CalendarUntrustedIngestRecorder | undefined;
  readonly provenance: CalendarEventProvenance;
  readonly events: readonly UntrustedCalendarEventFields[];
  /** ISO timestamp for the batch, injected so tests are deterministic. */
  readonly at: string;
}): void {
  const record = input.record;
  if (record === undefined) return;
  for (const event of input.events) {
    if (!calendarEventIsExternallySourced(input.provenance, event)) continue;
    const content = calendarEventIngestText(event);
    if (content.length === 0) continue;
    record({
      surface: 'calendar-event',
      origin: calendarEventOrigin(input.provenance, event),
      at: input.at,
      content,
    });
  }
}
