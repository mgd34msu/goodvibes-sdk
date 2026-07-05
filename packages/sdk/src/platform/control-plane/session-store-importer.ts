/**
 * session-store-importer.ts
 *
 * Boot-time migration that folds every pre-existing session store into the ONE
 * home-scoped durable broker store. Idempotent and safe to run repeatedly — the
 * merge is keyed on session id, so a re-run over the same sources is a no-op.
 *
 * Sources folded in (One-Platform Wave 1, S1 spine):
 *  1. Companion chat files — ~/.goodvibes/companion-chat/sessions/*.json
 *     (home-scoped, projectless → project 'unknown'); INCLUDING closed sessions.
 *  2. Per-project broker snapshots — <root>/.goodvibes/<surface>/control-plane/
 *     sessions.json (the old project-scoped store path); stamped project = <root>.
 *  3. The stale agent-fork store — same broker-snapshot shape under its surface.
 *
 * No session is dropped (closed included); deletion remains the GC's job. Corrupt
 * or partial files are logged and skipped per-file — the run never aborts.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PersistentStore } from '../state/persistent-store.js';
import { CompanionChatPersistence } from '../companion/companion-chat-persistence.js';
import { defaultSessionsDir } from '../companion/companion-chat-persistence.js';
import { loadSessionBrokerState, createSessionBrokerSnapshot } from './session-broker-state.js';
import type { SharedSessionStoreSnapshot } from './session-broker-helpers.js';
import type {
  SharedSessionMessage,
  SharedSessionRecord,
} from './session-types.js';
import type { SharedSessionInputRecord } from './session-intents.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * How many message bodies to retain PER SESSION when re-persisting the merged
 * store. This is a per-session cap, not a global one: every session keeps its
 * most-recent 2 000 bodies independently, and a session that is truncated is
 * stamped with an honest `retainedMessageCount` (see createSessionBrokerSnapshot).
 * Migration therefore never silently drops whole sessions' transcripts.
 */
const MAX_PERSISTED_MESSAGES_PER_SESSION = 2_000;

/** A legacy store to fold into the home store. */
export interface LegacySessionSource {
  /** 'broker-store' = a SharedSessionStoreSnapshot JSON file; 'companion-dir' = a dir of PersistedChatSession files. */
  readonly kind: 'broker-store' | 'companion-dir';
  /** File path (broker-store) or directory path (companion-dir). */
  readonly path: string;
  /** Project to stamp on records that carry no explicit project. Companion sources default to 'unknown'. */
  readonly project?: string | undefined;
}

export interface ImportLegacySessionsResult {
  /** Total sessions in the home store after the import. */
  readonly total: number;
  /** Sessions newly added by this run (0 on an idempotent re-run). */
  readonly imported: number;
  /** Sources that did not exist on disk (skipped, not an error). */
  readonly missingSources: readonly string[];
  /** Files that failed to parse and were skipped. */
  readonly skippedFiles: readonly string[];
}

interface MergeState {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly messages: Map<string, SharedSessionMessage>;
  readonly inputs: Map<string, SharedSessionInputRecord>;
}

/**
 * Discover the legacy stores reachable from a single project root plus the
 * home-scoped companion directory. Scans <projectRoot>/.goodvibes/<surface>/
 * control-plane/sessions.json across every surface subdir (tui, goodvibes,
 * agent, …). The home store itself is never returned as a source.
 */
export function discoverLegacySessionSources(input: {
  readonly projectRoot: string;
  readonly companionSessionsDir?: string | undefined;
}): LegacySessionSource[] {
  const sources: LegacySessionSource[] = [];
  const companionDir = input.companionSessionsDir ?? defaultSessionsDir();
  sources.push({ kind: 'companion-dir', path: companionDir, project: 'unknown' });

  const goodvibesRoot = join(input.projectRoot, '.goodvibes');
  let surfaceDirs: string[] = [];
  try {
    surfaceDirs = existsSync(goodvibesRoot)
      ? readdirSync(goodvibesRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [];
  } catch (error) {
    logger.warn('[session-import] failed to scan project .goodvibes root', {
      root: goodvibesRoot,
      error: summarizeError(error),
    });
  }
  for (const surface of surfaceDirs) {
    const storePath = join(goodvibesRoot, surface, 'control-plane', 'sessions.json');
    if (existsSync(storePath)) {
      sources.push({ kind: 'broker-store', path: storePath, project: input.projectRoot });
    }
  }
  return sources;
}

/**
 * Fold every source into the home store at `homeStorePath`, idempotently.
 * Starts from the existing home store, merges each source keyed by session id
 * (newer updatedAt wins; messages/inputs union-deduped by id), and re-persists
 * atomically. A second run over the same sources produces the same store.
 */
export async function importLegacySessionStores(input: {
  readonly homeStorePath: string;
  readonly sources: readonly LegacySessionSource[];
}): Promise<ImportLegacySessionsResult> {
  const homeStore = new PersistentStore<SharedSessionStoreSnapshot>(input.homeStorePath);
  const existing = loadSessionBrokerState(await safeLoad(homeStore));
  const state: MergeState = {
    sessions: new Map(existing.sessions),
    messages: new Map(),
    inputs: new Map(),
  };
  for (const bucket of existing.messages.values()) for (const m of bucket) state.messages.set(m.id, m);
  for (const bucket of existing.inputs.values()) for (const i of bucket) state.inputs.set(i.id, i);

  const startCount = state.sessions.size;
  const missingSources: string[] = [];
  const skippedFiles: string[] = [];

  for (const source of input.sources) {
    if (!existsSync(source.path)) {
      missingSources.push(source.path);
      continue;
    }
    if (source.kind === 'companion-dir') {
      await mergeCompanionDir(state, source, skippedFiles);
    } else {
      await mergeBrokerStore(state, source, skippedFiles);
    }
  }

  await homeStore.persist(buildSnapshot(state));
  return {
    total: state.sessions.size,
    imported: state.sessions.size - startCount,
    missingSources,
    skippedFiles,
  };
}

async function safeLoad(
  store: PersistentStore<SharedSessionStoreSnapshot>,
): Promise<SharedSessionStoreSnapshot | null> {
  try {
    return await store.load();
  } catch (error) {
    logger.warn('[session-import] home store failed to load; starting empty', {
      error: summarizeError(error),
    });
    return null;
  }
}

async function mergeBrokerStore(
  state: MergeState,
  source: LegacySessionSource,
  skippedFiles: string[],
): Promise<void> {
  let loaded: ReturnType<typeof loadSessionBrokerState>;
  try {
    const snapshot = await new PersistentStore<SharedSessionStoreSnapshot>(source.path).load();
    loaded = loadSessionBrokerState(snapshot);
  } catch (error) {
    logger.warn('[session-import] broker store failed to load; skipping', {
      path: source.path,
      error: summarizeError(error),
    });
    skippedFiles.push(source.path);
    return;
  }
  for (const record of loaded.sessions.values()) {
    const stamped = record.project === 'unknown' && source.project
      ? { ...record, project: source.project }
      : record;
    upsertSession(state, stamped);
  }
  for (const bucket of loaded.messages.values()) {
    for (const message of bucket) if (!state.messages.has(message.id)) state.messages.set(message.id, message);
  }
  for (const bucket of loaded.inputs.values()) {
    for (const inputRecord of bucket) if (!state.inputs.has(inputRecord.id)) state.inputs.set(inputRecord.id, inputRecord);
  }
}

async function mergeCompanionDir(
  state: MergeState,
  source: LegacySessionSource,
  skippedFiles: string[],
): Promise<void> {
  const persistence = new CompanionChatPersistence(source.path);
  const stored = await persistence.loadAll();
  for (const { meta, messages } of stored) {
    const converted = companionMessagesToShared(meta.id, messages);
    for (const message of converted) if (!state.messages.has(message.id)) state.messages.set(message.id, message);
    upsertSession(state, companionSessionToShared(meta, converted, source.project ?? 'unknown'));
  }
  // CompanionChatPersistence.loadAll already logs+skips corrupt files internally;
  // there is no per-file signal to surface here beyond its own warnings.
  void skippedFiles;
}

function upsertSession(state: MergeState, incoming: SharedSessionRecord): void {
  const current = state.sessions.get(incoming.id);
  if (!current || incoming.updatedAt >= current.updatedAt) {
    const participants = current
      ? mergeParticipants(current, incoming)
      : incoming.participants;
    state.sessions.set(incoming.id, { ...incoming, participants });
  }
}

function mergeParticipants(
  current: SharedSessionRecord,
  incoming: SharedSessionRecord,
): SharedSessionRecord['participants'] {
  const byId = new Map<string, SharedSessionRecord['participants'][number]>();
  for (const p of current.participants) byId.set(`${p.surfaceKind}:${p.surfaceId}:${p.userId ?? ''}`, p);
  for (const p of incoming.participants) byId.set(`${p.surfaceKind}:${p.surfaceId}:${p.userId ?? ''}`, p);
  return [...byId.values()];
}

function companionSessionToShared(
  meta: {
    readonly id: string;
    readonly title: string;
    readonly status: 'active' | 'closed';
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly closedAt: number | null;
  },
  messages: readonly SharedSessionMessage[],
  project: string,
): SharedSessionRecord {
  const lastMessageAt = messages.reduce<number | undefined>(
    (latest, m) => (latest === undefined || m.createdAt > latest ? m.createdAt : latest),
    undefined,
  );
  return {
    id: meta.id,
    kind: 'companion-chat',
    project,
    title: meta.title.trim().length > 0 ? meta.title : `Session ${meta.id}`,
    status: meta.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(meta.closedAt != null ? { closedAt: meta.closedAt } : {}),
    lastActivityAt: meta.updatedAt,
    messageCount: messages.length,
    pendingInputCount: 0,
    routeIds: [],
    surfaceKinds: ['companion'],
    participants: [{ surfaceKind: 'companion', surfaceId: meta.id, lastSeenAt: meta.updatedAt }],
    metadata: {},
  };
}

function companionMessagesToShared(
  sessionId: string,
  messages: readonly { readonly id: string; readonly role: 'user' | 'assistant'; readonly content: string; readonly createdAt: number }[],
): SharedSessionMessage[] {
  return messages.map((message) => ({
    id: message.id,
    sessionId,
    role: message.role,
    body: message.content,
    createdAt: message.createdAt,
    surfaceKind: 'companion',
    surfaceId: sessionId,
    metadata: {},
  }));
}

function buildSnapshot(state: MergeState): SharedSessionStoreSnapshot {
  const sessions = new Map(state.sessions);
  const messages = new Map<string, readonly SharedSessionMessage[]>();
  const inputs = new Map<string, readonly SharedSessionInputRecord[]>();
  for (const message of state.messages.values()) {
    messages.set(message.sessionId, [...(messages.get(message.sessionId) ?? []), message]);
  }
  for (const inputRecord of state.inputs.values()) {
    inputs.set(inputRecord.sessionId, [...(inputs.get(inputRecord.sessionId) ?? []), inputRecord]);
  }
  return createSessionBrokerSnapshot({ sessions, messages, inputs }, MAX_PERSISTED_MESSAGES_PER_SESSION);
}
