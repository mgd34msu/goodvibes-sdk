import { getKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeRefinementTaskRecord,
  KnowledgeRefinementTaskState,
} from '../types.js';
import { readString } from './utils.js';

const STALE_ACTIVE_TASK_MS = 10 * 60 * 1000;
const ACTIVE_REFINEMENT_STATES = new Set<KnowledgeRefinementTaskState>([
  'queued',
  'searching',
  'evaluating',
  'extracting',
  'applying',
]);

export async function recoverStaleActiveTasks(store: KnowledgeStore, spaceId: string): Promise<void> {
  const now = Date.now();
  const staleTasks = store.listRefinementTasks(10_000, { spaceId })
    .filter((task) => ACTIVE_REFINEMENT_STATES.has(task.state))
    .filter((task) => now - task.updatedAt >= STALE_ACTIVE_TASK_MS);
  await store.batch(async () => {
    for (const task of staleTasks) {
      await upsertRecoveredTask(
        store,
        task,
        'blocked',
        'Refinement task was interrupted or exceeded the active window; it can be retried.',
        { recoveredFrom: 'stale_active' },
      );
    }
  });
}

export async function recoverNoRepairerTasks(store: KnowledgeStore, spaceId: string): Promise<void> {
  const tasks = store.listRefinementTasks(10_000, { spaceId })
    .filter((task) => task.state === 'blocked')
    .filter((task) => /no semantic gap repairer is configured/i.test(task.blockedReason ?? ''));
  for (const task of tasks) {
    await store.batch(async () => {
      if (task.gapId) {
        const gap = store.getNode(task.gapId);
        if (gap && getKnowledgeSpaceId(gap) === spaceId && readString(gap.metadata.repairStatus) === 'no_repairer') {
          await store.upsertNode({
            id: gap.id,
            kind: gap.kind,
            slug: gap.slug,
            title: gap.title,
            summary: gap.summary,
            aliases: gap.aliases,
            status: gap.status,
            confidence: gap.confidence,
            sourceId: gap.sourceId,
            metadata: {
              ...gap.metadata,
              repairStatus: 'open',
              repairReason: 'Semantic gap repairer is now configured; retry is allowed.',
              nextRepairAttemptAt: undefined,
              knowledgeSpaceId: spaceId,
            },
          });
        }
      }
      await upsertRecoveredTask(
        store,
        task,
        'detected',
        'Semantic gap repairer is now configured; task can be retried.',
        { recoveredFrom: 'no_repairer' },
        { repairStatus: 'open', recoveredFrom: 'no_repairer', recoveredAt: Date.now() },
      );
    });
  }
}

async function upsertRecoveredTask(
  store: KnowledgeStore,
  task: KnowledgeRefinementTaskRecord,
  state: KnowledgeRefinementTaskState,
  message: string,
  data: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await store.upsertRefinementTask({
    id: task.id,
    spaceId: task.spaceId,
    subjectKind: task.subjectKind,
    subjectId: task.subjectId,
    subjectTitle: task.subjectTitle,
    subjectType: task.subjectType,
    gapId: task.gapId,
    issueId: task.issueId,
    state,
    priority: task.priority,
    trigger: task.trigger,
    budget: task.budget,
    attemptCount: task.attemptCount,
    ...(state === 'blocked' ? { blockedReason: message } : {}),
    appendTrace: [{ at: Date.now(), state, message, data }],
    metadata: { ...task.metadata, ...metadata },
  });
}
