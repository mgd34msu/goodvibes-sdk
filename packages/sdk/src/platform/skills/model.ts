/**
 * skills/model.ts
 *
 * The canonical skill model, hoisted into the SDK so every consumer parses,
 * serializes, and discloses skills the same way instead of each carrying its
 * own drifting copy. A skill is a Markdown document with a YAML-style
 * frontmatter block:
 *
 *   ---
 *   name: my-skill
 *   description: One line the model reads to decide whether to open the skill.
 *   ---
 *   The full skill body in Markdown.
 *
 * PROGRESSIVE DISCLOSURE is the whole point of the split between the two parse
 * entry points here:
 *   - `parseSkillIndex` reads ONLY the frontmatter (name + description + any
 *     extra scalar/list keys) and never materializes the body. This is the
 *     cheap "index line" a caller loads for every skill to decide which one is
 *     relevant.
 *   - `parseSkill` reads the full document including the body. This is the
 *     expensive read a caller makes for exactly the one skill it decided to
 *     invoke.
 *
 * The frontmatter parser is intentionally a small, well-defined subset of YAML
 * (scalar strings and single-line string lists) rather than a full YAML engine:
 * it is the exact shape skills use, it pulls in no dependency, and an
 * unsupported construct is surfaced as the raw string rather than guessed at.
 */

/** A JSON-ish frontmatter value: a scalar string or a list of strings. */
export type SkillFrontmatterValue = string | readonly string[];

/** Parsed frontmatter: the two reserved keys plus any extra author-supplied keys. */
export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  /** Every frontmatter key other than name/description, preserved verbatim. */
  readonly metadata: Readonly<Record<string, SkillFrontmatterValue>>;
}

/**
 * The cheap "index line" of a skill: everything a caller needs to decide
 * whether to open it, and nothing more. Deliberately omits the body.
 */
export interface SkillIndexEntry extends SkillFrontmatter {
  /** Millisecond epoch of the skill's last modification, when the store knows it. */
  readonly updatedAt?: number | undefined;
}

/** A fully-disclosed skill: its index line plus the Markdown body. */
export interface Skill extends SkillIndexEntry {
  readonly body: string;
}

const FRONTMATTER_FENCE = /^---[ \t]*\r?\n/;

/**
 * Split a raw skill document into its frontmatter block text and body text.
 * A document with no leading `---` fence is treated as a bodyless-frontmatter
 * error path by the callers below (name/description are required), but the
 * split itself is total: no fence -> empty frontmatter, whole input is body.
 */
function splitDocument(text: string): { frontmatter: string; body: string } {
  const normalized = text.startsWith('﻿') ? text.slice(1) : text;
  if (!FRONTMATTER_FENCE.test(normalized)) {
    return { frontmatter: '', body: normalized };
  }
  const afterOpen = normalized.replace(FRONTMATTER_FENCE, '');
  const closeMatch = afterOpen.match(/\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    // Opened but never closed: the whole remainder is frontmatter, no body.
    return { frontmatter: afterOpen, body: '' };
  }
  const frontmatter = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  return { frontmatter, body };
}

/** Strip one layer of matching single or double quotes from a scalar. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Parse a single-line `[a, b, c]` flow list into its string items. */
function parseFlowList(value: string): readonly string[] {
  const inner = value.trim().slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(',').map((item) => unquote(item)).filter((item) => item.length > 0);
}

function parseFrontmatterValue(raw: string): SkillFrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseFlowList(trimmed);
  }
  return unquote(trimmed);
}

/**
 * Parse a frontmatter block's `key: value` lines into a flat map. Comment
 * lines (`#`) and blank lines are skipped; a line without a colon is ignored
 * rather than throwing, so a malformed extra key can never make an otherwise
 * valid skill unreadable.
 */
function parseFrontmatterBlock(block: string): Map<string, SkillFrontmatterValue> {
  const out = new Map<string, SkillFrontmatterValue>();
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key.length === 0) continue;
    out.set(key, parseFrontmatterValue(line.slice(colon + 1)));
  }
  return out;
}

function asScalar(value: SkillFrontmatterValue | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return '';
}

function toFrontmatter(block: string): SkillFrontmatter {
  const map = parseFrontmatterBlock(block);
  const name = asScalar(map.get('name'));
  const description = asScalar(map.get('description'));
  const metadata: Record<string, SkillFrontmatterValue> = {};
  for (const [key, value] of map) {
    if (key === 'name' || key === 'description') continue;
    metadata[key] = value;
  }
  return { name, description, metadata };
}

/**
 * Parse only the frontmatter of a skill document — the cheap index-line read.
 * The body is never materialized. `updatedAt`, when known by the caller (e.g.
 * a file mtime), is threaded through unchanged.
 */
export function parseSkillIndex(text: string, updatedAt?: number): SkillIndexEntry {
  const { frontmatter } = splitDocument(text);
  return { ...toFrontmatter(frontmatter), updatedAt };
}

/**
 * Parse a full skill document — frontmatter plus the Markdown body. A single
 * leading blank line after the closing fence and a single trailing newline are
 * trimmed, so a body round-trips exactly through `serializeSkill` (which emits
 * one trailing newline) and a conventional newline-terminated file yields a
 * clean body.
 */
export function parseSkill(text: string, updatedAt?: number): Skill {
  const { frontmatter, body } = splitDocument(text);
  const trimmed = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  return { ...toFrontmatter(frontmatter), updatedAt, body: trimmed };
}

function serializeFrontmatterValue(value: SkillFrontmatterValue): string {
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

/**
 * Serialize a skill back to its canonical `---` frontmatter + body Markdown
 * form. name and description are emitted first (in that order), then any extra
 * metadata keys in insertion order, so a round trip is stable.
 */
export function serializeSkill(skill: Skill): string {
  const lines = ['---', `name: ${skill.name}`, `description: ${skill.description}`];
  for (const [key, value] of Object.entries(skill.metadata)) {
    lines.push(`${key}: ${serializeFrontmatterValue(value)}`);
  }
  lines.push('---', '');
  const body = skill.body.length > 0 ? `${skill.body}\n` : '';
  return `${lines.join('\n')}${body}`;
}

/** Project a full skill down to its index line (drops the body). */
export function toSkillIndexEntry(skill: SkillIndexEntry): SkillIndexEntry {
  return {
    name: skill.name,
    description: skill.description,
    metadata: skill.metadata,
    ...(skill.updatedAt !== undefined ? { updatedAt: skill.updatedAt } : {}),
  };
}

/** The allowed shape of a skill name: a filesystem- and URL-safe slug. */
export const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Whether a candidate skill name is well-formed (safe slug, non-empty). */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name) && name.length <= 128;
}
