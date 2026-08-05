/**
 * grammar.ts — the one line format for an occasion and for a plan.
 *
 * An occasion is a PROSE LINE in the owner's profile, under `## Important dates`.
 * It is not a mechanical field, and that is structural rather than incidental:
 * the field registry maps one section-plus-label to one value, so it can hold
 * `commerce.shippingAddress` and cannot hold twenty birthdays. Occasions are a
 * repeated record, so they are prose to the profile parser — preserved verbatim,
 * never rewritten by it — and typed here, by a reader layered on top.
 *
 * That layering is what keeps the profile's guarantee intact. Nothing in this
 * file edits a line; it reads one and reports what it found, including what it
 * could not make sense of. A line this parser dislikes is still his line.
 *
 * ── The format ────────────────────────────────────────────────────────────
 *
 * ```
 * - Sarah's birthday · 03-14 · annual · gift-giving · for Sarah · lead 21
 * - Dad · 11-02 · annual · remember-only
 * - Our anniversary · 2015-09-12 · annual · gift-giving · for Jane
 * - My birthday · 08-06 · annual · remember-only · for me
 * ```
 *
 * `for me` — and a bare `mine`, `myself` or `self` — says the occasion is about
 * the OWNER. It is the one attribution the parser can settle by itself, and it
 * matters because something he only has to remember about himself is something
 * he already knows: see subject.ts. Every other attribution is reported as
 * written and resolved by the reader, which can see what he calls himself.
 *
 * Segments after the title are classified BY SHAPE rather than by position, so
 * he can write them in whatever order he thinks of them and a line stays valid
 * when he adds one later. Anything unrecognised is kept in `extras` and written
 * back unchanged — dropping a segment because this module did not know it would
 * be the profile's cardinal sin arriving by a side door.
 *
 * `·` is the canonical separator and `|` is accepted because a middot is
 * awkward to type on most keyboards; the renderer always emits `·`. Two
 * separators is the whole leniency, and both are characters that essentially
 * never occur inside a birthday's name.
 */
import { normalizeProfileKey } from '../owner-profile/fields.js';
import {
  isIsoDate,
  parseOccasionDate,
  renderOccasionDate,
  type OccasionDate,
  type OccasionRecurrence,
} from './dates.js';
import { isSelfAttribution } from './subject.js';
import {
  isOccasionKind,
  type Occasion,
  type OccasionKind,
  type Plan,
  type UnparsedOccasionLine,
  type UnparsedPlanLine,
} from './types.js';

/** The separator the renderer writes. */
export const OCCASION_SEPARATOR = '·';

/** Separators the parser accepts, canonical first. */
const SEPARATORS = [OCCASION_SEPARATOR, '|'] as const;

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const LEAD = /^lead\s+(\d{1,4})(?:\s+days?)?$/i;
const FOR = /^for\s+(.+)$/i;
const IN = /^in\s+(.+)$/i;
const RANGE = /^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to|–|—)\s*(\d{4}-\d{2}-\d{2})$/i;

/** Strip the Markdown list marker; the `- ` is syntax, not content. */
export function withoutListMarker(text: string): string {
  return text.replace(LIST_MARKER, '').trim();
}

/** Split a line into its title and its attribute segments. */
export function splitSegments(text: string): { title: string; segments: readonly string[] } {
  const body = withoutListMarker(text);
  const separator = SEPARATORS.find((candidate) => body.includes(candidate));
  if (separator === undefined) return { title: body.trim(), segments: [] };
  const parts = body.split(separator).map((part) => part.trim());
  return { title: (parts[0] ?? '').trim(), segments: parts.slice(1).filter((part) => part.length > 0) };
}

/** The stable id of an occasion or plan: its title, normalised. */
export function occasionIdFor(title: string): string {
  return normalizeProfileKey(title);
}

/** A recognised kind word, including the shorthands worth accepting. */
function readKind(segment: string): OccasionKind | null {
  const value = segment.trim().toLowerCase();
  if (isOccasionKind(value)) return value;
  if (value === 'gift') return 'gift-giving';
  if (value === 'remember') return 'remember-only';
  if (value === 'none') return 'neither';
  return null;
}

function readRecurrence(segment: string): OccasionRecurrence | null {
  const value = segment.trim().toLowerCase();
  if (value === 'annual' || value === 'annually' || value === 'yearly') return 'annual';
  if (value === 'once' || value === 'one-off' || value === 'oneoff') return 'once';
  return null;
}

/** What one line under the dates heading turned out to be. */
export type OccasionLineResult =
  | { readonly ok: true; readonly occasion: Occasion }
  | { readonly ok: false; readonly unparsed: UnparsedOccasionLine };

/**
 * Read one occasion line.
 *
 * Two refusals are deliberate and are the reason this returns a reason rather
 * than `null`:
 *
 *  - **No date.** There is nothing to approach, so there is nothing to raise.
 *  - **No kind.** The kind is his choice, made at capture, and is never
 *    inferred. A line without one is recorded and answerable — he can still ask
 *    when the date is — and is never raised, because guessing whether a date
 *    wants a cheerful gift prompt is exactly the guess that gets a death
 *    anniversary wrong.
 */
export function parseOccasionLine(lineIndex: number, text: string): OccasionLineResult {
  const { title, segments } = splitSegments(text);
  if (title.length === 0) {
    return unparsedOccasion(lineIndex, text, 'the line has no title, so there is nothing to name');
  }

  let date: OccasionDate | null = null;
  let recurrence: OccasionRecurrence | null = null;
  let kind: OccasionKind | null = null;
  let person = '';
  let selfDeclared = false;
  let leadDays: number | null = null;
  let mirrored = false;
  const extras: string[] = [];

  for (const segment of segments) {
    const parsedDate: OccasionDate | null = date === null ? parseOccasionDate(segment) : null;
    if (parsedDate !== null) {
      date = parsedDate;
      continue;
    }
    const parsedRecurrence = readRecurrence(segment);
    if (parsedRecurrence !== null) {
      recurrence = parsedRecurrence;
      continue;
    }
    const parsedKind = readKind(segment);
    if (parsedKind !== null) {
      kind = parsedKind;
      continue;
    }
    const lead = LEAD.exec(segment);
    if (lead !== null) {
      leadDays = Number(lead[1]);
      continue;
    }
    // `for me` and a bare `mine` both say the occasion is about HIM. Checked
    // before the general `for <name>` branch so "me" never lands in `person`
    // as if it were somebody's name.
    if (isSelfAttribution(segment)) {
      selfDeclared = true;
      continue;
    }
    const who = FOR.exec(segment);
    if (who !== null) {
      const named = (who[1] ?? '').trim();
      if (isSelfAttribution(named)) {
        selfDeclared = true;
        continue;
      }
      person = named;
      continue;
    }
    if (segment.trim().toLowerCase() === 'mirrored') {
      mirrored = true;
      continue;
    }
    extras.push(segment);
  }

  if (date === null) {
    return unparsedOccasion(
      lineIndex,
      text,
      'no date on the line, so there is nothing to count down to — write it as MM-DD or YYYY-MM-DD',
    );
  }
  if (kind === null) {
    return unparsedOccasion(
      lineIndex,
      text,
      'no kind on the line. Add gift-giving, remember-only or neither — nothing is inferred, '
      + 'so until it is there this date is kept and answerable but never raised on its own',
    );
  }

  return {
    ok: true,
    occasion: {
      id: occasionIdFor(title),
      title,
      date,
      // A bare `YYYY-MM-DD` with no recurrence word is a single dated thing; a
      // bare `MM-DD` has no year and can only mean every year.
      recurrence: recurrence ?? (date.kind === 'dated' ? 'once' : 'annual'),
      kind,
      person,
      selfDeclared,
      // The parser reads ONE LINE and has never seen the Identity section, so
      // it cannot know whether "Mike" is him. It reports what the line says and
      // leaves the conclusion to `readOccasions`, which has his declared names.
      // Unattributed is the safe default: it behaves exactly as before.
      subject: selfDeclared ? 'owner' : 'unattributed',
      leadDays,
      mirrored,
      extras,
      lineIndex,
      text: withoutListMarker(text),
    },
  };
}

function unparsedOccasion(lineIndex: number, text: string, reason: string): OccasionLineResult {
  return { ok: false, unparsed: { lineIndex, text: withoutListMarker(text), reason } };
}

/**
 * Render an occasion back to a line, WITHOUT its list marker or provenance.
 *
 * The caller supplies both — `appendProse` writes the marker and the store
 * writes the provenance suffix — so nothing here can produce a line that
 * bypasses the profile's write path.
 */
export function renderOccasionLine(occasion: Occasion): string {
  const parts = [
    occasion.title,
    renderOccasionDate(occasion.date),
    occasion.recurrence,
    occasion.kind,
  ];
  if (occasion.selfDeclared) parts.push('for me');
  else if (occasion.person.length > 0) parts.push(`for ${occasion.person}`);
  if (occasion.leadDays !== null) parts.push(`lead ${occasion.leadDays}`);
  if (occasion.mirrored) parts.push('mirrored');
  parts.push(...occasion.extras);
  return parts.join(` ${OCCASION_SEPARATOR} `);
}

export type PlanLineResult =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly unparsed: UnparsedPlanLine };

/**
 * Read one plan line.
 *
 * ```
 * - Lisbon · 2026-09-12..2026-09-19 · away · in Lisbon
 * ```
 *
 * A plan needs a range and nothing else. `away` is opt-in rather than assumed:
 * a plan can be "the kitchen is being redone, 3rd to the 10th", which is a real
 * dated range he wants known and is not him leaving the house.
 */
export function parsePlanLine(lineIndex: number, text: string): PlanLineResult {
  const { title, segments } = splitSegments(text);
  if (title.length === 0) {
    return { ok: false, unparsed: { lineIndex, text: withoutListMarker(text), reason: 'the line has no title' } };
  }

  let from = '';
  let to = '';
  let away = false;
  let destination = '';
  const extras: string[] = [];

  for (const segment of segments) {
    const range = from.length === 0 ? RANGE.exec(segment) : null;
    if (range !== null) {
      const start = range[1] ?? '';
      const end = range[2] ?? '';
      if (isIsoDate(start) && isIsoDate(end)) {
        from = start;
        to = end;
        continue;
      }
    }
    if (segment.trim().toLowerCase() === 'away') {
      away = true;
      continue;
    }
    const where = IN.exec(segment);
    if (where !== null) {
      destination = (where[1] ?? '').trim();
      continue;
    }
    extras.push(segment);
  }

  if (from.length === 0) {
    return {
      ok: false,
      unparsed: {
        lineIndex,
        text: withoutListMarker(text),
        reason: 'no dated range on the line — write it as YYYY-MM-DD..YYYY-MM-DD',
      },
    };
  }
  // A range written backwards is his typo, not a reason to drop the line. It is
  // ordered so nothing downstream has to ask which end is which.
  const ordered = from <= to ? { from, to } : { from: to, to: from };

  return {
    ok: true,
    plan: {
      id: occasionIdFor(title),
      title,
      from: ordered.from,
      to: ordered.to,
      away,
      destination,
      extras,
      lineIndex,
      text: withoutListMarker(text),
    },
  };
}

/**
 * Make one free-text detail safe to carry as a segment on a plan line.
 *
 * A plan's details — a confirmation number, a flight and its times, who is
 * travelling, why he is going — are the reason he pasted the itinerary, so they
 * are kept verbatim wherever verbatim is possible. Three things would corrupt
 * the line if they went through untouched, and each is handled rather than
 * refused:
 *
 *  - A separator character inside the text would split one detail into two.
 *    Both accepted separators are replaced with a hyphen.
 *  - A newline would end the line early. All whitespace collapses to spaces.
 *  - A detail that happens to READ like structure — a bare `away`, an `in X`,
 *    or a `YYYY-MM-DD..YYYY-MM-DD` range — would be parsed back as the plan's
 *    own attributes and silently change the record. Those are prefixed with
 *    `note`, which parses back as an ordinary detail.
 *
 * Returns an empty string for a detail that was only whitespace; the caller
 * drops those rather than writing a bare separator.
 */
export function normalizePlanDetail(detail: string): string {
  const flattened = detail
    .replace(/[·|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length === 0) return '';
  const readsAsStructure = flattened.toLowerCase() === 'away'
    || IN.test(flattened)
    || RANGE.test(flattened);
  return readsAsStructure ? `note ${flattened}` : flattened;
}

/** Render a plan back to a line, without its marker or provenance. */
export function renderPlanLine(plan: Plan): string {
  const parts = [plan.title, `${plan.from}..${plan.to}`];
  if (plan.away) parts.push('away');
  if (plan.destination.length > 0) parts.push(`in ${plan.destination}`);
  parts.push(...plan.extras);
  return parts.join(` ${OCCASION_SEPARATOR} `);
}
