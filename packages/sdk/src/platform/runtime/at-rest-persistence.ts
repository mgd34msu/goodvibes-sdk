/**
 * at-rest-persistence.ts — the redaction + retention policy layer for the two
 * raw-content on-disk writers: the per-agent transcript journal
 * (agents/session.ts, `<agentId>.jsonl`) and the local execution ledger
 * (runtime/telemetry/exporters/local-ledger.ts, spans + `<file>.ledger.jsonl`).
 *
 * Both historically appended raw serialized records — a prompt, a tool stdout,
 * an event payload — straight to disk, so an API key or bearer token that
 * flowed through a turn was persisted in the clear. The redaction helper
 * (utils/redaction.ts) existed but was wired only to the telemetry query egress,
 * so nothing masked the at-rest copy.
 *
 * This module supplies:
 *   - redactAtRestLine: run the SAME secret/credential patterns
 *     (redactSensitiveData) over a serialized JSON line before it is appended.
 *     The patterns replace only the matched secret substrings with
 *     JSON-safe `[REDACTED_*]` markers, so the line stays valid JSON and its
 *     non-secret content stays readable — a redacted record never pretends the
 *     content was not there, it shows the marker.
 *   - enforceFileRetention: an age + total-size cap over a set of append-only
 *     files, deleting oldest-first. A production caller invokes it at a natural
 *     lifecycle point (the checkpoint-gc lesson: retention that is defined but
 *     never called reclaims nothing).
 *   - resolveAtRestPolicy: read the honest-default config keys (redaction on by
 *     default; retention generous but bounded) into a resolved policy.
 */
import { statSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { redactSensitiveData } from '../utils/redaction.js';

/** Resolved at-rest policy the journal + ledger writers consult. */
export interface AtRestPolicy {
  /** Redact secret/credential patterns in each record before it is written. */
  readonly redact: boolean;
  /** Retention caps enforced over the on-disk files. */
  readonly retention: {
    /** Delete files whose mtime is older than this many milliseconds. */
    readonly maxAgeMs: number;
    /** Delete oldest files until the set's total size is under this many bytes. */
    readonly maxTotalBytes: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

/**
 * The honest defaults, used when no config is wired: redaction ON, retention
 * generous but bounded (30 days / 512 MB) so a long-lived daemon cannot grow
 * these files without limit while a normal debugging window stays intact.
 */
export const DEFAULT_AT_REST_POLICY: AtRestPolicy = {
  redact: true,
  retention: { maxAgeMs: 30 * DAY_MS, maxTotalBytes: 512 * MB },
};

/** Config keys backing the policy (see config/schema-domain-at-rest.ts). */
export const AT_REST_CONFIG_KEYS = {
  redactEnabled: 'atRest.redactionEnabled',
  maxAgeDays: 'atRest.retentionMaxAgeDays',
  maxTotalMb: 'atRest.retentionMaxTotalMb',
} as const;

/**
 * Build a resolved policy from a config getter (ConfigManager.get shape). A
 * missing/invalid value falls back to the honest default rather than throwing —
 * a config problem must never take the write path down.
 */
export function resolveAtRestPolicy(get?: (key: string) => unknown): AtRestPolicy {
  if (!get) return DEFAULT_AT_REST_POLICY;
  const redactRaw = get(AT_REST_CONFIG_KEYS.redactEnabled);
  const ageDaysRaw = get(AT_REST_CONFIG_KEYS.maxAgeDays);
  const totalMbRaw = get(AT_REST_CONFIG_KEYS.maxTotalMb);
  const redact = typeof redactRaw === 'boolean' ? redactRaw : DEFAULT_AT_REST_POLICY.redact;
  const maxAgeMs = typeof ageDaysRaw === 'number' && ageDaysRaw > 0
    ? ageDaysRaw * DAY_MS
    : DEFAULT_AT_REST_POLICY.retention.maxAgeMs;
  const maxTotalBytes = typeof totalMbRaw === 'number' && totalMbRaw > 0
    ? totalMbRaw * MB
    : DEFAULT_AT_REST_POLICY.retention.maxTotalBytes;
  return { redact, retention: { maxAgeMs, maxTotalBytes } };
}

/**
 * Redact secret/credential patterns in a serialized JSON line. Reuses
 * redactSensitiveData so the pattern set is the single source shared with the
 * telemetry egress; the replacements are JSON-safe markers, so the result stays
 * a valid, parseable line.
 */
export function redactAtRestLine(line: string): string {
  return redactSensitiveData(line);
}

export interface RetentionOutcome {
  readonly deletedFiles: readonly string[];
  readonly reclaimedBytes: number;
}

/**
 * Enforce the age + total-size caps over a set of append-only files, deleting
 * oldest-first. Missing files are skipped. Deletion failures are swallowed
 * (best-effort gc must never break the write path) but excluded from the
 * reclaimed total. Returns what was reclaimed for the caller to log.
 */
export function enforceFileRetention(files: readonly string[], policy: AtRestPolicy): RetentionOutcome {
  const now = Date.now();
  const stats: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const path of files) {
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      stats.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Missing / unreadable file — nothing to retain.
    }
  }

  const deleted: string[] = [];
  let reclaimed = 0;
  const remove = (entry: { path: string; size: number }): void => {
    try {
      unlinkSync(entry.path);
      deleted.push(entry.path);
      reclaimed += entry.size;
    } catch {
      // Best-effort: a file we cannot delete is left in place.
    }
  };

  // Age cap: drop anything older than maxAgeMs.
  const survivors: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of stats) {
    if (now - entry.mtimeMs > policy.retention.maxAgeMs) remove(entry);
    else survivors.push(entry);
  }

  // Size cap: oldest-first until the surviving set is under the byte budget.
  survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = survivors.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of survivors) {
    if (total <= policy.retention.maxTotalBytes) break;
    remove(entry);
    total -= entry.size;
  }

  return { deletedFiles: deleted, reclaimedBytes: reclaimed };
}

/**
 * Enforce retention over every `*.jsonl` transcript-journal file in a directory
 * (the per-agent `<agentId>.jsonl` logs). A convenience wrapper over
 * enforceFileRetention that resolves the directory listing; a missing directory
 * is a no-op.
 */
export function enforceJournalDirectoryRetention(dir: string, policy: AtRestPolicy): RetentionOutcome {
  if (!existsSync(dir)) return { deletedFiles: [], reclaimedBytes: 0 };
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return { deletedFiles: [], reclaimedBytes: 0 };
  }
  return enforceFileRetention(names.map((name) => join(dir, name)), policy);
}
