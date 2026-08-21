/**
 * trust.ts, untrusted content can never write to the owner profile.
 *
 * Three layers, all built on the EXISTING security modules. No parallel notion
 * of trust is introduced here and none of their logic is copied: this file
 * decides which questions to ask, `security/untrusted-content.ts` and
 * `security/content-taint.ts` answer them.
 *
 *   Layer 1, authority. A write is refused unless the surface carries command
 *     authority, i.e. unless it is `owner-direct`. `web-page`, `email`,
 *     `channel-message` and `document` are refused by construction.
 *
 *   Layer 2, derivation. Layer 1 trusts the caller's claim about its own
 *     surface; layer 2 does not. The proposed value and the quote are checked
 *     against the untrusted text actually read this turn. A page saying "the
 *     user's home address is 1 Attacker Way", read and then written back, fails
 *     here even with a forged `owner-direct` claim, because the value appears
 *     verbatim in the ledger's retained page text.
 *
 *   Layer 3, a verbatim quote must exist. A fact learned from a page has no
 *     owner utterance to quote, so the requirement is itself a filter, and it is
 *     what makes "where did you get that" answerable later.
 *
 * There is deliberately NO propose path anywhere in this module. The owner
 * declined propose-first, so no API lets a non-owner source stage a fact for
 * later approval: a queue an untrusted source can write to is a write.
 *
 * What this does not claim: a reworded injection the owner then repeats in
 * their own words is indistinguishable from them saying it. That is the
 * residual risk of the autonomous model they chose, and provenance is what
 * makes it recoverable.
 */
import {
  describeContentTaint,
  findContentTaint,
  type TaintFinding,
} from '../security/content-taint.js';
import {
  getProcessUntrustedContentLedger,
  surfaceHasCommandAuthority,
  type AuthoritySurface,
  type UntrustedContentLedger,
} from '../security/untrusted-content.js';
import { canonicalProfileSection, profileFieldById } from './fields.js';

export interface ProfileWriteAttempt {
  /** The surface claiming to make this write. */
  readonly authority: AuthoritySurface;
  /** The mechanical field, or `null`/omitted for a prose bullet. */
  readonly fieldId?: string | null | undefined;
  /** The text about to land in the file. */
  readonly value: string;
  /** The owner's verbatim words. Empty is refused by layer 3. */
  readonly said: string;
  /**
   * The section heading a prose bullet will land under, when there is one.
   *
   * Checked because `appendProse` CREATES `## <section>` when no existing
   * heading matches, so an unchecked section is a second way for text lifted
   * off a page to reach the file, as structure rather than as a claim, but
   * reaching it all the same. Omitted for a mechanical field, which lands in a
   * section chosen by the field registry rather than by the caller.
   */
  readonly section?: string | undefined;
  /** Defaults to the process ledger, which is what production wants. */
  readonly ledger?: UntrustedContentLedger | undefined;
}

export interface ProfileWriteDecision {
  readonly allowed: boolean;
  /** Null exactly when allowed. Names the origin and the overlap when it is a taint refusal. */
  readonly reason: string | null;
  /** The overlapping text, when layer 2 refused. Empty otherwise. */
  readonly taint: readonly TaintFinding[];
}

const ALLOWED: ProfileWriteDecision = { allowed: true, reason: null, taint: [] };

function refuse(reason: string, taint: readonly TaintFinding[] = []): ProfileWriteDecision {
  return { allowed: false, reason, taint };
}

/** What the refusal calls this write, so an operator recognises it. */
function describeTarget(fieldId: string | null | undefined): string {
  if (fieldId === null || fieldId === undefined) return 'adding a note to your profile';
  const def = profileFieldById(fieldId);
  return `saving your ${def?.label ?? fieldId} to your profile`;
}

/** The name of the thing a removal is aimed at. */
function describeRemovalTarget(fieldId: string | null | undefined): string {
  if (fieldId === null || fieldId === undefined) return 'a note in your profile';
  const def = profileFieldById(fieldId);
  return `your ${def?.label ?? fieldId}`;
}

/** No-authority refusal wording, shared by both gates so they read alike. */
function noAuthority(action: string, authority: AuthoritySurface, verb: string): string {
  return (
    `Refused ${action}: content from ${authority} carries no command authority, so it cannot ${verb} `
    + 'facts about you. Only you, speaking directly to the runtime, can.'
  );
}

/**
 * Layer 2, run as TWO passes over the same sources, refusing if either finds
 * derivation.
 *
 * The two passes exist because `findContentTaint` treats a field named in
 * `exactMatchFields` by exact containment and then skips the length checks for
 * it entirely. Listing a field there is therefore strictly WEAKER for long
 * values, a reworded postal address would clear exact containment and never
 * reach the span check. Running both passes means no value's only defence is
 * exact string equality, and no value is exempt from exact containment either.
 *
 *  - Pass 1 catches the long payloads: a postal address, a note, an instruction
 *    lifted from a page, including reworded and partly-quoted forms.
 *  - Pass 2 catches the short high-signal ones: an email address, a phone
 *    number, an agent alias, all under both the 8-word and 40-character
 *    thresholds, where the whole value IS the payload.
 */
function findProfileTaint(
  value: string,
  said: string,
  section: string | undefined,
  ledger: UntrustedContentLedger,
): readonly TaintFinding[] {
  // Pass 1, length-based derivation, over a window one turn boundary wide.
  //
  // NOT `taintSourcesThisTurn()`. The gateway starts a turn as the first
  // statement of `invokeGatewayMethodCall`, before dispatch, so a `profile.set`
  // that declares `explicitUserRequest: true` moved the watermark past the page
  // it had just read and this check then saw an empty corpus. Measured: the
  // same write refused with the page in the window was ALLOWED after one
  // `startTurnForOwnerRequest(true)`. The window that survives the boundary the
  // gated call itself crosses is the smallest honest one.
  //
  // `section` rides pass 1 rather than pass 2 on purpose: a canonical heading
  // is one short word, and exact containment of "Notes" against any page that
  // happens to use that word would refuse every legitimate note. The 8-word /
  // 40-character thresholds here cannot fire on a short heading, and do fire on
  // a sentence lifted off a page and used as one.
  const recent = ledger.taintSourcesSinceLastTurnBoundary();
  if (recent.length > 0) {
    const lengthBased = findContentTaint(
      section === undefined ? { value, said } : { value, said, section },
      recent,
      {},
    );
    if (lengthBased.length > 0) return lengthBased;
  }

  // Pass 2, exact containment, over EVERYTHING retained.
  //
  // A value that appears verbatim inside something a stranger wrote is not a
  // coincidence however many turns ago it was read, and scoping this one to a
  // turn would let an attacker defeat it by waiting. It is safe to widen only
  // because it is exact: the fuzzy check above stays bounded so it cannot start
  // refusing ordinary work and get itself switched off.
  //
  // A non-canonical section is included here too, a made-up heading lifted
  // verbatim is the case pass 1's length floor cannot see, while a canonical
  // one is left out for the "Notes" reason above.
  const retained = ledger.taintSourcesRetained();
  if (retained.length === 0) return [];
  const madeUpSection = section !== undefined && canonicalProfileSection(section) === null
    ? section
    : undefined;
  return madeUpSection === undefined
    ? findContentTaint({ value }, retained, { exactMatchFields: ['value'] })
    : findContentTaint(
      { value, section: madeUpSection },
      retained,
      { exactMatchFields: ['value', 'section'] },
    );
}

/**
 * The gate every profile write passes through.
 *
 * Ordered as the design states them, cheapest and most absolute first: a
 * `web-page` claim never reaches the taint check, and a write with no quote is
 * refused whether or not anything untrusted was read.
 */
export function evaluateProfileWrite(input: ProfileWriteAttempt): ProfileWriteDecision {
  // Layer 1, authority.
  if (!surfaceHasCommandAuthority(input.authority)) {
    return refuse(
      `${noAuthority(describeTarget(input.fieldId), input.authority, 'record')} `
      + 'Tell the runtime yourself and it will record it.',
    );
  }

  // Layer 2, derivation, which does not take the caller's word for layer 1.
  const ledger = input.ledger ?? getProcessUntrustedContentLedger();
  const taint = findProfileTaint(input.value, input.said, input.section, ledger);
  if (taint.length > 0) {
    return refuse(describeContentTaint(describeTarget(input.fieldId), taint), taint);
  }

  // Layer 3, a verbatim quote must exist.
  if (input.said.trim().length === 0) {
    return refuse(
      `Refused ${describeTarget(input.fieldId)}: a recorded fact must carry the words you said that `
      + 'produced it, so you can see later where it came from. There are none here.',
    );
  }

  return ALLOWED;
}

export interface ProfileRemovalAttempt {
  readonly authority: AuthoritySurface;
  /** The mechanical field, or `null`/omitted for a prose bullet. */
  readonly fieldId?: string | null | undefined;
}

/**
 * The gate on `forget` and `undo`.
 *
 * Removing a fact is a write. An injection that cannot ADD one could otherwise
 * still DELETE one, "forget the user's shipping address" is tampering and
 * denial rather than exfiltration, but it is squarely inside what the
 * untrusted-content boundary exists to stop, and deleting `contact.email` would
 * be worse still because it is what consumers fall back to.
 *
 * Layer 1 is the WHOLE gate here, deliberately. A removal has no value whose
 * derivation could be checked and no owner utterance to quote, so applying
 * layers 2 and 3 would either refuse every legitimate delete or invite a caller
 * to invent a quote to satisfy a check. Authority is the right question and the
 * only honest one: only the owner speaking directly can remove a fact.
 */
export function evaluateProfileRemoval(input: ProfileRemovalAttempt): ProfileWriteDecision {
  if (!surfaceHasCommandAuthority(input.authority)) {
    return refuse(
      noAuthority(`forgetting ${describeRemovalTarget(input.fieldId)}`, input.authority, 'remove'),
    );
  }
  return ALLOWED;
}
