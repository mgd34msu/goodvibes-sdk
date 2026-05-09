import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.js';
import {
  GENERIC_LIST_SCHEMA,
  JSON_RECORD_SCHEMA,
  METADATA_SCHEMA,
  STRING_LIST_SCHEMA,
  nullableSchema,
} from './operator-contract-schemas-shared.js';
import { KNOWLEDGE_SOURCE_SCHEMA } from './operator-contract-schemas-knowledge.js';

export const PROJECT_PLANNING_SPACE_INPUT_SCHEMA = objectSchema({
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
}, [], { additionalProperties: true });

const PROJECT_PLANNING_QUESTION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  prompt: STRING_SCHEMA,
  whyItMatters: STRING_SCHEMA,
  recommendedAnswer: STRING_SCHEMA,
  consequence: STRING_SCHEMA,
  status: STRING_SCHEMA,
  answer: STRING_SCHEMA,
  answeredAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'prompt'], { additionalProperties: true });

const PROJECT_PLANNING_DECISION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  context: STRING_SCHEMA,
  decision: STRING_SCHEMA,
  alternatives: STRING_LIST_SCHEMA,
  reasoning: STRING_SCHEMA,
  consequences: STRING_LIST_SCHEMA,
  status: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'title', 'decision'], { additionalProperties: true });

const PROJECT_PLANNING_TASK_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  why: STRING_SCHEMA,
  status: STRING_SCHEMA,
  dependencies: STRING_LIST_SCHEMA,
  likelyFiles: STRING_LIST_SCHEMA,
  verification: STRING_LIST_SCHEMA,
  canRunConcurrently: BOOLEAN_SCHEMA,
  needsReview: BOOLEAN_SCHEMA,
  blockedOnUserInput: BOOLEAN_SCHEMA,
  recommendedAgent: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'title'], { additionalProperties: true });

const PROJECT_PLANNING_STATE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  goal: STRING_SCHEMA,
  scope: STRING_SCHEMA,
  knownContext: STRING_LIST_SCHEMA,
  openQuestions: arraySchema(PROJECT_PLANNING_QUESTION_SCHEMA),
  answeredQuestions: arraySchema(PROJECT_PLANNING_QUESTION_SCHEMA),
  decisions: arraySchema(PROJECT_PLANNING_DECISION_SCHEMA),
  assumptions: STRING_LIST_SCHEMA,
  constraints: STRING_LIST_SCHEMA,
  risks: STRING_LIST_SCHEMA,
  tasks: arraySchema(PROJECT_PLANNING_TASK_SCHEMA),
  dependencies: GENERIC_LIST_SCHEMA,
  verificationGates: GENERIC_LIST_SCHEMA,
  agentAssignments: GENERIC_LIST_SCHEMA,
  readiness: STRING_SCHEMA,
  executionApproved: BOOLEAN_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, [
  'id', 'projectId', 'knowledgeSpaceId', 'goal', 'knownContext', 'openQuestions',
  'answeredQuestions', 'decisions', 'assumptions', 'constraints', 'risks', 'tasks',
  'dependencies', 'verificationGates', 'agentAssignments', 'readiness',
  'executionApproved', 'createdAt', 'updatedAt',
], { additionalProperties: true });

const PROJECT_PLANNING_LANGUAGE_SCHEMA = objectSchema({
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  terms: GENERIC_LIST_SCHEMA,
  ambiguities: GENERIC_LIST_SCHEMA,
  examples: STRING_LIST_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['projectId', 'knowledgeSpaceId', 'terms', 'ambiguities', 'updatedAt'], { additionalProperties: true });

const PROJECT_WORK_PLAN_COUNTS_SCHEMA = objectSchema({
  total: NUMBER_SCHEMA,
  pending: NUMBER_SCHEMA,
  in_progress: NUMBER_SCHEMA,
  blocked: NUMBER_SCHEMA,
  done: NUMBER_SCHEMA,
  failed: NUMBER_SCHEMA,
  cancelled: NUMBER_SCHEMA,
}, ['total', 'pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'], { additionalProperties: false });

export const PROJECT_WORK_PLAN_TASK_SCHEMA = objectSchema({
  taskId: STRING_SCHEMA,
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  title: STRING_SCHEMA,
  notes: STRING_SCHEMA,
  owner: STRING_SCHEMA,
  status: STRING_SCHEMA,
  priority: NUMBER_SCHEMA,
  order: NUMBER_SCHEMA,
  source: STRING_SCHEMA,
  tags: STRING_LIST_SCHEMA,
  parentTaskId: STRING_SCHEMA,
  chainId: STRING_SCHEMA,
  phaseId: STRING_SCHEMA,
  agentId: STRING_SCHEMA,
  turnId: STRING_SCHEMA,
  decisionId: STRING_SCHEMA,
  sourceMessageId: STRING_SCHEMA,
  linkedArtifactIds: STRING_LIST_SCHEMA,
  linkedSourceIds: STRING_LIST_SCHEMA,
  linkedNodeIds: STRING_LIST_SCHEMA,
  originSurface: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  completedAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, [
  'taskId',
  'projectId',
  'knowledgeSpaceId',
  'title',
  'status',
  'order',
  'tags',
  'linkedArtifactIds',
  'linkedSourceIds',
  'linkedNodeIds',
  'createdAt',
  'updatedAt',
], { additionalProperties: true });

export const PROJECT_WORK_PLAN_SNAPSHOT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  workPlanId: STRING_SCHEMA,
  tasks: arraySchema(PROJECT_WORK_PLAN_TASK_SCHEMA),
  counts: PROJECT_WORK_PLAN_COUNTS_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['ok', 'projectId', 'knowledgeSpaceId', 'workPlanId', 'tasks', 'counts', 'updatedAt'], { additionalProperties: true });

export const PROJECT_WORK_PLAN_TASK_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  workPlanId: STRING_SCHEMA,
  task: nullableSchema(PROJECT_WORK_PLAN_TASK_SCHEMA),
  snapshot: PROJECT_WORK_PLAN_SNAPSHOT_SCHEMA,
}, ['ok', 'projectId', 'knowledgeSpaceId', 'workPlanId', 'task', 'snapshot'], { additionalProperties: true });

export const PROJECT_WORK_PLAN_MUTATION_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  workPlanId: STRING_SCHEMA,
  task: PROJECT_WORK_PLAN_TASK_SCHEMA,
  previousTask: PROJECT_WORK_PLAN_TASK_SCHEMA,
  deletedTask: PROJECT_WORK_PLAN_TASK_SCHEMA,
  clearedTaskIds: STRING_LIST_SCHEMA,
  snapshot: PROJECT_WORK_PLAN_SNAPSHOT_SCHEMA,
}, ['ok', 'projectId', 'knowledgeSpaceId', 'workPlanId', 'snapshot'], { additionalProperties: true });

const PROJECT_PLANNING_GAP_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  severity: STRING_SCHEMA,
  message: STRING_SCHEMA,
  question: PROJECT_PLANNING_QUESTION_SCHEMA,
  relatedTaskIds: STRING_LIST_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'kind', 'severity', 'message'], { additionalProperties: true });

export const PROJECT_PLANNING_STATUS_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  passiveOnly: BOOLEAN_SCHEMA,
  counts: JSON_RECORD_SCHEMA,
  capabilities: STRING_LIST_SCHEMA,
}, ['ok', 'projectId', 'knowledgeSpaceId', 'passiveOnly', 'counts', 'capabilities'], { additionalProperties: true });

export const PROJECT_PLANNING_STATE_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  state: nullableSchema(PROJECT_PLANNING_STATE_SCHEMA),
  source: KNOWLEDGE_SOURCE_SCHEMA,
}, ['ok', 'projectId', 'knowledgeSpaceId'], { additionalProperties: true });

export const PROJECT_PLANNING_EVALUATION_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  readiness: STRING_SCHEMA,
  gaps: arraySchema(PROJECT_PLANNING_GAP_SCHEMA),
  nextQuestion: PROJECT_PLANNING_QUESTION_SCHEMA,
  state: PROJECT_PLANNING_STATE_SCHEMA,
}, ['ok', 'projectId', 'knowledgeSpaceId', 'readiness', 'gaps', 'state'], { additionalProperties: true });

export const PROJECT_PLANNING_DECISIONS_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  decisions: arraySchema(PROJECT_PLANNING_DECISION_SCHEMA),
}, ['ok', 'projectId', 'knowledgeSpaceId', 'decisions'], { additionalProperties: true });

export const PROJECT_PLANNING_DECISION_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  decision: PROJECT_PLANNING_DECISION_SCHEMA,
  source: KNOWLEDGE_SOURCE_SCHEMA,
}, ['ok', 'projectId', 'knowledgeSpaceId', 'decision', 'source'], { additionalProperties: true });

export const PROJECT_PLANNING_LANGUAGE_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  projectId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  language: nullableSchema(PROJECT_PLANNING_LANGUAGE_SCHEMA),
  source: KNOWLEDGE_SOURCE_SCHEMA,
}, ['ok', 'projectId', 'knowledgeSpaceId'], { additionalProperties: true });
