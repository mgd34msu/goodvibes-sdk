/**
 * subject.ts, working out who an occasion is about.
 *
 * ## Why this exists
 *
 * The owner knows when their own birthday is. Reminding them of it at all is
 * questionable; reminding them of it every hour, as this feature did, is the
 * behaviour of something that has not understood what it is for. So "is this
 * occasion about the owner" has to be answerable, and answerable well enough
 * to hang a silence on.
 *
 * ## Why it is not a name check
 *
 * The tempting version reads the title, looks for the owner's name, and stops.
 * That is wrong in both directions, and both directions are real:
 *
 *  - The owner's father may share their name. Silencing "Dad's birthday"
 *    because the word matched would silence the wrong occasion permanently
 *    and invisibly.
 *  - They may go by something the file does not spell the same way.
 *
 * So the resolution is layered, and every layer is evidence rather than a guess:
 *
 *  1. **The line said so.** `for me` / `mine` / `myself` on the line is the
 *     owner stating it. Nothing overrides that, and it is the escape hatch
 *     for every case the rest of this file gets wrong.
 *  2. **The line names a person.** `for Natalie Sons` names a subject, and the
 *     question becomes whether that name is one the owner declared for
 *     themselves.
 *  3. **The title is possessive.** `Jordan's birthday` names its subject in
 *     the only place the grammar leaves for it, and the same comparison
 *     applies.
 *  4. **Nothing names anybody.** `Our anniversary`, `Dad`. UNATTRIBUTED, which
 *     behaves exactly as it always has. This is the safe direction on purpose:
 *     an unresolved subject gets the ordinary cadence, so the failure mode of
 *     this whole file is "the owner gets a nudge they did not need", never
 *     "their wife's birthday went silent".
 *
 * ## What "the owner's own name" means
 *
 * `identity.name` and `identity.goesBy` from the owner's profile, the two
 * fields the document already has for exactly this, read live from their
 * file. There is no name literal in this module and there is none in the
 * tests that matter: the behaviour is "a line whose subject is a name the
 * owner declared for themselves", which is true on any owner's machine and
 * stays true the day they change what they go by.
 */
import { normalizeProfileKey } from '../owner-profile/fields.js';
import type { Occasion, OccasionSubject } from './types.js';

/**
 * The words that mark a line as being about the owner himself.
 *
 * Accepted both bare (`· mine ·`) and behind `for` (`· for me ·`), because both
 * are things a person writes and neither is ambiguous with a person's name.
 */
const SELF_WORDS: readonly string[] = ['me', 'myself', 'mine', 'self'];

/** True when a segment, with or without its `for`, declares the owner. */
export function isSelfAttribution(value: string): boolean {
  return SELF_WORDS.includes(normalizeProfileKey(value));
}

/**
 * The subject a possessive title names, or empty.
 *
 * `Jordan's birthday` → `Jordan`. `Natalie Sons's birthday` → `Natalie Sons`.
 * `Our anniversary` → empty, because it names no one; `birthday` → empty.
 *
 * Deliberately only the possessive. A title is not a sentence to be mined for
 * names, the one place a title reliably names its subject is in front of an
 * apostrophe-s, and reaching further would be the guessing this module exists
 * to avoid.
 */
export function possessiveSubject(title: string): string {
  const match = /^(.+?)['’]s\s+\S/.exec(title.trim());
  return (match?.[1] ?? '').trim();
}

/**
 * Every way the owner refers to themselves, normalised, from their own file.
 *
 * A declared name contributes itself AND its first word, so `identity.name` of
 * "Jordan Reyes" recognises a line written as "Jordan's birthday". The first word
 * only, the last name alone is a family name, and a family name matching would
 * silence every relative sharing it.
 */
export function ownerAliasSet(declaredNames: readonly string[]): ReadonlySet<string> {
  const aliases = new Set<string>();
  for (const raw of declaredNames) {
    const normalized = normalizeProfileKey(raw);
    if (normalized.length === 0) continue;
    aliases.add(normalized);
    const first = normalized.split(' ')[0] ?? '';
    if (first.length > 0) aliases.add(first);
  }
  return aliases;
}

/** What one occasion's attribution resolves to, given the owner's declared names. */
export function resolveOccasionSubject(
  occasion: Pick<Occasion, 'title' | 'person' | 'selfDeclared'>,
  declaredNames: readonly string[],
): OccasionSubject {
  if (occasion.selfDeclared) return 'owner';
  const aliases = ownerAliasSet(declaredNames);

  const named = occasion.person.trim();
  if (named.length > 0) {
    return aliases.has(normalizeProfileKey(named)) ? 'owner' : 'other';
  }

  const fromTitle = possessiveSubject(occasion.title);
  if (fromTitle.length > 0) {
    return aliases.has(normalizeProfileKey(fromTitle)) ? 'owner' : 'other';
  }

  return 'unattributed';
}

/**
 * Whether this occasion may ever be PUSHED at the owner.
 *
 * One rule, and it is narrow on purpose: something about the owner that they
 * only have to remember is something they already know. Their own birthday,
 * their own anniversary of anything. They do not need a message about it,
 * least of all an hourly one, so nothing is sent, and it stays visible to
 * anything that ASKS what is coming up.
 *
 * The narrowness is the load-bearing part. An occasion about the owner that
 * wants an ACTION, `Renew passport · 2026-11-02 · once · gift-giving` is the
 * shape, and the kind is the thing that says an action is wanted, is not
 * covered, and keeps the ordinary two-boundary cadence. They do not know when
 * their passport expires. They do know when they were born.
 */
export function pushableSubject(
  occasion: Pick<Occasion, 'subject' | 'kind'>,
): boolean {
  return !(occasion.subject === 'owner' && occasion.kind === 'remember-only');
}

/** Why an occasion is not pushed, in words a surface can show the owner. */
export function selfOccasionReason(occasion: Pick<Occasion, 'title'>): string {
  return `${occasion.title} is about you and is one to remember rather than act on, `
    + 'so it is kept and answerable but never sent to you.';
}
