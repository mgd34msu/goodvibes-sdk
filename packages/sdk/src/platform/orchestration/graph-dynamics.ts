/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * graph-dynamics.ts — the runtime-dynamic dependency-graph muscles added to
 * the ONE workstream engine (the fix-phase rework; never a sibling
 * scheduler):
 *
 * - live edge addition with cycle refusal (a discovered missed dependency adds
 *   an edge; a cycle surfaces IMMEDIATELY as a structured outcome, never a
 *   silently-never-ready node);
 * - integration-conflict serialization edges (later items touching a
 *   conflicted item's files wait for its resolution);
 * - deepest-remaining-path priority (the critical path never idles);
 * - orphan detection (a blocker hard-failed past its retry bound orphans its
 *   transitive dependents — surfaced immediately, structured);
 * - the graph snapshot surfaces render (nodes, edges, states, pool state,
 *   stalled tells).
 */
import type { OrchestrationEvent, WorkItem, Workstream } from './types.js';

/** Fields shared by every edge-add outcome. */
export interface EdgeAddResult {
  readonly added: boolean;
  /** The cycle path (item titles) when the edge was refused for creating one. */
  readonly cycle?: readonly string[] | undefined;
  readonly reason?: string | undefined;
}

function edgeTargets(workstream: Workstream, item: WorkItem): WorkItem[] {
  const out: WorkItem[] = [];
  for (const depId of item.dependsOn) {
    const dep = workstream.items.find((i) => i.id === depId);
    if (dep) out.push(dep);
    else for (const sibling of workstream.items.filter((i) => i.attemptSourceId === depId)) out.push(sibling);
  }
  return out;
}

/** DFS: would adding `from -> dependsOn -> to` close a cycle? Returns the path when yes. */
export function wouldCreateCycle(workstream: Workstream, fromItemId: string, toItemId: string): readonly string[] | null {
  // A cycle exists if `to` (the new blocker) can already reach `from` through dependsOn edges.
  const start = workstream.items.find((i) => i.id === toItemId);
  const target = fromItemId;
  if (!start) return null;
  const stack: Array<{ item: WorkItem; path: string[] }> = [{ item: start, path: [start.title] }];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const { item, path } = stack.pop()!;
    if (item.id === target) return [...path, workstream.items.find((i) => i.id === fromItemId)?.title ?? fromItemId];
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    for (const dep of edgeTargets(workstream, item)) {
      stack.push({ item: dep, path: [...path, dep.title] });
    }
  }
  return null;
}

/**
 * Add a dependency edge live (`itemId` now waits on `dependsOnId`). Refuses a
 * self-edge, an unknown endpoint, a duplicate (idempotent success), and — the
 * structured outcome — a cycle: the refusal emits `graph-cycle` naming the
 * path, so the discovery is immediate and visible, never a stuck node.
 */
export function addDependencyEdge(
  workstream: Workstream,
  itemId: string,
  dependsOnId: string,
  reason: string,
  emit: (event: OrchestrationEvent) => void,
): EdgeAddResult {
  if (itemId === dependsOnId) return { added: false, reason: 'an item cannot depend on itself' };
  const item = workstream.items.find((i) => i.id === itemId);
  const blocker = workstream.items.find((i) => i.id === dependsOnId)
    ?? workstream.items.find((i) => i.attemptSourceId === dependsOnId);
  if (!item || !blocker) return { added: false, reason: 'unknown item id' };
  if (item.dependsOn.includes(dependsOnId)) return { added: true, reason: 'edge already present' };
  const cycle = wouldCreateCycle(workstream, itemId, dependsOnId);
  if (cycle) {
    emit({ type: 'graph-cycle', workstreamId: workstream.id, itemIds: [itemId, dependsOnId], cycle });
    return { added: false, cycle, reason: `edge refused: would create a cycle (${cycle.join(' -> ')})` };
  }
  item.dependsOn.push(dependsOnId);
  emit({ type: 'item-edge-added', workstreamId: workstream.id, itemId, dependsOnId, reason });
  return { added: true };
}

/**
 * Integration-conflict serialization: when `conflicted` could not merge, every
 * LATER non-terminal item that shares any of its files gains a serialization
 * edge on the conflicted item — they wait for the resolution instead of piling
 * more merges onto a known-conflicted base region.
 */
export function addConflictSerializationEdges(
  workstream: Workstream,
  conflicted: WorkItem,
  conflictFiles: readonly string[],
  emit: (event: OrchestrationEvent) => void,
): number {
  const fileSet = new Set([...conflictFiles, ...(conflicted.files ?? []), ...conflicted.touchedPaths]);
  if (fileSet.size === 0) return 0;
  let added = 0;
  for (const other of workstream.items) {
    if (other.id === conflicted.id) continue;
    if (other.state === 'passed' || other.state === 'failed') continue;
    if (other.state === 'in-phase') continue; // already running — the lane will serialize its merge anyway
    const otherFiles = [...(other.files ?? []), ...other.touchedPaths];
    if (!otherFiles.some((file) => fileSet.has(file))) continue;
    const result = addDependencyEdge(
      workstream, other.id, conflicted.id,
      `serialized after merge conflict on ${conflictFiles.join(', ') || 'shared files'}`, emit,
    );
    if (result.added && result.reason === undefined) added += 1;
  }
  return added;
}

/**
 * Deepest-remaining-path depth per item: the longest chain of transitive
 * DEPENDENTS below it. Claiming deepest-first keeps the critical path moving.
 */
export function remainingDepths(workstream: Workstream): Map<string, number> {
  const dependents = new Map<string, string[]>();
  for (const item of workstream.items) {
    for (const dep of edgeTargets(workstream, item)) {
      const list = dependents.get(dep.id) ?? [];
      list.push(item.id);
      dependents.set(dep.id, list);
    }
  }
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const memo = depths.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) return 0; // cycle guard — cycles surface elsewhere
    visiting.add(id);
    const below = (dependents.get(id) ?? []).map((childId) => 1 + depthOf(childId));
    visiting.delete(id);
    const depth = below.length > 0 ? Math.max(...below) : 0;
    depths.set(id, depth);
    return depth;
  };
  for (const item of workstream.items) depthOf(item.id);
  return depths;
}

/**
 * Orphan pass: an item is ORPHANED when a blocker it (transitively) waits on
 * has hard-failed past its retry bound. Surfaced immediately as a structured
 * outcome (`item-orphaned`, once per item) with the blocker named — never a
 * silently-never-ready node. Returns the ids orphaned by this pass.
 */
export function detectOrphans(
  workstream: Workstream,
  isHardFailed: (item: WorkItem) => boolean,
  emit: (event: OrchestrationEvent) => void,
): string[] {
  const orphanedNow: string[] = [];
  const hardFailedCache = new Map<string, WorkItem | null>();
  const findHardFailedBlocker = (item: WorkItem, seen: Set<string>): WorkItem | null => {
    if (hardFailedCache.has(item.id)) return hardFailedCache.get(item.id)!;
    if (seen.has(item.id)) return null;
    seen.add(item.id);
    for (const dep of edgeTargets(workstream, item)) {
      if (isHardFailed(dep)) { hardFailedCache.set(item.id, dep); return dep; }
      const transitive = findHardFailedBlocker(dep, seen);
      if (transitive) { hardFailedCache.set(item.id, transitive); return transitive; }
    }
    hardFailedCache.set(item.id, null);
    return null;
  };
  for (const item of workstream.items) {
    if (item.state === 'passed' || item.state === 'failed' || item.orphaned) continue;
    if (item.dependsOn.length === 0) continue;
    const blocker = findHardFailedBlocker(item, new Set());
    if (!blocker) continue;
    item.orphaned = true;
    item.blockedReason = `orphaned: blocker "${blocker.title}" hard-failed past its retry bound`;
    orphanedNow.push(item.id);
    emit({ type: 'item-orphaned', workstreamId: workstream.id, itemId: item.id, blockerItemId: blocker.id, reason: item.blockedReason });
  }
  return orphanedNow;
}

/** The elastic-pool state a graph snapshot reports (see engine tick gating). */
export interface PoolStateSnapshot {
  readonly ready: number;
  readonly running: number;
  readonly atCap: boolean;
  readonly capKey: string;
  readonly maxSize: number;
  /** The refusal reason left on ready items when a spawn was refused (cap/policy). */
  readonly refusal?: string | undefined;
}

/** One node of the served task graph. */
export interface GraphNodeSnapshot {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly cluster?: string | undefined;
  readonly files: readonly string[];
  readonly mergeState?: string | undefined;
  readonly blockedReason?: string | undefined;
  readonly orphaned: boolean;
  /** Deepest-remaining-path depth (scheduling priority within the ready set). */
  readonly remainingDepth: number;
  /** Stalled tell: in-phase with no observed activity past the stall window. */
  readonly stalled: boolean;
  readonly agentId?: string | undefined;
}

export interface GraphEdgeSnapshot {
  readonly from: string;
  readonly to: string;
}

export interface WorkstreamGraphSnapshot {
  readonly workstreamId: string;
  readonly title: string;
  readonly nodes: readonly GraphNodeSnapshot[];
  readonly edges: readonly GraphEdgeSnapshot[];
  readonly pool: PoolStateSnapshot | null;
}

/** Build the surface-facing graph snapshot from live workstream state. */
export function buildGraphSnapshot(
  workstream: Workstream,
  pool: PoolStateSnapshot | null,
  isStalled: (item: WorkItem) => boolean,
): WorkstreamGraphSnapshot {
  const depths = remainingDepths(workstream);
  return {
    workstreamId: workstream.id,
    title: workstream.title,
    nodes: workstream.items.map((item) => ({
      id: item.id,
      title: item.title,
      state: item.state,
      cluster: item.cluster,
      files: item.files ?? [],
      mergeState: item.mergeState,
      blockedReason: item.blockedReason,
      orphaned: item.orphaned === true,
      remainingDepth: depths.get(item.id) ?? 0,
      stalled: isStalled(item),
      agentId: item.agentId,
    })),
    edges: workstream.items.flatMap((item) => item.dependsOn.map((dep) => ({ from: item.id, to: dep }))),
    pool,
  };
}
