/**
 * owner-profile/ — what the platform knows about the person who owns it.
 *
 * One Markdown file at daemon scope (`~/.goodvibes/daemon/owner-profile.md`),
 * read once into memory, read back out at the cost of a property access. See
 * `docs/owner-profile.md` for the decision record.
 *
 * Naming note: `platform/profiles/` is an unrelated named-config-preset manager.
 * Nothing here is called `Profile` unqualified, so an import list never leaves a
 * reader guessing which of the two a symbol came from.
 *
 * What this barrel deliberately does NOT export: the raw mutation functions in
 * `writer.ts`. Every write the rest of the platform can reach goes through
 * `OwnerProfileStore`, which runs the §7 trust gate first. A gate that can be
 * walked around is not a gate.
 */

export {
  PROFILE_SURFACES,
  isProfileSurface,
  type ProfileChange,
  type ProfileFieldValue,
  type ProfileInvalidField,
  type ProfileLine,
  type ProfileLoadState,
  type ProfileProjection,
  type ProfileProvenance,
  type ProfileSection,
  type ProfileSupersededLine,
  type ProfileSurface,
  type ProfileTier,
  type ProfileWriteResult,
} from './types.js';

export {
  PROFILE_FIELDS,
  PROFILE_SECTIONS,
  PROSE_ONLY_SECTIONS,
  canonicalProfileSection,
  closedTierFieldIds,
  normalizeProfileKey,
  openTierFieldIds,
  profileFieldById,
  profileFieldForLabel,
  profileFieldsForSection,
  profileSectionTier,
  unknownProfileFieldMessage,
  type ProfileFieldDef,
  type ProfileFieldValidation,
  type ProfileFieldValidator,
  type ProfileSectionName,
} from './fields.js';

export {
  findProfileSection,
  findProfileSectionByHeading,
  parseProfileDocument,
  renderProvenanceSuffix,
  splitProvenanceSuffix,
  type ParseProfileInput,
  type ProvenanceSplit,
} from './document.js';

export {
  MAX_MACHINE_LINE_CHARS,
  MAX_MACHINE_VALUE_CHARS,
  persistProfileText,
  type ProfilePersistIo,
} from './writer.js';

export {
  evaluateProfileRemoval,
  evaluateProfileWrite,
  type ProfileRemovalAttempt,
  type ProfileWriteAttempt,
  type ProfileWriteDecision,
} from './trust.js';

export {
  describeProfilePersonRead,
  describeProfileRead,
  describeProfileWrite,
} from './disclosure.js';

export {
  OWNER_PROFILE_FILE,
  ownerProfilePath,
  ownerProfilePathForHome,
  resolveOwnerProfilePath,
  type OwnerProfilePathOptions,
} from './paths.js';

export {
  DEFAULT_PROFILE_RELOAD_THROTTLE_MS,
  OwnerProfileStore,
  type AppendProfileProseInput,
  type ForgetProfileInput,
  type OwnerProfileStoreOptions,
  type ProfileDocumentView,
  type ProfileFieldView,
  type ProfileProvenanceReport,
  type ProfileSectionView,
  type SetProfileFieldInput,
  type UndoProfileInput,
} from './store.js';
