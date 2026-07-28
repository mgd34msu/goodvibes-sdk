# Owner Profile

The owner profile is what the platform knows about the person who owns it: his
name, how to reach him, where he lives, where to ship things, how he likes
answers written, who the people around him are, and whatever else he has told
it. It exists because an assistant that asks for a shipping address every time,
or guesses a metro area for a weather answer, is doing the same work forever.

It is **one Markdown file** at daemon scope, read once into memory, and read back
out at the cost of a property access.

---

## 1. What the owner asked for

Four rulings define this. They are quoted, not paraphrased.

**Scope.** Offered three widths, he chose the widest:

> IDENTITY name, preferred name, pronouns · CONTACT email(s), phone, agent alias ·
> LOCATION home address, city, timezone · COMMERCE billing addr, shipping addr ·
> PREFS units, date format, currency · CONTACT-ME default channel, quiet hours ·
> STYLE reply verbosity, formality · DEFAULTS shipping tier, approval window ·
> PEOPLE name → relationship, contact · PLACES work, gym, regular spots ·
> WORK employer, role · NOTES free-form facts about you

The option he read was labelled *"Richest, and the most sensitive: it becomes a
dossier that any compromise exposes."* He chose it knowing that, which is why
containment (§9, §10) is part of the design rather than a caveat on it.

**Learning.** Offered propose-first and autonomous, he chose autonomous:

> You: "ship it to my office instead" → Agent: [records office address] "Noted —
> saved your office address to your profile."

described as *"The agent writes facts it learns from things you say directly to
it, without asking each time, and tells you what it recorded. Fastest to build
up. Untrusted sources still barred, but a wrong inference lands in the profile
silently."*

Two conditions travelled with that choice and are requirements: **untrusted
sources stay barred** (§7) and **it tells him what it recorded** (§8).

**Storage.** Asked whether to build on the knowledge subsystem:

> "it needs to be extremely fast and probably faster than the knowledge system
> will allow"
>
> "just a file with notes will probably be good"

**Format.**

> "just an MD file that the daemon can access or some other store that will be
> quick to recall is fine"

---

## 2. Decision: a Markdown file, not a store

**Decided: one Markdown document at daemon scope, loaded into memory at startup,
re-read when its mtime changes, written by surgical line edits with
write-temp-then-rename.**

### 2.1 Rejected: build on `platform/knowledge/`

The knowledge subsystem (`packages/sdk/src/platform/knowledge/`, 52 modules) has
provenance, node revision history, spaces, consolidation, refinement, lint and
scheduling over a SQLite store. Reusing it would avoid writing provenance and
history machinery twice, and duplicated machinery is a drift class that has cost
this platform repeatedly. It was still rejected, for three reasons in descending
weight.

1. **The owner's speed ruling, quoted above.** The knowledge store is sql.js
   (WASM): every open loads the whole database into memory and every `save()`
   rewrites the entire file. A profile lookup would pass through space-scope
   resolution (`scope-records.ts`), node status gates and confidence clamping
   (`store-node-history.ts`) to return a string. Wrong order of magnitude for a
   hot-path value.

2. **The knowledge store is the machine's untrusted-content intake.** Its ingest
   paths are `knowledge.ingest.url`, `.bookmarks`, `.artifact`,
   `.browserHistory`, `.connector` — web pages, documents, bookmark exports.
   Requirement 3 says untrusted content must be *incapable* of reaching the
   profile. Putting the profile inside the store built to absorb web pages makes
   that a filter to maintain instead of a property of the design. A separate file
   cannot be reached by an ingest path that does not know it exists.

3. **The shapes disagree.** Knowledge records are source-grounded,
   confidence-scored and draft-gated; `clampConfidence` exists because producers
   emit scores. A shipping address is not 72% true.

### 2.2 Rejected: a parallel typed store beside knowledge

A second SQLite store with its own provenance and GC tables was where the design
was heading before the owner ruled. It is rejected by his ruling and,
independently, by §9.4's reasoning.

### 2.3 What "a file" rules out

No database. No secondary index. No embeddings, no semantic search. No
consolidation or refinement pipeline. No graph, no spaces, no background jobs, no
query language. **If a second file is ever added to make lookups faster, this
design has been abandoned.** The one file is watched for changes (§5.3) so a hand
edit is picked up without a restart; a watcher is not a lookup structure.

### 2.4 Why Markdown, given the file was already chosen

He named it. Beyond that it is the only one of the candidates that is legible
*as a document* — he can open it, read the whole dossier at a glance, and fix a
line the way he would fix a line in any note. JSON, YAML and TOML are all
formats you edit as data; this is a page he reads. The cost of Markdown is that
nothing is strictly validated, which is why §4.4 makes leniency explicit and
§4.5 makes his hand edits authoritative rather than something the parser
disciplines.

---

## 3. Location: daemon scope

```
~/.goodvibes/daemon/owner-profile.md
```

Resolved through the daemon home (honouring `GOODVIBES_DAEMON_HOME`), the
directory that already holds `settings.json`, `operator-tokens.json` and
`detached-daemon.json` — see `platform/config/daemon-config-tier.ts`.

Daemon scope, not surface scope, for the reason `config-ownership.ts` already
gives: a fact written from the agent must be readable by the daemon with every
surface closed, and by the TUI tomorrow. A surface-scoped profile reproduces the
failure that motivated the daemon-credential-scope round — a value written
successfully into a silo the daemon never reads, reporting success and
configuring nothing.

Surfaces never open the file. They read and write through the daemon's control
plane (§11).

**The daemon is the only *program* that writes it — but it is not the only
writer.** The owner is one too, by design (§4.5), and an earlier draft of this
section claimed single-writer to justify having no lock while §4.5 and §5.3
simultaneously depended on him editing the same file. That contradiction was a
real defect and it was reproduced: a save of his landing inside the reload
window was destroyed by the next machine write, with a success receipt and no
error.

So the rule is: **a write must verify the file has not changed underneath it
between the projection it edited and the rename.** Compare mtime and content
against disk immediately before the rename; on a mismatch, re-read and replay
the edit against the new content, or refuse and say why. Never clobber. The
window is small — roughly the debounce with `fs.watch`, up to
`profile.reloadThrottleMs` on the poll fallback, and unbounded if the watcher
errored — but "small" is not a property anyone should rely on for the file that
holds his address.

**Naming note:** `platform/profiles/` already exists and is a named-config-preset
manager (`ProfileData` = saved `display.*`/`provider.*` settings), unrelated to
this. The new module is `platform/owner-profile/`, and nothing in it is called
`Profile` unqualified.

---

## 4. The document

### 4.1 Shape

Headed sections, one per area. Under each heading: a small number of
`key: value` lines for the few things something must act on mechanically, and
prose bullets for everything else.

```markdown
# Mike's profile

<!-- GoodVibes keeps this file. Edit it by hand whenever you like — your edits
     win and are never rewritten. Lines it learned from you carry a short note
     at the end saying where it heard it. Delete the note if you find it noisy;
     delete the line to make it forget. -->

## Identity

name: Mike Davis
goes by: Mike
pronouns: he/him

## Contact

email: mgd34msu@gmail.com
phone: +1 517 555 0134
- Prefers Telegram for anything urgent — agent, 2026-07-27, "ping me on telegram if it's urgent"

## Location

timezone: America/Detroit
city: Lansing, MI
- Home is the blue house on the corner of Elm — tui, 2026-07-20, "we're the blue house on the corner of Elm"

## Commerce

shipping address: 200 Office Way, Lansing, MI 48933, US — tui, 2026-07-27, "ship it to my office instead"
billing address: 401 Home St, Lansing, MI 48933, US
currency: USD
shipping tier: standard

<!-- was: shipping address: 401 Home St, Lansing, MI 48933, US — tui, 2026-07-20, "ship to 401 Home St" (superseded 2026-07-27) -->

## Preferences

units: imperial
date format: iso
locale: en-US

## Contacting me

channel: telegram
quiet hours: 22:00-07:00

## Style

- Keep replies short unless I ask for detail — tui, 2026-07-26, "keep it short unless I ask"

## People

- Sarah, sister, sarah@example.com — tui, 2026-07-27, "my sister Sarah, sarah@example.com"
- Dave from work, handles the Pellux contracts

## Places

- Gym: the Y on Michigan Ave — agent, 2026-07-27, "I go to the Y on Michigan Ave"

## Work

- Runs Pellux, founder — tui, 2026-07-27, "I run Pellux"

## Notes

- Allergic to shellfish — tui, 2026-07-27, "I'm allergic to shellfish"
```

### 4.2 Provenance rendering

A learned line carries a compact suffix at end of line:

```
 — <surface>, <YYYY-MM-DD>, "<what he said>"
```

Em dash, surface, date, verbatim quote. It is recognised only when the whole
shape matches at end of line, so an em dash in his own prose is prose. Where a
line somehow carries two suffixes, the **rightmost** valid one wins and the
older one stays as ordinary visible text — the newest provenance is the true
one, and nothing is silently destroyed to reach that answer.

Verified against real strings: `- He said — and I quote — that it was fine`
stays prose; a malformed date, an unknown surface name, and a line ending in a
bare `"` all stay prose; embedded quotes in the verbatim need no escaping.

That is the lightest rendering that still answers "where did you get that"
completely: which surface, when, and the exact words. It is not dropped, and if
he finds it ugly the answer is to delete the suffix on that line — which is
allowed and authoritative (§4.5), and after which the honest answer to "where
did you get that" becomes "no provenance recorded; you edited this line by
hand."

A `key: value` line carries the suffix the same way, after the value.

### 4.3 Mechanical fields

Only these are parsed into typed values. Everything else in the document is
prose, preserved and served as prose. The people and places sections have **no**
mechanical fields at all — he asked for notes, and notes are what they are.

| Section | Field | Parsed as |
|---|---|---|
| Identity | `name`, `goes by`, `pronouns` | string |
| Contact | `email` | address-shaped string |
| Contact | `phone` | string |
| Contact | `agent alias` | address-shaped string |
| Location | `timezone` | IANA zone, checked against `Intl.supportedValuesOf('timeZone')` |
| Location | `city` | string |
| Location | `home address` | string |
| Commerce | `shipping address`, `billing address` | string |
| Commerce | `currency` | ISO-4217 (3 letters) |
| Commerce | `shipping tier` | string |
| Preferences | `units` | `metric` \| `imperial` |
| Preferences | `date format` | `iso` \| `us` \| `eu` |
| Preferences | `locale` | BCP-47 shaped |
| Contacting me | `channel` | string |
| Contacting me | `quiet hours` | `HH:MM-HH:MM` |
| Style | `verbosity` | `brief` \| `normal` \| `detailed` |
| Style | `formality` | `casual` \| `neutral` \| `formal` |
| Defaults | `approval window` | integer minutes |

Field names are matched case-insensitively with whitespace collapsed, so
`Shipping Address:` and `shipping address:` are the same field.

**An invalid mechanical value does not fail the file.** `timezone: Mars/Olympus`
is preserved verbatim, reported by `profile.status` as an invalid field with the
reason, and its consumer falls back exactly as if it were unset. Deleting a line
he typed because the parser disliked it would be the worst possible behaviour in
a file he owns.

### 4.4 Parse leniently, fail loudly

- An unrecognised `## heading` is a section whose content is preserved verbatim
  and returned as prose. It is not an error.
- A `key: value` line under a known heading whose key is not a mechanical field
  is prose. It is not an error.
- **Fenced code blocks are opaque.** The scanner tracks fence state (` ``` ` and
  `~~~`) and, while inside a fence, treats nothing as a heading, a field, a
  bullet or a provenance suffix. Without this, a document containing a fenced
  `## Notes` or a fenced `timezone:` line would have that line rewritten by a
  later write — silent corruption of his own content, which is the worst
  failure this design can have.
- **Mechanical fields are recognised only at column 0.** An indented
  `Gym: the Y on Michigan Ave` under a bullet is prose, not a field. This also
  avoids guessing at four-space indented code blocks, which are indistinguishable
  from deep list indentation.
- A bullet, a paragraph, a nested list, a table, a code fence, an HTML comment —
  all preserved verbatim.
- Blank lines, indentation and ordering are preserved.

The **only** conditions that produce "profile unavailable" are: the file cannot
be read (permissions, I/O error), or its bytes are not valid UTF-8. In those
cases every verb answers with the state and the reason —
*"Your profile could not be read: <reason> (`<path>`)"* — never with an empty
profile, which would read as "I know nothing about you" when the truth is "I
could not open the file."

Content can therefore never be silently dropped, because there is no path that
discards a line it did not understand.

#### "Not loaded yet" is not one of the states

There are exactly three: **loaded**, **disabled**, and **unavailable with a
reason**. A live run found a fourth leaking out — `composeOwnerProfile` fires
`void store.load().then(…)` and returns synchronously, so for the first
milliseconds of daemon life every verb answered *"Your profile has not been
loaded yet"*.

That is the same dishonesty as returning an empty profile, wearing a different
sentence. "I have not got round to opening the file" is not an answer to "what do
you know about me", and it is worse further down: the consumer fallback is
installed in that window but resolves nothing, so `checkin.quietHours` and
`daemon.timezone` read as *unset* rather than as their profile values, and a
first turn landing there gets no open-tier block at all. Nothing logs it. The
owner would see his check-in fire at the wrong hour once after a restart and have
no way to connect it to anything.

**The initial load is synchronous, at boot.** An earlier version of this section
prescribed a `ready` promise that verbs and consumer reads would await. That was
wrong, and the reason is worth keeping: **`ConfigManager.get()` is synchronous**,
so a fallback reader has nothing to await with. A readiness promise could have
closed the verb half of the window and never the consumer half — which is the
half that costs him a mis-timed check-in. Reading the file once, synchronously,
in the composition root removes the window instead of making it awaitable.

The cost is one small file read on a path the daemon already reads
`settings.json` from at boot. The reload path stays asynchronous, because the
watcher has an event loop to run on and a reload must never block one.

This is the class of defect only a live run finds. Every stubbed test constructs
a loaded store, so the window does not exist for it, and four refusal tests were
passing on this message rather than on the gate they were written to prove.

### 4.5 His edits are authoritative

- A line he deletes stays deleted. Nothing restores it, and nothing re-learns it
  from a superseded record. The `<!-- was: … -->` history comments (§9.1) are
  themselves deletable, and deleting one destroys that history — his call.
- A line he rewrites keeps his wording. The writer never normalises prose, never
  re-orders sections, never re-wraps, never converts a bullet to a field or back.
- A line whose provenance suffix he strips keeps no provenance and reports none.
- Sections he adds, renames or removes are respected. A write to a section that
  does not exist creates it at the end of the document; a write to a section he
  renamed goes to the renamed one when its heading still matches a known section
  name case-insensitively, and otherwise creates the canonical one rather than
  guessing.

Implementation rule that makes this true rather than aspirational: **the file's
text is the source of truth, the in-memory model is a projection of it, and every
write is a surgical edit to a line array — never a re-serialisation of the
model.** A round-trip test asserts that writing one fact changes exactly the
lines it should and leaves every other byte identical.

---

## 5. In memory, and speed

### 5.1 Structure

```ts
interface ProfileLine {
  readonly lineIndex: number;     // into the raw line array; internal only, never a verb parameter (§9.2)
  readonly section: string;       // heading text as written
  readonly text: string;          // the line minus its provenance suffix
  readonly provenance?: { surface: ProfileSurface; date: string; said: string };
}

interface ProfileFieldValue {
  readonly value: string;
  readonly valid: boolean;
  readonly invalidReason?: string;
  readonly provenance?: ProfileLine['provenance'];
}
```

Loaded once into:

- `Map<string, ProfileFieldValue>` — mechanical fields, keyed
  `'location.timezone'`, `'commerce.shippingAddress'`, …
- `Map<string, ProfileLine[]>` — prose lines by section.
- `string[]` — the raw lines, for writes.

A mechanical read is `map.get(key)`. No I/O, no lock, no parse, no `stat` on the
read path.

### 5.2 Acceptance criterion

A mechanical-field read must be **effectively free** — target sub-microsecond.
`test/owner-profile-read-latency.test.ts` measures nanoseconds per read
against a realistic document (200 lines), and the measured number goes in the
round report. Not an assertion that it is fast; a number. If it is not
effectively free the design has failed his requirement regardless of how correct
everything else is.

**Measured: 15.2 ns/read** — median of five runs (14.7, 15.0, 15.2, 15.4, 17.2)
at 1,000,000 reads of a 200-line profile, on a host at 0.42 load per core.
Roughly sixty-five times inside the sub-microsecond target.

Quote a figure only from a quiet host. An earlier run during a four-lane build
read 43.6 ns — still far inside the criterion, but nearly three times the
settled number. A benchmark taken under contention measures the contention.

### 5.3 Picking up a hand edit

`fs.watch` on the **containing directory**, filtered to the profile's filename —
never on the file itself. §5.4's atomic write replaces the file's inode, and a
file-level watch is bound to the old inode, so it goes deaf after the first
write. The symptom would be subtle and awful: hand edits picked up until the
first autonomous write, and silently ignored forever after. Measured on this
machine, a directory watch sees a `rename` event for each of two successive
atomic replacements; a file watch sees the first and then nothing.

On a change event the file is re-read, re-projected, and the model is swapped
atomically — a reader sees the old projection or the new one, never a half-built
one. Where `fs.watch` is unavailable, a `stat` throttled to
`profile.reloadThrottleMs` (default 2000). **Neither path puts a syscall on a
read.** The watcher ignores the event caused by its own write (own-write token +
mtime).

If a re-read fails (unreadable, not UTF-8) the profile reports unavailable with
the reason. It does not keep serving the previous projection, because that would
mean a broken file silently kept answering with stale values.

### 5.4 Writes

Mutate the raw line array, join, write to
`owner-profile.md.tmp.<pid>.<uuid>`, `rename()` over the target — atomic on
POSIX, so a crash mid-write leaves either the old complete file or the new
complete file. Same pattern as `PersistentStore.persist()`
(`platform/state/persistent-store.ts`) with a text join instead of
`JSON.stringify`.

---

## 6. Sections

`Identity`, `Contact`, `Location`, `Commerce`, `Preferences`, `Contacting me`,
`Style`, `Defaults`, `People`, `Places`, `Work`, `Notes`.

`People`, `Places`, `Work`, `Notes` and `Style` are prose-only. Autonomous writes
into them append a bullet with a provenance suffix. Nothing turns them into
records.

---

## 7. Trust: untrusted content can never write or propose

Absolute, enforced in three layers, all built on the existing security modules.
No parallel notion of trust is introduced.

### Layer 1 — authority

Every write takes an `AuthoritySurface`
(`platform/security/untrusted-content.ts`) and is refused unless
`surfaceHasCommandAuthority(authority)` is true, i.e. unless it is
`owner-direct`. `web-page`, `email`, `channel-message` and `document` are refused
by construction, with that module's own reasoning: there is deliberately no
middle tier.

**`authority` is required on every write verb and is never defaulted.** An
earlier version read an absent `authority` as `owner-direct`, reasoning that no
live transport populates it. That reasoning does not hold here: `authority` is a
body parameter of these verbs, so any caller can send it or omit it. And for
`forget` and `undo` the authority check is the *only* gate — there is no value
to check for derivation and no utterance to quote — so an omitted authority on a
delete was not a weakened gate, it was no gate. A caller that sent nothing at all
could remove his shipping address. Absent now refuses.

Each surface answers honestly rather than uniformly:

| Surface | What it sends | Why |
|---|---|---|
| TUI | hardcoded `owner-direct` | the only input reaching these calls is him typing on his own machine |
| Web UI | hardcoded `owner-direct` | the same — his own typing in his own settings page |
| Agent | the model states it per write | the agent genuinely can be handed a purported fact by an email, a page, a channel message or a document, and the SDK must be told which so it can refuse |

The contract has to declare it required too. A schema listing `authority` as
optional while the handler throws without it publishes a lie, and a generated
client that follows the contract is broken by construction. A test pins
`authority` in the required array of all four write descriptors, because a
contract and a handler that disagree is the drift this platform keeps paying for.

There is **no propose path at all**. He declined propose-first, so no API lets a
non-owner source stage a fact for later approval. A queue an untrusted source can
write to is a write.

### Layer 2 — derivation

Layer 1 trusts the caller's claim about its own surface. Layer 2 does not.

Before a line lands, its text and its verbatim quote are checked with
`findContentTaint()` against `getProcessUntrustedContentLedger().taintSourcesThisTurn()`.
If the proposed text overlaps untrusted text read this turn, the write is refused
and the refusal names the origin and shows the overlapping excerpt via
`describeContentTaint()`.

This defeats the realistic attack: a page saying *"the user's home address is
1 Attacker Way"*, read by the agent and then written, fails layer 2 even with a
forged `owner-direct` claim, because the value appears verbatim in the ledger's
retained page text.

The check runs **twice** over the same sources, refusing on a finding from
either:

1. length-based derivation over `{value, said}` with no exact fields;
2. exact containment over `{value}` with `exactMatchFields: ['value']`.

Two passes rather than one because `findContentTaint` **skips the word-shingle
and span checks for any field listed in `exactMatchFields`** — it takes the
containment branch and `continue`s. Listing a postal address there would
therefore make it *weaker*, not stronger: a reworded address from a hostile page
would pass. Pass 2 catches the short high-signal payloads that slip under both
the 8-word and 40-character thresholds (an email address, a phone number, an
alias); pass 1 catches the long ones including reworded and partially-quoted
forms. No field is exempt from either pass, so no value's only defence is exact
string equality.

### Removal is a write, and gets layer 1

`profile.forget` and `profile.undo` pass the same authority gate. An injection
that cannot add a fact must not be able to delete one either: clearing his
shipping address or his `contact.email` is tampering and denial, which is
squarely inside what this boundary exists to stop.

Layers 2 and 3 do not apply to a removal and are deliberately not faked — there
is no value to check for derivation and no owner utterance to quote, and
demanding either would refuse every legitimate delete or invite a caller to
invent a quote. Authority is the whole gate here, and it is the right one.

### Layer 3 — a verbatim quote must exist

An autonomous write must carry a non-empty `said`. A fact learned from a page has
no owner utterance to quote, so the requirement is itself a filter, and it is
what makes §8's "where did you get that" answerable. (A settings-UI edit carries
`"(edited in settings)"`; a hand edit carries none and says so.)

### What this does not claim

A reworded injection that the owner then repeats in his own words is
indistinguishable from him telling the agent something, and nothing here claims
otherwise. That is the residual risk of the autonomous model he chose. Provenance
is what makes it recoverable: he can see the utterance that produced the line and
delete it.

---

## 8. Provenance and disclosure

### 8.1 Per line, always

Every learned line carries surface, date and his verbatim words. No write path
omits it (§7 layer 3). A line without a suffix is one he wrote or edited by hand,
and that is reported as such rather than dressed up as a recorded source.

This is the load-bearing safeguard. Autonomous writes without it are
undebuggable: he cannot tell why it thinks his office is somewhere it is not.

### 8.2 Disclosure on write

When it records something autonomously it says so in the reply, in one line:

> Noted — saved your office address to your profile.

**One line, naming what was recorded, not quoting the value back** unless he
asked. Several facts in one turn collapse into one line. It is a receipt, not a
confirmation prompt — he declined confirmation prompts.
`describeProfileWrite(changes)` in the SDK produces the string so all three
surfaces say the same thing.

### 8.3 The three questions, on every surface

| He asks | Verb | Answer |
|---|---|---|
| "what do you know about me?" | `profile.read` | the whole document, by section |
| "where did you get that?" | `profile.provenance` | surface, date, verbatim, and superseded predecessors |
| "forget that" | `profile.forget` | deletes the line; confirms what went |

All three are control-plane verbs (§11) surfaced in the TUI, the agent and the
webui, so none is a single-surface capability.

---

## 9. Correction, forgetting, and what was dropped

### 9.1 Superseding

Setting a mechanical field that already has a value rewrites its line and moves
the old one into an HTML comment directly below the section:

```markdown
<!-- was: shipping address: 401 Home St, … — tui, 2026-07-20, "ship to 401 Home St" (superseded 2026-07-27) -->
```

Invisible in rendered Markdown, plain text in the file, deletable by hand.
`profile.provenance` reads them; `profile.undo` promotes the most recent one back
— so a wrong correction is recoverable. Prose bullets are not superseded; a new
bullet is a new bullet, and he removes the old one if he wants it gone.

### 9.2 Deleting

`profile.forget` removes the line **and every `<!-- was: … -->` comment for that
field**, then writes atomically. No tombstone, no `deleted:true` flag, no
retention window. This follows
`docs/decisions/2026-07-06-delete-means-delete.md`: a delete that leaves the
record on disk is exactly the dishonesty that decision removed. The response says
`deleted: true` and names what went. Forgetting something that was not there
reports that it was not there — it does not report success.

**A prose line is addressed by its content, never by its position.**
`profile.forget` takes either a `fieldId`, for a mechanical field, or a
`section` plus the `text` of the line, for a note, a person, a place or a work
entry. It does **not** take a raw line index, and `lineIndex` is not a parameter
of any verb.

The reason is §3: the owner is a concurrent writer. A line index is only valid
against the exact file state that produced it, and between his `profile.read`
and his `profile.forget` he can add a line in his editor and shift everything
below it. Positional addressing would then delete the wrong line and report
success — the same class of false receipt that §9.2 exists to prevent, arriving
through the front door. It is not theoretical: a review reproduced a raw index
of `NaN` deleting his title, `4.9` deleting a currency line, and `2` deleting a
`## Commerce` heading while reporting "removed a note", orphaning every field
under it.

Content addressing degrades honestly. If the text no longer matches, nothing is
deleted and the answer is "that is not there any more" — which is true, and
which tells him his file changed. "Forget that" has to mean forget *that*,
identified by what it says.

**The list marker is syntax, not content, and is normalised on both sides.**
`ProfileLine.text` keeps the leading `- `, so a naive `text.trim() === wanted`
requires a caller to pass `- Allergic to shellfish` and finds nothing for
`Allergic to shellfish`. That is the wrong boundary: the owner says "forget that
I'm allergic to shellfish", and the marker is a markdown artefact he never
uttered. The matcher strips a leading list marker (`-`, `*`, `+`, or an ordered
`1.`) from the stored line and from the wanted text before comparing, so both
forms find the same line. Nothing else changes, and it cannot widen a match into
the wrong line, because ambiguity is already refused.

**Two lines reading identically are refused, never guessed.** The answer names
how many matched and the file is untouched. Deleting the wrong one of two
identical lines is unrecoverable; asking is not, and it is not a burden because
the disambiguating information — which one he meant — is only in his head.

`ProfileLine.lineIndex` (§5.1) stays, because the writer needs it to splice. It
describes the **in-memory model**, not the reachable surface: the model is
positional because a text file is, and the verbs are content-addressed because
the owner is not holding the file still.

### 9.3 Editing

`profile.set` from a settings UI is a supersede with `surface` = the editing
surface and `said` = `(edited in settings)`. Editing the file by hand needs no
verb and is authoritative (§4.5).

### 9.4 Dropped: bounding, periodic sweeping, GC

The original brief asked for the full recovery-rule treatment: bounded, validated
on load, swept periodically, discloses what it holds.

**Validate-on-load is kept** (§4.4) and **disclosure of what it holds is kept**
(§8.3 — `profile.read` is exactly that).

**Bounding and periodic sweeping are dropped, deliberately.** The recovery rule
exists for state a machine accumulates faster than a person inspects it; the
reaper protects the owner from the machine. This file is the owner's own notes,
which he opens and edits. If it grows large that is his content, and a sweeper
that truncated his own notes to satisfy a size budget would be a worse outcome
than the size. Retained `<!-- was: -->` history is likewise his, and it is what
makes undo work.

Two limits survive and neither is a reaper: a machine-written line is capped at
4096 characters and a machine-written value at 2000, enforced **on write only**,
so an autonomous write cannot produce a line no human can read. A hand-written
line of any length is accepted on load.

---

## 10. Third-party personal data

The `People` section holds facts about people who never agreed to be in a
database. It gets the same containment as card material.

- Never written to logs, at any level, including debug.
- Never in exports, diagnostics or support bundles.
- Never in telemetry.

**This is absolute, and it overrides the redaction distinctiveness floor.**
`redaction.ts` skips values under a length threshold and without a digit, `@` or
internal whitespace, because turning `standard` or `imperial` into a redaction
pattern would blank those words out of every unrelated log line — sound
reasoning, and it stays for ordinary values. But it conflicts with this section,
and the conflict was reproduced: `- Bob Lee` is seven characters and left an
export in the clear. The resolution is that `People` content is keyed on its
**section**, not on the shape of its value: it is redacted regardless of length,
while the floor keeps protecting ordinary words everywhere else. An earlier
draft of this document asserted the absolute rule without acknowledging the
trade, which is how the code came to implement the floor faithfully and breach
the rule.
- Never injected into model context (§11.2 — closed tier).
- Never volunteered in outbound content unless the task genuinely needs it.

### What "needs it" means

Not "the model judged it relevant" — that is not a boundary, because the model's
judgement is the thing an injection attacks. The rule is structural:

> A `People` line may appear in outbound content **only** when the owner named
> that person in the instruction for the current turn, and a consumer called
> `profile.person(name)` with a name taken from that instruction.

"Email my sister the tickets" reaches for Sarah because he said "my sister".
"Email the vendor and cc anyone relevant" reaches for nothing, because he named
nobody. The lookup is by name and the name comes from him, this turn. **There is
no enumerate-all-people call available to a composition path**: `profile.person`
takes a name, and `profile.read` — which returns everything — is not callable
from a composition path at all.

**The name is flat on purpose.** It was briefly `read:profile.full`, which was
the only dotted scope in the entire platform and invented a hierarchy the
matcher does not implement: `scopeMatches` grants on an exact match, on `*`, or
on a `prefix:*` wildcard, and nothing else. So `.full` read as "profile, but
more" while giving its holder *no* access to the plain `read:profile` verbs — a
token minted with what looked like the superset would have taken 403s on
`profile.get`, `profile.person`, `profile.provenance` and `profile.status`.
Today that is masked, because `getGrantedGatewayScopes` unions every scope the
catalog declares and real tokens hold both; it would have surfaced the first
time a caller passed an explicit list to `gateway.ts`, which accepts one. Two
flat unrelated names make the two capabilities what they actually are, and a
caller wanting both lists both.

**`profile.read` carries its own scope, `read:profile-document`.** Every other read
verb is `read:profile`. This is what stops "not callable from a composition path"
being a sentence in a document that no mechanism keeps: a caller holding
`read:profile` can ask `profile.get` for one field and `profile.person` for one
named person, and **cannot** enumerate the document. Enumerating it — which is
what answering "what do you know about me" means — needs a scope that only the
owner-facing path is issued. Same-scope-as-everything-else was the earlier state,
and it made the guarantee depend on nobody thinking to call the verb.

For that guarantee to be structural rather than a comment, the store's generic
`section(name)` accessor **refuses the closed-tier prose sections**. `People` is
reachable two ways and only two: `person(name)`, which requires a name, and
`read()`, which returns the whole document and exists to answer him about
himself. A generic section accessor that served `People` would be the
enumerate-all call this rule denies, arriving by another name.

Every `profile.person` read is disclosed in the reply in the same one-line form
as §8.2: *"Used Sarah's details from your profile."*

---

## 11. Access

### 11.1 Control-plane verbs

Modelled on `method-catalog-principals.ts` / `routes/principals.ts`.

| Verb | Scope | Purpose |
|---|---|---|
| `profile.read` | `read:profile-document` | the whole document, by section |
| `profile.get` | `read:profile` | one mechanical field |
| `profile.person` | `read:profile` | one person by name |
| `profile.provenance` | `read:profile` | provenance + `<!-- was: -->` predecessors |
| `profile.set` | `write:profile` | write/supersede (authority-gated, §7) |
| `profile.append` | `write:profile` | add a prose bullet to a section |
| `profile.forget` | `write:profile` | delete a line (§9.2) |
| `profile.undo` | `write:profile` | promote the most recent superseded value |
| `profile.status` | `read:profile` | loaded/unavailable + reason, counts, invalid fields, path |

`profile.set`, `profile.append` and `profile.forget` also call
`refuseNonUserRequest()` (`routes/explicit-user-request.ts`), so a caller
declaring itself not a user request is refused before the authority check.

#### The contract does not protect callers, and that is not a profile bug

Two changes on this feature — `authority` becoming required, then `forget`
becoming content-addressed — were **breaking changes to consumers that no
compiler caught**. Both times a surface kept sending the old body and compiled
clean. That is worth writing down here because the profile verbs are where it was
found, but the cause is platform-wide and the fix is not this round's to make
unilaterally.

The SDK's *typed* overload is correct:

```ts
invoke<TMethodId extends OperatorTypedMethodId>(
  methodId: TMethodId,
  ...args: KnownMethodArgs<TMethodId>   // = MethodArgs<OperatorMethodInput<TMethodId>, …>
): Promise<OperatorMethodOutput<TMethodId>>;
```

The escape is the overload beneath it:

```ts
invoke<T = unknown>(methodId: string, input?: Record<string, unknown>, …): Promise<T>;
```

A *known* method id carrying a *wrong* body fails the typed overload and then
silently matches the loose one, because `Record<string, unknown>` accepts
anything. So the type system reports success on exactly the case it exists to
catch. The surfaces then widen it further — the web UI declares
`TInput = OperatorMethodInput<TMethodId>` as a **default** rather than a
constraint, so inference from the argument discards it, and the agent casts
`payload as never` at the call site, opting out entirely.

**Ruling for this round:** close the local widening, and pin the payloads by
test. Each surface types its wrapper's input parameter as
`OperatorMethodInput<TMethodId>` directly instead of inferring it, drops the
`as never`, and carries a test asserting the body it sends conforms to the
declared input for that method. That catches this class today without touching a
published signature.

**Proposed platform change, for the owner to rule on, not adopted here:** make
`invoke` typed-only and move dynamic invocation to a separately named method, so
a known id can never fall through to the loose overload. That is a breaking
change to a published SDK surface affecting every operator method, and it should
be decided across the platform rather than by whichever feature happened to trip
over it.

### 11.2 Open tier vs closed tier — the outbound rule

**Profile content is never bulk-injected into model context.** That is what makes
requirement 7 structural rather than a hope: a composition path cannot leak his
home address, because the address was never in context to leak.

- **Open tier**, injected as a short system-context block because it is useless
  if it must be asked for and harmless in context: `identity.goesBy`,
  `identity.pronouns`, `location.city`, `location.timezone`, all `Preferences`
  fields, all `Style` content. Governed by `profile.injectOpenTier`, default on.
- **Closed tier**, reachable only by an explicit named call, every read
  disclosed: `identity.name`, all `Contact` fields, `location.homeAddress`, all
  `Commerce` fields, all `Contacting me` fields, `Defaults`, and the `People`,
  `Places`, `Work` and `Notes` sections entirely.

The block is rendered once by `renderOpenTierBlock(store)` and composed at two
seams, both of which build per-turn additions onto the base prompt **without
writing back** into any cached base string — an invariant their own comments
call out, because writing back compounds the block once per tool round:

| Seam | File |
|---|---|
| Main conversation | `platform/core/orchestrator-turn-loop.ts`, its local `composeTurnSystemPrompt` |
| Spawned agents | `platform/agents/orchestrator-runner.ts`, its local `composeTurnSystemPrompt` |

When the profile is disabled or unavailable the block is simply absent. It is
never replaced by a placeholder saying it could not be read — that would be
prompt noise on every turn for a condition the `profile.status` verb already
reports honestly.

`location.city` is open deliberately: the failure that prompted this work was the
agent guessing a metro area for a weather answer. `location.homeAddress` is
closed — a city is not a doorstep.

Stated for tests: **composing an outbound message must not cause any closed-tier
value to appear in that message unless a named accessor was called for it in the
same turn.**

### 11.3 Containment in logs, exports, diagnostics

- `platform/utils/redaction.ts` gains owner-profile awareness: closed-tier values
  present in the loaded profile are replaced with `[REDACTED_PROFILE]` by
  `redactSensitiveData()`, and object keys matching the profile-key pattern are
  redacted by `redactStructuredData()`.

  One change, four containment paths — verified call sites:

  | Path | Function | What it covers |
  |---|---|---|
  | `platform/export/session-export.ts` | both | markdown and JSON session exports |
  | `platform/runtime/at-rest-persistence.ts` | `redactSensitiveData` | what a turn writes to disk |
  | `platform/runtime/telemetry/api-helpers.ts` | `redactStructuredData` | telemetry payloads, attributes, span attributes |
  | `platform/utils/error-display.ts` | `redactSensitiveData` | `redactedErrorMessage`, so a thrown value carrying a profile string does not surface it |

  The profile store supplies its closed-tier values through a registered reader
  rather than an import, so `redaction.ts` keeps no dependency on the profile
  module and stays usable where no profile is loaded.
- The owner-profile module logs counts and field names, never values.
- `profile.status` — the diagnostic verb — returns load state, path, section
  names, line counts and the list of invalid mechanical fields with reasons. It
  never returns values.

---

## 12. Configuration and defaults

Config domain `profile.*`, daemon-owned (prefix added to
`DAEMON_OWNED_CONFIG_PREFIXES` in `config-ownership.ts`), schema in
`platform/config/schema-domain-owner-profile.ts`, exposed as real editable
settings in the TUI, the agent and the webui.

| Key | Default | Reasoning |
|---|---|---|
| `profile.enabled` | `true` | He asked for it built. Off by default ships it dark, and flags ship as features. |
| `profile.autonomousWrites` | `true` | His explicit ruling. Off leaves reads and manual edits working — the honest "I'll curate this myself" mode. |
| `profile.discloseWrites` | `true` | The condition attached to his choice. Editable because he may find the receipts noisy, but he turns them off himself, knowingly. |
| `profile.injectOpenTier` | `true` | Otherwise the agent still guesses a metro area, which is the failure that started this. |
| `profile.discloseClosedTierReads` | `true` | Using his address on an order should be visible. |
| `profile.consumerFallback` | `true` | Whether unset consumer config keys fall back to the profile (§13). On, because a profile nothing reads is a diary. |
| `profile.reloadThrottleMs` | `2000` | Only used where `fs.watch` is unavailable; under human edit-then-check latency and off the read path. |
| `profile.path` | `""` | Empty means §3's default path; an override for a non-default daemon home. |

`profile.enabled = false` means the file is not loaded and every verb answers
"profile is disabled" — a stated state, not an empty profile.

### 12.1 Registering the section in each surface

All three surfaces bucket settings automatically by `key.split('.')[0]`, so the
`profile.*` keys need no per-key registration. But in the TUI and the agent a
prefix with no matching category is **silently dropped** — `buildSettingGroups`
guards every push with `if (groups.has(cat))`, and the file's own comments record
two past cases (`push.*`, `cluster.*`) where a domain vanished from the
workspace and was reachable only by hand-editing a settings file.

So the registration is mandatory, not cosmetic:

| Surface | Required change |
|---|---|
| TUI | add `'profile'` to `SettingsCategory` and to a `SETTINGS_CATEGORY_GROUPS` group in `src/input/settings-modal-types.ts` |
| Agent | the same two edits in its own `src/input/settings-modal-types.ts` |
| Webui | regenerate `src/lib/generated/config-schema.ts` from the SDK; add `CATEGORY_LABELS['profile']` in `src/lib/config-redaction.ts` for the display name |

The webui derives its groups with no hand-maintained category list, so it cannot
drop the domain — but without the label entry the group renders as a Title-Cased
key rather than a name.

---

## 13. Consumers

Every place that holds or guesses a fact about the owner reads it from here
instead of keeping a private copy.

### 13.1 The mechanism: config fallback, not call-site edits

`platform/owner-profile/consumers.ts` declares one map from consumer config key
to profile field, and installs it as a **read fallback** in the `ConfigManager`:
an explicitly configured value still wins; the profile fills the gap where the
key is unset.

That direction matters. A profile that overrode a value he deliberately
configured would be the drift class in reverse.

**The fallback applies in `ConfigManager.get()` only, never in a bulk listing or
export path.** `get()` is a single keyed read by a consumer that needs the value
to do its job. A config dump is a different act: it hands the whole settings
surface to a caller, and if the fallback applied there, `commerce.shippingAddress`
would appear in a config listing without passing the closed-tier disclosure rule
of §11.2. So a bulk read sees the raw stored value — unset — and the profile
value reaches only the consumer that asked for that one key. A listing may show
*that* a key resolves from the profile; it does not show the value.

It is a fallback rather than a set of call-site edits for a practical reason as
well: the payments capability and `daemon.timezone` live on an unmerged branch
(`wo/payments-spec`) that a live round owns. Editing that branch from here would
collide with it. A declared fallback map keyed by config path wires those
consumers the moment their keys exist, with no change to their code and no
contention over their files.

**"Inert until the key exists" is true of the `payments.*` rows and false of
`daemon.timezone`, and the difference is worth stating precisely** because an
earlier version of this section got it wrong. `ConfigManager.resolvePath()` walks
only as far as the *parent* section and then reads the field off it. So
`payments.currency` throws — there is no `payments` section on this branch — and
the fallback catches that and stays dormant. But `daemon.timezone` resolves
today: the `daemon` section exists for other reasons, the field is simply unset,
and an unset field is exactly what the fallback is for. It is live now, not
waiting on a merge. Both behaviours are correct and both are pinned by tests; it
was the description that was wrong.

| Consumer config key | Profile field | Status |
|---|---|---|
| `daemon.timezone` | `location.timezone` | **live now** — the `daemon` section exists, the field is unset |
| `payments.billingAddress.*` | `commerce.billingAddress` (parsed to the 7 `PostalAddress` parts) | dormant — no `payments` section on this branch; activates on merge |
| `payments.shippingAddress.*` | `commerce.shippingAddress` (as above) | as above |
| `payments.currency` | `commerce.currency` | as above |
| `checkin.quietHours` | `contactMe.quietHours` | live now |
| `checkin.deliveryChannel` | `contactMe.channel` | live now |

### 13.2 Direct consumers

- **`platform/google/account-registry.ts`** — supplies `baseAddress` to
  `signup-address.ts`'s alias minting, which is documented as *"the owner's real
  delivery address this alias resolves to."* It falls back to `contact.email`
  when no mail account is configured. `signup-address.ts` itself is unchanged;
  it is alias-minting machinery, not a store of owner facts.
- **Locality / weather.** There is no location-guessing code to replace — the
  agent guessed a metro area because nothing told it one. The fix is the
  open-tier injection of `location.city` and `location.timezone` (§11.2), so the
  model has the answer instead of inferring it.

### 13.3 Deliberately not wired: `security/owner-identity.ts`

`resolveOwnerAddresses()` reads five config keys to decide which addresses are
"the owner's own", and that set gates the one exemption to the content-taint rule
— a send addressed only to the owner. It is **not** fed from the profile.

Its own module header says the exemption is safe because spoofing it requires an
authenticated write to daemon config, which is a strictly stronger capability
than sending mail. A profile written autonomously from conversation is a weaker
input than daemon config, and routing it into a security gate would lower that
bar. The profile's `contact.email` serves ordinary consumers; the taint
exemption keeps reading configuration only. Recorded here as a decision, not an
oversight.

---

## 14. Test plan

Each test is verified to fail without its fix, and both counts are reported.

| # | Test | Asserts |
|---|---|---|
| 1 | untrusted authority refused | `profile.set`/`append` with `web-page`, `email`, `channel-message`, `document` authority is refused; the file is byte-identical after |
| 2 | untrusted derivation refused | a page is ingested into the ledger, then an `owner-direct`-claimed write whose value appears in that page is refused, naming the origin and excerpt |
| 3 | no propose path | no exported API accepts a non-`owner-direct` authority for any write or staging operation |
| 4 | provenance recorded | a written line round-trips surface, date and verbatim through the file |
| 5 | provenance retrievable | `profile.provenance` returns the suffix plus every `<!-- was: -->` predecessor |
| 6 | disclosure fires | an autonomous write returns a non-empty one-line disclosure naming the field |
| 7 | deletion deletes | after `profile.forget` the value is absent from memory **and** from the file bytes, including its `<!-- was: -->` comments |
| 8 | supersede keeps history | after a correction the old value is present as a `<!-- was: -->` comment and `profile.undo` restores it |
| 9 | not in logs | a captured logger across read/write/delete contains no profile value |
| 10 | not in exports | a session export containing a profile value redacts it |
| 11 | not in diagnostics | `profile.status` returns counts, names and invalid-field reasons, no values |
| 12 | not injected outbound | an outbound composition with no named accessor call contains no closed-tier value |
| 13 | unreadable degrades loudly | a non-UTF-8 file yields "profile unavailable" with the reason; an empty profile is never returned in its place |
| 14 | odd content preserved | unknown headings, unknown `key:` lines, tables, code fences and nested lists survive a write to another section byte-for-byte |
| 15 | hand edit authoritative | an externally edited/deleted line is served as edited and never restored |
| 16 | hand edit picked up | an external modification is reflected without a restart |
| 17 | atomic write | an interrupted write leaves the previous complete file |
| 18 | invalid mechanical value | `timezone: Mars/Olympus` is preserved, reported invalid with a reason, and its consumer falls back |
| 19 | third-party containment | `People` content is absent from context, exports and logs; `profile.person` requires a name; and no exported store method other than `read()` returns the whole `People` section — `section('People')` refuses |
| 20 | consumer fallback direction | an explicitly configured `checkin.quietHours` beats the profile; an unset one reads from the profile |
| 21 | read latency | benchmark; measured nanoseconds reported |
| 22 | removal is gated | `forget` and `undo` from each untrusted authority are refused and the file is byte-identical after |
| 23 | watcher survives rename | after two atomic writes, an external edit is still observed (fails against a file-level `fs.watch`) |
