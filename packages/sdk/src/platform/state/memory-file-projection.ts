/**
 * memory-file-projection.ts — standing memory records as GIT-BACKED markdown
 * files that ROUND-TRIP through the confirmation-gated mutation path.
 *
 * The platform's memory should be inspectable and correctable as files. This
 * module projects standing (project/team-scope) MemoryRecords to one markdown
 * file per record under a git-backed directory, and reads user edits BACK — but
 * never as a silent write to the store. A user edit or deletion becomes a
 * PROPOSAL (a review-queue entry); the store is mutated only for proposals the
 * caller explicitly confirms, through the registry's own update/delete. The disk
 * file is a correction surface, not a second source of truth.
 *
 * Temporal validity (validFrom/validUntil) is projected into each file's
 * front-matter and its live status is labelled — an expired record is shown as
 * `status: expired`, not silently dropped from the projection.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryClass, MemoryRecord, MemoryScope, MemoryTemporalStatus } from './memory-store.js';
import { memoryRecordTemporalStatus } from './memory-store.js';

/** Scopes eligible for the file projection — standing memory only (not per-session). */
const DEFAULT_PROJECTION_SCOPES: readonly MemoryScope[] = ['project', 'team'];

export interface MemoryProjectionOptions {
  /** Restrict projection to these scopes; defaults to project + team. */
  readonly scopes?: readonly MemoryScope[];
}

/** Optional git seam: durably commit the projected files. Injectable for tests. */
export interface MemoryProjectionGit {
  add(dir: string): void;
  commit(dir: string, message: string): void;
}

/** The parsed content of one projected markdown file. */
export interface MemoryProjectionFile {
  readonly id: string;
  readonly path: string;
  readonly scope?: MemoryScope | undefined;
  readonly cls?: MemoryClass | undefined;
  readonly summary: string;
  readonly detail?: string | undefined;
  readonly tags: readonly string[];
  readonly validFrom?: number | undefined;
  readonly validUntil?: number | undefined;
}

export interface MemoryProjectionWriteReport {
  readonly dir: string;
  readonly written: readonly string[];
  readonly committed: boolean;
}

function selectStandingRecords(records: readonly MemoryRecord[], options: MemoryProjectionOptions): MemoryRecord[] {
  const scopes = new Set(options.scopes ?? DEFAULT_PROJECTION_SCOPES);
  return records
    .filter((record) => scopes.has(record.scope))
    .sort((left, right) => left.createdAt - right.createdAt);
}

function toIso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** Render one record as a markdown file body (front-matter + content). */
export function projectMemoryRecordToMarkdown(record: MemoryRecord, now: number = Date.now()): string {
  const status = memoryRecordTemporalStatus(record, now);
  const lines: string[] = ['---'];
  lines.push(`id: ${record.id}`);
  lines.push(`scope: ${record.scope}`);
  lines.push(`cls: ${record.cls}`);
  lines.push(`tags: ${record.tags.join(', ')}`);
  lines.push(`confidence: ${record.confidence}`);
  lines.push(`reviewState: ${record.reviewState}`);
  const validFrom = toIso(record.validFrom);
  const validUntil = toIso(record.validUntil);
  if (validFrom) lines.push(`validFrom: ${validFrom}`);
  if (validUntil) lines.push(`validUntil: ${validUntil}`);
  // The live temporal status, so an expired record is visibly labelled expired
  // in its own file rather than silently missing from injection.
  lines.push(`status: ${status}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${record.summary}`);
  if (record.detail?.trim()) {
    lines.push('');
    lines.push(record.detail.trim());
  }
  lines.push('');
  return lines.join('\n');
}

function recordFileName(id: string): string {
  // ids are `mem_...` (safe filename chars); keep 1:1 with the id for round-trip.
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
}

/**
 * Project standing records to `<dir>/<id>.md`. Writes one file per in-scope
 * record. When a git seam is supplied, stages + commits the directory so the
 * projection is durable and diffable. Never deletes existing files (a store
 * deletion is surfaced as a proposal on the next diff, not a silent unlink).
 */
export function projectMemoryToFiles(
  records: readonly MemoryRecord[],
  dir: string,
  options: MemoryProjectionOptions & { readonly now?: number; readonly git?: MemoryProjectionGit } = {},
): MemoryProjectionWriteReport {
  const now = options.now ?? Date.now();
  mkdirSync(dir, { recursive: true });
  const standing = selectStandingRecords(records, options);
  const written: string[] = [];
  for (const record of standing) {
    const path = join(dir, recordFileName(record.id));
    writeFileSync(path, projectMemoryRecordToMarkdown(record, now), 'utf-8');
    written.push(path);
  }
  let committed = false;
  if (options.git) {
    options.git.add(dir);
    options.git.commit(dir, `memory projection: ${written.length} record(s)`);
    committed = true;
  }
  return { dir, written, committed };
}

/** Parse one projected markdown file. Returns null when it has no `id` front-matter key. */
export function parseProjectedMemoryFile(path: string, content: string): MemoryProjectionFile | null {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return null;
  const front: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    front[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const id = front.id;
  if (!id) return null;

  const body = (match[2] ?? '').trim();
  const bodyLines = body.split('\n');
  const headingIdx = bodyLines.findIndex((line) => line.startsWith('# '));
  const summary = headingIdx >= 0 ? bodyLines[headingIdx]!.slice(2).trim() : (bodyLines[0]?.trim() ?? '');
  const detailText = headingIdx >= 0 ? bodyLines.slice(headingIdx + 1).join('\n').trim() : bodyLines.slice(1).join('\n').trim();

  const tags = (front.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const parseTime = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  };

  return {
    id,
    path,
    ...(front.scope === 'session' || front.scope === 'project' || front.scope === 'team' ? { scope: front.scope } : {}),
    ...(front.cls ? { cls: front.cls as MemoryClass } : {}),
    summary,
    ...(detailText ? { detail: detailText } : {}),
    tags,
    ...(parseTime(front.validFrom) !== undefined ? { validFrom: parseTime(front.validFrom) } : {}),
    ...(parseTime(front.validUntil) !== undefined ? { validUntil: parseTime(front.validUntil) } : {}),
  };
}

/**
 * One entry in the LIVE memory projection (computed from the store's standing
 * records, not read from disk) — the shape the memory.projections.* wire verbs
 * expose. `status` is the record's live temporal status (active / expired /
 * pending), so an expired record is visibly labelled rather than silently
 * dropped, exactly as the file projection labels it.
 */
export interface MemoryProjectionEntry {
  readonly id: string;
  /** The `<id>.md` filename the file projection would use — a stable per-record handle. */
  readonly filename: string;
  readonly scope: MemoryScope;
  readonly cls: MemoryClass;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly confidence: number;
  readonly reviewState: string;
  readonly validFrom?: number | undefined;
  readonly validUntil?: number | undefined;
  readonly status: MemoryTemporalStatus;
}

function toProjectionEntry(record: MemoryRecord, now: number): MemoryProjectionEntry {
  return {
    id: record.id,
    filename: recordFileName(record.id),
    scope: record.scope,
    cls: record.cls,
    summary: record.summary,
    tags: record.tags,
    confidence: record.confidence,
    reviewState: record.reviewState,
    ...(record.validFrom !== undefined ? { validFrom: record.validFrom } : {}),
    ...(record.validUntil !== undefined ? { validUntil: record.validUntil } : {}),
    status: memoryRecordTemporalStatus(record, now),
  };
}

/**
 * The live projection of standing (project/team) memory records — one metadata
 * entry per record, oldest first. Does not touch disk. Session-scope records are
 * excluded (they are not standing memory), matching the file projection's own
 * scope selection.
 */
export function listMemoryProjections(
  records: readonly MemoryRecord[],
  options: MemoryProjectionOptions & { readonly now?: number } = {},
): MemoryProjectionEntry[] {
  const now = options.now ?? Date.now();
  return selectStandingRecords(records, options).map((record) => toProjectionEntry(record, now));
}

/**
 * The live projection of ONE standing record by id: its metadata entry plus the
 * exact markdown the file projection would write. Returns null when no standing
 * record has that id (a session-scope or unknown id is an honest miss, not an
 * empty projection).
 */
export function getMemoryProjection(
  records: readonly MemoryRecord[],
  id: string,
  options: MemoryProjectionOptions & { readonly now?: number } = {},
): { readonly entry: MemoryProjectionEntry; readonly markdown: string } | null {
  const now = options.now ?? Date.now();
  const record = selectStandingRecords(records, options).find((candidate) => candidate.id === id);
  if (!record) return null;
  return { entry: toProjectionEntry(record, now), markdown: projectMemoryRecordToMarkdown(record, now) };
}

/** Read + parse every `*.md` in the projection directory. */
export function readProjectedMemoryFiles(dir: string): MemoryProjectionFile[] {
  if (!existsSync(dir)) return [];
  const files: MemoryProjectionFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    const parsed = parseProjectedMemoryFile(path, readFileSync(path, 'utf-8'));
    if (parsed) files.push(parsed);
  }
  return files;
}

export type MemoryProjectionProposalKind = 'update' | 'delete';

/**
 * A proposed change from the projection round-trip — a review-queue entry, NOT a
 * write. The caller confirms (or not) each entry; only confirmed entries mutate
 * the store, through the registry's own update/delete.
 */
export interface MemoryProjectionProposal {
  readonly kind: MemoryProjectionProposalKind;
  readonly id: string;
  /** Honest human-readable reason this change is proposed. */
  readonly reason: string;
  /** For 'update': the record fields the edited file would change. */
  readonly changedFields?: readonly string[] | undefined;
  /** The desired field values parsed from the file (for 'update'). */
  readonly desired?: {
    readonly scope?: MemoryScope | undefined;
    readonly summary?: string | undefined;
    readonly detail?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly validFrom?: number | null | undefined;
    readonly validUntil?: number | null | undefined;
  } | undefined;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((tag) => setB.has(tag));
}

/**
 * Diff the current record set against the projected files and produce proposals.
 * PURE — no I/O. An edited file whose fields differ from its record yields an
 * `update` proposal; an in-scope record with NO file yields a `delete` proposal
 * (the user removed the file); a file with no matching record is ignored (its
 * record is already gone). Nothing here mutates the store.
 */
export function diffProjectionToProposals(
  records: readonly MemoryRecord[],
  files: readonly MemoryProjectionFile[],
  options: MemoryProjectionOptions = {},
): MemoryProjectionProposal[] {
  const scopes = new Set(options.scopes ?? DEFAULT_PROJECTION_SCOPES);
  const filesById = new Map(files.map((file) => [file.id, file]));
  const proposals: MemoryProjectionProposal[] = [];

  for (const record of records) {
    if (!scopes.has(record.scope)) continue;
    const file = filesById.get(record.id);
    if (!file) {
      proposals.push({
        kind: 'delete',
        id: record.id,
        reason: `Projected file for "${record.summary}" was removed; propose deleting the record (confirmation required).`,
      });
      continue;
    }

    const changedFields: string[] = [];
    const desired: {
      scope?: MemoryScope;
      summary?: string;
      detail?: string;
      tags?: string[];
      validFrom?: number | null;
      validUntil?: number | null;
    } = {};
    if (file.summary && file.summary !== record.summary) { changedFields.push('summary'); desired.summary = file.summary; }
    const fileDetail = file.detail ?? '';
    if (fileDetail !== (record.detail ?? '')) { changedFields.push('detail'); desired.detail = fileDetail; }
    if (!sameTags(file.tags, record.tags)) { changedFields.push('tags'); desired.tags = [...file.tags]; }
    if (file.scope && file.scope !== record.scope) { changedFields.push('scope'); desired.scope = file.scope; }
    if ((file.validFrom ?? undefined) !== (record.validFrom ?? undefined)) {
      changedFields.push('validFrom');
      desired.validFrom = file.validFrom ?? null;
    }
    if ((file.validUntil ?? undefined) !== (record.validUntil ?? undefined)) {
      changedFields.push('validUntil');
      desired.validUntil = file.validUntil ?? null;
    }

    if (changedFields.length > 0) {
      proposals.push({
        kind: 'update',
        id: record.id,
        reason: `Projected file edited (${changedFields.join(', ')}); propose updating the record (confirmation required).`,
        changedFields,
        desired,
      });
    }
  }

  return proposals;
}

/** The registry surface the projection apply needs — update + delete only. */
export interface MemoryProjectionRegistry {
  update(id: string, patch: {
    scope?: MemoryScope;
    summary?: string;
    detail?: string;
    tags?: string[];
    validFrom?: number | null;
    validUntil?: number | null;
  }): MemoryRecord | null;
  delete(id: string): boolean;
}

export interface MemoryProjectionApplyReceipt {
  readonly applied: readonly MemoryProjectionProposal[];
  /** Proposals the caller did NOT confirm — left untouched (the gate). */
  readonly skipped: readonly MemoryProjectionProposal[];
  /** Proposals confirmed but whose store mutation returned no record / false. */
  readonly failed: readonly MemoryProjectionProposal[];
}

/**
 * Apply ONLY the proposals the caller confirms, through the registry's own
 * update/delete. This is the confirmation gate: a proposal is never applied
 * unless `confirm(proposal)` returns true — a file edit can never become a
 * silent store write. Unconfirmed proposals are recorded as skipped.
 */
export function applyMemoryProjectionProposals(
  registry: MemoryProjectionRegistry,
  proposals: readonly MemoryProjectionProposal[],
  options: { readonly confirm: (proposal: MemoryProjectionProposal) => boolean },
): MemoryProjectionApplyReceipt {
  const applied: MemoryProjectionProposal[] = [];
  const skipped: MemoryProjectionProposal[] = [];
  const failed: MemoryProjectionProposal[] = [];

  for (const proposal of proposals) {
    if (!options.confirm(proposal)) {
      skipped.push(proposal);
      continue;
    }
    if (proposal.kind === 'delete') {
      const ok = registry.delete(proposal.id);
      (ok ? applied : failed).push(proposal);
      continue;
    }
    const desired = proposal.desired ?? {};
    const patch: Parameters<MemoryProjectionRegistry['update']>[1] = {
      ...(desired.scope !== undefined ? { scope: desired.scope } : {}),
      ...(desired.summary !== undefined ? { summary: desired.summary } : {}),
      ...(desired.detail !== undefined ? { detail: desired.detail } : {}),
      ...(desired.tags !== undefined ? { tags: [...desired.tags] } : {}),
      ...(desired.validFrom !== undefined ? { validFrom: desired.validFrom } : {}),
      ...(desired.validUntil !== undefined ? { validUntil: desired.validUntil } : {}),
    };
    const result = registry.update(proposal.id, patch);
    (result ? applied : failed).push(proposal);
  }

  return { applied, skipped, failed };
}
