/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Persistence (Wave 4, wo701) — mirrors the WrfcController chain seams
 * exactly: serializeChain:323 / deserializeChain:345 (including the
 * future-schemaVersion-reject guard at :364) / importChain:402. Writes to
 * `.goodvibes/orchestration/<workstreamId>.json` — SEPARATE from the TUI's
 * `.goodvibes/tui/wrfc-chains.json` (src/runtime/wrfc-persistence.ts), no
 * path collision. Debounce (250ms) and corrupt-snapshot quarantine
 * (`<path>.unrecognized`) mirror that same TUI module's conventions.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  CURRENT_WORKSTREAM_SCHEMA_VERSION,
  type OrchestrationEvent,
  type PhaseResult,
  type SerializedWorkItem,
  type SerializedWorkstream,
  type WorkItem,
  type Workstream,
  type WorkstreamSnapshot,
} from './types.js';

const DEBOUNCE_MS = 250;

function serializeWorkItem(item: WorkItem): SerializedWorkItem {
  return { ...item, visits: Object.fromEntries(item.visits) };
}

function deserializeWorkItem(raw: SerializedWorkItem): WorkItem {
  return { ...raw, visits: new Map(Object.entries(raw.visits)) };
}

export function serializeWorkstream(workstream: Workstream): SerializedWorkstream {
  return { ...workstream, items: workstream.items.map(serializeWorkItem) };
}

export function deserializeWorkstream(serialized: SerializedWorkstream): Workstream {
  return { ...serialized, items: serialized.items.map(deserializeWorkItem) };
}

/** Mirrors WrfcController.serializeChain: JSON.stringify a schema-versioned envelope. Returns null on serialization failure rather than throwing. */
export function serializeWorkstreamSnapshot(workstream: Workstream, completedResults: readonly PhaseResult[]): string | null {
  const snapshot: WorkstreamSnapshot = {
    schemaVersion: CURRENT_WORKSTREAM_SCHEMA_VERSION,
    writtenAt: Date.now(),
    workstream: serializeWorkstream(workstream),
    completedResults,
  };
  try {
    return JSON.stringify(snapshot);
  } catch (error) {
    logger.error('orchestration persistence: JSON serialization failed', { workstreamId: workstream.id, error: summarizeError(error) });
    return null;
  }
}

/**
 * Mirrors WrfcController.deserializeChain's future-schemaVersion-reject
 * guard: a snapshot written by a newer runtime is rejected (fail closed)
 * rather than partially trusted.
 */
export function deserializeWorkstreamSnapshot(json: string): WorkstreamSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    logger.error('orchestration persistence: JSON parse failed', { error: summarizeError(error) });
    return null;
  }
  if (raw === null || typeof raw !== 'object') {
    logger.warn('orchestration persistence: invalid snapshot JSON — not an object');
    return null;
  }
  const candidate = raw as Partial<WorkstreamSnapshot>;
  if (typeof candidate.schemaVersion !== 'number') {
    logger.warn('orchestration persistence: invalid snapshot JSON — missing schemaVersion');
    return null;
  }
  if (candidate.schemaVersion > CURRENT_WORKSTREAM_SCHEMA_VERSION) {
    logger.error('orchestration persistence: future schemaVersion rejected — upgrade runtime to read this snapshot', {
      schemaVersion: candidate.schemaVersion,
      supportedVersion: CURRENT_WORKSTREAM_SCHEMA_VERSION,
    });
    return null;
  }
  if (!candidate.workstream || typeof candidate.workstream !== 'object' || !Array.isArray(candidate.completedResults)) {
    logger.warn('orchestration persistence: invalid snapshot JSON — missing workstream/completedResults');
    return null;
  }
  return candidate as WorkstreamSnapshot;
}

function orchestrationDir(projectRoot: string): string {
  return join(projectRoot, '.goodvibes', 'orchestration');
}

function snapshotPath(projectRoot: string, workstreamId: string): string {
  return join(orchestrationDir(projectRoot), `${workstreamId}.json`);
}

/** Read + quarantine-on-corrupt (never throws, never crashes the caller on a bad file). */
export function loadWorkstreamSnapshot(projectRoot: string, workstreamId: string): WorkstreamSnapshot | null {
  const path = snapshotPath(projectRoot, workstreamId);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    logger.warn('orchestration persistence: snapshot read failed', { path, error: summarizeError(error) });
    return null;
  }
  const snapshot = deserializeWorkstreamSnapshot(text);
  if (snapshot === null) {
    const quarantinePath = `${path}.unrecognized`;
    try {
      renameSync(path, quarantinePath);
      logger.warn('orchestration persistence: quarantined unrecognized snapshot', { path, quarantinePath });
    } catch (error) {
      logger.error('orchestration persistence: failed to quarantine unrecognized snapshot', { path, error: summarizeError(error) });
    }
    return null;
  }
  return snapshot;
}

/** List the workstream ids with a snapshot on disk (recognized or not — callers decide via loadWorkstreamSnapshot). */
export function listSnapshotWorkstreamIds(projectRoot: string): string[] {
  const dir = orchestrationDir(projectRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length));
  } catch (error) {
    logger.warn('orchestration persistence: failed to list snapshot directory', { dir, error: summarizeError(error) });
    return [];
  }
}

export function writeWorkstreamSnapshot(projectRoot: string, workstream: Workstream, completedResults: readonly PhaseResult[]): void {
  const json = serializeWorkstreamSnapshot(workstream, completedResults);
  if (json === null) return;
  const path = snapshotPath(projectRoot, workstream.id);
  try {
    mkdirSync(orchestrationDir(projectRoot), { recursive: true });
    writeFileSync(path, json, 'utf-8');
  } catch (error) {
    logger.error('orchestration persistence: snapshot write failed', { path, error: summarizeError(error) });
  }
}

/**
 * Debounced trailing writer (250ms, exactly like wrfc-persistence.ts
 * DEBOUNCE_MS), subscribing to engine lifecycle events. Returns an
 * unsubscribe function that also flushes any pending timers.
 */
export function attachDebouncedWriter(
  projectRoot: string,
  getWorkstream: (workstreamId: string) => Workstream | null,
  getCompletedResults: (workstreamId: string) => readonly PhaseResult[],
  subscribe: (listener: (event: OrchestrationEvent) => void) => () => void,
): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleWrite(workstreamId: string): void {
    const existing = timers.get(workstreamId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(workstreamId);
      const workstream = getWorkstream(workstreamId);
      if (!workstream) return;
      writeWorkstreamSnapshot(projectRoot, workstream, getCompletedResults(workstreamId));
    }, DEBOUNCE_MS);
    timer.unref?.();
    timers.set(workstreamId, timer);
  }

  const unsubscribe = subscribe((event) => {
    scheduleWrite(event.workstreamId);
  });

  return () => {
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
