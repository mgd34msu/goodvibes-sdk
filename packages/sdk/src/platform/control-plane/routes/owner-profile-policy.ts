/**
 * routes/owner-profile-policy.ts — the owner's `profile.*` switches, enforced.
 *
 * `schema-domain-owner-profile.ts` declares eight settings and tells the owner
 * in each description what turning it off will do. Three of them —
 * `autonomousWrites`, `discloseWrites`, `discloseClosedTierReads` — had nothing
 * reading them, so the runtime kept recording and kept announcing after he
 * turned them off. A setting whose description promises a behaviour change and
 * delivers none is worse than no setting: he believes he has stopped autonomous
 * recording and he has not. This module is where those three become real.
 *
 * ## Why a wrapper rather than checks inside the store
 *
 * `OwnerProfileStore` is mechanism: it parses, edits lines, and runs the §7
 * trust gate, which is about who may write at all. These three are POLICY —
 * what the owner has asked the platform to do on his behalf — and policy is
 * resolved from live config, which the store deliberately has no access to.
 * The wrapper implements the same `OwnerProfileGatewayService` the handlers
 * consume, so it sits on the one path a surface can reach and cannot be
 * stepped around by a caller holding the catalog.
 *
 * The predicates are read at each call, never snapshotted, so all three are
 * live toggles rather than restart-only ones.
 */
import {
  evaluateProfileWrite,
  type AppendProfileProseInput,
  type ProfileWriteResult,
} from '../../owner-profile/index.js';
import type { OwnerProfileGatewayService } from './owner-profile.js';

/**
 * The verbatim quote a settings-UI edit carries (docs/owner-profile.md §7, §9.3).
 *
 * Named here, once, because two different rules key on it: layer 3 accepts it
 * as the required utterance, and `autonomousWrites` uses it to tell an edit the
 * owner made by hand from a fact the runtime inferred. A second spelling of
 * this string anywhere would silently reclassify every settings edit as an
 * autonomous one.
 */
export const SETTINGS_EDIT_UTTERANCE = '(edited in settings)';

/** True when this write is the owner editing his own file through a UI. */
export function isSettingsEdit(said: string): boolean {
  return said.trim() === SETTINGS_EDIT_UTTERANCE;
}

/** The three owner-facing switches, read live. */
export interface OwnerProfilePolicy {
  /** `profile.autonomousWrites` — may the runtime record what it learns? */
  readonly autonomousWrites: () => boolean;
  /** `profile.discloseWrites` — does an autonomous write announce itself? */
  readonly discloseWrites: () => boolean;
  /** `profile.discloseClosedTierReads` — is a named closed-tier read announced? */
  readonly discloseClosedTierReads: () => boolean;
}

/** Everything permitted and everything announced — the schema defaults. */
export const PERMISSIVE_OWNER_PROFILE_POLICY: OwnerProfilePolicy = {
  autonomousWrites: () => true,
  discloseWrites: () => true,
  discloseClosedTierReads: () => true,
};

const AUTONOMOUS_WRITES_OFF =
  'Refused: you have turned off letting me record facts I learn on my own (profile.autonomousWrites). '
  + 'Your profile is still readable, and you can still edit it yourself — by hand or from settings.';

function refused(reason: string): ProfileWriteResult {
  return { ok: false, reason, changes: [], disclosure: '' };
}

/** Strip the receipt when he has asked not to be told. Never changes the outcome. */
function applyDisclosurePolicy(result: ProfileWriteResult, disclose: boolean): ProfileWriteResult {
  return disclose || result.disclosure === '' ? result : { ...result, disclosure: '' };
}

/**
 * Wrap a store so the owner's three switches actually govern it.
 *
 * `forget` and `undo` pass through untouched, deliberately:
 *
 *  - `autonomousWrites: false` is the "I will curate this myself" mode, and
 *    curating requires being able to delete. Blocking removals when the owner
 *    switched off autonomous LEARNING would turn a preference about what the
 *    machine writes into a lock on his own file.
 *  - `discloseWrites` governs the receipt for a fact the runtime recorded on its
 *    own. §8.3 makes the confirmation of a deletion a separate promise —
 *    "forget that" answers with what went — so it is not silenced here.
 */
export function applyOwnerProfilePolicy(
  service: OwnerProfileGatewayService,
  policy: OwnerProfilePolicy,
): OwnerProfileGatewayService {
  return {
    read: () => service.read(),
    get: (fieldId) => service.get(fieldId),
    person: (name) => service.person(name),
    provenance: (fieldId) => service.provenance(fieldId),
    status: () => service.status(),
    forget: (input) => service.forget(input),
    undo: (input) => service.undo(input),

    set: async (input) => {
      if (!policy.autonomousWrites() && !isSettingsEdit(input.said)) {
        return refused(AUTONOMOUS_WRITES_OFF);
      }
      return applyDisclosurePolicy(await service.set(input), policy.discloseWrites());
    },

    append: async (input) => {
      if (!policy.autonomousWrites() && !isSettingsEdit(input.said)) {
        return refused(AUTONOMOUS_WRITES_OFF);
      }
      const sectionRefusal = refuseTaintedSection(input);
      if (sectionRefusal !== null) return sectionRefusal;
      return applyDisclosurePolicy(await service.append(input), policy.discloseWrites());
    },
  };
}

/**
 * Run the §7 gate over the SECTION HEADING an append will land under.
 *
 * `appendProse` creates `## <section>` when no existing heading matches, so the
 * heading is a second route for text lifted off a page to reach the file. The
 * store's own gate checks the bullet text and the quote; it does not see the
 * section, because a mechanical field's section comes from the field registry
 * rather than from the caller. Checked here, at the one place a caller-supplied
 * section enters the system.
 *
 * This is the same `evaluateProfileWrite` the store runs, with the same ledger
 * and the same two passes — not a second, weaker copy of the rule.
 */
function refuseTaintedSection(input: AppendProfileProseInput): ProfileWriteResult | null {
  const decision = evaluateProfileWrite({
    authority: input.authority,
    fieldId: null,
    value: input.text,
    said: input.said,
    section: input.section,
  });
  return decision.allowed ? null : refused(decision.reason ?? 'Refused.');
}
