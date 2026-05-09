import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import {
  PROJECT_KNOWLEDGE_SPACE_PREFIX,
  isProjectKnowledgeSpace,
  normalizeKnowledgeSpaceId,
  normalizeProjectId,
  normalizeSpaceComponent,
  projectKnowledgeSpaceId,
} from '../spaces.js';
import type {
  ProjectPlanningDecision,
  ProjectPlanningLanguageArtifact,
  ProjectPlanningSpaceInput,
  ProjectPlanningState,
  ProjectWorkPlanArtifact,
} from './types.js';

export const PROJECT_PLANNING_CONNECTOR_ID = 'goodvibes-project-planning';
export const PROJECT_PLANNING_TAG = 'project-planning';

export type ProjectPlanningArtifactKind = 'state' | 'decision' | 'language' | 'work-plan';

export interface ResolvedProjectPlanningSpace {
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
}

export function projectPlanningProjectIdFromPath(path: string): string {
  const resolved = resolve(path);
  const name = normalizeSpaceComponent(basename(resolved) || 'project');
  const digest = createHash('sha256').update(resolved).digest('hex').slice(0, 10);
  return `${name}-${digest}`;
}

export function resolveProjectPlanningSpace(
  input: ProjectPlanningSpaceInput = {},
  defaultProjectId = 'default',
): ResolvedProjectPlanningSpace {
  const explicitSpace = typeof input.knowledgeSpaceId === 'string'
    ? normalizeKnowledgeSpaceId(input.knowledgeSpaceId)
    : '';
  if (explicitSpace && isProjectKnowledgeSpace(explicitSpace)) {
    return {
      knowledgeSpaceId: explicitSpace,
      projectId: projectIdFromSpace(explicitSpace),
    };
  }
  const projectId = normalizeProjectId(input.projectId ?? defaultProjectId);
  return {
    projectId,
    knowledgeSpaceId: projectKnowledgeSpaceId(projectId),
  };
}

export function projectIdFromSpace(spaceId: string): string {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  if (!normalized.startsWith(PROJECT_KNOWLEDGE_SPACE_PREFIX)) {
    return normalizeProjectId(normalized);
  }
  return normalizeProjectId(normalized.slice(PROJECT_KNOWLEDGE_SPACE_PREFIX.length));
}

export function projectPlanningCanonicalUri(
  spaceId: string,
  kind: ProjectPlanningArtifactKind,
  id: string,
): string {
  return `goodvibes://planning/${encodeURIComponent(spaceId)}/${kind}/${encodeURIComponent(id)}`;
}

export function projectPlanningSourceId(
  spaceId: string,
  kind: ProjectPlanningArtifactKind,
  id: string,
): string {
  const digest = createHash('sha256').update(`${spaceId}:${kind}:${id}`).digest('hex').slice(0, 16);
  return `project-planning-${kind}-${digest}`;
}

export function projectPlanningArtifactSummary(kind: ProjectPlanningArtifactKind, value: unknown): string {
  if (kind === 'state') {
    const state = value as Partial<ProjectPlanningState>;
    return state.goal ? `Planning state for ${state.goal}` : 'Project planning state.';
  }
  if (kind === 'decision') {
    const decision = value as Partial<ProjectPlanningDecision>;
    return decision.decision ? `${decision.title ?? 'Decision'}: ${decision.decision}` : 'Project planning decision record.';
  }
  if (kind === 'work-plan') {
    const workPlan = value as Partial<ProjectWorkPlanArtifact>;
    return `Project work plan with ${workPlan.tasks?.length ?? 0} tasks.`;
  }
  const language = value as Partial<ProjectPlanningLanguageArtifact>;
  return `Project language artifact with ${language.terms?.length ?? 0} terms and ${language.ambiguities?.length ?? 0} resolved ambiguities.`;
}

export function stablePlanningId(prefix: string, value: string): string {
  const normalized = normalizeSpaceComponent(value);
  if (normalized !== 'default') return normalized;
  const digest = createHash('sha256').update(value || prefix).digest('hex').slice(0, 10);
  return `${prefix}-${digest}`;
}

export function readPlanningMetadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
