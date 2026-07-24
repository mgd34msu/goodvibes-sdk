/**
 * legacy-agent-journal-patterns.ts — how a pre-repoint agent journal is
 * recognised on disk, shared by append-only-registry.ts's session-journals
 * sweep and session-migration.ts's one-time move.
 *
 * Before agents/session.ts and agents/wrfc-workmap.ts were repointed at
 * sessions/agents/, agent transcripts and WRFC workmaps were written flat into
 * the scoped sessions/ directory, alongside user conversation files. Both the
 * retention sweep (which must never delete a user conversation) and the
 * migration (which must never MOVE a user conversation into sessions/agents/)
 * need the identical, precise classification — defined once here so they can
 * never drift apart.
 *
 * Recognition is TWO tests, both of which must pass:
 *
 *  1. Filename shape:
 *     - `<sessionId>_workmap.jsonl` — WrfcWorkmap's legacy path.
 *     - `agent-<8 lowercase hex chars>.jsonl` — AgentSession's legacy path,
 *       matching the id shape `agent-${randomUUID().slice(0, 8)}` minted in
 *       tools/agent/manager.ts.
 *
 *  2. First-line content (`isLegacyAgentJournalFile`): the file's first line
 *     must actually BE the corresponding journal's opening record.
 *
 * The filename test alone is not sufficient and must never be used to decide
 * a delete or a move. SessionManager.sanitizeName (sessions/manager.ts)
 * preserves underscores and the `agent-` prefix, so a user who saves a
 * conversation as "release_workmap" or "agent-deadbeef" gets a file whose NAME
 * is indistinguishable from a legacy journal's. Their CONTENT is not:
 *
 *   - A saved user conversation opens with SessionManager's meta record —
 *     `{"type":"meta","schemaVersion":1,...,"titleSource":...,"saveSource":...}`
 *     — which never carries an `agentId`.
 *   - An agent journal opens with AgentSession's session-start record —
 *     `{"type":"meta","agentId":"agent-xxxxxxxx","model":...,"provider":...}` —
 *     which never carries schemaVersion / titleSource / saveSource.
 *   - A workmap opens with a WorkmapEntry — `{"ts":...,"wrfcId":...,"event":...}`
 *     — which has no `type` field at all.
 *
 * Anything that does not positively match a journal's opening record — a file
 * that is empty, truncated, unreadable, non-JSON, or simply shaped like
 * something else — is NOT a legacy agent journal. "When in doubt, leave it"
 * is the rule, and this module is where that rule is actually enforced rather
 * than merely promised.
 */
import { closeSync, openSync, readSync } from 'node:fs';

const LEGACY_WORKMAP_JOURNAL_PATTERN = /_workmap\.jsonl$/;
const LEGACY_AGENT_JOURNAL_PATTERN = /^agent-[0-9a-f]{8}\.jsonl$/;

/** How many leading bytes are read to recover a file's first line. */
const FIRST_LINE_PEEK_BYTES = 8192;

/**
 * True when `name` (a bare filename, no directory component) has the shape of
 * a legacy flat agent journal or workmap.
 *
 * NAME ONLY — this is a necessary but NOT sufficient condition, because legal
 * user session names collide with these shapes (see the module header). Use
 * {@link isLegacyAgentJournalFile} for any decision that deletes or moves a
 * file; this predicate exists for cheap pre-filtering and for tests.
 */
export function isLegacyAgentJournalFilename(name: string): boolean {
  return LEGACY_WORKMAP_JOURNAL_PATTERN.test(name) || LEGACY_AGENT_JOURNAL_PATTERN.test(name);
}

/** The file's first line, or null when it cannot be read (missing, unreadable, empty). */
function peekFirstLine(filePath: string): string | null {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(FIRST_LINE_PEEK_BYTES);
    const bytesRead = readSync(fd, buf, 0, FIRST_LINE_PEEK_BYTES, 0);
    const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
    return firstLine && firstLine.trim().length > 0 ? firstLine : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Parse a first line into a plain record, or null when it is not a JSON object. */
function parseFirstRecord(filePath: string): Record<string, unknown> | null {
  const firstLine = peekFirstLine(filePath);
  if (!firstLine) return null;
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/**
 * True when `record` is AgentSession's session-start record: a meta line
 * carrying an `agentId` and none of the fields SessionManager.save always
 * writes onto a user conversation's meta line.
 */
function isAgentSessionStartRecord(record: Record<string, unknown>): boolean {
  if (record.type !== 'meta') return false;
  if (!isNonEmptyString(record.agentId)) return false;
  return record.schemaVersion === undefined
    && record.saveSource === undefined
    && record.titleSource === undefined;
}

/** True when `record` is a WrfcWorkmap entry: `{ ts, wrfcId, event }`, with no `type` wrapper. */
function isWorkmapEntryRecord(record: Record<string, unknown>): boolean {
  if (record.type !== undefined) return false;
  return isNonEmptyString(record.wrfcId) && isNonEmptyString(record.event) && isNonEmptyString(record.ts);
}

/**
 * True when the file at `filePath` is genuinely a legacy flat agent journal or
 * workmap: its NAME has a legacy journal shape AND its first line is that
 * journal's opening record (see the module header).
 *
 * This is the predicate every destructive decision must use. `name` defaults to
 * the file's basename; callers that already have the directory entry's name
 * pass it to avoid re-deriving it.
 */
export function isLegacyAgentJournalFile(filePath: string, name?: string): boolean {
  const fileName = name ?? filePath.split(/[\\/]/).pop() ?? '';
  if (!isLegacyAgentJournalFilename(fileName)) return false;

  const record = parseFirstRecord(filePath);
  // Unreadable, empty, truncated, or not JSON at all — leave it alone.
  if (!record) return false;

  if (LEGACY_WORKMAP_JOURNAL_PATTERN.test(fileName)) {
    return isWorkmapEntryRecord(record);
  }
  return isAgentSessionStartRecord(record);
}
