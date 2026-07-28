/**
 * types.ts — the shapes of the owner profile.
 *
 * The owner profile is ONE Markdown file at daemon scope (see docs/owner-profile.md).
 * The file's text is the source of truth; everything here is a projection of it.
 * Nothing in this module is called `Profile` unqualified — `platform/profiles/`
 * is an unrelated named-config-preset manager and the two must never be confused
 * by a reader skimming imports.
 */

/** Where a recorded line came from. `hand-edit` means the owner typed it himself. */
export type ProfileSurface = 'tui' | 'agent' | 'webui' | 'voice' | 'hand-edit';

/** The surfaces recognised in a provenance suffix, in the order the grammar lists them. */
export const PROFILE_SURFACES: readonly ProfileSurface[] = [
  'tui',
  'agent',
  'webui',
  'voice',
  'hand-edit',
];

export function isProfileSurface(value: string): value is ProfileSurface {
  return (PROFILE_SURFACES as readonly string[]).includes(value);
}

/**
 * Where a line came from: which surface, when, and the owner's exact words.
 *
 * `said` is verbatim and is what makes "where did you get that" answerable. A
 * line with no provenance is one the owner wrote or edited by hand, and is
 * reported as such rather than dressed up as a recorded source.
 */
export interface ProfileProvenance {
  readonly surface: ProfileSurface;
  /** ISO calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  readonly said: string;
}

/** One line of the document, as projected. */
export interface ProfileLine {
  /** Index into the raw line array. Writes address lines by this index. */
  readonly lineIndex: number;
  /** The heading text exactly as written; `''` for content before the first heading. */
  readonly section: string;
  /** The line minus its provenance suffix, and minus a trailing CR on a CRLF file. */
  readonly text: string;
  readonly provenance?: ProfileProvenance | undefined;
}

/**
 * A parsed mechanical field.
 *
 * `valid: false` is NEVER a reason to drop or rewrite the line. An invalid value
 * is preserved verbatim, reported with its reason, and its consumer falls back
 * exactly as if the field were unset.
 */
export interface ProfileFieldValue {
  readonly value: string;
  readonly valid: boolean;
  readonly invalidReason?: string | undefined;
  readonly provenance?: ProfileProvenance | undefined;
  /** Field id, e.g. `location.timezone`. */
  readonly fieldId: string;
  /** The heading this field was found under, as written. */
  readonly section: string;
  /** Index into the raw line array, so a write can edit exactly this line. */
  readonly lineIndex: number;
  /** The label as written on the line, e.g. `Shipping Address`. */
  readonly label: string;
}

/**
 * A `<!-- was: … (superseded <date>) -->` history comment.
 *
 * Retained because it is what makes `undo` work and what answers "what did it
 * say before". Deletable by hand, and deleting one destroys that history — the
 * owner's call.
 */
export interface ProfileSupersededLine {
  readonly lineIndex: number;
  readonly fieldId: string;
  readonly section: string;
  /** The superseded line's own text, minus its provenance suffix. */
  readonly text: string;
  /** The superseded value. */
  readonly value: string;
  /** The date the supersede happened, `YYYY-MM-DD`. */
  readonly supersededOn: string;
  readonly provenance?: ProfileProvenance | undefined;
  /** The full previous line, exactly as it read before the supersede. */
  readonly previousLine: string;
}

/** A `## ` section of the document. */
export interface ProfileSection {
  /** The heading text exactly as written; `''` for the preamble. */
  readonly heading: string;
  /** The canonical section name when the heading matches one, else `null`. */
  readonly canonical: string | null;
  /** Index of the `## ` line, or `-1` for the preamble. */
  readonly headingLine: number;
  /** One past the last line belonging to this section. */
  readonly endLine: number;
  /** Field ids found under this heading, in document order. */
  readonly fields: readonly string[];
  /** Non-blank, non-field, non-history lines, preserved verbatim. */
  readonly prose: readonly ProfileLine[];
  readonly superseded: readonly ProfileSupersededLine[];
}

/**
 * The in-memory model. Built once per load, swapped in whole, never mutated.
 *
 * `rawLines` is the authority: every write is a surgical edit to it and the
 * projection is rebuilt from the result. Nothing is ever re-serialised from the
 * maps, which is what makes "his edits are authoritative" true rather than
 * aspirational.
 */
export interface ProfileProjection {
  readonly path: string;
  /** False when the file is simply not there yet — an honest empty, not a failure. */
  readonly exists: boolean;
  /** The document's line ending, so a rewritten line matches the file it lives in. */
  readonly eol: '\n' | '\r\n';
  readonly rawLines: readonly string[];
  readonly fields: ReadonlyMap<string, ProfileFieldValue>;
  readonly sections: readonly ProfileSection[];
  /** Prose lines keyed by heading text as written. */
  readonly prose: ReadonlyMap<string, readonly ProfileLine[]>;
  /** Superseded history keyed by field id, oldest first. */
  readonly superseded: ReadonlyMap<string, readonly ProfileSupersededLine[]>;
}

/** A mechanical field whose value did not validate, with the reason. */
export interface ProfileInvalidField {
  readonly fieldId: string;
  readonly reason: string;
}

/**
 * What `profile.status` answers. Never carries a value — counts, names and
 * reasons only.
 *
 * The ONLY unavailable conditions are: the file cannot be read, or its bytes are
 * not valid UTF-8. A missing file is `loaded` with `exists: false`, because "you
 * have not told me anything yet" is true and "I could not open the file" is not.
 */
export type ProfileLoadState =
  | {
    readonly kind: 'loaded';
    readonly path: string;
    readonly exists: boolean;
    readonly lineCount: number;
    readonly fieldCount: number;
    readonly proseLineCount: number;
    readonly sections: readonly string[];
    readonly invalidFields: readonly ProfileInvalidField[];
  }
  | { readonly kind: 'unavailable'; readonly path: string; readonly reason: string }
  | { readonly kind: 'disabled'; readonly path: string };

/** Which tier a field or section belongs to — see docs/owner-profile.md §11.2. */
export type ProfileTier = 'open' | 'closed';

/** One thing a write did, for the disclosure line and the verb's response. */
export interface ProfileChange {
  readonly kind: 'set' | 'append' | 'forget' | 'undo';
  /** The mechanical field, or `null` for a prose bullet. */
  readonly fieldId: string | null;
  /** The heading it landed under, as written. */
  readonly section: string;
  /** What to call it in a disclosure line, e.g. `shipping address`. */
  readonly label: string;
  /** True when a previous value was moved into a `<!-- was: … -->` comment. */
  readonly superseded: boolean;
}

/** The result of any write verb. `ok: false` always carries a reason. */
export interface ProfileWriteResult {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly changes: readonly ProfileChange[];
  /** The one-line receipt, `''` when nothing changed. */
  readonly disclosure: string;
}
