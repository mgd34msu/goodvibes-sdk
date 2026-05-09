import type { AgentInput } from './schema.js';

type BatchTask = NonNullable<AgentInput['tasks']>[number];

const ROOT_REVIEW_ROLE_TEMPLATES = new Set([
  'reviewer',
  'tester',
  'verifier',
  'review',
  'test',
  'qa',
]);

const IMPLEMENTATION_TEMPLATES = new Set(['engineer', 'general']);

const ROLE_PREFIX_RE =
  /^\s*(?:\[?\s*)?(?:reviewer|tester|verifier|qa|quality\s+assurance|test|review|verify|validator)\b[\]\s:;-]*/i;

const ROLE_ACTION_RE =
  /\b(?:test|tests|testing|review|reviews|reviewing|verify|verifies|verifying|verification|validate|validates|validating|validation|qa)\s+(?:the|this|that|implementation|solution|feature|deliverable|code|changes|work|output|result|patch|diff)\b/i;

const IMPLEMENTATION_ACTION_RE =
  /\b(?:build|implement|create|add|write|fix|repair|update|refactor|change|modify|deliver|make)\b/i;

export interface WrfcBatchPolicyDecision {
  readonly kind: 'independent' | 'collapse-to-wrfc';
  readonly reason?: string | undefined;
  readonly ownerInput?: AgentInput | undefined;
  readonly roleTaskIndexes?: readonly number[] | undefined;
}

export function isRootReviewRoleTemplate(template: string | undefined): boolean {
  return ROOT_REVIEW_ROLE_TEMPLATES.has((template ?? '').trim().toLowerCase());
}

export function isRootReviewRoleTask(task: Pick<BatchTask, 'task' | 'template'>): boolean {
  if (isRootReviewRoleTemplate(task.template)) return true;
  const text = task.task.trim();
  return ROLE_PREFIX_RE.test(text) || ROLE_ACTION_RE.test(text);
}

function isImplementationLikeTask(task: Pick<BatchTask, 'task' | 'template'>): boolean {
  const template = (task.template ?? '').trim().toLowerCase();
  return IMPLEMENTATION_TEMPLATES.has(template) || IMPLEMENTATION_ACTION_RE.test(task.task);
}

function uniqueStrings(values: Array<string[] | undefined>): string[] | undefined {
  const unique = [...new Set(values.flatMap((value) => value ?? []).filter((value) => value.trim().length > 0))];
  return unique.length > 0 ? unique : undefined;
}

function formatTask(task: BatchTask, index: number): string {
  const template = task.template ?? 'general';
  return `${index + 1}. [${template}] ${task.task}`;
}

function buildCollapsedContext(input: AgentInput, tasks: readonly BatchTask[], roleTaskIndexes: readonly number[]): string {
  const roleIndexText = roleTaskIndexes.map((index) => index + 1).join(', ');
  const existing = input.context?.trim();
  return [
    existing ? `Caller context:\n${existing}` : null,
    'SDK WRFC topology enforcement collapsed this batch because root review/test/verification tasks are lifecycle phases, not independent root agents.',
    `Collapsed role-task indexes: ${roleIndexText}.`,
    'The WRFC owner must keep one root chain for the original deliverable. The controller owns engineer, reviewer, tester/verifier, and fixer child lifecycle agents after owner output exists.',
    'Original batch:',
    ...tasks.map(formatTask),
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function evaluateWrfcBatchPolicy(input: AgentInput): WrfcBatchPolicyDecision {
  const tasks = input.tasks ?? [];
  if (input.mode !== 'batch-spawn' || tasks.length <= 1) {
    return { kind: 'independent' };
  }

  const roleTaskIndexes = tasks
    .map((task, index) => isRootReviewRoleTask(task) ? index : -1)
    .filter((index) => index >= 0);

  if (roleTaskIndexes.length === 0) {
    return { kind: 'independent' };
  }

  const primaryIndex = tasks.findIndex((task, index) =>
    !roleTaskIndexes.includes(index) && isImplementationLikeTask(task));
  const ownerTask = tasks[primaryIndex >= 0 ? primaryIndex : 0]!;
  const ownerTemplate = isRootReviewRoleTemplate(ownerTask.template)
    ? 'engineer'
    : ownerTask.template ?? input.template ?? 'engineer';
  const template = isRootReviewRoleTemplate(ownerTemplate) ? 'engineer' : ownerTemplate;

  const ownerInput: AgentInput = {
    mode: 'spawn',
    task: ownerTask.task,
    template,
    model: ownerTask.model ?? input.model,
    provider: ownerTask.provider ?? input.provider,
    fallbackModels: ownerTask.fallbackModels ?? input.fallbackModels,
    routing: ownerTask.routing ?? input.routing,
    executionIntent: ownerTask.executionIntent ?? input.executionIntent,
    reasoningEffort: ownerTask.reasoningEffort ?? input.reasoningEffort,
    tools: ownerTask.tools ?? input.tools,
    restrictTools: ownerTask.restrictTools ?? input.restrictTools,
    context: buildCollapsedContext(input, tasks, roleTaskIndexes),
    successCriteria: uniqueStrings([
      ownerTask.successCriteria,
      input.successCriteria,
      ...tasks.map((task) => task.successCriteria),
      ['Keep the WRFC work as one owner chain; review, test, verification, and fix work must be WRFC lifecycle children, not sibling root agents.'],
    ]),
    requiredEvidence: uniqueStrings([
      ownerTask.requiredEvidence,
      input.requiredEvidence,
      ...tasks.map((task) => task.requiredEvidence),
    ]),
    writeScope: uniqueStrings([
      ownerTask.writeScope,
      input.writeScope,
      ...tasks.map((task) => task.writeScope),
    ]),
    executionProtocol: ownerTask.executionProtocol ?? input.executionProtocol,
    reviewMode: 'wrfc',
    communicationLane: ownerTask.communicationLane ?? input.communicationLane,
    parentAgentId: ownerTask.parentAgentId ?? input.parentAgentId,
    orchestrationGraphId: ownerTask.orchestrationGraphId ?? input.orchestrationGraphId,
    orchestrationNodeId: ownerTask.orchestrationNodeId ?? input.orchestrationNodeId,
    parentNodeId: ownerTask.parentNodeId ?? input.parentNodeId,
    dangerously_disable_wrfc: false,
    cohort: input.cohort,
  };

  return {
    kind: 'collapse-to-wrfc',
    reason: 'batch-spawn contained root review/test/verification role tasks for the same deliverable',
    ownerInput,
    roleTaskIndexes,
  };
}
