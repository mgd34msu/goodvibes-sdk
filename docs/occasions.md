# Occasions and plans

The daemon holds durable facts about the owner's life — his wife's birthday, an
anniversary, a friend's birthday — and **raises them on its own, before they
matter**, without being asked. It remembers what he answered so it does not keep
asking, but not forever, because the occasions recur.

His framing, verbatim:

> I'd like for example the agent to know it is my wife's birthday in the next week
> or so and for it to suggest (proactively suggest, on its own) buying something
> for the occasion. it doesn't need to make a recommendation, just needs to know
> that it would be something that needs to happen. and then it should remember
> that i said yes or no to make sure it doesn't keep asking (but not forever
> because birthdays are annual)... something like that. ditto anniversary or
> friend's birthday... or if I tell it i'm planning a vacation it will remember
> the dates and where i'm going etc.

---

## 1. Two things, not one

They behave differently and share no code path beyond storage.

**Occasions** — dated, usually recurring, and they *need an action*. Birthdays,
anniversaries. These prompt, and they remember the answer.

**Plans** — a dated range with attributes, ambient rather than prompting.
"Vacation, 12–19 September, Lisbon." There is nothing to decide; the system just
needs to know, so it can stop suggesting things into that window and so it can
move a nudge that would otherwise land while he is abroad.

## 2. The governing principle

**Nothing unresolved is ever dropped.**

One principle behind three cases — an unanswered nudge, a conflicting date, and
an interview he walked away from — and therefore ONE mechanism: the open item
(`occasions/cadence.ts`, `OccasionStateStore.openItems`). Silence never ends
anything. It only moves a date.

## 3. Where each piece lives, and why

| Thing | Lives in | Why |
|---|---|---|
| Occasion declarations (what, whose, date, kind, lead override) | The owner's profile file | A durable fact about his life that he owns and can hand-edit. |
| Plans | The owner's profile file | Same. |
| Acknowledgement state (asked when, answered what, expires when) | A separate machine-owned store | Machine-written state has no business in a file he owns. |
| Gift history (what he landed on) | Machine-owned store | Same reason. |
| Calendar mirror records | Machine-owned store | Bookkeeping about a copy, not a fact about him. |

The owner-profile design is explicit that **a validator never rewrites a line he
wrote**. Writing "asked on the 3rd, he said no" into that file would break that
guarantee, so the two are kept apart:
`~/.goodvibes/daemon/owner-profile.md` and the control-plane state directory's
`occasions-state.json`.

### 3.1 Why an occasion is prose, not a mechanical field

The profile's field registry maps one section-plus-label to one value. It can
hold `commerce.shippingAddress` and it cannot hold twenty birthdays. So
`## Important dates` and `## Plans` are prose-only canonical sections: the
profile parser preserves each line verbatim exactly as it does any other bullet,
and `occasions/grammar.ts` types them on the way past. A line the grammar cannot
make sense of is reported with a reason and never rewritten.

```
- Sarah's birthday · 03-14 · annual · gift-giving · for Sarah · lead 21
- Dad · 11-02 · annual · remember-only
- Our anniversary · 2015-09-12 · annual · gift-giving · for Jane
- Lisbon · 2026-09-12..2026-09-19 · away · in Lisbon
```

Segments after the title are classified by SHAPE, not position, so he can write
them in any order and add one later. Anything unrecognised is kept verbatim.
`·` is canonical and `|` is accepted, because a middot is awkward to type.

### 3.2 The persisted-state treatment

`OccasionStateStore` is bounded (caps per collection, oldest first), validated
record by record (a malformed record is dropped and counted, never the file),
reaped on schedule (an answer expires with its occurrence), swept (orphans and
aged gift history), and it discloses what it holds through `occasions.state`.
Every write is ordered through `StoreWriteQueue`: the sweep runs on a timer while
an answer arrives over a channel, and an unordered write would put the file back
without the answer — so he would be asked again about something he had answered.

## 4. Owner rulings

Each of these was decided by the owner. They are not to be quietly revised.

### 4.1 Lead time — 10 days, with a per-occasion override
Enough runway to order something and have it arrive. `occasions.leadDays`, and a
line carrying `lead 21` overrides it for that occasion alone.

### 4.2 Channel — Telegram **and** the agent. Never the TUI
His reason, verbatim: *"that's more of a 'get work done' kind of interface."*

**This generalises beyond this feature.** The TUI is a work interface;
life-admin and proactive personal nudges belong on Telegram and the agent.
`resolveNudgeDestination` refuses a TUI target structurally rather than merely
not choosing one.

### 4.3 A nudge names the occasion but **never the date**
His words: *"it only needs to tell me a birthday date if i ask it what it is,
same for other dates."*

Stronger than "do not print the date": "in 10 days" is the date with arithmetic
applied. So proximity is a WORD — approaching / soon / imminent — chosen from a
day count that never leaves `occasions/nudge.ts`. Side effect worth preserving:
a reminder delivered to Telegram never puts family birth dates into a message
channel. `occasions.list` does return the dates, because that is him asking his
own system over an authenticated verb — the explicit ask that unlocks a
closed-tier read.

### 4.4 Occasion **kind** is chosen by him at capture time — never inferred
Kinds: **gift-giving**, **remember-only**, and **neither**. `occasions.confirm`
refuses without one. A parent's death anniversary might well be worth
remembering, and a cheerful "you'll probably want to sort something" against it
would be genuinely bad. Never guess.

### 4.5 A date captured from conversation is confirmed **once**, at the time
*"Noted your anniversary as 12 September — right?"* One line, at the moment he
can still catch a mishearing. Silent afterwards; no re-confirmation at nudge
time. For an annual date a silent write means he discovers the error up to
eleven months later.

### 4.6 Silence does not end anything — the nudges continue
No give-up-after-one-retry. Cadence (**my choice, not his** — flagged and not
objected to, and settings rather than constants): first at the top of the
window, then every `occasions.cadenceDays` days, then daily for the last
`occasions.finalStretchDays`.

### 4.7 Quiet hours — 8am to 10pm, in his timezone
*"8am to 10pm are generally fine, anything outside of that probably not, so
quiet outside of that range."* `occasions.activeHours`, reckoned in
`daemon.timezone`. Outside the window nothing is dropped — it waits.

### 4.8 Declining goes silent until the date passes, then asks fresh next year
One "no" ends it for this cycle. The record expires WITH THE OCCURRENCE, so next
year asks again carrying no memory of the refusal. For a one-off, "handled" is
permanent.

### 4.9 "Later" is a distinct answer
"Not yet" three weeks out is not a decline. It returns roughly halfway to the
date.

### 4.10 Yes opens a **short interview**, not a shopping trip
*"if yes, ask me a few questions to guide me into a good gift idea."* The agent
does **not** make the recommendation. It opens from what the profile already
knows (People and Notes prose, verbatim), records **what he landed on** rather
than merely that he said yes, and keeps it to `occasions.interviewQuestions`
questions. A thread he goes quiet on is a dropped thread, not a completion: it
resumes at the question he did not answer.

### 4.11 Removal takes one confirmation
Not unquestioned, and not an argument. People divorce and people die. Orphaned
acknowledgement state is dropped with the occasion.

### 4.12 Conflicting dates — raise immediately, and again later if ignored
Two different dates for one thing are both reported. The newer value is never
taken silently.

### 4.13 Travel/away state feeds nudge timing
*"if you know i'm going to be somewhere, then sure, you can modify things like
nudge times."* A nudge due inside an away window moves EARLIER, to the day before
he leaves — he cannot have something delivered to a house he is not in. Once he
has already left there is nothing earlier to move to and the nudge stands.

### 4.14 Bulk entry is not needed in v1
Skipped.

## 5. Calendar — the profile is the record, the calendar is a mirror

His ruling, verbatim:

> these are permanent dates, not ephemeral dates like exist on the google
> calendar — and while you can feel free to put the dates there, dates from the
> google calendar will (normally) not persist for multiple occurrances

- **Profile → calendar: allowed**, behind `occasions.calendarMirror` (off by
  default).
- **Calendar → profile: NEVER.** There is no calendar-shaped input to
  `occasions/reader.ts` at all, so this is structural rather than a rule someone
  has to remember. Calendar feed content from outside the owner is also
  untrusted content, so ingesting occasions from one would be wrong twice over.
- **Deleting the calendar entry never deletes the occasion** — nothing reads a
  calendar, so there is no path by which it could.
- **Mirrored occasions suppress our nudge** (`occasions.suppressMirroredNudges`),
  so the calendar's own reminder is the only ping.
- **The mirror is idempotent**: keyed by occasion AND occurrence, so re-writing
  the same occasion each year adds one record and never accumulates duplicates.

## 6. Decisions I took, stated so they can be overridden

- Several occasions inside one window **batch into a single message**.
- A **29 February** occasion fires on the 28th in non-leap years. Skipping it is
  what a naive implementation does, and it means the feature silently does
  nothing three years in four.
- The occasion carries the person as a **plain label**, rather than restructuring
  the People section, which is prose-only by design.
- Nudge cadence as in §4.6.
- Nudges push to Telegram by default (`occasions.nudgeChannel = telegram`), the
  owner's ruling. Setting that key to empty makes the feature **pull-only**
  instead: nothing is pushed, and `occasions.pending` is how a surface sees what
  is outstanding.
- A dropped interview resumes the **next day**.

## 7. The control-plane surface

Everything a surface needs is a verb. A consumer that computed anything beyond
calling these and rendering the answers would be a second implementation of a
rule that lives in the daemon — most dangerously the rule that a nudge never
carries the date.

| Verb | Scope | What it is for |
|---|---|---|
| `occasions.list` | `read:occasions` | Every occasion, its next occurrence, days away, window, recorded answer; unparsed lines with reasons; conflicts. |
| `occasions.propose` | `write:occasions` | What would be written, plus the one-line confirmation. Writes nothing. |
| `occasions.confirm` | `write:occasions` | Write the confirmed occasion. Refuses without a kind. |
| `occasions.remove` | `write:occasions` | One confirmation; removes the line and every record against it. |
| `occasions.answer` | `write:occasions` | yes / no / later. A yes opens the interview. |
| `occasions.interview.get` | `read:occasions` | Resume at the unanswered question. |
| `occasions.interview.answer` | `write:occasions` | Record one answer, return the next question. |
| `occasions.interview.record` | `write:occasions` | Close with what he landed on; writes gift history. |
| `occasions.gifts` | `read:occasions` | What he landed on in previous years. |
| `occasions.pending` | `read:occasions` | Everything outstanding, delivered to nobody. |
| `occasions.sweep` | `write:occasions` | Run one pass now. |
| `occasions.conflict.resolve` | `write:occasions` | Stop re-raising a conflict he has dealt with. |
| `occasions.plans.list` | `read:occasions` | Plans, and whether one has him away today. |
| `occasions.plans.propose` | `write:occasions` | Same two-step capture, for a plan. |
| `occasions.plans.confirm` | `write:occasions` | Write the confirmed plan. |
| `occasions.state` | `read:occasions` | What the machine-owned store holds; counts and reasons only. |

`occasions.confirm`, `occasions.plans.confirm` and `occasions.remove` write to
the owner's profile and therefore take `authority` as a required parameter, go
through the profile's own write gate, and refuse a caller that declares the call
was not a user request.

## 8. Settings

All daemon-owned (`config-ownership.ts`), because the sweep runs in the daemon
with every surface closed. All twelve defaults were confirmed by the owner key by
key on 2026-07-28; eleven stood as proposed and `occasions.nudgeChannel` changed
from empty to `telegram`. The "source" column below records where each default
came from originally.

| Key | Default | Source of the default |
|---|---|---|
| `occasions.enabled` | `true` | Not pinned by the plan; a feature that ships off ships dark. |
| `occasions.leadDays` | `10` | Owner ruling §4.1. |
| `occasions.activeHours` | `08:00-22:00` | Owner ruling §4.7. |
| `occasions.nudgeChannel` | `telegram` | Owner ruling, 2026-07-28: nudges push to Telegram out of the box. Empty makes it pull-only. |
| `occasions.cadenceDays` | `3` | My choice, flagged (§4.6). |
| `occasions.finalStretchDays` | `2` | My choice, flagged (§4.6). |
| `occasions.awayAdjust` | `true` | Owner ruling §4.13. |
| `occasions.calendarMirror` | `false` | Not pinned; §5 permits mirroring, it does not require it. |
| `occasions.suppressMirroredNudges` | `true` | Owner ruling §5. |
| `occasions.interviewQuestions` | `3` | Not pinned; §4.10 says "genuinely short". |
| `occasions.giftHistoryYears` | `10` | Not pinned; §4.10 says year three should not be steered by year one. |
| `occasions.sweepIntervalMinutes` | `60` | Not pinned; the plan does not say how often the sweep runs, only that it runs. |

## 8.1 What runs the sweep

A loop that only runs when a verb asks it to is not proactive, and proactive is
the whole feature — so the composition arms a repeating timer
(`occasions/ticker.ts`), re-read from config every tick so
`occasions.sweepIntervalMinutes` is live rather than restart-only.

The ticker is deliberately dumb, because the sweep is where the judgement is: a
tick inside quiet hours raises nothing and reaps anyway, and a tick on a day an
occasion has already been raised finds its open item not yet due. The interval
therefore decides how soon the FIRST nudge lands after a window opens and
nothing else — shortening it cannot make the system nag.

Passes are strictly serial: the next tick is armed only when the current pass
finishes, so a slow sweep delays the next one rather than having one start on
top of it and deliver the same batch twice. The re-arm sits in a `finally`, so
one transient failure cannot end the loop for the life of the process, and the
timer is `unref`'d so it never holds the daemon open.

## 9. What this feature deliberately does not do

Several adjacent things were discussed with the owner and marked "on the list",
"not now" or "think about it later". None of them is built here, and none of them
is scaffolded here either — no stub, no extension seam, no flag. The open-item
loop is a general mechanism and would serve some of them one day, but nothing in
this code refers to any of them.
