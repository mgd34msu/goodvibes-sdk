/**
 * document.ts — Markdown text in, projection out.
 *
 * Parsing is LENIENT by construction: there is no path in this file that
 * discards, rewrites or normalises a line it did not understand. An unknown
 * heading, an unknown `key:` line, a table, a code fence, a nested list, an HTML
 * comment — all end up in `rawLines` exactly as written, and the ones this
 * module cannot type are served as prose.
 *
 * Two hazards drive the shape of the scanner:
 *
 *   - FENCES. A fenced code block may contain a line that looks like a heading
 *     or a field. Reading those as real would let a later write edit a line
 *     inside the owner's code block, which is silent corruption of his content
 *     and the worst failure this design can have. Fence state is tracked and
 *     nothing inside a fence is ever typed.
 *   - EM DASHES. The provenance suffix is em-dash delimited and he writes em
 *     dashes in prose. The suffix is therefore recognised only when the WHOLE
 *     shape matches at end of line, and it is matched from the RIGHT so a line
 *     carrying two suffix-shaped tails resolves to the newest one instead of
 *     swallowing the tail into the quote.
 *
 * Failure is reserved for two conditions the caller detects before calling here:
 * the file cannot be read, and its bytes are not valid UTF-8. Nothing in this
 * file throws.
 */
import {
  canonicalProfileSection,
  normalizeProfileKey,
  profileFieldForLabel,
  type ProfileSectionName,
} from './fields.js';
import {
  PROFILE_SURFACES,
  isProfileSurface,
  type ProfileFieldValue,
  type ProfileLine,
  type ProfileProjection,
  type ProfileProvenance,
  type ProfileSection,
  type ProfileSupersededLine,
} from './types.js';

/** The em-dash marker that opens a provenance suffix. */
export const PROVENANCE_MARKER = ' — ';

/** ` — <surface>, <YYYY-MM-DD>, "<verbatim>"`, anchored to the end of a line. */
const PROVENANCE_SUFFIX = new RegExp(
  `^ — (${PROFILE_SURFACES.join('|')}), (\\d{4}-\\d{2}-\\d{2}), "([\\s\\S]*)"$`,
);

/** `<!-- was: <line> (superseded <YYYY-MM-DD>) -->` */
const WAS_COMMENT = /^\s*<!-- was: (.*) \(superseded (\d{4}-\d{2}-\d{2})\) -->\s*$/;

/**
 * A mechanical field line, recognised at COLUMN 0 only.
 *
 * Indentation means the line belongs to something else — a nested bullet, an
 * indented block — so `  Gym: the Y` under a `- Places` bullet stays prose
 * rather than becoming a field the writer would later rewrite.
 */
const FIELD_LINE = /^([A-Za-z][A-Za-z ]*?)\s*:\s*(.+)$/;

/** ``` or ~~~ at the start of a line (up to three spaces of indent, as CommonMark allows). */
const FENCE_LINE = /^\s{0,3}(```|~~~)/;

/** A bullet or numbered list item — never a mechanical field. */
const BULLET_LINE = /^\s*([-*+]|\d+[.)])\s/;

/** True when this line opens or closes a fenced code block. */
export function isFenceToggle(line: string): boolean {
  return FENCE_LINE.test(line);
}

export interface ProvenanceSplit {
  /** The line with its provenance suffix removed. */
  readonly text: string;
  readonly provenance: ProfileProvenance | null;
}

/**
 * Split a line into its text and its provenance suffix, matching from the RIGHT.
 *
 * Rightmost wins because a line that somehow carries two suffixes should resolve
 * to the newest one with the older left visible as ordinary text. Matching from
 * the left instead swallows everything after the first suffix into the quote,
 * which produces a provenance record that is quietly wrong.
 *
 * Anything that is not a complete, well-formed suffix is text: an em dash in his
 * own prose, a malformed date, a surface name outside the set, a bare trailing
 * quote. Such a line is preserved whole and reports no provenance.
 */
export function splitProvenanceSuffix(line: string): ProvenanceSplit {
  let searchFrom = line.length;
  while (searchFrom > 0) {
    const at = line.lastIndexOf(PROVENANCE_MARKER, searchFrom - 1);
    if (at < 0) break;
    const match = PROVENANCE_SUFFIX.exec(line.slice(at));
    const surface = match?.[1];
    const date = match?.[2];
    const said = match?.[3];
    if (surface !== undefined && date !== undefined && said !== undefined && isProfileSurface(surface)) {
      return { text: line.slice(0, at), provenance: { surface, date, said } };
    }
    searchFrom = at;
  }
  return { text: line, provenance: null };
}

/** Render a provenance suffix. The inverse of {@link splitProvenanceSuffix}. */
export function renderProvenanceSuffix(provenance: ProfileProvenance): string {
  return `${PROVENANCE_MARKER}${provenance.surface}, ${provenance.date}, "${provenance.said}"`;
}

export interface ParsedFieldLine {
  readonly label: string;
  readonly value: string;
}

/**
 * A `key: value` line at column 0, or `null`. Bullets are excluded explicitly as
 * well as by the pattern, so the intent survives a later edit to either.
 */
export function parseFieldLine(text: string): ParsedFieldLine | null {
  if (BULLET_LINE.test(text)) return null;
  const match = FIELD_LINE.exec(text);
  const label = match?.[1];
  const value = match?.[2];
  if (label === undefined || value === undefined) return null;
  return { label, value: value.trim() };
}

export interface ParsedWasComment {
  /** The superseded line, exactly as it read. */
  readonly previousLine: string;
  readonly supersededOn: string;
}

export function parseWasComment(text: string): ParsedWasComment | null {
  const match = WAS_COMMENT.exec(text);
  const previousLine = match?.[1];
  const supersededOn = match?.[2];
  if (previousLine === undefined || supersededOn === undefined) return null;
  return { previousLine, supersededOn };
}

/** Render a `<!-- was: … -->` history comment for a line being superseded. */
export function renderWasComment(previousLine: string, supersededOn: string): string {
  return `<!-- was: ${previousLine} (superseded ${supersededOn}) -->`;
}

/** Strip a trailing CR so a CRLF document parses the same as an LF one. */
function withoutCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Mutable scratch for one section while the scanner is inside it. */
interface SectionBuilder {
  heading: string;
  canonical: ProfileSectionName | null;
  headingLine: number;
  fields: string[];
  prose: ProfileLine[];
  superseded: ProfileSupersededLine[];
}

function newSection(heading: string, headingLine: number): SectionBuilder {
  return {
    heading,
    canonical: canonicalProfileSection(heading),
    headingLine,
    fields: [],
    prose: [],
    superseded: [],
  };
}

function sealSection(builder: SectionBuilder, endLine: number): ProfileSection {
  return {
    heading: builder.heading,
    canonical: builder.canonical,
    headingLine: builder.headingLine,
    endLine,
    fields: builder.fields,
    prose: builder.prose,
    superseded: builder.superseded,
  };
}

export interface ParseProfileInput {
  readonly path: string;
  readonly text: string;
  /** False when the file is not there yet, so `status` can say so honestly. */
  readonly exists: boolean;
}

/**
 * Project Markdown text into the in-memory model.
 *
 * Split on `'\n'` alone, keeping any `'\r'` on the end of the line: joining with
 * `'\n'` then reproduces a CRLF file byte-for-byte, and a trailing newline
 * survives as a final empty element.
 */
export function parseProfileDocument(input: ParseProfileInput): ProfileProjection {
  const rawLines = input.text.split('\n');
  const eol: '\n' | '\r\n' = rawLines.some((line) => line.endsWith('\r')) ? '\r\n' : '\n';

  const sections: ProfileSection[] = [];
  const fields = new Map<string, ProfileFieldValue>();
  const superseded = new Map<string, ProfileSupersededLine[]>();

  let current = newSection('', -1);
  let inFence = false;

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? '';
    const line = withoutCarriageReturn(raw);

    if (isFenceToggle(line)) {
      inFence = !inFence;
      current.prose.push({ lineIndex: index, section: current.heading, text: line });
      continue;
    }

    // Inside a fence nothing is typed: not a heading, not a field, not a bullet.
    if (inFence) {
      current.prose.push({ lineIndex: index, section: current.heading, text: line });
      continue;
    }

    const heading = /^##\s+(.*)$/.exec(line);
    const headingText = heading?.[1];
    if (headingText !== undefined) {
      if (current.headingLine >= 0 || current.prose.length > 0 || current.fields.length > 0) {
        sections.push(sealSection(current, index));
      }
      current = newSection(headingText.trim(), index);
      continue;
    }

    if (line.trim().length === 0) continue;

    if (
      recordWasComment(line, index, current, superseded)
      || recordField(line, index, current, fields)
    ) {
      continue;
    }

    const split = splitProvenanceSuffix(line);
    current.prose.push({
      lineIndex: index,
      section: current.heading,
      text: split.text,
      ...(split.provenance === null ? {} : { provenance: split.provenance }),
    });
  }
  if (current.headingLine >= 0 || current.prose.length > 0 || current.fields.length > 0) {
    sections.push(sealSection(current, rawLines.length));
  }

  const prose = new Map<string, readonly ProfileLine[]>();
  for (const section of sections) {
    const existing = prose.get(section.heading);
    prose.set(section.heading, existing === undefined ? section.prose : [...existing, ...section.prose]);
  }

  return { path: input.path, exists: input.exists, eol, rawLines, fields, sections, prose, superseded };
}

/**
 * Record a `<!-- was: … -->` comment as history for the field it names.
 *
 * A comment whose content does not name a known field of the enclosing section
 * is not history — it is one of his own HTML comments, and it falls through to
 * prose so it is still served rather than silently classified as machinery.
 */
function recordWasComment(
  line: string,
  index: number,
  current: SectionBuilder,
  superseded: Map<string, ProfileSupersededLine[]>,
): boolean {
  const parsed = parseWasComment(line);
  if (parsed === null || current.canonical === null) return false;
  const split = splitProvenanceSuffix(parsed.previousLine);
  const field = parseFieldLine(split.text);
  if (field === null) return false;
  const def = profileFieldForLabel(current.canonical, field.label);
  if (def === undefined) return false;

  const entry: ProfileSupersededLine = {
    lineIndex: index,
    fieldId: def.id,
    section: current.heading,
    text: split.text,
    value: field.value,
    supersededOn: parsed.supersededOn,
    previousLine: parsed.previousLine,
    ...(split.provenance === null ? {} : { provenance: split.provenance }),
  };
  current.superseded.push(entry);
  const bucket = superseded.get(def.id);
  if (bucket === undefined) superseded.set(def.id, [entry]);
  else bucket.push(entry);
  return true;
}

/**
 * Record a mechanical field.
 *
 * The FIRST occurrence of a field in the document is the active one; a duplicate
 * further down falls through to prose so it is preserved and visible rather than
 * dropped or silently preferred.
 */
function recordField(
  line: string,
  index: number,
  current: SectionBuilder,
  fields: Map<string, ProfileFieldValue>,
): boolean {
  if (current.canonical === null) return false;
  const split = splitProvenanceSuffix(line);
  const parsed = parseFieldLine(split.text);
  if (parsed === null) return false;
  const def = profileFieldForLabel(current.canonical, parsed.label);
  if (def === undefined) return false;
  if (fields.has(def.id)) return false;

  const check = def.validate(parsed.value);
  fields.set(def.id, {
    value: parsed.value,
    valid: check.valid,
    fieldId: def.id,
    section: current.heading,
    lineIndex: index,
    label: parsed.label,
    ...(check.valid || check.reason === undefined ? {} : { invalidReason: check.reason }),
    ...(split.provenance === null ? {} : { provenance: split.provenance }),
  });
  current.fields.push(def.id);
  return true;
}

/**
 * The section a write to `canonical` should target.
 *
 * A heading he renamed still matches when it normalises to a known section name;
 * anything else means the section is absent and the caller creates the canonical
 * one rather than guessing which of his headings was meant.
 */
export function findProfileSection(
  projection: ProfileProjection,
  canonical: ProfileSectionName,
): ProfileSection | undefined {
  const wanted = normalizeProfileKey(canonical);
  return projection.sections.find((section) => normalizeProfileKey(section.heading) === wanted);
}

/** The section a heading names, matched the same way, for read verbs. */
export function findProfileSectionByHeading(
  projection: ProfileProjection,
  heading: string,
): ProfileSection | undefined {
  const wanted = normalizeProfileKey(heading);
  return projection.sections.find((section) => normalizeProfileKey(section.heading) === wanted);
}

/** Join a raw line array back into document text, byte-for-byte. */
export function joinProfileLines(lines: readonly string[]): string {
  return lines.join('\n');
}
