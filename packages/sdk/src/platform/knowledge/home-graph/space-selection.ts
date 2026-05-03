import type { KnowledgeStore } from '../store.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { homeAssistantSpaceComponent, resolveHomeGraphSpace, sameHomeAssistantSpace } from './helpers.js';
import type { HomeGraphSpaceInput } from './types.js';

export function resolveReadableHomeGraphSpace(
  store: KnowledgeStore,
  input: HomeGraphSpaceInput = {},
): {
  readonly spaceId: string;
  readonly installationId: string;
} {
  const resolved = resolveHomeGraphSpace(input);
  const inferred = inferHomeGraphSpace(store, resolved.spaceId, hasExplicitSpace(input));
  if (!inferred) return resolved;
  return {
    spaceId: inferred,
    installationId: homeAssistantSpaceComponent(inferred) ?? resolved.installationId,
  };
}

function hasExplicitSpace(input: HomeGraphSpaceInput): boolean {
  return hasText(input.installationId) || hasText(input.knowledgeSpaceId);
}

function inferHomeGraphSpace(
  store: KnowledgeStore,
  requestedSpaceId: string,
  requireRequestedSpaceMatch: boolean,
): string | undefined {
  const candidates = new Map<string, number>();
  for (const record of [
    ...store.listSources(Number.MAX_SAFE_INTEGER),
    ...store.listNodes(Number.MAX_SAFE_INTEGER),
    ...store.listIssues(Number.MAX_SAFE_INTEGER),
    ...store.listExtractions(Number.MAX_SAFE_INTEGER),
  ]) {
    const spaceId = getKnowledgeSpaceId(record);
    if (!homeAssistantSpaceComponent(spaceId)) continue;
    if (requireRequestedSpaceMatch && !sameHomeAssistantSpace(spaceId, requestedSpaceId)) continue;
    candidates.set(spaceId, Math.max(candidates.get(spaceId) ?? 0, record.updatedAt ?? record.createdAt ?? 0));
  }
  return [...candidates.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
