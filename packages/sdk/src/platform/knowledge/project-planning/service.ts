import {
  knowledgeSpaceMetadata,
  normalizeProjectId,
} from '../spaces.js';
import type { KnowledgeSourceRecord } from '../types.js';
import { KnowledgeStore } from '../store.js';
import {
  PROJECT_PLANNING_CONNECTOR_ID,
  PROJECT_PLANNING_TAG,
  type ProjectPlanningArtifactKind,
  projectPlanningArtifactSummary,
  projectPlanningCanonicalUri,
  projectPlanningSourceId,
  readPlanningMetadataObject,
  resolveProjectPlanningSpace,
  stablePlanningId,
} from './helpers.js';
import { evaluateProjectPlanningReadiness } from './readiness.js';
import type {
  ProjectPlanningDecision,
  ProjectPlanningDecisionRecordInput,
  ProjectPlanningDecisionResult,
  ProjectPlanningDecisionsResult,
  ProjectPlanningEvaluateInput,
  ProjectPlanningEvaluation,
  ProjectPlanningLanguageArtifact,
  ProjectPlanningLanguageResult,
  ProjectPlanningLanguageUpsertInput,
  ProjectPlanningSpaceInput,
  ProjectPlanningState,
  ProjectPlanningStateResult,
  ProjectPlanningStateUpsertInput,
  ProjectPlanningStatus,
} from './types.js';

export interface ProjectPlanningServiceOptions {
  readonly defaultProjectId?: string;
}

export class ProjectPlanningService {
  private readonly defaultProjectId: string;

  constructor(
    private readonly store: KnowledgeStore,
    options: ProjectPlanningServiceOptions = {},
  ) {
    this.defaultProjectId = normalizeProjectId(options.defaultProjectId ?? 'default');
  }

  async status(input: ProjectPlanningSpaceInput = {}): Promise<ProjectPlanningStatus> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const sources = this.sourcesForSpace(space.knowledgeSpaceId);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      passiveOnly: true,
      counts: {
        states: sources.filter((source) => artifactKind(source) === 'state').length,
        decisions: sources.filter((source) => artifactKind(source) === 'decision').length,
        languageArtifacts: sources.filter((source) => artifactKind(source) === 'language').length,
      },
      capabilities: [
        'project-scoped-storage',
        'planning-state-validation',
        'project-language-artifacts',
        'decision-records',
        'agent-task-graph-metadata',
        'passive-daemon-only',
      ],
    };
  }

  async getState(input: ProjectPlanningSpaceInput & { readonly planningId?: string } = {}): Promise<ProjectPlanningStateResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const planningId = normalizePlanningId(input.planningId);
    const source = this.getArtifactSource(space.knowledgeSpaceId, 'state', planningId);
    const state = source ? readState(source) : null;
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      state,
      ...(source ? { source } : {}),
    };
  }

  async upsertState(input: ProjectPlanningStateUpsertInput): Promise<ProjectPlanningStateResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const state = normalizeState(input.state, space.projectId, space.knowledgeSpaceId);
    const evaluation = evaluateProjectPlanningReadiness(state);
    const normalized = evaluation.state;
    const source = await this.upsertArtifactSource(space, 'state', normalized.id, normalized);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      state: normalized,
      source,
    };
  }

  async evaluate(input: ProjectPlanningEvaluateInput = {}): Promise<ProjectPlanningEvaluation> {
    await this.store.init();
    const space = this.resolveSpace(input);
    if (input.state) {
      return evaluateProjectPlanningReadiness(normalizeState(input.state, space.projectId, space.knowledgeSpaceId));
    }
    const stateResult = await this.getState({ ...space, planningId: input.planningId });
    const state = stateResult.state ?? normalizeState({}, space.projectId, space.knowledgeSpaceId);
    return evaluateProjectPlanningReadiness(state);
  }

  async listDecisions(input: ProjectPlanningSpaceInput = {}): Promise<ProjectPlanningDecisionsResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const decisions = this.sourcesForSpace(space.knowledgeSpaceId)
      .filter((source) => artifactKind(source) === 'decision')
      .map(readDecision)
      .filter((decision): decision is ProjectPlanningDecision => decision !== null)
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      decisions,
    };
  }

  async recordDecision(input: ProjectPlanningDecisionRecordInput): Promise<ProjectPlanningDecisionResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const now = Date.now();
    const decision: ProjectPlanningDecision = {
      id: input.decision.id ?? stablePlanningId('decision', input.decision.title),
      title: input.decision.title.trim(),
      ...(input.decision.context ? { context: input.decision.context } : {}),
      decision: input.decision.decision.trim(),
      ...(input.decision.alternatives ? { alternatives: [...input.decision.alternatives] } : {}),
      ...(input.decision.reasoning ? { reasoning: input.decision.reasoning } : {}),
      ...(input.decision.consequences ? { consequences: [...input.decision.consequences] } : {}),
      status: input.decision.status ?? 'accepted',
      createdAt: input.decision.createdAt ?? now,
      updatedAt: now,
      ...(input.decision.metadata ? { metadata: { ...input.decision.metadata } } : {}),
    };
    const source = await this.upsertArtifactSource(space, 'decision', decision.id, decision);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      decision,
      source,
    };
  }

  async getLanguage(input: ProjectPlanningSpaceInput = {}): Promise<ProjectPlanningLanguageResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const source = this.getArtifactSource(space.knowledgeSpaceId, 'language', 'current');
    const language = source ? readLanguage(source) : null;
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      language,
      ...(source ? { source } : {}),
    };
  }

  async upsertLanguage(input: ProjectPlanningLanguageUpsertInput): Promise<ProjectPlanningLanguageResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const now = Date.now();
    const existing = await this.getLanguage(space);
    const language: ProjectPlanningLanguageArtifact = {
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      terms: input.language.terms ? [...input.language.terms] : existing.language?.terms ?? [],
      ambiguities: input.language.ambiguities ? [...input.language.ambiguities] : existing.language?.ambiguities ?? [],
      ...(input.language.examples ? { examples: [...input.language.examples] } : existing.language?.examples ? { examples: existing.language.examples } : {}),
      updatedAt: now,
      metadata: {
        ...(existing.language?.metadata ?? {}),
        ...(input.language.metadata ?? {}),
      },
    };
    const source = await this.upsertArtifactSource(space, 'language', 'current', language);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      language,
      source,
    };
  }

  private resolveSpace(input: ProjectPlanningSpaceInput = {}) {
    return resolveProjectPlanningSpace(input, this.defaultProjectId);
  }

  private sourcesForSpace(spaceId: string): readonly KnowledgeSourceRecord[] {
    return this.store.listSources(Number.MAX_SAFE_INTEGER).filter((source) => {
      const metadata = source.metadata ?? {};
      return metadata.projectPlanning === true && metadata.knowledgeSpaceId === spaceId;
    });
  }

  private getArtifactSource(
    spaceId: string,
    kind: ProjectPlanningArtifactKind,
    id: string,
  ): KnowledgeSourceRecord | null {
    const sourceId = projectPlanningSourceId(spaceId, kind, id);
    return this.store.getSource(sourceId) ?? this.store.getSourceByCanonicalUri(projectPlanningCanonicalUri(spaceId, kind, id));
  }

  private async upsertArtifactSource(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    kind: ProjectPlanningArtifactKind,
    id: string,
    value: ProjectPlanningState | ProjectPlanningDecision | ProjectPlanningLanguageArtifact,
  ): Promise<KnowledgeSourceRecord> {
    const spaceId = space.knowledgeSpaceId;
    return this.store.upsertSource({
      id: projectPlanningSourceId(spaceId, kind, id),
      connectorId: PROJECT_PLANNING_CONNECTOR_ID,
      sourceType: 'dataset',
      title: titleForArtifact(kind, value),
      canonicalUri: projectPlanningCanonicalUri(spaceId, kind, id),
      summary: projectPlanningArtifactSummary(kind, value),
      tags: [PROJECT_PLANNING_TAG, `project-planning:${kind}`],
      status: 'indexed',
      metadata: knowledgeSpaceMetadata(spaceId, {
        projectPlanning: true,
        planningArtifactKind: kind,
        planningArtifactId: id,
        projectId: space.projectId,
        value,
      }),
    });
  }
}

function normalizeState(
  input: Partial<ProjectPlanningState> & { readonly goal?: string },
  projectId: string,
  knowledgeSpaceId: string,
): ProjectPlanningState {
  const now = Date.now();
  const id = normalizePlanningId(input.id);
  return {
    id,
    projectId,
    knowledgeSpaceId,
    goal: typeof input.goal === 'string' ? input.goal : '',
    ...(typeof input.scope === 'string' ? { scope: input.scope } : {}),
    knownContext: arrayOfObjectsOrStrings(input.knownContext),
    openQuestions: arrayOfObjects(input.openQuestions),
    answeredQuestions: arrayOfObjects(input.answeredQuestions),
    decisions: arrayOfObjects(input.decisions),
    assumptions: arrayOfObjectsOrStrings(input.assumptions),
    constraints: arrayOfObjectsOrStrings(input.constraints),
    risks: arrayOfObjectsOrStrings(input.risks),
    tasks: arrayOfObjects(input.tasks),
    dependencies: arrayOfObjects(input.dependencies),
    verificationGates: arrayOfObjects(input.verificationGates),
    agentAssignments: arrayOfObjects(input.agentAssignments),
    readiness: input.readiness ?? 'not-ready',
    executionApproved: input.executionApproved === true,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: now,
    metadata: readPlanningMetadataObject(input.metadata),
  } as ProjectPlanningState;
}

function normalizePlanningId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? stablePlanningId('plan', value)
    : 'current';
}

function arrayOfObjects<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is T => !!entry && typeof entry === 'object' && !Array.isArray(entry));
}

function arrayOfObjectsOrStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (entry && typeof entry === 'object' && 'text' in entry && typeof entry.text === 'string') return [entry.text];
    return [];
  });
}

function artifactKind(source: KnowledgeSourceRecord): ProjectPlanningArtifactKind | null {
  const kind = source.metadata.planningArtifactKind;
  return kind === 'state' || kind === 'decision' || kind === 'language' ? kind : null;
}

function readState(source: KnowledgeSourceRecord): ProjectPlanningState | null {
  const value = source.metadata.value;
  return value && typeof value === 'object' ? value as ProjectPlanningState : null;
}

function readDecision(source: KnowledgeSourceRecord): ProjectPlanningDecision | null {
  const value = source.metadata.value;
  return value && typeof value === 'object' ? value as ProjectPlanningDecision : null;
}

function readLanguage(source: KnowledgeSourceRecord): ProjectPlanningLanguageArtifact | null {
  const value = source.metadata.value;
  return value && typeof value === 'object' ? value as ProjectPlanningLanguageArtifact : null;
}

function titleForArtifact(
  kind: ProjectPlanningArtifactKind,
  value: ProjectPlanningState | ProjectPlanningDecision | ProjectPlanningLanguageArtifact,
): string {
  if (kind === 'state') return `Planning: ${(value as ProjectPlanningState).goal || 'Current plan'}`;
  if (kind === 'decision') return `Decision: ${(value as ProjectPlanningDecision).title}`;
  return 'Project Language';
}
