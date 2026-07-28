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
  profileFieldById,
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
  const said = provenance === null ? '' : provenance.said.replace(/[\r\n]+/g, ' ').trim();
  const full = provenance === null ? null : { ...provenance, said };
  let line = renderLine(prefix, value, full);
  if (line.length <= MAX_MACHINE_LINE_CHARS) return line;

  if (full !== null) {
    const shorter = Math.max(0, said.length - (line.length - MAX_MACHINE_LINE_CHARS));
    line = renderLine(prefix, value, { ...full, said: said.slice(0, shorter) });
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
  const anchor = Math.max(...fieldLineIndexes(projection, section), ...historyIndexes);
  const line = withEol(comment, eol);

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
    return refuse(projection, `"${input.fieldId}" is not a profile field.`);
  }

  const existing = projection.fields.get(def.id);
  const section = findProfileSection(projection, def.section);
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
    if (at === undefined || at < 0 || at >= projection.rawLines.length) {
      return refuse(projection, 'There is no such line in your profile.');
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
  if (def === undefined) return refuse(projection, `"${input.fieldId}" is not a profile field.`);
  const existing = projection.fields.get(def.id);
  const history = projection.superseded.get(def.id) ?? [];
  if (existing === undefined && history.length === 0) {
    return refuse(projection, `Your profile has no ${def.label} recorded, so there was nothing to forget.`);
  }

  const edits: LineEdit[] = history.map((entry) => ({ kind: 'remove', at: entry.lineIndex }));
  if (existing !== undefined) edits.push({ kind: 'remove', at: existing.lineIndex });
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
  if (def === undefined) return refuse(projection, `"${fieldId}" is not a profile field.`);
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function refuse(projection: ProfileProjection, reason: string): ProfileEditResult {
  return { ok: false, reason, lines: projection.rawLines, changes: [] };
}

/** Exported for the store's own duplicate-label check; keeps the grammar in one place. */
export { parseFieldLine };
