/**
 * diagnostics.ts, where a voice failure is written down.
 *
 * A wake word fired, an utterance was captured, transcription failed, and the
 * reason was handed to `notify()` and persisted NOWHERE. The user saw one line
 * in a scrolling UI; by the time anyone asked what happened, the only record
 * was gone. Every question that followed, which provider ran, where its config
 * came from, what the exception actually said, was unanswerable from disk.
 *
 * So a failure on the voice path lands here, with the three facts that make it
 * diagnosable: the PROVIDER that ran, the CONFIG SOURCE it was resolved from,
 * and the exception string verbatim. Successes are recorded too, but only the
 * route-defining ones (which path transcribed), because "it worked, over the
 * connected host" is what turns "it broke" into "it broke after switching".
 *
 * This is a persisted store, so it does the housekeeping every persisted store
 * owes: bounded by COUNT and by AGE on every write, content-validated on read
 * (a torn file is quarantined rather than served), and written atomically so a
 * crash mid-write cannot leave a half-entry that reads as data.
 */
import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { join } from 'node:path';

/** File name of the voice diagnostics log within a surface's managed voice root. */
export const VOICE_DIAGNOSTICS_FILE = 'voice-diagnostics.json';

/** Newest entries kept. Older ones are dropped on the next write. */
export const VOICE_DIAGNOSTICS_MAX_ENTRIES = 50;

/** Entries older than this are dropped on the next write. */
export const VOICE_DIAGNOSTICS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Which path handled (or tried to handle) the audio. */
export type VoiceDiagnosticRoute = 'connected-host' | 'in-process' | 'none';

/** One thing that happened on the voice path, with what it took to explain it. */
export interface VoiceDiagnosticEntry {
  readonly at: string;
  /** What was being attempted: `stt`, `wake-transcribe`, `provision-proof`. */
  readonly operation: string;
  readonly route: VoiceDiagnosticRoute;
  readonly ok: boolean;
  /** The provider that ran, as far as this surface knows it. */
  readonly provider: string;
  /** Where the configuration behind that provider came from. */
  readonly configSource: string;
  /** The exception text, verbatim, when this entry records a failure. */
  readonly error?: string | undefined;
  /** Anything else the caller knows that a reader would want. */
  readonly detail?: string | undefined;
}

/** Absolute path of the diagnostics file for a managed voice root. */
export function voiceDiagnosticsPath(managedRoot: string): string {
  return join(managedRoot, VOICE_DIAGNOSTICS_FILE);
}

interface VoiceDiagnosticsFile {
  readonly entries: readonly VoiceDiagnosticEntry[];
}

function isEntry(value: unknown): value is VoiceDiagnosticEntry {
  const entry = value as Partial<VoiceDiagnosticEntry> | null;
  return !!entry
    && typeof entry.at === 'string'
    && typeof entry.operation === 'string'
    && typeof entry.ok === 'boolean'
    && typeof entry.provider === 'string'
    && typeof entry.configSource === 'string';
}

/**
 * Read the diagnostics entries, newest last. Never throws: a store that cannot
 * be read is empty rather than fatal, it is evidence, and evidence that fails
 * to load must not take the voice path down with it.
 */
export function readVoiceDiagnostics(managedRoot: string): readonly VoiceDiagnosticEntry[] {
  try {
    const parsed = readJsonFileOrQuarantine<VoiceDiagnosticsFile>(voiceDiagnosticsPath(managedRoot), {
      label: 'voice/diagnostics',
      recovery: 'Voice diagnostics start empty again; the file records past failures and nothing reads it to make decisions.',
      validate: (raw) => {
        const file = raw as Partial<VoiceDiagnosticsFile> | null;
        if (!file || !Array.isArray(file.entries)) throw new Error('diagnostics file has no entries array');
        // Content-validated, entry by entry: a truncated write can leave a
        // parseable array whose last element is not an entry.
        return { entries: file.entries.filter(isEntry) };
      },
    });
    return parsed?.entries ?? [];
  } catch {
    return [];
  }
}

/** Options for {@link recordVoiceDiagnostic}, injected by tests. */
export interface VoiceDiagnosticsWriteOptions {
  readonly now?: (() => number) | undefined;
  readonly maxEntries?: number | undefined;
  readonly maxAgeMs?: number | undefined;
}

/**
 * Append one entry, then bound the store by count and by age.
 *
 * Best-effort by design: recording that voice failed must never be the reason
 * voice fails. A store that cannot be written is a lost diagnostic, not an
 * error the caller has to handle.
 */
export function recordVoiceDiagnostic(
  managedRoot: string,
  entry: VoiceDiagnosticEntry,
  options: VoiceDiagnosticsWriteOptions = {},
): void {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? VOICE_DIAGNOSTICS_MAX_ENTRIES;
  const maxAgeMs = options.maxAgeMs ?? VOICE_DIAGNOSTICS_MAX_AGE_MS;
  const cutoff = now() - maxAgeMs;
  const kept = [...readVoiceDiagnostics(managedRoot), entry]
    .filter((candidate) => {
      const at = Date.parse(candidate.at);
      // An unparseable timestamp is kept rather than reaped: the count cap still
      // bounds it, and silently dropping the one entry whose clock was odd is
      // how evidence goes missing.
      return Number.isNaN(at) || at >= cutoff;
    })
    .slice(-maxEntries);
  try {
    writeJsonFileAtomic(voiceDiagnosticsPath(managedRoot), { entries: kept });
  } catch {
    // Nothing to do and nothing to raise: see the doc comment.
  }
}

/** One-line rendering of an entry, for a status surface or a reply. */
export function describeVoiceDiagnostic(entry: VoiceDiagnosticEntry): string {
  const outcome = entry.ok ? 'ok' : 'failed';
  const where = entry.route === 'connected-host'
    ? 'through the connected host'
    : entry.route === 'in-process'
      ? 'in this process'
      : 'with no route available';
  const tail = entry.ok ? (entry.detail ?? '') : (entry.error ?? entry.detail ?? 'no reason recorded');
  return `${entry.at} ${entry.operation} ${outcome} ${where}, provider ${entry.provider}, config from ${entry.configSource}${tail ? `: ${tail}` : ''}`;
}
