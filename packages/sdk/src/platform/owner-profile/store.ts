/**
 * store.ts — the profile in memory, and the only path to a write.
 *
 * ## Speed
 *
 * The owner's ruling was "it needs to be extremely fast". A mechanical read here
 * is `Map.get` against a projection built once at load: no `stat`, no `readFile`,
 * no parse, no lock on the read path. The watcher exists so a hand edit is
 * picked up without a restart; it is not a lookup structure and it never puts a
 * syscall on a read.
 *
 * ## Why the store is the only exported write path
 *
 * `writer.ts` knows how to edit lines and nothing about trust. Every mutation
 * offered to the rest of the platform goes through this class, which runs the
 * §7 gate first — `evaluateProfileWrite` for `set`/`append`,
 * `evaluateProfileRemoval` for `forget`/`undo`. A gate that can be walked around
 * is not a gate, so the module barrel deliberately does not re-export the raw
 * writer functions.
 *
 * ## Reload
 *
 * The model is swapped atomically: the new projection is built completely and
 * only then assigned, so a reader sees the old one or the new one and never a
 * half-built one. A reload that FAILS discards the previous projection and
 * reports unavailable — continuing to serve stale values from a file that can no
 * longer be read is exactly the silent-success failure this design exists to
 * avoid.
 */
import { promises as fs, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type { AuthoritySurface, UntrustedContentLedger } from '../security/untrusted-content.js';
import { parseProfileDocument, findProfileSectionByHeading } from './document.js';
import { describeProfileWrite } from './disclosure.js';
import { PROFILE_SECTIONS, profileFieldById, profileSectionTier } from './fields.js';
import { resolveOwnerProfilePath } from './paths.js';
import { evaluateProfileRemoval, evaluateProfileWrite } from './trust.js';
import {
  appendProse,
  forget as forgetLines,
  persistProfileText,
  profileTextFromLines,
  setField,
  undo as undoLines,
  type ProfileEditResult,
  type ProfilePersistIo,
} from './writer.js';
import type {
  ProfileFieldValue,
  ProfileInvalidField,
  ProfileLine,
  ProfileLoadState,
  ProfileProjection,
  ProfileProvenance,
  ProfileSection,
  ProfileSupersededLine,
  ProfileSurface,
  ProfileTier,
  ProfileWriteResult,
} from './types.js';

/** Default poll interval where `fs.watch` is unavailable. Off the read path. */
export const DEFAULT_PROFILE_RELOAD_THROTTLE_MS = 2000;

/** Collapse the burst of events one save produces into a single reload. */
const WATCH_DEBOUNCE_MS = 25;

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
  /** True when the field is there but carries no suffix: he wrote or edited it. */
  readonly handEdited: boolean;
  /** Every `<!-- was: … -->` predecessor, oldest first. */
  readonly superseded: readonly ProfileSupersededLine[];
}

interface WriteIdentity {
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
  readonly fieldId?: string | undefined;
  readonly lineIndex?: number | undefined;
}

export interface UndoProfileInput {
  readonly authority: AuthoritySurface;
  readonly fieldId: string;
}

export class OwnerProfileStore {
  private readonly filePath: string;
  private readonly enabled: boolean;
  private readonly throttleMs: number;
  private readonly now: () => Date;
  private readonly options: OwnerProfileStoreOptions;

  /** The whole model. Replaced wholesale, never mutated in place. */
  private projection: ProfileProjection | null = null;
  private state: ProfileLoadState;

  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reloading = false;
  /** The stat of the file this store itself last wrote, so its own write is not a change. */
  private ownWrite: { mtimeMs: number; size: number } | null = null;

  constructor(options: OwnerProfileStoreOptions = {}) {
    this.options = options;
    this.filePath = options.path ?? resolveOwnerProfilePath();
    this.enabled = options.enabled ?? true;
    this.throttleMs = options.reloadThrottleMs ?? DEFAULT_PROFILE_RELOAD_THROTTLE_MS;
    this.now = options.now ?? (() => new Date());
    this.state = this.enabled
      ? { kind: 'unavailable', path: this.filePath, reason: 'Your profile has not been loaded yet.' }
      : { kind: 'disabled', path: this.filePath };
  }

  get path(): string {
    return this.filePath;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Read, project, swap.
   *
   * `profile.enabled = false` means the file is not opened at all and every verb
   * answers "profile is disabled" — a stated state, not an empty profile.
   */
  async load(): Promise<ProfileLoadState> {
    if (!this.enabled) {
      this.projection = null;
      this.state = { kind: 'disabled', path: this.filePath };
      return this.state;
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.filePath);
    } catch (error) {
      if (isNotFound(error)) return this.adopt(parseProfileDocument({ path: this.filePath, text: '', exists: false }));
      return this.markUnavailable(summarizeError(error));
    }

    let text: string;
    try {
      // Fatal decoding, not replacement characters: a UTF-16 mis-save decodes to
      // plausible-looking mojibake under a lenient decoder, and the profile would
      // then load "successfully" full of garbage instead of saying it cannot be
      // read. Round-tripping the bytes is the only honest check.
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      // The cause is stated here rather than passed through from the runtime:
      // Node says "The encoded data was not valid for encoding utf-8" and Bun
      // says "invalid byte sequence", and he should read the same sentence
      // either way — one that names the encoding, since "saved as UTF-16" is
      // the accident behind almost every occurrence.
      return this.markUnavailable(`its bytes are not valid UTF-8 (${summarizeError(error)})`);
    }

    return this.adopt(parseProfileDocument({ path: this.filePath, text, exists: true }));
  }

  /** Build the status from a finished projection, then swap both in one step. */
  private adopt(projection: ProfileProjection): ProfileLoadState {
    const invalidFields: ProfileInvalidField[] = [];
    for (const value of projection.fields.values()) {
      if (!value.valid) {
        invalidFields.push({ fieldId: value.fieldId, reason: value.invalidReason ?? 'invalid value' });
      }
    }
    let proseLineCount = 0;
    for (const section of projection.sections) proseLineCount += section.prose.length;

    const state: ProfileLoadState = {
      kind: 'loaded',
      path: projection.path,
      exists: projection.exists,
      lineCount: projection.rawLines.length,
      fieldCount: projection.fields.size,
      proseLineCount,
      sections: projection.sections.map((section) => section.heading).filter((heading) => heading.length > 0),
      invalidFields,
    };
    this.projection = projection;
    this.state = state;
    // Counts and field names only. A value never reaches a log at any level.
    logger.debug('owner-profile: loaded', {
      path: projection.path,
      exists: projection.exists,
      lines: state.lineCount,
      fields: state.fieldCount,
      proseLines: proseLineCount,
      invalidFields: invalidFields.map((entry) => entry.fieldId),
    });
    return state;
  }

  /**
   * Report unavailable and DROP the previous projection.
   *
   * Keeping it would mean a broken file silently kept answering with values that
   * no longer correspond to anything on disk.
   */
  private markUnavailable(cause: string): ProfileLoadState {
    this.projection = null;
    this.state = {
      kind: 'unavailable',
      path: this.filePath,
      reason: `Your profile could not be read: ${cause} (${this.filePath})`,
    };
    logger.warn('owner-profile: unavailable', { path: this.filePath, cause });
    return this.state;
  }

  // -------------------------------------------------------------------------
  // Watching
  // -------------------------------------------------------------------------

  /**
   * Pick up a hand edit without a restart.
   *
   * The watch is on the CONTAINING DIRECTORY, filtered by filename — not on the
   * file. The atomic write in `persistProfileText` replaces the file's inode, and
   * an `fs.watch` handle bound to a file is bound to that inode: after the first
   * write it would be watching an unlinked inode and would never fire again. The
   * symptom is the kind that survives review — hand edits work perfectly until
   * the first autonomous write, then are ignored forever with no way to tell why.
   *
   * Where `fs.watch` throws (some filesystems, some containers) a throttled
   * `stat` poll takes over. Neither path touches a read.
   */
  watch(): void {
    if (!this.enabled || this.watcher !== null || this.pollTimer !== null) return;
    const dir = dirname(this.filePath);
    const base = basename(this.filePath);
    try {
      this.watcher = watch(dir, (_event, name) => {
        // `name` is null on some platforms: treat it as "something here changed"
        // and let the mtime check decide, rather than dropping the event.
        if (name !== null && name !== undefined && basename(String(name)) !== base) return;
        this.scheduleReload();
      });
      this.watcher.on('error', (error) => {
        logger.warn('owner-profile: directory watch failed, falling back to polling', {
          path: this.filePath,
          error: summarizeError(error),
        });
        this.closeWatcher();
        this.startPolling();
      });
    } catch (error) {
      logger.warn('owner-profile: fs.watch unavailable, polling instead', {
        path: this.filePath,
        error: summarizeError(error),
      });
      this.startPolling();
    }
  }

  /** Stop watching. Safe to call when nothing is running. */
  unwatch(): void {
    this.closeWatcher();
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    let previous = statOf(this.filePath);
    this.pollTimer = setInterval(() => {
      const current = statOf(this.filePath);
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
      previous = current;
      this.scheduleReload();
    }, Math.max(1, this.throttleMs));
    this.pollTimer.unref?.();
  }

  /** Collapse a burst of events into one reload, skipping this store's own write. */
  private scheduleReload(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.reloadIfChanged();
    }, WATCH_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  private async reloadIfChanged(): Promise<void> {
    if (this.reloading) return;
    const observed = statOf(this.filePath);
    const own = this.ownWrite;
    if (own !== null && own.mtimeMs === observed.mtimeMs && own.size === observed.size) return;
    this.reloading = true;
    try {
      const state = await this.load();
      this.options.onReload?.(state);
    } finally {
      this.reloading = false;
    }
  }

  // -------------------------------------------------------------------------
  // Reads — pure in-memory, no syscalls
  // -------------------------------------------------------------------------

  /** One mechanical field, or `undefined` when unset, unavailable or disabled. */
  get(fieldId: string): ProfileFieldValue | undefined {
    return this.projection?.fields.get(fieldId);
  }

  /** One section by heading, matched case-insensitively with whitespace collapsed. */
  section(name: string): ProfileSection | undefined {
    const projection = this.projection;
    return projection === undefined || projection === null
      ? undefined
      : findProfileSectionByHeading(projection, name);
  }

  /**
   * The lines about one person, BY NAME.
   *
   * There is deliberately no enumerate-all-people counterpart. A `People` line
   * may reach outbound content only when the owner named that person in this
   * turn's instruction, and the structural guarantee behind that rule is that
   * the only lookup available takes a name.
   */
  person(name: string): readonly ProfileLine[] {
    const trimmed = name.trim();
    if (trimmed.length === 0) return [];
    const section = this.section('People');
    if (section === undefined) return [];
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}([^\\p{L}\\p{N}]|$)`, 'iu');
    return section.prose.filter((line) => pattern.test(line.text));
  }

  /** Provenance for one field, plus every superseded predecessor. */
  provenance(fieldId: string): ProfileProvenanceReport {
    const value = this.projection?.fields.get(fieldId);
    const superseded = this.projection?.superseded.get(fieldId) ?? [];
    return {
      fieldId,
      present: value !== undefined,
      provenance: value?.provenance ?? null,
      handEdited: value !== undefined && value.provenance === undefined,
      superseded,
    };
  }

  /** The whole document, by section. Not callable from a composition path. */
  read(): ProfileDocumentView {
    const projection = this.projection;
    if (projection === null) return { state: this.state, sections: [] };
    const sections = projection.sections
      .filter((section) => section.heading.length > 0 || section.prose.length > 0)
      .map((section) => this.viewOf(section, projection));
    return { state: this.state, sections };
  }

  private viewOf(section: ProfileSection, projection: ProfileProjection): ProfileSectionView {
    const fields: ProfileFieldView[] = [];
    for (const fieldId of section.fields) {
      const value = projection.fields.get(fieldId);
      if (value === undefined) continue;
      fields.push({
        fieldId,
        label: value.label,
        value: value.value,
        valid: value.valid,
        ...(value.invalidReason === undefined ? {} : { invalidReason: value.invalidReason }),
        ...(value.provenance === undefined ? {} : { provenance: value.provenance }),
      });
    }
    return {
      heading: section.heading,
      tier: profileSectionTier(section.heading),
      fields,
      prose: section.prose,
    };
  }

  /** Load state, path, section names, counts and invalid fields. Never a value. */
  status(): ProfileLoadState {
    return this.state;
  }

  /** The canonical section names, for a caller building a settings surface. */
  static sections(): readonly string[] {
    return PROFILE_SECTIONS;
  }

  // -------------------------------------------------------------------------
  // Writes — gated, then surgical, then atomic
  // -------------------------------------------------------------------------

  /** Write or supersede a mechanical field. */
  async set(input: SetProfileFieldInput): Promise<ProfileWriteResult> {
    const projection = this.writableProjection();
    if ('reason' in projection) return refusal(projection.reason);

    const decision = evaluateProfileWrite({
      authority: input.authority,
      fieldId: input.fieldId,
      value: input.value,
      said: input.said,
      ...(this.options.ledger === undefined ? {} : { ledger: this.options.ledger }),
    });
    if (!decision.allowed) return refusal(decision.reason ?? 'Refused.');

    const provenance = this.provenanceFor(input);
    return this.commit(setField(projection.value, {
      fieldId: input.fieldId,
      value: input.value,
      provenance,
      supersededOn: provenance.date,
    }));
  }

  /** Add a prose bullet to a section. */
  async append(input: AppendProfileProseInput): Promise<ProfileWriteResult> {
    const projection = this.writableProjection();
    if ('reason' in projection) return refusal(projection.reason);

    const decision = evaluateProfileWrite({
      authority: input.authority,
      fieldId: null,
      value: input.text,
      said: input.said,
      ...(this.options.ledger === undefined ? {} : { ledger: this.options.ledger }),
    });
    if (!decision.allowed) return refusal(decision.reason ?? 'Refused.');

    return this.commit(appendProse(projection.value, {
      section: input.section,
      text: input.text,
      provenance: this.provenanceFor(input),
    }));
  }

  /** Delete a line and, for a field, every history comment it left behind. */
  async forget(input: ForgetProfileInput): Promise<ProfileWriteResult> {
    const projection = this.writableProjection();
    if ('reason' in projection) return refusal(projection.reason);

    const decision = evaluateProfileRemoval({
      authority: input.authority,
      fieldId: input.fieldId ?? null,
    });
    if (!decision.allowed) return refusal(decision.reason ?? 'Refused.');

    return this.commit(forgetLines(projection.value, {
      ...(input.fieldId === undefined ? {} : { fieldId: input.fieldId }),
      ...(input.lineIndex === undefined ? {} : { lineIndex: input.lineIndex }),
    }));
  }

  /** Promote the most recent superseded value back to an active line. */
  async undo(input: UndoProfileInput): Promise<ProfileWriteResult> {
    const projection = this.writableProjection();
    if ('reason' in projection) return refusal(projection.reason);

    const decision = evaluateProfileRemoval({ authority: input.authority, fieldId: input.fieldId });
    if (!decision.allowed) return refusal(decision.reason ?? 'Refused.');

    return this.commit(undoLines(projection.value, input.fieldId));
  }

  private provenanceFor(input: WriteIdentity): ProfileProvenance {
    return {
      surface: input.surface,
      date: input.date ?? this.now().toISOString().slice(0, 10),
      said: input.said,
    };
  }

  /** The projection a write may edit, or the reason there is not one. */
  private writableProjection(): { value: ProfileProjection } | { reason: string } {
    if (!this.enabled) return { reason: 'Your profile is turned off, so nothing was recorded.' };
    const projection = this.projection;
    if (projection === null) {
      return {
        reason: this.state.kind === 'unavailable'
          ? this.state.reason
          : 'Your profile has not been loaded, so nothing was recorded.',
      };
    }
    return { value: projection };
  }

  /**
   * Persist an edit, then re-project from the lines just written.
   *
   * Re-projecting in memory rather than re-reading is correct because those are
   * exactly the bytes that reached the disk, and it keeps a write off the read
   * path too. If the persist throws, the in-memory model is left untouched: the
   * file on disk and the model still agree, which is the invariant that matters.
   */
  private async commit(edit: ProfileEditResult): Promise<ProfileWriteResult> {
    if (!edit.ok) {
      return { ok: false, reason: edit.reason, changes: [], disclosure: '' };
    }
    const text = profileTextFromLines(edit.lines);
    try {
      await persistProfileText(this.filePath, text, this.options.persistIo);
    } catch (error) {
      logger.warn('owner-profile: write failed', {
        path: this.filePath,
        fields: edit.changes.map((change) => change.fieldId ?? change.section),
        error: summarizeError(error),
      });
      return {
        ok: false,
        reason: `Your profile could not be written: ${summarizeError(error)} (${this.filePath})`,
        changes: [],
        disclosure: '',
      };
    }

    this.ownWrite = statOf(this.filePath);
    this.adopt(parseProfileDocument({ path: this.filePath, text, exists: true }));
    logger.info('owner-profile: wrote', {
      path: this.filePath,
      changes: edit.changes.map((change) => ({ kind: change.kind, field: change.fieldId ?? change.section })),
    });
    return {
      ok: true,
      reason: null,
      changes: edit.changes,
      disclosure: describeProfileWrite(edit.changes),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refusal(reason: string): ProfileWriteResult {
  return { ok: false, reason, changes: [], disclosure: '' };
}

interface FileStat {
  readonly mtimeMs: number;
  readonly size: number;
}

/** A missing file is a real state (zeros), not an error. */
function statOf(path: string): FileStat {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Re-exported so a caller holding a field id can name it without a second import. */
export { profileFieldById };
