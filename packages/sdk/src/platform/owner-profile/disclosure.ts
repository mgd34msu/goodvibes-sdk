/**
 * disclosure.ts, the one-line receipt.
 *
 * The owner chose autonomous learning over propose-first, and two conditions
 * travelled with that choice: untrusted sources stay barred (trust.ts), and it
 * TELLS THEM WHAT IT RECORDED. This file is the second one.
 *
 * The rules, from design §8.2 and §10:
 *
 *   - One line. Several facts in one turn collapse into one sentence.
 *   - It names WHAT was recorded and never quotes the value back. "Saved your
 *     office address" is a receipt; "saved your office address as 200 Office
 *     Way" repeats a closed-tier value into a transcript for no benefit.
 *   - It is a receipt, not a confirmation prompt, that option was declined.
 *
 * The SDK produces the string so the TUI, the agent and the webui all say the
 * same thing; a second copy of this wording in a surface would drift within a
 * release.
 */
import { profileFieldById } from './fields.js';
import type { ProfileChange } from './types.js';

/** Join a list the way a person writes one: "a", "a and b", "a, b and c". */
function conjoin(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  const head = parts.slice(0, -1).join(', ');
  return `${head} and ${parts[parts.length - 1] ?? ''}`;
}

/** What to call one change in a receipt. Never the value. */
function nameOf(change: ProfileChange): string {
  if (change.fieldId === null) return `a note under ${change.section}`;
  const def = profileFieldById(change.fieldId);
  return `your ${def?.label ?? change.label}`;
}

/** De-duplicated names, in the order the changes happened. */
function namesFor(changes: readonly ProfileChange[]): readonly string[] {
  return [...new Set(changes.map(nameOf))];
}

/**
 * The receipt for a write.
 *
 * Returns `''` when nothing changed, so a caller can append it unconditionally
 * without producing "Noted, saved nothing." Mixed kinds collapse into one
 * sentence rather than one line each.
 */
export function describeProfileWrite(changes: readonly ProfileChange[]): string {
  if (changes.length === 0) return '';

  const saved = namesFor(changes.filter((change) => change.kind === 'set' || change.kind === 'append'));
  const removed = namesFor(changes.filter((change) => change.kind === 'forget'));
  const restored = namesFor(changes.filter((change) => change.kind === 'undo'));

  const clauses: string[] = [];
  if (saved.length > 0) clauses.push(`saved ${conjoin(saved)}`);
  if (restored.length > 0) clauses.push(`put ${conjoin(restored)} back`);
  if (removed.length > 0) clauses.push(`removed ${conjoin(removed)}`);
  if (clauses.length === 0) return '';

  const preposition = saved.length > 0 && removed.length === 0 && restored.length === 0
    ? 'to your profile'
    : 'in your profile';
  return `Noted, ${conjoin(clauses)} ${preposition}.`;
}

/**
 * The receipt for a closed-tier read.
 *
 * Using the owner's address on an order should be visible, so every named-accessor
 * read is disclosed in the same one-line form. Field names only, the point is that
 * they can see it was used, not to print it again.
 */
export function describeProfileRead(fieldIds: readonly string[]): string {
  const names = [...new Set(fieldIds.map((fieldId) => profileFieldById(fieldId)?.label ?? fieldId))];
  if (names.length === 0) return '';
  return `Used your ${conjoin(names)} from your profile.`;
}

/**
 * The receipt for a `People` lookup.
 *
 * Separate from {@link describeProfileRead} because a person is reached by NAME,
 * not by field id, and the name is the only thing worth saying: "Used Sarah's
 * details from your profile." The lookup itself is only reachable when the owner
 * named that person in the instruction for this turn.
 */
export function describeProfilePersonRead(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '';
  const possessive = trimmed.endsWith('s') ? `${trimmed}'` : `${trimmed}'s`;
  return `Used ${possessive} details from your profile.`;
}
