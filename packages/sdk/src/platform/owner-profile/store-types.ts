/**
 * store-types.ts, the input and view shapes `store.ts` takes and answers with.
 *
 * Split out of `store.ts` only because that file reached the repo's 800-line
 * cap. Nothing here has behaviour, and nothing here is a second definition of
 * anything: every shape is the one the store already used, moved verbatim, and
 * `store.ts` re-exports each of them so no import path anywhere else changes.
 * The class and its methods deliberately stayed put, the method list is a
 * tested contract, and moving a method off the class to win lines would break
 * that contract for a reason that has nothing to do with the contract.
 */
import type { AuthoritySurface, UntrustedContentLedger } from '../security/untrusted-content.js';
import type { ProfilePersistIo } from './writer.js';
import type {
  ProfileLine,
  ProfileLoadState,
  ProfileProvenance,
  ProfileSupersededLine,
  ProfileSurface,
  ProfileTier,
} from './types.js';

export interface OwnerProfileStoreOptions {
  /** Explicit path; otherwise resolved from the daemon home. */
  readonly path?: string | undefined;
  /** `profile.enabled`. False means the file is never opened. */
  readonly enabled?: boolean | undefined;
  readonly reloadThrottleMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  /** Ledger for the derivation check; defaults to the process ledger. */
  readonly ledger?: UntrustedContentLedger | undefined;
  /** Injected file operations, so a test can interrupt a write. */
  readonly persistIo?: ProfilePersistIo | undefined;
  /** Called after every reload the watcher causes. */
  readonly onReload?: ((state: ProfileLoadState) => void) | undefined;
}

/** One field as `profile.read` presents it. */
export interface ProfileFieldView {
  readonly fieldId: string;
  readonly label: string;
  readonly value: string;
  readonly valid: boolean;
  readonly invalidReason?: string | undefined;
  readonly provenance?: ProfileProvenance | undefined;
}

export interface ProfileSectionView {
  readonly heading: string;
  readonly tier: ProfileTier;
  readonly fields: readonly ProfileFieldView[];
  readonly prose: readonly ProfileLine[];
}

/** What `profile.read` answers: the whole document, by section. */
export interface ProfileDocumentView {
  readonly state: ProfileLoadState;
  readonly sections: readonly ProfileSectionView[];
}

/** What `profile.provenance` answers for one field. */
export interface ProfileProvenanceReport {
  readonly fieldId: string;
  readonly present: boolean;
  readonly provenance: ProfileProvenance | null;
  /** True when the field is there but carries no suffix: the owner wrote or edited it. */
  readonly handEdited: boolean;
  /** Every `<!-- was: … -->` predecessor, oldest first. */
  readonly superseded: readonly ProfileSupersededLine[];
}

/**
 * Who is writing, and on the strength of what.
 *
 * Exported because `store.ts` names it in a private method signature; it is not
 * re-exported from `store.ts` and is not part of the module barrel, because it
 * was never part of the store's public surface and this split is not the moment
 * to widen it.
 */
export interface WriteIdentity {
  readonly authority: AuthoritySurface;
  readonly surface: ProfileSurface;
  readonly said: string;
  readonly date?: string | undefined;
}

export interface SetProfileFieldInput extends WriteIdentity {
  readonly fieldId: string;
  readonly value: string;
}

export interface AppendProfileProseInput extends WriteIdentity {
  readonly section: string;
  readonly text: string;
}

export interface ForgetProfileInput {
  readonly authority: AuthoritySurface;
  /** A mechanical field, by id. Every line carrying it goes, history included. */
  readonly fieldId?: string | undefined;
  /**
   * A prose line, addressed by the section it sits under plus its exact text.
   *
   * Content rather than position, because the owner is a concurrent writer
   * (docs/owner-profile.md §3, §9.2): an index is only valid against the exact
   * file state that produced it, and between the owner's `profile.read` and
   * their `profile.forget` they can insert a line in their editor and shift
   * everything below. A positional delete then removes the wrong line and
   * reports success.
   * Resolution happens inside the commit callback, against the projection the
   * edit is actually computed from, so a replay after a concurrent edit
   * re-resolves rather than reusing a stale answer.
   */
  readonly section?: string | undefined;
  readonly text?: string | undefined;
  /**
   * INTERNAL. A raw line index, retained because the writer splices by index
   * and the core module's own tests address lines that way.
   *
   * Deliberately NOT a parameter of any verb, `PROFILE_FORGET_INPUT_SCHEMA`
   * does not accept it and `routes/owner-profile.ts` does not read it, so it is
   * unreachable from the control plane. A caller that supplies it gets the
   * non-replayable path: `commit` refuses rather than replaying, because the
   * index named a document that no longer exists.
   */
  readonly lineIndex?: number | undefined;
}

export interface UndoProfileInput {
  readonly authority: AuthoritySurface;
  readonly fieldId: string;
}
