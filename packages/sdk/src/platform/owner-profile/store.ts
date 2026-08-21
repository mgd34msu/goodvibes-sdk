/**
 * store.ts, the profile in memory, and the only path to a write.
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
 * §7 gate first, `evaluateProfileWrite` for `set`/`append`,
 * `evaluateProfileRemoval` for `forget`/`undo`. A gate that can be walked around
 * is not a gate, so the module barrel deliberately does not re-export the raw
 * writer functions.
 *
 * ## Reload
 *
 * The model is swapped atomically: the new projection is built completely and
 * only then assigned, so a reader sees the old one or the new one and never a
 * half-built one. A reload that FAILS discards the previous projection and
 * reports unavailable, continuing to serve stale values from a file that can no
 * longer be read is exactly the silent-success failure this design exists to
 * avoid.
 */
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { parseProfileDocument, findProfileSectionByHeading } from './document.js';
import { readProfile, readProfileSync, statOf, type FileStat, type ProfileReadResult } from './store-load.js';
import { describeProfileWrite } from './disclosure.js';
import { PROFILE_SECTIONS, profileFieldById, profileSectionTier } from './fields.js';
import { resolveOwnerProfilePath } from './paths.js';
import { evaluateProfileRemoval, evaluateProfileWrite } from './trust.js';
import {
  appendProse,
  forget as forgetLines,
  forgetProseByText,
  persistProfileText,
  profileTextFromLines,
  setField,
  undo as undoLines,
  type ProfileEditResult,
} from './writer.js';
import type {
  AppendProfileProseInput,
  ForgetProfileInput,
  OwnerProfileStoreOptions,
  ProfileDocumentView,
  ProfileFieldView,
  ProfileProvenanceReport,
  ProfileSectionView,
  SetProfileFieldInput,
  UndoProfileInput,
  WriteIdentity,
} from './store-types.js';
import type {
  ProfileFieldValue,
  ProfileInvalidField,
  ProfileLine,
  ProfileLoadState,
  ProfileProjection,
  ProfileProvenance,
  ProfileSection,
  ProfileWriteResult,
} from './types.js';

/** Default poll interval where `fs.watch` is unavailable. Off the read path. */
export const DEFAULT_PROFILE_RELOAD_THROTTLE_MS = 2000;

/** Collapse the burst of events one save produces into a single reload. */
const WATCH_DEBOUNCE_MS = 25;

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
  /**
   * The stat of the file content the current projection reflects.
   *
   * A write compares against this to notice that the owner edited the file
   * underneath it. Distinct from `ownWrite`, which answers the watcher's
   * different question ("was that event mine?").
   */
  private lastSeen: FileStat | null = null;

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
   * answers "profile is disabled", a stated state, not an empty profile.
   */
  async load(): Promise<ProfileLoadState> {
    return this.adoptRead(await readProfile(this.filePath), this.enabled);
  }

  /**
   * The same load, synchronously, for the ONE caller that cannot await.
   *
   * A daemon composition root is synchronous. Loading asynchronously there left
   * a window in which every verb answered "your profile has not been loaded
   * yet" (not a state §4.4 sanctions) and, worse because nothing logged it, the
   * config fallback answered UNSET and the open-tier block rendered empty. See
   * store-load.ts for why a readiness promise could not have closed that.
   */
  loadSync(): ProfileLoadState {
    return this.adoptRead(readProfileSync(this.filePath), this.enabled);
  }

  /** Turn one read into the load state, or report the profile turned off. */
  private adoptRead(read: ProfileReadResult, enabled: boolean): ProfileLoadState {
    if (!enabled) {
      this.projection = null;
      this.state = { kind: 'disabled', path: this.filePath };
      return this.state;
    }
    if (read.kind === 'error') return this.markUnavailable(read.cause);
    this.lastSeen = read.seen;
    const text = read.kind === 'text' ? read.text : '';
    return this.adopt(parseProfileDocument({ path: this.filePath, text, exists: read.kind === 'text' }));
  }

  /** True when the file on disk is still the content the projection reflects. */
  private matchesLastSeen(current: FileStat): boolean {
    const seen = this.lastSeen;
    return seen !== null && seen.mtimeMs === current.mtimeMs && seen.size === current.size;
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
   * The watch is on the CONTAINING DIRECTORY, filtered by filename, not on the
   * file. The atomic write in `persistProfileText` replaces the file's inode, and
   * an `fs.watch` handle bound to a file is bound to that inode: after the first
   * write it would be watching an unlinked inode and would never fire again. The
   * symptom is the kind that survives review, hand edits work perfectly until
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
  // Reads, pure in-memory, no syscalls
  // -------------------------------------------------------------------------

  /** One mechanical field, or `undefined` when unset, unavailable or disabled. */
  get(fieldId: string): ProfileFieldValue | undefined {
    return this.projection?.fields.get(fieldId);
  }

  /**
   * One section by heading, OPEN TIER ONLY.
   *
   * A closed-tier section returns `undefined`, `People` included. This is the
   * STRUCTURE behind {@link person}'s guarantee rather than a comment asserting
   * it. `section('People')` was an enumerate-all-people call sitting next to the
   * by-name lookup that exists precisely so no such call is available, which
   * re-opens the failure §10 rules out: "the model judged it relevant" is not a
   * boundary, because the model's judgement is the thing an injection attacks.
   *
   * Everything closed is still reachable, by a route that is either named or
   * addressed to him:
   *   - `People`             → {@link person}, by a name he used this turn
   *   - a mechanical field   → {@link get}, by field id
   *   - the whole document   → {@link read}, the owner-disclosure verb
   *
   * A heading he invented is treated as closed. His own sections can hold
   * anything, and defaulting them open would mean a section named by nobody in
   * particular became bulk-readable from a composition path.
   */
  section(name: string): ProfileSection | undefined {
    const found = this.sectionByHeading(name);
    if (found === undefined) return undefined;
    return profileSectionTier(found.heading) === 'open' ? found : undefined;
  }

  /**
   * Unfiltered section lookup, for this class's own use only.
   *
   * `person()` goes through this rather than through the public `section()`, so
   * the tier filter is not something a caller can sidestep by reaching for
   * whichever method happens to skip it, and so tightening the public method
   * cannot silently break the private one.
   */
  private sectionByHeading(name: string): ProfileSection | undefined {
    const projection = this.projection;
    return projection === null ? undefined : findProfileSectionByHeading(projection, name);
  }

  /**
   * The lines about one person, BY NAME.
   *
   * There is deliberately no enumerate-all-people counterpart, and `section()`
   * refusing the closed tier is what makes that true rather than merely stated.
   * A `People` line may reach outbound content only when the owner named that
   * person in this turn's instruction, and the structural guarantee behind that
   * rule is that the only lookup available takes a name.
   *
   * An empty or whitespace-only name returns nothing rather than everything,
   * "he named nobody" must not degrade into "give me all of them", which is the
   * shape this kind of guard usually fails in.
   *
   * Two things make that hold rather than nearly hold:
   *
   *  - The name must contain a LETTER OR DIGIT. `person('-')` used to return
   *    every line in the section: `ProfileLine.text` keeps the `- ` list marker,
   *    and the word-boundary alternative `(^|[^\p{L}\p{N}])` matches at index 0
   *    of every bullet, so one character of punctuation was a complete
   *    enumerate-all call. Rejecting empty-after-trim is not the same test.
   *  - Matching runs against the line with its list marker STRIPPED, so the
   *    marker cannot participate in a boundary match at all. Belt and braces:
   *    either fix alone closes the measured case, and the pair closes the shape.
   */
  person(name: string): readonly ProfileLine[] {
    const trimmed = name.trim();
    if (trimmed.length === 0) return [];
    if (!/[\p{L}\p{N}]/u.test(trimmed)) return [];
    const section = this.sectionByHeading('People');
    if (section === undefined) return [];
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}([^\\p{L}\\p{N}]|$)`, 'iu');
    return section.prose.filter((line) => pattern.test(withoutListMarker(line.text)));
  }

  /**
   * The declared occasions, as raw prose lines.
   *
   * ## Why this is a named method rather than `section('Important dates')`
   *
   * `section()` refuses the closed tier, and this section is closed, it holds
   * family birth dates, which are the single most obvious thing that must never
   * be bulk-injected into a prompt or a message channel. The daemon still has to
   * read the whole section, because the approach sweep's entire job is "which of
   * these is coming up".
   *
   * So it gets a route that is NAMED and narrow, the same shape `person()` has,
   * rather than a widened `section()`. Two properties make that safe rather than
   * merely stated:
   *
   *  - The only consumer is the sweep, and the sweep's OUTPUT, the nudge,
   *    carries the occasion and the person and never the date. The date reaches
   *    a message channel through no path at all.
   *  - There is no generic "give me a closed section" call. Widening this to one
   *    would re-open the enumerate-all hole `section()` exists to close, by a
   *    different name.
   */
  importantDates(): readonly ProfileLine[] {
    return this.sectionByHeading('Important dates')?.prose ?? [];
  }

  /**
   * The declared plans, as raw prose lines. Same reasoning as
   * {@link importantDates}: closed tier, one named consumer, no generic
   * counterpart.
   */
  plans(): readonly ProfileLine[] {
    return this.sectionByHeading('Plans')?.prose ?? [];
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

  /**
   * The whole document, by section, the ONLY method that returns the full
   * `People` section.
   *
   * The asymmetry with {@link section} is deliberate, not an inconsistency.
   * `read()` answers "what do you know about me?": it is him asking about
   * himself, and an answer that silently omitted the section holding facts
   * about the people around him would be a dishonest disclosure, the one place
   * where withholding is the wrong behaviour. `section()` serves a consumer
   * assembling something, where bulk access to that same content is exactly the
   * hole §10 closes.
   *
   * The rule that keeps both true: `read()` is reachable only from the
   * `profile.read` control-plane verb, and never from a composition path. Any
   * other caller reaching for it is the enumerate-all hole by another route,
   * check that before wiring it into anything new.
   */
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
  // Writes, gated, then surgical, then atomic
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
    return this.commit((current) => setField(current, {
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

    const provenance = this.provenanceFor(input);
    return this.commit((current) => appendProse(current, {
      section: input.section,
      text: input.text,
      provenance,
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

    // A prose line addressed by CONTENT resolves inside the callback, so a
    // replay after his concurrent edit re-resolves against the new document
    // instead of reusing an answer computed from the old one. That is the whole
    // reason the verb takes content rather than a position: a stale index is
    // perfectly well-formed, so no validation can catch it.
    if (input.fieldId === undefined && input.text !== undefined) {
      const section = input.section ?? '';
      const wanted = input.text;
      return this.commit(
        (current) => forgetProseByText(current, section, wanted),
        { replayable: true },
      );
    }

    return this.commit((current) => forgetLines(current, {
      ...(input.fieldId === undefined ? {} : { fieldId: input.fieldId }),
      ...(input.lineIndex === undefined ? {} : { lineIndex: input.lineIndex }),
    }), { replayable: input.lineIndex === undefined });
  }

  /** Promote the most recent superseded value back to an active line. */
  async undo(input: UndoProfileInput): Promise<ProfileWriteResult> {
    const projection = this.writableProjection();
    if ('reason' in projection) return refusal(projection.reason);

    const decision = evaluateProfileRemoval({ authority: input.authority, fieldId: input.fieldId });
    if (!decision.allowed) return refusal(decision.reason ?? 'Refused.');

    return this.commit((current) => undoLines(current, input.fieldId));
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
   * Compute an edit against the CURRENT file, persist it, then re-project.
   *
   * ## Why this takes an operation rather than a finished edit
   *
   * §3 says the daemon is the single writer, and that is what makes a
   * rename-based atomic write sufficient with no lock. It is not true. The
   * OWNER is a second writer by design, §4.5 exists precisely so he can open
   * the file and change it, and a write computed from a projection loaded
   * minutes ago joins the whole document, so every line he changed in between is
   * overwritten by a stale copy. It is silent: he gets a success receipt and his
   * edits are simply gone, which is the worst failure this design can have in a
   * file whose entire premise is that his edits win.
   *
   * ## The rule
   *
   * Detect, reload, REPLAY, do not clobber, and do not merely refuse. The
   * file's stat is compared against what this store last saw; if it moved, the
   * document is re-read, re-projected, and the operation is re-run against the
   * fresh projection so his edit and this write both survive. The stat is
   * re-checked immediately before the rename, and a write that keeps losing the
   * race is refused rather than forced.
   *
   * This is not a lock and does not claim to be. It closes the minutes-wide
   * window (a stale projection) and narrows the remaining one to the few
   * milliseconds between the final stat and the rename. Two DAEMONS writing
   * concurrently would still need a real lock; the owner editing his own file
   * while the daemon runs is the case this design actually has, and it is now
   * handled rather than assumed away.
   */
  private async commit(
    operate: (projection: ProfileProjection) => ProfileEditResult,
    options: { readonly replayable?: boolean } = {},
  ): Promise<ProfileWriteResult> {
    const replayable = options.replayable !== false;
    const start = this.projection;
    if (start === null) return refusal('Your profile has not been loaded, so nothing was recorded.');
    let edit = operate(start);
    if (!edit.ok) {
      return { ok: false, reason: edit.reason, changes: [], disclosure: '' };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const onDisk = statOf(this.filePath);
      if (this.matchesLastSeen(onDisk)) break;

      // Someone else, him, wrote to this file since the projection was built.
      const reloaded = await this.load();
      if (reloaded.kind !== 'loaded' || this.projection === null) {
        return refusal(
          reloaded.kind === 'unavailable'
            ? reloaded.reason
            : 'Your profile changed while this was being written and could not be re-read, so nothing was recorded.',
        );
      }
      if (!replayable) {
        // A line-index delete cannot be replayed: the index it named referred to
        // the old document, and re-running it would remove whatever now sits at
        // that position. Refusing is the only honest answer.
        return refusal(
          'Your profile changed while this was being written, and the line to remove was identified by '
          + 'position, so it may no longer be the same line. Nothing was removed, look at the profile and ask again.',
        );
      }
      edit = operate(this.projection);
      if (!edit.ok) return { ok: false, reason: edit.reason, changes: [], disclosure: '' };
      logger.info('owner-profile: replayed a write over a concurrent edit', {
        path: this.filePath,
        attempt: attempt + 1,
        changes: edit.changes.map((change) => change.fieldId ?? change.section),
      });
    }

    if (!this.matchesLastSeen(statOf(this.filePath))) {
      return refusal(
        'Your profile is being changed faster than this write could be applied, so nothing was recorded. '
        + 'Try again in a moment.',
      );
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
    this.lastSeen = this.ownWrite;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A prose line without its bullet or numbered-list marker. */
function withoutListMarker(text: string): string {
  return text.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
}

/** Re-exported so a caller holding a field id can name it without a second import. */
export { profileFieldById };

/**
 * The store's own input and view shapes, which live in `store-types.ts` because
 * this file hit the 800-line cap. Re-exported here so `store.js` remains the one
 * import path for them and nothing downstream had to move.
 */
export type {
  AppendProfileProseInput,
  ForgetProfileInput,
  OwnerProfileStoreOptions,
  ProfileDocumentView,
  ProfileFieldView,
  ProfileProvenanceReport,
  ProfileSectionView,
  SetProfileFieldInput,
  UndoProfileInput,
} from './store-types.js';
