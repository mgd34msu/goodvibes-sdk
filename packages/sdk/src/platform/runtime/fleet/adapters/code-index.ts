/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { CodeIndexBuildProgress, CodeIndexStats } from '../../../state/code-index-store.js';
import type { ProcessNode, ProcessState } from '../types.js';

/** Narrow view of CodeIndexStore the fleet needs — Pick<CodeIndexStore, ...>, same pattern as the other adapter deps. */
export interface CodeIndexProcessSource {
  isBuilding(): boolean;
  buildProgress(): CodeIndexBuildProgress | null;
  buildStartedAt(): number | null;
  stats(): CodeIndexStats;
}

/** Single well-known id: one code index per working directory (no per-workspace fan-out in Stage A). */
export function codeIndexNodeId(): string {
  return 'code-index:main';
}

/**
 * CodeIndexStore → ProcessNode. Silent source (no bus emission, like
 * background-process): liveness rides the registry tick. An index build has
 * no pid, so it is NOT a 'background-process' node (ProcessManager is
 * shell/OS-process-only) — it gets its own ProcessKind, mirroring the
 * orchestrationEngine-dep precedent.
 */
export function adaptCodeIndex(service: CodeIndexProcessSource, now: number): ProcessNode {
  const building = service.isBuilding();
  const progress = service.buildProgress();
  const startedAt = service.buildStartedAt();
  const stats = service.stats();
  const lastBuild = stats.lastBuild;

  const state: ProcessState = building ? 'executing-tool' : lastBuild ? 'done' : 'idle';

  const label = building
    ? progress
      ? `Code index: building ${progress.scanned}/${progress.total} files`
      : 'Code index: building'
    : lastBuild
      ? `Code index: ${stats.indexedFiles} files, ${stats.indexedChunks} chunks`
      : 'Code index: idle';

  return {
    id: codeIndexNodeId(),
    kind: 'code-index',
    parentId: undefined,
    label,
    state,
    startedAt: building ? (startedAt ?? undefined) : (lastBuild?.startedAt ?? undefined),
    completedAt: building ? undefined : (lastBuild?.completedAt ?? undefined),
    elapsedMs: building ? Math.max(0, now - (startedAt ?? now)) : Math.max(0, lastBuild?.durationMs ?? 0),
    costUsd: null,
    costState: 'unpriced',
    currentActivity: building
      ? { kind: 'phase', text: progress ? `Indexing ${progress.scanned}/${progress.total}` : 'Indexing', at: now }
      : undefined,
    capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
    raw: stats,
  };
}
