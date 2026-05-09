import { randomUUID } from 'node:crypto';
import {
  knowledgeSpaceMetadata,
  normalizeProjectId,
} from '../spaces.js';
import type { KnowledgeSourceRecord } from '../types.js';
import { KnowledgeStore } from '../store.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import {
  emitWorkPlanSnapshotInvalidated,
  emitWorkPlanTaskCreated,
  emitWorkPlanTaskDeleted,
  emitWorkPlanTaskStatusChanged,
  emitWorkPlanTaskUpdated,
} from '../../runtime/emitters/index.js';
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
  ProjectPlanningTask,
  ProjectWorkPlanArtifact,
  ProjectWorkPlanClearCompletedInput,
  ProjectWorkPlanCounts,
  ProjectWorkPlanMutationResult,
  ProjectWorkPlanSnapshot,
  ProjectWorkPlanTask,
  ProjectWorkPlanTaskCreateInput,
  ProjectWorkPlanTaskDeleteInput,
  ProjectWorkPlanTaskGetInput,
  ProjectWorkPlanTaskListInput,
  ProjectWorkPlanTaskMutationSource,
  ProjectWorkPlanTaskReorderInput,
  ProjectWorkPlanTaskResult,
  ProjectWorkPlanTaskStatus,
  ProjectWorkPlanTaskStatusInput,
  ProjectWorkPlanTaskUpdateInput,
} from './types.js';

type MutableProjectWorkPlanCounts = {
  -readonly [K in keyof ProjectWorkPlanCounts]: ProjectWorkPlanCounts[K];
};

type WorkPlanTaskCandidate = {
  readonly [K in keyof ProjectWorkPlanTask]?: ProjectWorkPlanTask[K] | undefined;
} & {
  readonly title?: string | undefined;
};

export interface ProjectPlanningServiceOptions {
  readonly defaultProjectId?: string | undefined;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
}

export class ProjectPlanningService {
  private readonly defaultProjectId: string;
  private runtimeBus: RuntimeEventBus | null;

  constructor(
    private readonly store: KnowledgeStore,
    options: ProjectPlanningServiceOptions = {},
  ) {
    this.defaultProjectId = normalizeProjectId(options.defaultProjectId ?? 'default');
    this.runtimeBus = options.runtimeBus ?? null;
  }

  attachRuntimeBus(runtimeBus: RuntimeEventBus | null | undefined): void {
    this.runtimeBus = runtimeBus ?? null;
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
        workPlans: sources.filter((source) => artifactKind(source) === 'work-plan').length,
        workPlanTasks: sources
          .filter((source) => artifactKind(source) === 'work-plan')
          .reduce((count, source) => count + (readWorkPlan(source)?.tasks.length ?? 0), 0),
      },
      capabilities: [
        'project-scoped-storage',
        'planning-state-validation',
        'project-language-artifacts',
        'decision-records',
        'durable-work-plan-tasks',
        'work-plan-transition-events',
        'agent-task-graph-metadata',
        'passive-daemon-only',
      ],
    };
  }

  async getState(input: ProjectPlanningSpaceInput & { readonly planningId?: string | undefined } = {}): Promise<ProjectPlanningStateResult> {
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
    await this.syncPlanningStateTasksToWorkPlan(space, normalized);
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

  async getWorkPlanSnapshot(input: ProjectWorkPlanTaskListInput = {}): Promise<ProjectWorkPlanSnapshot> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const workPlan = this.getWorkPlanArtifact(space, normalizeWorkPlanId(input.workPlanId));
    return snapshotFromWorkPlan(space, workPlan, {
      status: input.status,
      parentTaskId: input.parentTaskId,
      chainId: input.chainId,
      owner: input.owner,
      limit: input.limit,
    });
  }

  async getWorkPlanTask(input: ProjectWorkPlanTaskGetInput): Promise<ProjectWorkPlanTaskResult> {
    await this.store.init();
    const snapshot = await this.getWorkPlanSnapshot(input);
    return {
      ok: true,
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      task: snapshot.tasks.find((task) => task.taskId === input.taskId) ?? null,
      snapshot,
    };
  }

  async createWorkPlanTask(input: ProjectWorkPlanTaskCreateInput): Promise<ProjectWorkPlanMutationResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const existing = this.getWorkPlanArtifact(space, workPlanId);
    const now = Date.now();
    const task = normalizeWorkPlanTask(input.task, {
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      now,
      fallbackOrder: nextWorkPlanOrder(existing.tasks),
    });
    if (existing.tasks.some((entry) => entry.taskId === task.taskId)) {
      throw new Error(`Work plan task already exists: ${task.taskId}`);
    }
    const workPlan = await this.saveWorkPlanArtifact(space, {
      ...existing,
      tasks: sortWorkPlanTasks([...existing.tasks, task]),
      updatedAt: now,
    });
    const snapshot = snapshotFromWorkPlan(space, workPlan);
    this.emitWorkPlanTaskCreated(snapshot, task);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      workPlanId,
      task,
      snapshot,
    };
  }

  async updateWorkPlanTask(input: ProjectWorkPlanTaskUpdateInput): Promise<ProjectWorkPlanMutationResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const existing = this.getWorkPlanArtifact(space, workPlanId);
    const previousTask = existing.tasks.find((task) => task.taskId === input.taskId);
    if (!previousTask) throw new Error(`Work plan task not found: ${input.taskId}`);
    const now = Date.now();
    const task = normalizeWorkPlanTask({
      ...previousTask,
      ...input.patch,
      metadata: {
        ...(previousTask.metadata ?? {}),
        ...(input.patch.metadata ?? {}),
      },
      taskId: previousTask.taskId,
      createdAt: previousTask.createdAt,
      updatedAt: now,
    }, {
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      now,
      fallbackOrder: previousTask.order,
    });
    const workPlan = await this.saveWorkPlanArtifact(space, {
      ...existing,
      tasks: sortWorkPlanTasks(existing.tasks.map((entry) => entry.taskId === input.taskId ? task : entry)),
      updatedAt: now,
    });
    const snapshot = snapshotFromWorkPlan(space, workPlan);
    this.emitWorkPlanTaskUpdated(snapshot, task, previousTask);
    if (previousTask.status !== task.status) {
      this.emitWorkPlanTaskStatusChanged(snapshot, task, previousTask);
    }
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      workPlanId,
      task,
      previousTask,
      snapshot,
    };
  }

  async setWorkPlanTaskStatus(input: ProjectWorkPlanTaskStatusInput): Promise<ProjectWorkPlanMutationResult> {
    return this.updateWorkPlanTask({
      projectId: input.projectId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      workPlanId: input.workPlanId,
      taskId: input.taskId,
      patch: {
        status: normalizeWorkPlanStatus(input.status),
        ...(input.source ? { source: input.source } : {}),
        metadata: {
          ...(input.reason ? { statusReason: input.reason } : {}),
        },
      },
    });
  }

  async reorderWorkPlanTasks(input: ProjectWorkPlanTaskReorderInput): Promise<ProjectWorkPlanSnapshot> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const existing = this.getWorkPlanArtifact(space, workPlanId);
    const previousById = new Map(existing.tasks.map((task) => [task.taskId, task]));
    const orderById = new Map(input.orderedTaskIds.map((taskId, index) => [taskId, index]));
    for (const taskId of orderById.keys()) {
      if (!previousById.has(taskId)) throw new Error(`Work plan task not found: ${taskId}`);
    }
    const now = Date.now();
    const tasks = sortWorkPlanTasks(existing.tasks.map((task) => ({
      ...task,
      order: orderById.get(task.taskId) ?? task.order + input.orderedTaskIds.length,
      updatedAt: orderById.has(task.taskId) ? now : task.updatedAt,
    })));
    const workPlan = await this.saveWorkPlanArtifact(space, {
      ...existing,
      tasks,
      updatedAt: now,
    });
    const snapshot = snapshotFromWorkPlan(space, workPlan);
    for (const task of tasks) {
      const previousTask = previousById.get(task.taskId);
      if (previousTask && previousTask.order !== task.order) {
        this.emitWorkPlanTaskUpdated(snapshot, task, previousTask, true);
      }
    }
    this.emitWorkPlanSnapshotInvalidated(snapshot, 'reordered');
    return snapshot;
  }

  async deleteWorkPlanTask(input: ProjectWorkPlanTaskDeleteInput): Promise<ProjectWorkPlanMutationResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const existing = this.getWorkPlanArtifact(space, workPlanId);
    const deletedTask = existing.tasks.find((task) => task.taskId === input.taskId);
    if (!deletedTask) throw new Error(`Work plan task not found: ${input.taskId}`);
    const now = Date.now();
    const workPlan = await this.saveWorkPlanArtifact(space, {
      ...existing,
      tasks: existing.tasks.filter((task) => task.taskId !== input.taskId),
      updatedAt: now,
    });
    const snapshot = snapshotFromWorkPlan(space, workPlan);
    this.emitWorkPlanTaskDeleted(snapshot, deletedTask);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      workPlanId,
      deletedTask,
      snapshot,
    };
  }

  async clearCompletedWorkPlanTasks(input: ProjectWorkPlanClearCompletedInput = {}): Promise<ProjectWorkPlanMutationResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const existing = this.getWorkPlanArtifact(space, workPlanId);
    const statuses = new Set(input.statuses?.length ? input.statuses.map(normalizeWorkPlanStatus) : ['done']);
    const cleared = existing.tasks.filter((task) => statuses.has(task.status));
    const now = Date.now();
    const workPlan = await this.saveWorkPlanArtifact(space, {
      ...existing,
      tasks: existing.tasks.filter((task) => !statuses.has(task.status)),
      updatedAt: now,
    });
    const snapshot = snapshotFromWorkPlan(space, workPlan);
    for (const task of cleared) {
      this.emitWorkPlanTaskDeleted(snapshot, task, true);
    }
    this.emitWorkPlanSnapshotInvalidated(snapshot, 'cleared-completed');
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      workPlanId,
      clearedTaskIds: cleared.map((task) => task.taskId),
      snapshot,
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

  private getWorkPlanArtifact(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    workPlanId: string,
  ): ProjectWorkPlanArtifact {
    const source = this.getArtifactSource(space.knowledgeSpaceId, 'work-plan', workPlanId);
    const value = source?.metadata.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return normalizeWorkPlanArtifact(value as Partial<ProjectWorkPlanArtifact>, space, workPlanId);
    }
    const now = Date.now();
    return {
      id: workPlanId,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      tasks: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async saveWorkPlanArtifact(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    workPlan: ProjectWorkPlanArtifact,
  ): Promise<ProjectWorkPlanArtifact> {
    const normalized = normalizeWorkPlanArtifact(workPlan, space, workPlan.id);
    await this.upsertArtifactSource(space, 'work-plan', normalized.id, normalized);
    return normalized;
  }

  private async syncPlanningStateTasksToWorkPlan(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    state: ProjectPlanningState,
  ): Promise<void> {
    for (const [index, task] of state.tasks.entries()) {
      if (!task.title?.trim()) continue;
      const taskId = normalizeWorkPlanTaskId(`planning-${state.id}-${task.id || task.title}`);
      const workPlanTask = {
        taskId,
        title: task.title,
        notes: task.why,
        owner: task.recommendedAgent,
        status: workPlanStatusFromPlanningTask(task),
        priority: task.needsReview ? 10 : 0,
        order: index,
        source: 'planning',
        tags: [
          'planning',
          ...(task.needsReview ? ['needs-review'] : []),
          ...(task.blockedOnUserInput ? ['blocked-on-user-input'] : []),
        ],
        originSurface: 'daemon',
        metadata: {
          planningId: state.id,
          planningTaskId: task.id,
          dependencies: task.dependencies ?? [],
          likelyFiles: task.likelyFiles ?? [],
          verification: task.verification ?? [],
          canRunConcurrently: task.canRunConcurrently === true,
        },
      };
      try {
        await this.createWorkPlanTask({
          projectId: space.projectId,
          knowledgeSpaceId: space.knowledgeSpaceId,
          task: workPlanTask,
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('already exists')) throw error;
        await this.updateWorkPlanTask({
          projectId: space.projectId,
          knowledgeSpaceId: space.knowledgeSpaceId,
          taskId,
          patch: workPlanTask,
        });
      }
    }
  }

  private async upsertArtifactSource(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    kind: ProjectPlanningArtifactKind,
    id: string,
    value: ProjectPlanningState | ProjectPlanningDecision | ProjectPlanningLanguageArtifact | ProjectWorkPlanArtifact,
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

  private emitWorkPlanTaskCreated(snapshot: ProjectWorkPlanSnapshot, task: ProjectWorkPlanTask): void {
    if (!this.runtimeBus) return;
    emitWorkPlanTaskCreated(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      task,
    });
    this.emitWorkPlanSnapshotInvalidated(snapshot, 'task-created');
  }

  private emitWorkPlanTaskUpdated(
    snapshot: ProjectWorkPlanSnapshot,
    task: ProjectWorkPlanTask,
    previousTask: ProjectWorkPlanTask,
    skipSnapshotInvalidation = false,
  ): void {
    if (!this.runtimeBus) return;
    emitWorkPlanTaskUpdated(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      task,
      previousTask,
    });
    if (!skipSnapshotInvalidation) this.emitWorkPlanSnapshotInvalidated(snapshot, 'task-updated');
  }

  private emitWorkPlanTaskStatusChanged(
    snapshot: ProjectWorkPlanSnapshot,
    task: ProjectWorkPlanTask,
    previousTask: ProjectWorkPlanTask,
  ): void {
    if (!this.runtimeBus) return;
    emitWorkPlanTaskStatusChanged(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      taskId: task.taskId,
      status: task.status,
      previousStatus: previousTask.status,
      task,
    });
  }

  private emitWorkPlanTaskDeleted(
    snapshot: ProjectWorkPlanSnapshot,
    task: ProjectWorkPlanTask,
    skipSnapshotInvalidation = false,
  ): void {
    if (!this.runtimeBus) return;
    emitWorkPlanTaskDeleted(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      taskId: task.taskId,
      task,
    });
    if (!skipSnapshotInvalidation) this.emitWorkPlanSnapshotInvalidated(snapshot, 'task-deleted');
  }

  private emitWorkPlanSnapshotInvalidated(snapshot: ProjectWorkPlanSnapshot, reason: string): void {
    if (!this.runtimeBus) return;
    emitWorkPlanSnapshotInvalidated(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      reason,
      snapshot,
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

function normalizeWorkPlanArtifact(
  input: Partial<ProjectWorkPlanArtifact>,
  space: { readonly projectId: string; readonly knowledgeSpaceId: string },
  workPlanId: string,
): ProjectWorkPlanArtifact {
  const now = Date.now();
  const createdAt = typeof input.createdAt === 'number' ? input.createdAt : now;
  const tasks = Array.isArray(input.tasks)
    ? input.tasks.map((task, index) => normalizeWorkPlanTask(task, {
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      now,
      fallbackOrder: index,
    }))
    : [];
  return {
    id: normalizeWorkPlanId(input.id ?? workPlanId),
    projectId: space.projectId,
    knowledgeSpaceId: space.knowledgeSpaceId,
    tasks: sortWorkPlanTasks(tasks),
    createdAt,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now,
    ...(input.metadata ? { metadata: readPlanningMetadataObject(input.metadata) } : {}),
  };
}

function normalizeWorkPlanTask(
  input: WorkPlanTaskCandidate,
  options: {
    readonly projectId: string;
    readonly knowledgeSpaceId: string;
    readonly now: number;
    readonly fallbackOrder: number;
  },
): ProjectWorkPlanTask {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new Error('Work plan task title is required.');
  const status = normalizeWorkPlanStatus(input.status ?? 'pending');
  const createdAt = typeof input.createdAt === 'number' ? input.createdAt : options.now;
  return {
    taskId: normalizeWorkPlanTaskId(input.taskId ?? `task-${randomUUID().slice(0, 12)}`),
    projectId: options.projectId,
    knowledgeSpaceId: options.knowledgeSpaceId,
    title,
    ...(typeof input.notes === 'string' ? { notes: input.notes } : {}),
    ...(typeof input.owner === 'string' && input.owner.trim() ? { owner: input.owner.trim() } : {}),
    status,
    ...(typeof input.priority === 'number' && Number.isFinite(input.priority) ? { priority: input.priority } : {}),
    order: typeof input.order === 'number' && Number.isFinite(input.order) ? input.order : options.fallbackOrder,
    ...(typeof input.source === 'string' && input.source.trim() ? { source: input.source.trim() } : {}),
    tags: stringList(input.tags),
    ...(typeof input.parentTaskId === 'string' && input.parentTaskId.trim() ? { parentTaskId: normalizeWorkPlanTaskId(input.parentTaskId) } : {}),
    ...(typeof input.chainId === 'string' && input.chainId.trim() ? { chainId: input.chainId.trim() } : {}),
    ...(typeof input.phaseId === 'string' && input.phaseId.trim() ? { phaseId: input.phaseId.trim() } : {}),
    ...(typeof input.agentId === 'string' && input.agentId.trim() ? { agentId: input.agentId.trim() } : {}),
    ...(typeof input.turnId === 'string' && input.turnId.trim() ? { turnId: input.turnId.trim() } : {}),
    ...(typeof input.decisionId === 'string' && input.decisionId.trim() ? { decisionId: input.decisionId.trim() } : {}),
    ...(typeof input.sourceMessageId === 'string' && input.sourceMessageId.trim() ? { sourceMessageId: input.sourceMessageId.trim() } : {}),
    linkedArtifactIds: stringList(input.linkedArtifactIds),
    linkedSourceIds: stringList(input.linkedSourceIds),
    linkedNodeIds: stringList(input.linkedNodeIds),
    ...(typeof input.originSurface === 'string' && input.originSurface.trim() ? { originSurface: input.originSurface.trim() } : {}),
    createdAt,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : options.now,
    ...(status === 'done' || status === 'failed' || status === 'cancelled'
      ? { completedAt: typeof input.completedAt === 'number' ? input.completedAt : options.now }
      : {}),
    ...(input.metadata ? { metadata: readPlanningMetadataObject(input.metadata) } : {}),
  };
}

function normalizeWorkPlanId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? stablePlanningId('work-plan', value)
    : 'current';
}

function normalizeWorkPlanTaskId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? stablePlanningId('task', value)
    : `task-${randomUUID().slice(0, 12)}`;
}

function normalizeWorkPlanStatus(value: unknown): ProjectWorkPlanTaskStatus {
  if (
    value === 'pending'
    || value === 'in_progress'
    || value === 'blocked'
    || value === 'done'
    || value === 'failed'
    || value === 'cancelled'
  ) {
    return value;
  }
  if (value === 'in-progress') return 'in_progress';
  if (value === 'completed') return 'done';
  throw new Error(`Invalid work plan task status: ${String(value)}`);
}

function workPlanStatusFromPlanningTask(task: ProjectPlanningTask): ProjectWorkPlanTaskStatus {
  if (task.status === 'in-progress') return 'in_progress';
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'completed') return 'done';
  if (task.blockedOnUserInput === true) return 'blocked';
  return 'pending';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()))];
}

function nextWorkPlanOrder(tasks: readonly ProjectWorkPlanTask[]): number {
  return tasks.reduce((max, task) => Math.max(max, task.order), -1) + 1;
}

function sortWorkPlanTasks(tasks: readonly ProjectWorkPlanTask[]): ProjectWorkPlanTask[] {
  return [...tasks].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
}

function snapshotFromWorkPlan(
  space: { readonly projectId: string; readonly knowledgeSpaceId: string },
  workPlan: ProjectWorkPlanArtifact,
  filter: {
    readonly status?: ProjectWorkPlanTaskStatus | undefined;
    readonly parentTaskId?: string | undefined;
    readonly chainId?: string | undefined;
    readonly owner?: string | undefined;
    readonly limit?: number | undefined;
  } = {},
): ProjectWorkPlanSnapshot {
  const tasks = sortWorkPlanTasks(workPlan.tasks).filter((task) => {
    if (filter.status && task.status !== filter.status) return false;
    if (filter.parentTaskId && task.parentTaskId !== filter.parentTaskId) return false;
    if (filter.chainId && task.chainId !== filter.chainId) return false;
    if (filter.owner && task.owner !== filter.owner) return false;
    return true;
  });
  const limit = typeof filter.limit === 'number' && Number.isFinite(filter.limit) && filter.limit > 0
    ? Math.floor(filter.limit)
    : undefined;
  return {
    ok: true,
    projectId: space.projectId,
    knowledgeSpaceId: space.knowledgeSpaceId,
    workPlanId: workPlan.id,
    tasks: limit ? tasks.slice(0, limit) : tasks,
    counts: countWorkPlanTasks(workPlan.tasks),
    updatedAt: workPlan.updatedAt,
  };
}

function countWorkPlanTasks(tasks: readonly ProjectWorkPlanTask[]): ProjectWorkPlanCounts {
  const counts: MutableProjectWorkPlanCounts = {
    total: tasks.length,
    pending: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of tasks) {
    counts[task.status] += 1;
  }
  return counts;
}

function workPlanEmitterContext(snapshot: ProjectWorkPlanSnapshot): {
  readonly traceId: string;
  readonly sessionId: string;
  readonly source: string;
} {
  return {
    traceId: `project-planning:work-plan:${snapshot.workPlanId}:${snapshot.updatedAt}`,
    sessionId: `project:${snapshot.projectId}`,
    source: 'project-planning.work-plan',
  };
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
  return kind === 'state' || kind === 'decision' || kind === 'language' || kind === 'work-plan' ? kind : null;
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

function readWorkPlan(source: KnowledgeSourceRecord): ProjectWorkPlanArtifact | null {
  const value = source.metadata.value;
  return value && typeof value === 'object' ? value as ProjectWorkPlanArtifact : null;
}

function titleForArtifact(
  kind: ProjectPlanningArtifactKind,
  value: ProjectPlanningState | ProjectPlanningDecision | ProjectPlanningLanguageArtifact | ProjectWorkPlanArtifact,
): string {
  if (kind === 'state') return `Planning: ${(value as ProjectPlanningState).goal || 'Current plan'}`;
  if (kind === 'decision') return `Decision: ${(value as ProjectPlanningDecision).title}`;
  if (kind === 'work-plan') return 'Project Work Plan';
  return 'Project Language';
}
