/**
 * settings-ingestion.ts — what a reader does with a setting it cannot ingest.
 *
 * ── The rule this file exists to state ────────────────────────────────────
 *
 * A daemon that cannot ingest a setting must say so. Not "log it somewhere",
 * not "fall back quietly" — say the FILE, the KEY, and the REASON, on stderr
 * (where a service journal captures it) and in the activity log (where whoever
 * finds the host later looks), and only then decide whether to carry on.
 *
 * That was not what happened. The settings reader had two silent modes and one
 * loud one, and the loud one was the least useful of the three:
 *
 *   - a value of the wrong SHAPE was ingested as-is. `controlPlane.port` set to
 *     the string "not-a-number" became the live port with no validation, no
 *     warning, and nothing on disk to say so;
 *   - a SECTION of the wrong shape was discarded and replaced by the default.
 *     `"controlPlane": "…"` silently returned the daemon to port 3421 while the
 *     operator's file said otherwise;
 *   - and a file that would not parse at ALL killed the process, taking every
 *     other key in it down over one stray byte.
 *
 * ── Skip or refuse: the rule, per key class ───────────────────────────────
 *
 * The platform's own doctrine for persisted state is validate-by-content and
 * disclose. So the default is to QUARANTINE the single unreadable key — drop
 * it, fall back to the tier below it, say loudly what was dropped and why — and
 * keep serving everything else. A daemon that will not start helps nobody; a
 * daemon running one setting short, loudly, is recoverable.
 *
 * The exception is the class where running WITHOUT the operator's value is
 * worse than not running: a key whose fallback default permits more than the
 * value that was stored. If an operator wrote a permission gate and we cannot
 * read it, resolving to the shipped default can open something they closed. For
 * those keys — {@link SAFETY_GATE_CONFIG_PREFIXES} — the reader refuses, loudly
 * and with the same three facts.
 *
 * A whole file that does not parse is also a refusal, for the same reason: an
 * unreadable file may have held a safety-gate key, and the reader cannot tell.
 *
 * A credential is deliberately NOT in the refusing class. A daemon missing a
 * mailbox password runs with one connector down; that is a degraded surface,
 * not an open door, and it is exactly the case that must not crash-loop.
 */

import { CONFIG_SCHEMA, DEFAULT_CONFIG } from './schema.js';
import type { ConfigSetting } from './schema.js';
import { listDaemonOwnedConfigPaths } from './config-ownership.js';
import { deleteRawDotPath } from './settings-io.js';
import { readDotPath } from './shared-config-tier.js';
import { isSecretBearingConfigKey, SECRET_BEARING_CONFIG_PATHS } from './secret-bearing-config-keys.js';
import { describeMalformedSecretRef, looksLikeSecretRef } from './secret-ref-refusal.js';
import { normalizeSecretRef } from './secret-refs.js';
import {
  describeFloorRefusal,
  readerIsBelowFloor,
  readSettingsReaderFloor,
  stripSettingsReaderFloor,
} from './settings-reader-floor.js';
import { VERSION } from '../version.js';
import { logger } from '../utils/logger.js';
import { writeFatalLine } from '../daemon/fatal-boot-report.js';

/** What the reader did with a setting it could not ingest. */
export type SettingsIngestionAction = 'skipped' | 'refused';

/** One setting that did not make it into the resolved config, and why. */
export interface SettingsIngestionNotice {
  /** Absolute path of the settings file the value came from. */
  readonly file: string;
  /** The dot-path key, or the file itself when the failure is whole-file. */
  readonly key: string;
  /** Why it could not be ingested. Never contains a credential value. */
  readonly reason: string;
  /** What the operator can do about it. */
  readonly remedy: string;
  readonly action: SettingsIngestionAction;
}

/** Thrown when a setting is in the class that must not be silently dropped. */
export class SettingsIngestionRefusal extends Error {
  readonly notice: SettingsIngestionNotice;
  constructor(notice: SettingsIngestionNotice) {
    super(`${notice.file}: ${notice.key} — ${notice.reason}. ${notice.remedy}`);
    this.name = 'SettingsIngestionRefusal';
    this.notice = notice;
  }
}

/**
 * The key classes where a fallback to the shipped default can permit more than
 * the operator's stored value did — so an unreadable value is refused rather
 * than skipped.
 *
 * A declared list rather than a name pattern, for the reason
 * secret-bearing-config-keys.ts already gives: a pattern is a habit, and every
 * key that does not fit the habit is silently outside it. This list is short on
 * purpose. Everything absent from it quarantines and the daemon keeps serving.
 */
export const SAFETY_GATE_CONFIG_PREFIXES: readonly string[] = [
  // Per-tool approval. Shipped defaults are `allow` and `prompt`; the strictest
  // value an operator can store is `deny`. Falling back therefore opens a gate
  // they closed, which is the whole hazard.
  'permissions.tools.',
  // The approval mode. Default `prompt`; `plan` is stricter.
  'permissions.mode',
  // Which permission engine decides. Default `baseline`; `policy-engine` is the
  // one that actually enforces a policy bundle.
  'permissions.engine',
  // The policy domain in full. Every key in it exists to make a restriction
  // take effect — the registry switch, the signed-bundle requirement, and the
  // source and path the bundle loads from. Every shipped default leaves the
  // restriction OFF, so a fallback silently stops enforcing whatever the
  // operator turned on.
  'policy.',
];

/**
 * Deliberately NOT in the list above, and why, because the omissions are the
 * part someone will want to re-argue:
 *
 *   - `danger.*`, `behavior.autoApprove`, `controlPlane.allowRemote`,
 *     `controlPlane.trustProxy` all ship as `false`, and `sandbox.enabled`
 *     ships as `true`. For every one of them the shipped default is the
 *     RESTRICTIVE value, so falling back to it can only ever close something,
 *     never open it. Refusing to start over these would trade a safe fallback
 *     for a dead daemon.
 *   - credential keys: a daemon short a mailbox password runs with one
 *     connector down. That is a degraded surface, not an open door, and it is
 *     exactly the case that must not crash-loop.
 */

/** True when an unreadable value at this key must refuse rather than skip. */
export function isSafetyGateConfigKey(key: string): boolean {
  return SAFETY_GATE_CONFIG_PREFIXES.some((prefix) => (
    prefix.endsWith('.') ? key.startsWith(prefix) : key === prefix
  ));
}

/** True when any safety-gate key lives at or under this section path. */
function sectionHoldsSafetyGate(path: string): boolean {
  const prefix = `${path}.`;
  return SAFETY_GATE_CONFIG_PREFIXES.some((gate) => gate.startsWith(prefix) || prefix.startsWith(gate));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A value's shape, for a diagnostic that must never print a credential. */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return `a ${typeof value}`;
}

/**
 * How to name the offending value. A credential-bearing key is described by
 * SHAPE only — a wrong-shaped password is still a password someone pasted.
 */
function describeOffendingValue(key: string, value: unknown): string {
  if (isSecretBearingConfigKey(key)) return describeShape(value);
  if (typeof value === 'string') return `${describeShape(value)} ${JSON.stringify(value.slice(0, 80))}`;
  if (isPlainObject(value)) return 'an object';
  return `${describeShape(value)} ${JSON.stringify(value) ?? 'undefined'}`;
}

/** Why this value fails its schema entry, or null when it does not. */
function schemaFailure(setting: ConfigSetting, value: unknown): string | null {
  const named = describeOffendingValue(setting.key, value);
  switch (setting.type) {
    case 'boolean':
      if (typeof value !== 'boolean') return `expects true or false, found ${named}`;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `expects a number, found ${named}`;
      break;
    case 'string':
      if (typeof value !== 'string') return `expects text, found ${named}`;
      break;
    case 'enum': {
      const allowed = setting.enumValues ?? [];
      if (typeof value !== 'string' || !allowed.includes(value)) {
        return `expects one of ${allowed.join(', ')}, found ${named}`;
      }
      break;
    }
    case 'object':
      if (value === null || typeof value !== 'object') return `expects a structured value, found ${named}`;
      break;
  }
  if (setting.validate && !setting.validate(value)) {
    const hint = setting.validationHint ? ` (${setting.validationHint})` : '';
    return `holds a value the setting rejects${hint}, found ${named}`;
  }
  return null;
}

/** Every dot-path this reader knows how to ingest, from all three declarations. */
function knownIngestiblePaths(): ReadonlySet<string> {
  if (knownPathCache) return knownPathCache;
  const paths = new Set<string>();
  for (const setting of CONFIG_SCHEMA) paths.add(setting.key);
  for (const path of listDaemonOwnedConfigPaths()) paths.add(path);
  const walk = (value: Record<string, unknown>, prefix: string): void => {
    for (const [name, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${name}` : name;
      paths.add(path);
      if (isPlainObject(child)) walk(child, path);
    }
  };
  walk(DEFAULT_CONFIG as unknown as Record<string, unknown>, '');
  knownPathCache = paths;
  return paths;
}
let knownPathCache: ReadonlySet<string> | null = null;

/** Known leaf names grouped by the section that holds them. */
function knownNamesBySection(): ReadonlyMap<string, ReadonlySet<string>> {
  if (knownNameCache) return knownNameCache;
  const sections = new Map<string, Set<string>>();
  for (const path of knownIngestiblePaths()) {
    const cut = path.lastIndexOf('.');
    const section = cut === -1 ? '' : path.slice(0, cut);
    const name = cut === -1 ? path : path.slice(cut + 1);
    const bucket = sections.get(section) ?? new Set<string>();
    bucket.add(name);
    sections.set(section, bucket);
  }
  knownNameCache = sections;
  return sections;
}
let knownNameCache: ReadonlyMap<string, ReadonlySet<string>> | null = null;

/**
 * The known setting this unknown name looks like a newer FORM of, or null.
 *
 * The observed case is `clientSecretRef` written where a reader knows
 * `clientSecret` — a migration adding a suffix to a key an older reader already
 * has. Prefix in either direction catches that, and catches nothing else: a
 * genuinely unrelated key in the same section shares no prefix with anything
 * and stays unremarked, because an app-layer section is allowed to carry keys
 * the SDK has never heard of.
 */
function knownFormOf(section: string, name: string): string | null {
  const known = knownNamesBySection().get(section);
  if (!known || known.has(name)) return null;
  const lower = name.toLowerCase();
  for (const candidate of known) {
    const other = candidate.toLowerCase();
    if (other === lower) continue;
    if (lower.startsWith(other) || other.startsWith(lower)) return `${section}.${candidate}`;
  }
  return null;
}

/**
 * Build a notice, deciding skip-versus-refuse from the key class and saying
 * what that decision MEANS in the remedy. A skipped key resolves to its
 * default; a refused key does not resolve at all, because resolving it to a
 * default is the hazard.
 */
function notice(
  file: string,
  key: string,
  reason: string,
  fix: string,
  refused = isSafetyGateConfigKey(key),
): SettingsIngestionNotice {
  return {
    file,
    key,
    reason,
    remedy: refused
      ? `${fix}; this key decides what may run, so falling back to the shipped default could permit more than you stored — nothing starts until it is readable`
      : `${fix}; until then ${key} resolves to its default`,
    action: refused ? 'refused' : 'skipped',
  };
}

/**
 * Sections whose shape is wrong: the defaults hold an object here and the file
 * holds something else. Left alone, the deep merge discards these silently and
 * the daemon runs on defaults while the operator's file says otherwise.
 */
function screenSectionShapes(
  raw: Record<string, unknown>,
  file: string,
  found: SettingsIngestionNotice[],
): void {
  const walk = (defaults: Record<string, unknown>, prefix: string): void => {
    for (const [name, defaultChild] of Object.entries(defaults)) {
      if (!isPlainObject(defaultChild)) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      const hit = readDotPath(raw, path);
      if (!hit.present) continue;
      if (!isPlainObject(hit.value)) {
        found.push(notice(
          file,
          path,
          `is a section of settings, but the file holds ${describeShape(hit.value)} here`,
          `remove the ${path} entry or restore it to an object`,
          sectionHoldsSafetyGate(path),
        ));
        deleteRawDotPath(raw, path);
        continue;
      }
      walk(defaultChild, path);
    }
  };
  walk(DEFAULT_CONFIG as unknown as Record<string, unknown>, '');
}

/** Known keys whose stored value fails the schema entry that defines them. */
function screenSchemaValues(
  raw: Record<string, unknown>,
  file: string,
  found: SettingsIngestionNotice[],
): void {
  for (const setting of CONFIG_SCHEMA) {
    const hit = readDotPath(raw, setting.key);
    if (!hit.present) continue;
    const failure = schemaFailure(setting, hit.value);
    if (!failure) continue;
    found.push(notice(file, setting.key, failure, 'fix the value or remove the key'));
    deleteRawDotPath(raw, setting.key);
  }
}

/**
 * Credential keys holding something SHAPED like a `goodvibes://secrets/…`
 * reference that does not parse as one.
 *
 * The value is never named — see secret-ref-refusal.ts, where refusing to hand
 * a mistyped reference to a transport as the credential was the whole point.
 * The shape is enough to fix a typo.
 */
function screenSecretReferences(
  raw: Record<string, unknown>,
  file: string,
  found: SettingsIngestionNotice[],
): void {
  for (const key of SECRET_BEARING_CONFIG_PATHS) {
    const hit = readDotPath(raw, key);
    if (!hit.present || typeof hit.value !== 'string') continue;
    if (!looksLikeSecretRef(hit.value) || normalizeSecretRef(hit.value) !== null) continue;
    found.push(notice(
      file,
      key,
      `holds a secret reference that cannot be resolved: ${describeMalformedSecretRef(hit.value)}`,
      'fix the reference — nothing was sent and the credential was not used',
      // A credential is never in the refusing class: one connector down is a
      // degraded surface, not an open door, and it must not crash-loop.
      false,
    ));
    deleteRawDotPath(raw, key);
  }
}

/**
 * Keys this reader does not know that look like a newer form of one it does.
 *
 * These are NOT removed. An unknown key is data the reader cannot classify, and
 * the file may be shared with a component that understands it perfectly well —
 * deleting it would destroy a newer component's setting. It is announced,
 * because "ignored in silence" is how a migrated setting became a daemon that
 * looked configured and behaved as if it were not.
 */
function screenUnknownForms(
  raw: Record<string, unknown>,
  file: string,
  found: SettingsIngestionNotice[],
): void {
  const known = knownIngestiblePaths();
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [name, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${name}` : name;
      // The unknown key may itself hold an object — the observed shape was
      // `clientSecretRef` growing into a `{ ref, … }` record under a newer
      // component. Checking the path BEFORE descending is what catches that;
      // descending first only ever finds the leaves inside it.
      if (!known.has(path)) {
        const looksLike = knownFormOf(prefix, name);
        if (looksLike) {
          found.push({
            file,
            key: path,
            reason: `is not a setting this build knows; it looks like a newer form of ${looksLike}`,
            remedy: 'update this component, or remove the key if it is a typo; the value was left in the file untouched',
            action: 'skipped',
          });
          continue;
        }
      }
      if (isPlainObject(value)) walk(value, path);
    }
  };
  walk(raw, '');
}

/** The result of screening one settings file. */
export interface SettingsIngestionResult {
  /** The raw object with every unreadable key removed, safe to merge. */
  readonly config: Record<string, unknown>;
  readonly notices: readonly SettingsIngestionNotice[];
}

/**
 * Screen one parsed settings file: remove what cannot be ingested and report
 * every removal. Does not throw — {@link ingestSettingsFile} decides that.
 */
export function screenSettingsForIngestion(
  raw: Record<string, unknown>,
  file: string,
): SettingsIngestionResult {
  const notices: SettingsIngestionNotice[] = [];
  screenSectionShapes(raw, file, notices);
  screenSchemaValues(raw, file, notices);
  screenSecretReferences(raw, file, notices);
  screenUnknownForms(raw, file, notices);
  return { config: raw, notices };
}

/**
 * Say it on stderr AND in the activity log, in that order.
 *
 * The default writer is a SYNCHRONOUS write to file descriptor 2, not
 * `process.stderr.write`. That is deliberate and load-bearing: the released
 * daemon binary died on exactly this path with zero bytes on either stream,
 * because a host's fatal handler is free to write nowhere and a host is free to
 * replace `process.stderr` (goodvibes-tui does, to keep a rendered screen
 * clean). Disclosing the refusal HERE, at the point of refusal and straight to
 * the descriptor, means every host speaks — including one whose own fatal tail
 * is silent. See daemon/fatal-boot-report.ts.
 *
 * The activity log follows, and is best-effort: on a refusal the process is
 * about to stop, and an asynchronously flushed log is exactly the part that
 * gets discarded. The descriptor write is the guarantee.
 */
export function announceIngestionNotice(
  entry: SettingsIngestionNotice,
  write: (line: string) => void = writeFatalLine,
): void {
  const verb = entry.action === 'refused' ? 'REFUSED' : 'skipped';
  const line = `goodvibes settings: ${verb} ${entry.key} in ${entry.file} — ${entry.reason}. ${entry.remedy}`;
  try {
    write(`${line}\n`);
  } catch {
    // A closed or unwritable stderr must never turn a bad setting into a crash.
  }
  const fields = { file: entry.file, key: entry.key, reason: entry.reason, remedy: entry.remedy };
  if (entry.action === 'refused') logger.error('goodvibes settings: a setting could not be ingested', fields);
  else logger.warn('goodvibes settings: a setting was skipped', fields);
}

/** A one-line, owner-facing summary of one notice, for a startup receipt. */
export function describeIngestionNotice(entry: SettingsIngestionNotice): string {
  const verb = entry.action === 'refused' ? 'refused to start over' : 'ignored';
  return `Settings: ${verb} ${entry.key} in ${entry.file} — ${entry.reason}. ${entry.remedy}`;
}

/** Options for {@link ingestSettingsFile}; all seams are injectable for tests. */
export interface IngestSettingsOptions {
  /** This reader's version, compared against the file's recorded floor. */
  readonly readerVersion?: string | undefined;
  /** Where the loud line goes. Defaults to a synchronous write to fd 2. */
  readonly write?: ((line: string) => void) | undefined;
  /** Called for every notice, refusals included, before a refusal throws. */
  readonly onNotice?: ((entry: SettingsIngestionNotice) => void) | undefined;
  /**
   * The caller's own load-time migrations, run BETWEEN the floor check and the
   * key screen.
   *
   * They have to run first or the screen lies. `sandbox.judgmentAutoApprove` is
   * a retired key the platform's own migration folds into `sandbox.judgment` on
   * every load — screening before that runs reports it as an unknown form of a
   * key the reader knows, which is true of the raw file and false of the config
   * the reader actually builds. A key the platform is about to rewrite itself is
   * not a key the platform does not understand.
   */
  readonly migrate?: ((raw: Record<string, unknown>) => Record<string, unknown>) | undefined;
}

/**
 * The whole ingestion decision for one parsed settings file.
 *
 * Order is the design. The reader-floor check runs FIRST, so a file written by
 * a newer component reports the version mismatch rather than whichever key
 * happened to be shaped in a way this build could not parse — the symptom is
 * never the story. Then the per-key screen; every notice is announced; and a
 * refusal throws only after it has been said in both places.
 */
export function ingestSettingsFile(
  raw: Record<string, unknown>,
  file: string,
  options: IngestSettingsOptions = {},
): SettingsIngestionResult {
  const readerVersion = options.readerVersion ?? VERSION;
  const announce = (entry: SettingsIngestionNotice): void => {
    announceIngestionNotice(entry, options.write);
    options.onNotice?.(entry);
  };

  const floor = readSettingsReaderFloor(raw);
  stripSettingsReaderFloor(raw);
  if (floor && readerIsBelowFloor(readerVersion, floor)) {
    const entry: SettingsIngestionNotice = {
      file,
      key: '(whole file)',
      reason: describeFloorRefusal(file, floor, readerVersion),
      remedy: `update this component to ${floor.minReaderVersion} or newer`,
      action: 'refused',
    };
    announce(entry);
    throw new SettingsIngestionRefusal(entry);
  }

  const result = screenSettingsForIngestion(options.migrate ? options.migrate(raw) : raw, file);
  for (const entry of result.notices) announce(entry);
  const refusal = result.notices.find((entry) => entry.action === 'refused');
  if (refusal) throw new SettingsIngestionRefusal(refusal);
  return result;
}

/**
 * The notice for a file that could not be parsed at all.
 *
 * A refusal, and the one place the skip-by-default rule does not apply: the
 * reader cannot tell whether the unreadable bytes held a safety-gate key, so it
 * cannot know that carrying on is safe. Names the file and the parse error,
 * which is what turns "the daemon will not start" into a two-minute fix.
 */
export function unreadableSettingsFileNotice(file: string, reason: string): SettingsIngestionNotice {
  return {
    file,
    key: '(whole file)',
    reason: `could not be read as JSON: ${reason}`,
    remedy: 'fix or move the file; a settings file that cannot be parsed may hold permission or safety settings, so it is not skipped',
    action: 'refused',
  };
}
