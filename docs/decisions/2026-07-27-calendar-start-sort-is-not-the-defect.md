# Decision: the calendar agenda sorts by start time, and externally-sourced event content is untrusted

Date: 2026-07-27
Scope: calendar views and calendar ingest. Written from the inbound-email round.
Status: accepted

## Context

The inbound-email round fixed a real defect in the webui mail view: it sorted
the inbox by `message.date`, the `Date:` header, which the sender writes. Any
stranger emailing the owner could set a far-future date and pin their message to
the top of his inbox indefinitely, a display-order control handed to arbitrary
outsiders, above everything real.

The fix was to sort by `uid`, a value the owner's own IMAP server assigns on
arrival and no sender can influence.

Sweeping the rest of the webui for the same shape surfaced
`src/views/calendar/CalendarView.tsx:177`:

```ts
[...items].sort((a, b) => a.start.localeCompare(b.start))
```

`start` can originate with an external inviter, via an ICS import or a shared
calendar subscription. Structurally this looks identical to the mail bug.

## Decision

**Do not clamp start times, do not reorder externally-sourced events, and do not
substitute a different sort key. The mail fix was correct for mail and is
deliberately not copied here.**

An invite legitimately changes where something lands in an agenda. A meeting
someone schedules for 9am **should** sort before one at 10am, and that is true
whether or not we like the sender. Clamping or de-prioritising external events
would break the feature in order to defend a boundary the sort is not.

The difference from mail, stated so the shape is not re-litigated:

| | Mail | Calendar |
|---|---|---|
| The disputed field | `Date:` header | `start` |
| What it is | decorative metadata | **the substantive value of the record** |
| Non-sender-controlled substitute | `uid`, server-assigned | **none exists** that preserves "what's next" |
| Effect of sorting by it | a stranger picks what he reads first | an event appears at the time it claims to be |

There is no key that both resists the sender and preserves chronological
meaning, because chronological meaning *is* the sender-supplied value. A sort
that ignored it would not be a safer agenda; it would not be an agenda.

## The real risk is action, not ordering

A spoofed start time only matters if something **acts** on "what's next", an
agent reading the top of the agenda and doing something about it. That is a
boundary that already exists for other inbound content, and it is where this
belongs.

**Finding, verified rather than assumed:** it is not wired for calendar at all.

- `grep` for `recordUntrustedIngest` across `packages/sdk/src/platform/` returns
  hits only in `email/email-service.ts` and
  `control-plane/routes/email-composition.ts`.
- `packages/sdk/src/platform/calendar/`, all twenty modules, including
  `ics-parser.ts`, `caldav-ics.ts`, `subscription-store.ts`,
  `google-calendar-api.ts` and `merged-calendar-model.ts`, contains **no
  reference to untrusted content, taint, or the ledger** of any kind.
- `UntrustedSurface` is `'web-page' | 'email' | 'channel-message' | 'document'`.
  Calendar content has no surface, so it cannot be labelled even if a caller
  wanted to.

So event summaries, descriptions, locations and attendee names arriving from an
external inviter, including from a **subscription URL the daemon polls on a
timer**, which is continuous externally-controlled input, enter the system
carrying no marking at all. This is the same gap inbound mail had before this
round, in a capability that already ships.

**That is the defect worth fixing, and it is larger than the sort.** It needs
its own round. Required there:

1. Add a calendar surface to `UntrustedSurface`, or route event content through
   the existing `'document'` surface with an origin naming the inviter or the
   subscription URL.
2. Record ingest **when a turn reads event content, never when a subscription
   poll receives it**, the arrival-is-not-ingest rule
   (`2026-07-27-arrival-is-not-ingest.md`) applies unchanged. A background
   calendar poll that recorded on arrival would poison whatever turn happened to
   be open, exactly as an inbound mail poll would.
3. Event content must not be able to initiate work, for the same reason email
   cannot.

## Two things to do in the view instead of clamping

- **Make provenance visible.** An event whose details came from outside should
  be identifiable as such, so the owner reads it as someone else's claim rather
  than as his own record. This is the same principle as rendering mail notices
  from structured fields: the owner should always be able to tell who wrote what
  he is looking at.
- **Make the sort stable on a daemon-stamped secondary key.** Identical start
  times must not be orderable by whoever crafts their payload to win the
  tiebreak. `CalendarEventSummary` carries `id` but not `uid`, only
  `CalendarEventDetail` has `uid`, so the tiebreak key needs choosing with that
  in mind.

## Alternatives considered

**Sort by a server-assigned key, as mail now does.** Rejected: it produces an
agenda in arrival order, which answers no question anyone has. It also is not
available, `CalendarEventSummary` does not carry `uid`.

**Clamp implausible start times.** Rejected: every threshold is wrong for
someone. A legitimate invite a year out is real, and a clamp that permits it
permits the attack.

**De-prioritise externally-sourced events.** Rejected: it inverts the feature.
Meetings other people schedule are most of a calendar.
