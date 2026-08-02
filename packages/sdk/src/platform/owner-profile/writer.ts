/**
 * writer.ts — surgical line edits, never a re-serialisation.
 *
 * This is the file that makes "his edits are authoritative" true rather than
 * aspirational. Every operation here computes a small set of index-addressed
 * edits against the RAW LINE ARRAY and leaves every other line byte-identical.
 * Nothing is ever regenerated from the projection, so the writer cannot
 * normalise his prose, re-order his sections, re-wrap his lines, convert a
 * bullet to a field, or reformat a table it did not understand — not because it
 * chooses not to, but because it never holds a rendering of the whole document.
 *
 * The projection is read-only input: it says WHERE things are. Edits are
 * computed in the original index space and applied from the highest index down,
 * so an insertion never invalidates an index computed before it.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
  PROVENANCE_MARKER,
  findProfileSection,
  findProfileSectionByHeading,
  joinProfileLines,
  parseFieldLine,
  renderProvenanceSuffix,
  renderWasComment,
  splitProvenanceSuffix,
} from './document.js';
import {
  canonicalProfileSection,
  normalizeProfileKey,
  profileFieldById,
  unknownProfileFieldMessage,
  type ProfileSectionName,
} from './fields.js';
import type {
  ProfileChange,
  ProfileProjection,
  ProfileProvenance,
  ProfileSection,
  ProfileSupersededLine,
} from './types.js';

/** Longest line a MACHINE may write. A hand-written line of any length loads fine. */
export const MAX_MACHINE_LINE_CHARS = 4096;

/** Longest value a MACHINE may write. Same asymmetry, same reason. */
export const MAX_MACHINE_VALUE_CHARS = 2000;

/** The outcome of one edit: new lines plus what changed, or a refusal. */
export interface ProfileEditResult {
  readonly ok: boolean;
  readonly reason: string | null;
  /** The new raw line array. Identical to the input when `ok` is false. */
  readonly lines: readonly string[];
  readonly changes: readonly ProfileChange[];
}

// ---------------------------------------------------------------------------
// Index-addressed edits
// ---------------------------------------------------------------------------

type LineEdit =
  | { readonly kind: 'replace'; readonly at: number; readonly line: string }
  | { readonly kind: 'remove'; readonly at: number }
  | { readonly kind: 'insert'; readonly at: number; readonly lines: readonly string[] };

/**
 * Apply edits from the highest index down.
 *
 * Descending order is what lets every index be computed against the ORIGINAL
 * array: an edit at a high index cannot move a line at a lower one. Doing it in
 * any other order requires tracking offsets, which is where this class of code
 * usually goes wrong.
 */
function applyLineEdits(lines: readonly string[], edits: readonly LineEdit[]): string[] {
  const next = [...lines];
  const ordered = [...edits].sort((a, b) => b.at - a.at);
  for (const edit of ordered) {
    if (edit.kind === 'replace') next[edit.at] = edit.line;
    else if (edit.kind === 'remove') next.splice(edit.at, 1);
    else next.splice(edit.at, 0, ...edit.lines);
  }
  return next;
}

/** Attach the document's line ending to a line this module authored. */
function withEol(line: string, eol: '\n' | '\r\n'): string {
  return eol === '\r\n' ? `${line}\r` : line;
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim().length === 0;
}

// ---------------------------------------------------------------------------
// Rendering, with the machine-write caps
// ---------------------------------------------------------------------------

/**
 * Collapse newlines to single spaces and drop a suffix already at the end.
 *
 * The strip is belt and braces against stacking: a caller handing back a value
 * it read off a line would otherwise produce a line with two provenance tails,
 * and the older one would sit inside the newer one's quote. Exactly one suffix
 * is removed — if he hand-typed something that looks like an old suffix, that is
 * his text and it stays.
 */
function sanitizeForLine(value: string): string {
  return splitProvenanceSuffix(value.replace(/[\r\n]+/g, ' ').trim()).text.trim();
}

function renderLine(prefix: string, value: string, provenance: ProfileProvenance | null): string {
  return `${prefix}${value}${provenance === null ? '' : renderProvenanceSuffix(provenance)}`;
}

/**
 * Make a verbatim quote safe to sit inside a provenance suffix.
 *
 * `said` is the field an injected instruction shapes most easily — it is
 * whatever the caller claims the owner uttered. A quote that itself ends in a
 * well-formed suffix wins on read, because `splitProvenanceSuffix` matches from
 * the RIGHT: the forged tail is further right than the one just appended. The
 * result is a line whose value is truncated at the forgery point and whose
 * provenance reports a surface and date nobody wrote. That is a provenance
 * FORGERY primitive, and provenance is the safeguard the autonomous model rests
 * on, so it has to be closed rather than narrowed.
 *
 * Trailing suffixes are stripped repeatedly, since stripping one can expose
 * another. The loop is bounded by the string shrinking each pass.
 */
function sanitizeSaid(said: string): string {
  let text = said.replace(/[\r\n]+/g, ' ').trim();
  for (let pass = 0; pass < 8; pass += 1) {
    const stripped = splitProvenanceSuffix(text).text.trim();
    if (stripped === text) break;
    text = stripped;
  }
  return text;
}

/**
 * Neutralise a quote that would still forge provenance after rendering.
 *
 * Stripping trailing suffixes cannot catch a suffix in the MIDDLE of a quote
 * that the closing `"` then completes. Rather than reason about that case, the
 * rendered line is checked: if reading it back does not return the provenance
 * just written, the marker inside the quote is downgraded to a plain hyphen so
 * no suffix can form. His words survive and stay readable; only the em dash
 * that would have been parsed as machinery changes.
 */
function renderVerifiedLine(
  prefix: string,
  value: string,
  provenance: ProfileProvenance | null,
): string {
  const line = renderLine(prefix, value, provenance);
  if (provenance === null) return line;
  const readBack = splitProvenanceSuffix(line).provenance;
  if (readBack !== null
    && readBack.surface === provenance.surface
    && readBack.date === provenance.date
    && readBack.said === provenance.said) {
    return line;
  }
  const defused = provenance.said.split(PROVENANCE_MARKER).join(' - ');
  return renderLine(prefix, value, { ...provenance, said: defused });
}

/**
 * Render a line under the machine-write caps.
 *
 * The value is capped first because it is the part with a stated limit; when the
 * whole line is still too long the QUOTE is shortened before the value, since a
 * truncated verbatim is a smaller loss than a truncated shipping address.
 */
function renderCappedLine(
  prefix: string,
  rawValue: string,
  provenance: ProfileProvenance | null,
): string {
  const value = sanitizeForLine(rawValue).slice(0, MAX_MACHINE_VALUE_CHARS);
  const said = provenance === null ? '' : sanitizeSaid(provenance.said);
  const full = provenance === null ? null : { ...provenance, said };
  let line = renderVerifiedLine(prefix, value, full);
  if (line.length <= MAX_MACHINE_LINE_CHARS) return line;

  if (full !== null) {
    const shorter = Math.max(0, said.length - (line.length - MAX_MACHINE_LINE_CHARS));
    line = renderVerifiedLine(prefix, value, { ...full, said: said.slice(0, shorter) });
    if (line.length <= MAX_MACHINE_LINE_CHARS) return line;
  }
  const trimmedValue = value.slice(0, Math.max(0, value.length - (line.length - MAX_MACHINE_LINE_CHARS)));
  line = renderLine(prefix, trimmedValue, full === null ? null : { ...full, said: '' });
  return line.length <= MAX_MACHINE_LINE_CHARS ? line : line.slice(0, MAX_MACHINE_LINE_CHARS);
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Every line index in a section this module recognises as machinery. */
function fieldLineIndexes(projection: ProfileProjection, section: ProfileSection): number[] {
  const indexes: number[] = [];
  for (const fieldId of section.fields) {
    const value = projection.fields.get(fieldId);
    if (value !== undefined) indexes.push(value.lineIndex);
  }
  return indexes;
}

/** Where a brand-new section goes: the end, keeping any trailing newline. */
function appendPosition(lines: readonly string[]): number {
  return lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Append `## <Section>` plus one line, with a blank line before it when needed. */
function appendNewSection(
  projection: ProfileProjection,
  canonical: ProfileSectionName,
  line: string,
): LineEdit {
  const at = appendPosition(projection.rawLines);
  const needsBlank = at > 0 && !isBlank(projection.rawLines[at - 1]);
  const eol = projection.eol;
  return {
    kind: 'insert',
    at,
    lines: [
      ...(needsBlank ? [withEol('', eol)] : []),
      withEol(`## ${canonical}`, eol),
      withEol('', eol),
      withEol(line, eol),
    ],
  };
}

/** Place a first field under a heading that has none yet. */
function insertUnderHeading(
  projection: ProfileProjection,
  section: ProfileSection,
  line: string,
): LineEdit {
  const eol = projection.eol;
  const after = section.headingLine + 1;
  if (isBlank(projection.rawLines[after]) && projection.rawLines[after] !== undefined) {
    return { kind: 'insert', at: Math.min(after + 1, projection.rawLines.length), lines: [withEol(line, eol)] };
  }
  return { kind: 'insert', at: after, lines: [withEol('', eol), withEol(line, eol)] };
}

/**
 * Where the `<!-- was: … -->` comment goes: below the section's field block.
 *
 * Grouped with any comments already there, and separated from the fields by the
 * blank line the document already has, so a section that has been corrected
 * several times reads as one block of history rather than a scatter.
 */
function insertWasComment(
  projection: ProfileProjection,
  section: ProfileSection,
  comment: string,
): LineEdit {
  const eol = projection.eol;
  const historyIndexes = section.superseded.map((entry) => entry.lineIndex);
  const anchors = [...fieldLineIndexes(projection, section), ...historyIndexes];
  const line = withEol(comment, eol);

  // `Math.max()` of nothing is -Infinity, which splices to index 0 and puts the
  // history comment above the document's title — outside any section, where it
  // is never re-tracked as history on reload. `provenance` then reports no
  // predecessor, `undo` says there is nothing to go back to, and `forget` leaves
  // the superseded value on disk permanently. A section with no fields and no
  // history has one honest anchor: its own heading.
  if (anchors.length === 0) return insertUnderHeading(projection, section, comment);
  const anchor = Math.max(...anchors);

  if (historyIndexes.includes(anchor)) {
    return { kind: 'insert', at: anchor + 1, lines: [line] };
  }
  if (anchor + 1 < projection.rawLines.length && isBlank(projection.rawLines[anchor + 1])) {
    return { kind: 'insert', at: anchor + 2, lines: [line, withEol('', eol)] };
  }
  return { kind: 'insert', at: anchor + 1, lines: [withEol('', eol), line] };
}

// ---------------------------------------------------------------------------
// setField
// ---------------------------------------------------------------------------

export interface SetFieldInput {
  readonly fieldId: string;
  readonly value: string;
  readonly provenance: ProfileProvenance | null;
  /** The date written into a `(superseded …)` marker; defaults to the provenance date. */
  readonly supersededOn?: string | undefined;
}

/**
 * Write a mechanical field.
 *
 * Existing field: its line is rewritten IN PLACE, keeping the label exactly as he
 * capitalised it, and the previous line — provenance suffix and all — moves into
 * a history comment. Missing field: one line is inserted into the field block.
 * Missing section: the canonical heading is appended at the end of the document,
 * because guessing which of his own headings he meant is worse than adding one.
 */
export function setField(projection: ProfileProjection, input: SetFieldInput): ProfileEditResult {
  const def = profileFieldById(input.fieldId);
  if (def === undefined) {
    return refuse(projection, unknownProfileFieldMessage(input.fieldId));
  }

  const existing = projection.fields.get(def.id);
  // Resolve to the section that ACTUALLY HOLDS the field when there is one.
  // `findProfileSection` returns the first heading matching the canonical name,
  // and a document with the heading twice can put the field under the second —
  // in which case the first is empty, its anchors are empty, and the history
  // comment lands nowhere useful.
  const section = existing === undefined
    ? findProfileSection(projection, def.section)
    : (sectionContaining(projection, existing.lineIndex) ?? findProfileSection(projection, def.section));
  const label = existing?.label ?? def.label;
  const line = renderCappedLine(`${label}: `, input.value, input.provenance);
  const change: ProfileChange = {
    kind: 'set',
    fieldId: def.id,
    section: section?.heading ?? def.section,
    label: def.label,
    superseded: existing !== undefined,
  };

  if (existing !== undefined && section !== undefined) {
    const previous = stripEol(projection.rawLines[existing.lineIndex] ?? '', projection.eol);
    const supersededOn = input.supersededOn ?? input.provenance?.date ?? todayIso();
    const edits: LineEdit[] = [
      { kind: 'replace', at: existing.lineIndex, line: withEol(line, projection.eol) },
      insertWasComment(projection, section, renderWasComment(previous, supersededOn)),
    ];
    return { ok: true, reason: null, lines: applyLineEdits(projection.rawLines, edits), changes: [change] };
  }

  if (section === undefined) {
    const edits = [appendNewSection(projection, def.section, line)];
    return { ok: true, reason: null, lines: applyLineEdits(projection.rawLines, edits), changes: [change] };
  }

  const indexes = fieldLineIndexes(projection, section);
  const edit: LineEdit = indexes.length === 0
    ? insertUnderHeading(projection, section, line)
    : { kind: 'insert', at: Math.max(...indexes) + 1, lines: [withEol(line, projection.eol)] };
  return { ok: true, reason: null, lines: applyLineEdits(projection.rawLines, [edit]), changes: [change] };
}

// ---------------------------------------------------------------------------
// appendProse
// ---------------------------------------------------------------------------

export interface AppendProseInput {
  /** A heading, canonical or one of his own. */
  readonly section: string;
  readonly text: string;
  readonly provenance: ProfileProvenance | null;
}

/**
 * Add a prose bullet at the end of a section.
 *
 * Prose is never superseded: a new bullet is a new bullet, and he removes the
 * old one if he wants it gone. Nothing here turns a notes section into records.
 */
export function appendProse(projection: ProfileProjection, input: AppendProseInput): ProfileEditResult {
  const heading = input.section.trim();
  if (heading.length === 0) return refuse(projection, 'A prose bullet needs a section.');
  const line = renderCappedLine('- ', input.text, input.provenance);
  const section = findProfileSectionByHeading(projection, heading);
  const change: ProfileChange = {
    kind: 'append',
    fieldId: null,
    section: section?.heading ?? heading,
    label: 'note',
    superseded: false,
  };

  if (section === undefined) {
    const canonical = canonicalProfileSection(heading);
    const edit = canonical === null
      ? appendNewSectionNamed(projection, heading, line)
      : appendNewSection(projection, canonical, line);
    return { ok: true, reason: null, lines: applyLineEdits(projection.rawLines, [edit]), changes: [change] };
  }

  const start = Math.max(section.headingLine, 0) + 1;
  let last = -1;
  for (let index = start; index < section.endLine; index += 1) {
    if (!isBlank(projection.rawLines[index])) last = index;
  }
  const edit: LineEdit = last < 0
    ? insertUnderHeading(projection, section, line)
    : { kind: 'insert', at: last + 1, lines: [withEol(line, projection.eol)] };
  return { ok: true, reason: null, lines: applyLineEdits(projection.rawLines, [edit]), changes: [change] };
}

/** Same as {@link appendNewSection} for a heading he named that does not exist yet. */
function appendNewSectionNamed(
  projection: ProfileProjection,
  heading: string,
  line: string,
): LineEdit {
  const at = appendPosition(projection.rawLines);
  const needsBlank = at > 0 && !isBlank(projection.rawLines[at - 1]);
  const eol = projection.eol;
  return {
    kind: 'insert',
    at,
    lines: [
      ...(needsBlank ? [withEol('', eol)] : []),
      withEol(`## ${heading}`, eol),
      withEol('', eol),
      withEol(line, eol),
    ],
  };
}

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

export interface ForgetInput {
  /** A mechanical field, or a raw line index for a prose bullet. */
  readonly fieldId?: string | undefined;
  readonly lineIndex?: number | undefined;
}

/**
 * Delete a line, and for a field every `<!-- was: … -->` comment it left behind.
 *
 * No tombstone, no `deleted: true`, no retention window — a delete that leaves
 * the record on disk is the dishonesty `docs/decisions/2026-07-06-delete-means-
 * delete.md` removed. Forgetting something that was not there says so; it does
 * not report success.
 */
export function forget(projection: ProfileProjection, input: ForgetInput): ProfileEditResult {
  if (input.fieldId === undefined) {
    const at = input.lineIndex;
    // `NaN` fails BOTH bounds comparisons, so a range check alone waves it
    // through and `splice(NaN, 1)` removes index 0 — his title. A fraction
    // splices at its floor, so `4.9` deletes line 4. Integrality is the check
    // that actually holds.
    if (at === undefined || !Number.isInteger(at) || at < 0 || at >= projection.rawLines.length) {
      return refuse(projection, 'There is no such line in your profile.');
    }
    const text = stripEol(projection.rawLines[at] ?? '', projection.eol);
    // Removing a heading orphans every field under it — they silently join the
    // section above — while the receipt claims a note was removed.
    if (/^##\s+/.test(text)) {
      return refuse(projection, 'That line is a section heading, not a note. Remove the lines under it instead.');
    }
    if (text.trim().length === 0) {
      return refuse(projection, 'That line is blank, so there was nothing to forget.');
    }
    const section = projection.sections.find((entry) => at > entry.headingLine && at < entry.endLine);
    const change: ProfileChange = {
      kind: 'forget',
      fieldId: null,
      section: section?.heading ?? '',
      label: 'note',
      superseded: false,
    };
    return {
      ok: true,
      reason: null,
      lines: applyLineEdits(projection.rawLines, [{ kind: 'remove', at }]),
      changes: [change],
    };
  }

  const def = profileFieldById(input.fieldId);
  if (def === undefined) return refuse(projection, unknownProfileFieldMessage(input.fieldId));
  const existing = projection.fields.get(def.id);
  const history = projection.superseded.get(def.id) ?? [];
  // Every line carrying this field, not just the active one:
  //  - a DUPLICATE further down is prose to the parser but still the value in
  //    the file, so removing only the active line reports success while the
  //    value survives — a false receipt on a delete;
  //  - a line under a heading he RENAMED is not in the model at all, so the
  //    old code said "nothing to forget" about a value `read()` still served.
  const strays = [
    ...(projection.duplicateFieldLines.get(def.id) ?? []),
    ...unrecognisedSectionFieldLines(projection, def.id),
  ];
  const targets = [...new Set([
    ...history.map((entry) => entry.lineIndex),
    ...(existing === undefined ? [] : [existing.lineIndex]),
    ...strays,
  ])];
  if (targets.length === 0) {
    return refuse(projection, `Your profile has no ${def.label} recorded, so there was nothing to forget.`);
  }

  const edits: LineEdit[] = targets.map((at) => ({ kind: 'remove', at }));
  const change: ProfileChange = {
    kind: 'forget',
    fieldId: def.id,
    section: existing?.section ?? def.section,
    label: def.label,
    superseded: false,
  };
  return { ok: true, reason: null, lines: applyLineEdits(projection.rawLines, edits), changes: [change] };
}

// ---------------------------------------------------------------------------
// undo
// ---------------------------------------------------------------------------

/**
 * The most recent superseded value: latest date, and among equal dates the one
 * furthest down the document, since history is appended in order.
 */
export function mostRecentSuperseded(
  entries: readonly ProfileSupersededLine[],
): ProfileSupersededLine | undefined {
  return [...entries].sort((a, b) =>
    a.supersededOn === b.supersededOn
      ? a.lineIndex - b.lineIndex
      : (a.supersededOn < b.supersededOn ? -1 : 1),
  ).pop();
}

/**
 * Promote the most recent superseded value back to an active line.
 *
 * The promoted line is restored EXACTLY as it read, provenance suffix included,
 * and its history comment is removed. The value being undone is not itself
 * recorded as history: undo exists to reverse a wrong correction, and a version
 * that wrote a new comment every time would make repeated undo oscillate between
 * two values instead of getting back to where he was.
 */
export function undo(projection: ProfileProjection, fieldId: string): ProfileEditResult {
  const def = profileFieldById(fieldId);
  if (def === undefined) return refuse(projection, unknownProfileFieldMessage(fieldId));
  const entry = mostRecentSuperseded(projection.superseded.get(def.id) ?? []);
  if (entry === undefined) {
    return refuse(projection, `Your profile has no earlier ${def.label} to go back to.`);
  }

  const restored = withEol(entry.previousLine, projection.eol);
  const existing = projection.fields.get(def.id);
  const edits: LineEdit[] = [{ kind: 'remove', at: entry.lineIndex }];
  if (existing !== undefined) {
    edits.push({ kind: 'replace', at: existing.lineIndex, line: restored });
  } else {
    const section = findProfileSection(projection, def.section);
    edits.push(
      section === undefined
        ? appendNewSection(projection, def.section, entry.previousLine)
        : placeRestored(projection, section, restored),
    );
  }
  const change: ProfileChange = {
    kind: 'undo',
    fieldId: def.id,
    section: existing?.section ?? def.section,
    label: def.label,
    superseded: false,
  };
  return { ok: true, reason: null, lines: applyLineEdits(projection.rawLines, edits), changes: [change] };
}

function placeRestored(
  projection: ProfileProjection,
  section: ProfileSection,
  restored: string,
): LineEdit {
  const indexes = fieldLineIndexes(projection, section);
  return indexes.length === 0
    ? insertUnderHeading(projection, section, stripEol(restored, projection.eol))
    : { kind: 'insert', at: Math.max(...indexes) + 1, lines: [restored] };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** The file operations persistence needs, injected so a test can interrupt one. */
export interface ProfilePersistIo {
  readonly mkdir: (dir: string) => Promise<void>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
}

const NODE_PERSIST_IO: ProfilePersistIo = {
  mkdir: async (dir) => { await fs.mkdir(dir, { recursive: true }); },
  writeFile: async (path, content) => { await fs.writeFile(path, content, 'utf-8'); },
  rename: async (from, to) => { await fs.rename(from, to); },
  remove: async (path) => { await fs.rm(path, { force: true }); },
};

/**
 * Write the document atomically: temp file, then `rename()` over the target.
 *
 * Same shape as `PersistentStore.persist()` with a text join instead of
 * `JSON.stringify`. On POSIX the rename is atomic, so an interrupted write
 * leaves either the old complete file or the new one — never half a profile.
 * The daemon is the single writer, which is what makes this sufficient with no
 * lock.
 */
export async function persistProfileText(
  path: string,
  text: string,
  io: ProfilePersistIo = NODE_PERSIST_IO,
): Promise<void> {
  await io.mkdir(dirname(path));
  const tmpPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await io.writeFile(tmpPath, text);
    await io.rename(tmpPath, path);
  } catch (error) {
    await io.remove(tmpPath).catch(() => undefined);
    throw error;
  }
}

/** Join a raw line array into the text to persist. */
export function profileTextFromLines(lines: readonly string[]): string {
  return joinProfileLines(lines);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function stripEol(line: string, eol: '\n' | '\r\n'): string {
  return eol === '\r\n' && line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** The section a raw line index falls inside, or `undefined` for the preamble. */
function sectionContaining(
  projection: ProfileProjection,
  lineIndex: number,
): ProfileSection | undefined {
  return projection.sections.find(
    (section) => lineIndex > section.headingLine && lineIndex < section.endLine,
  );
}

/**
 * Lines that read as `<label>: value` for this field under a heading the parser
 * does not recognise as a section.
 *
 * This is the `## Shopping` case: he renamed `## Commerce`, so `shipping
 * address:` under it is prose to the model while `read()` still shows it and the
 * file still holds it. Saying "nothing to forget" there is honest about the
 * model and dishonest about the document, and the document is what he asked
 * about.
 *
 * Scoped to UNRECOGNISED headings on purpose. A `shipping address:` line under a
 * known prose section like `Notes` is his own prose in a section that means
 * something else, and reaching into it would widen a delete past what he named.
 */
function unrecognisedSectionFieldLines(
  projection: ProfileProjection,
  fieldId: string,
): number[] {
  const def = profileFieldById(fieldId);
  if (def === undefined) return [];
  const wanted = normalizeProfileKey(def.label);
  const found: number[] = [];
  for (const section of projection.sections) {
    if (section.canonical !== null) continue;
    for (const line of section.prose) {
      const parsed = parseFieldLine(splitProvenanceSuffix(line.text).text);
      if (parsed !== null && normalizeProfileKey(parsed.label) === wanted) found.push(line.lineIndex);
    }
  }
  return found;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function refuse(projection: ProfileProjection, reason: string): ProfileEditResult {
  return { ok: false, reason, lines: projection.rawLines, changes: [] };
}

/** Exported for the store's own duplicate-label check; keeps the grammar in one place. */
export { parseFieldLine };

/**
 * Delete one prose line, matched by its exact text within one section.
 *
 * End whitespace and the leading LIST MARKER are ignored on both sides; nothing
 * else is. The marker is syntax, not content: he says "forget that I'm allergic
 * to shellfish", and the `- ` in front of it is a Markdown artefact he never
 * uttered. Requiring it back would be asking a model to guess at our storage
 * format, and it would fail closed in the least useful direction — a delete
 * that silently matches nothing.
 *
 * Normalising cannot widen a match onto the WRONG line, because ambiguity is
 * refused rather than resolved: if both `- Foo` and a bare `Foo` sit in the
 * same section they now both match, and that is two matches, which is a
 * refusal. A near-miss delete on the file that holds his address is worse than
 * a refusal, so an unmatched text removes nothing and says the line is not
 * there any more — which is true, and the useful thing to tell him: his file
 * changed under the answer he was working from.
 *
 * Two byte-identical lines in one section refuse rather than guess. Removing
 * "one of them" would report a deletion while the same text stayed in the file,
 * which is the false-receipt class §9.2 exists to prevent.
 */
export function forgetProseByText(
  projection: ProfileProjection,
  section: string,
  text: string,
): ProfileEditResult {
  const wanted = withoutListMarker(text);
  if (wanted.length === 0) {
    return {
      ok: false,
      reason: 'Name the line by its text — there was nothing to match on.',
      lines: projection.rawLines,
      changes: [],
    };
  }
  const target = findProfileSectionByHeading(projection, section);
  if (target === undefined) {
    return {
      ok: false,
      reason: `Your profile has no ${section} section, so there was nothing to forget.`,
      lines: projection.rawLines,
      changes: [],
    };
  }
  const matches = target.prose.filter((line) => withoutListMarker(line.text) === wanted);
  if (matches.length === 0) {
    return {
      ok: false,
      reason: `That line is not in ${target.heading} any more, so nothing was removed.`,
      lines: projection.rawLines,
      changes: [],
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason:
        `${matches.length} lines in ${target.heading} read exactly that, so it is not clear which one you `
        + 'mean. Nothing was removed — edit the file directly, or tell them apart and ask again.',
      lines: projection.rawLines,
      changes: [],
    };
  }
  return forget(projection, { lineIndex: matches[0]!.lineIndex });
}

/**
 * A prose line's content, with its list marker and surrounding space removed.
 *
 * Matches `-`, `*`, `+` and ordered `1.` / `1)` forms, and only when whitespace
 * follows — so a line that genuinely begins `-5 degrees` keeps its minus sign
 * rather than becoming `5 degrees`.
 */
function withoutListMarker(value: string): string {
  return value.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim();
}
