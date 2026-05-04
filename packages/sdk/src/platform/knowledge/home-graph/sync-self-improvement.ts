import type { ArtifactStore } from '../../artifacts/index.js';
import { sleep, yieldEvery } from '../cooperative.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import type { KnowledgeStore } from '../store.js';
import { edgeIsActive, readHomeAssistantMetadataString, uniqueStrings } from './helpers.js';
import { refreshHomeGraphDevicePassport } from './generated-pages.js';
import { isUsefulHomeGraphPageFact } from './page-quality.js';
import { readHomeGraphSearchState } from './search.js';
import { readHomeGraphState } from './state.js';

const MAX_DEVICE_PAGE_REPAIRS_PER_REFRESH = 16;
const SYNC_SELF_IMPROVEMENT_MAX_RUN_MS = 120_000;
const SYNC_SELF_IMPROVEMENT_MAX_ROUNDS = 10;
const SYNC_SELF_IMPROVEMENT_INITIAL_LIMIT = 24;
const SYNC_SELF_IMPROVEMENT_FOLLOWUP_LIMIT = 12;
const SYNC_SELF_IMPROVEMENT_INGEST_LIMIT = 12;
const SYNC_SELF_IMPROVEMENT_INITIAL_RUN_MS = 45_000;
const SYNC_SELF_IMPROVEMENT_FOLLOWUP_RUN_MS = 30_000;
const SYNC_SELF_IMPROVEMENT_FAST_SLEEP_MS = 5_000;
const SYNC_SELF_IMPROVEMENT_SLOW_SLEEP_MS = 15_000;

export const HOME_GRAPH_SYNC_SELF_IMPROVEMENT_START_DELAY_MS = 5_000;

export interface HomeGraphSelfImprovementRuntime {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly semanticService: KnowledgeSemanticService;
  readonly reportBackgroundError: (event: string, error: unknown, metadata: Record<string, unknown>) => void;
}

export async function runHomeGraphSyncSelfImprovementPump(
  runtime: HomeGraphSelfImprovementRuntime,
  spaceId: string,
  installationId: string,
  signal: AbortSignal,
): Promise<void> {
  const deadlineAt = Date.now() + SYNC_SELF_IMPROVEMENT_MAX_RUN_MS;
  for (let round = 0; round < SYNC_SELF_IMPROVEMENT_MAX_ROUNDS; round += 1) {
    if (signal.aborted) return;
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    if (remainingMs <= 0) return;
    const result = await runtime.semanticService.selfImprove({
      knowledgeSpaceId: spaceId,
      reason: 'homegraph-sync',
      limit: round === 0 ? SYNC_SELF_IMPROVEMENT_INITIAL_LIMIT : SYNC_SELF_IMPROVEMENT_FOLLOWUP_LIMIT,
      maxRunMs: Math.min(
        round === 0 ? SYNC_SELF_IMPROVEMENT_INITIAL_RUN_MS : SYNC_SELF_IMPROVEMENT_FOLLOWUP_RUN_MS,
        remainingMs,
      ),
      force: round > 0,
      signal,
    });
    if ((result.acceptedSourceIds?.length ?? 0) > 0 || (result.promotedFactCount ?? 0) > 0 || result.closedGaps > 0) {
      await refreshHomeGraphDevicePagesForSourceIds(runtime, spaceId, installationId, result.acceptedSourceIds ?? []);
    }
    if (!shouldContinueHomeGraphSyncSelfImprovement(result)) return;
    await sleep(Math.min(
      round < 2 ? SYNC_SELF_IMPROVEMENT_FAST_SLEEP_MS : SYNC_SELF_IMPROVEMENT_SLOW_SLEEP_MS,
      Math.max(0, deadlineAt - Date.now()),
    ), { signal });
  }
}

export async function enrichHomeGraphSpaceSources(
  runtime: HomeGraphSelfImprovementRuntime,
  spaceId: string,
): Promise<void> {
  const sources = readHomeGraphSearchState(runtime.store, spaceId).sources;
  await runtime.semanticService.enrichSources(sources, { knowledgeSpaceId: spaceId });
  const result = await runtime.semanticService.selfImprove({ knowledgeSpaceId: spaceId, reason: 'reindex' });
  const installationId = readHomeGraphInstallationIdFromSpace(spaceId);
  if (installationId && ((result.acceptedSourceIds?.length ?? 0) > 0 || (result.promotedFactCount ?? 0) > 0 || result.closedGaps > 0)) {
    await refreshHomeGraphDevicePagesForSourceIds(runtime, spaceId, installationId, result.acceptedSourceIds ?? []);
  }
}

export async function enrichAndImproveHomeGraphSource(
  runtime: HomeGraphSelfImprovementRuntime,
  sourceId: string,
  spaceId: string,
): Promise<void> {
  await runtime.semanticService.enrichSource(sourceId, { knowledgeSpaceId: spaceId });
  if (!sourceHasUsefulSemanticFacts(runtime.store, sourceId, spaceId)) return;
  const result = await runtime.semanticService.selfImprove({
    knowledgeSpaceId: spaceId,
    sourceIds: [sourceId],
    reason: 'ingest',
    limit: SYNC_SELF_IMPROVEMENT_INGEST_LIMIT,
  });
  const installationId = readHomeGraphInstallationIdFromSpace(spaceId);
  if (installationId && ((result.acceptedSourceIds?.length ?? 0) > 0 || (result.promotedFactCount ?? 0) > 0 || result.closedGaps > 0)) {
    await refreshHomeGraphDevicePagesForSourceIds(runtime, spaceId, installationId, uniqueStrings([sourceId, ...(result.acceptedSourceIds ?? [])]));
  }
}

function sourceHasUsefulSemanticFacts(store: KnowledgeStore, sourceId: string, spaceId: string): boolean {
  const state = readHomeGraphState(store, spaceId);
  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
  return state.edges
    .filter((edge) => edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    .map((edge) => nodesById.get(edge.toId))
    .some((node) => Boolean(node && node.kind === 'fact' && isUsefulHomeGraphPageFact(node)));
}

export async function refreshHomeGraphDevicePagesForSourceIds(
  runtime: HomeGraphSelfImprovementRuntime,
  spaceId: string,
  installationId: string,
  sourceIds: readonly string[],
): Promise<void> {
  const wanted = new Set(sourceIds.filter(Boolean));
  const state = readHomeGraphState(runtime.store, spaceId);
  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
  const factIds = new Set<string>();
  const deviceNodeIds = new Set<string>();
  for (const edge of state.edges) {
    if (!edgeIsActive(edge)) continue;
    if (wanted.size > 0 && edge.fromKind === 'source' && edge.toKind === 'node' && wanted.has(edge.fromId)) {
      const node = nodesById.get(edge.toId);
      if (node?.kind === 'ha_device') deviceNodeIds.add(node.id);
      if (node?.kind === 'fact') factIds.add(node.id);
    }
    if (wanted.size > 0 && edge.fromKind === 'node' && edge.toKind === 'source' && wanted.has(edge.toId)) {
      const node = nodesById.get(edge.fromId);
      if (node?.kind === 'ha_device') deviceNodeIds.add(node.id);
      if (node?.kind === 'fact') factIds.add(node.id);
    }
    if (wanted.size === 0 && edge.fromKind === 'node' && edge.toKind === 'node' && edge.relation === 'describes') {
      const fact = nodesById.get(edge.fromId);
      const device = nodesById.get(edge.toId);
      if (fact && device?.kind === 'ha_device' && isUsefulHomeGraphPageFact(fact)) deviceNodeIds.add(device.id);
    }
  }
  for (const edge of state.edges) {
    if (!edgeIsActive(edge)) continue;
    if (edge.fromKind === 'node' && edge.toKind === 'node' && factIds.has(edge.fromId) && edge.relation === 'describes') {
      const device = nodesById.get(edge.toId);
      if (device?.kind === 'ha_device') deviceNodeIds.add(device.id);
    }
  }
  for (const [index, deviceNodeId] of [...deviceNodeIds].slice(0, MAX_DEVICE_PAGE_REPAIRS_PER_REFRESH).entries()) {
    const device = nodesById.get(deviceNodeId);
    if (!device) continue;
    const deviceId = readHomeAssistantMetadataString(device, 'objectId', 'deviceId') ?? device.id;
    try {
      await refreshHomeGraphDevicePassport({
        store: runtime.store,
        artifactStore: runtime.artifactStore,
        spaceId,
        installationId,
        input: {
          knowledgeSpaceId: spaceId,
          deviceId,
          metadata: { automation: 'semantic-repair-refresh' },
        },
      });
    } catch (error) {
      runtime.reportBackgroundError('homegraph-refresh-device-page', error, {
        spaceId,
        installationId,
        deviceId,
      });
    }
    await yieldEvery(index, 2);
  }
}

export function shouldContinueHomeGraphSyncSelfImprovement(result: {
  readonly createdGaps?: number | undefined;
  readonly truncated?: boolean | undefined;
  readonly budgetExhausted?: boolean | undefined;
  readonly processedGaps?: number | undefined;
  readonly repairableGaps: number;
  readonly queuedTasks: number;
  readonly closedGaps: number;
  readonly acceptedSourceIds?: readonly string[] | undefined;
  readonly promotedFactCount?: number | undefined;
  readonly taskIds: readonly string[];
}): boolean {
  const madeProgress = result.closedGaps > 0
    || (result.createdGaps ?? 0) > 0
    || result.queuedTasks > 0
    || result.taskIds.length > 0
    || (result.acceptedSourceIds?.length ?? 0) > 0
    || (result.promotedFactCount ?? 0) > 0
    || (result.processedGaps ?? 0) > 0;
  if (!madeProgress) return false;
  return result.truncated === true || result.budgetExhausted === true || result.repairableGaps > 0 || result.queuedTasks > 0;
}

export function readHomeGraphInstallationIdFromSpace(spaceId: string): string | undefined {
  const match = /^homeassistant:(.+)$/i.exec(spaceId);
  return match?.[1] && match[1].trim() ? match[1].trim() : undefined;
}
