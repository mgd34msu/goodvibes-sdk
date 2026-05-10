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

const DESIGN_ONLY_ACTION_RE =
  /\b(?:design|plan|outline|specify|propose|describe)\b/i;

const NO_WRITE_RE =
  /\b(?:do\s+not|don't|without)\s+(?:write|modify|edit|create|change)\s+(?:files?|code|source|implementation)\b|\bno[-\s]?write\b|\bread[-\s]?only\b/i;

export interface WrfcBatchPolicyDecision {
  readonly kind: 'independent' | 'collapse-to-wrfc';
  readonly reason?: string | undefined;
  readonly ownerInput?: AgentInput | undefined;
  readonly roleTaskIndexes?: readonly number[] | undefined;
  readonly compoundTaskIndexes?: readonly number[] | undefined;
  readonly scopeMutation?: WrfcScopeMutation | undefined;
}

export interface WrfcScopeMutation {
  readonly detected: true;
  readonly action: 'used-authoritative-task' | 'normalized-narrowed-task';
  readonly proposedTask: string;
  readonly authoritativeTask: string;
  readonly warnings: readonly string[];
}

export interface WrfcToolContractResolution {
  readonly tools?: string[] | undefined;
  readonly restrictTools?: boolean | undefined;
  readonly scopeMutation?: WrfcScopeMutation | undefined;
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

function normalizeTaskText(value: string | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

function looksLikeScopeNarrowing(proposedTask: string, authoritativeTask: string | undefined): boolean {
  if (!NO_WRITE_RE.test(proposedTask) && !DESIGN_ONLY_ACTION_RE.test(proposedTask)) return false;
  if (authoritativeTask && (NO_WRITE_RE.test(authoritativeTask) || DESIGN_ONLY_ACTION_RE.test(authoritativeTask))) {
    return false;
  }
  return NO_WRITE_RE.test(proposedTask)
    || (DESIGN_ONLY_ACTION_RE.test(proposedTask) && IMPLEMENTATION_ACTION_RE.test(authoritativeTask ?? proposedTask));
}

function authoritativeTaskAllowsReadOnly(task: string): boolean {
  return NO_WRITE_RE.test(task)
    || (DESIGN_ONLY_ACTION_RE.test(task) && !IMPLEMENTATION_ACTION_RE.test(task));
}

function removesImplementationCapability(tools: readonly string[] | undefined): boolean {
  const normalized = new Set((tools ?? []).map((tool) => tool.trim().toLowerCase()).filter(Boolean));
  const hasWriteTool = normalized.has('write') || normalized.has('edit');
  const hasExecutionTool = normalized.has('exec') || normalized.has('precision_exec');
  return !hasWriteTool || !hasExecutionTool;
}

function appendScopeMutationWarning(
  existing: WrfcScopeMutation | undefined,
  proposedTask: string,
  authoritativeTask: string,
  warning: string,
): WrfcScopeMutation {
  if (existing) {
    return {
      ...existing,
      warnings: [...existing.warnings, warning],
    };
  }
  return {
    detected: true,
    action: 'used-authoritative-task',
    proposedTask,
    authoritativeTask,
    warnings: [warning],
  };
}

function stripNoWriteSentences(task: string): string {
  const sentences = task
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && !NO_WRITE_RE.test(sentence));
  return (sentences.length > 0 ? sentences.join(' ') : task.replace(NO_WRITE_RE, '')).trim();
}

function normalizeNarrowedTask(proposedTask: string): string {
  let normalized = stripNoWriteSentences(proposedTask);
  normalized = normalized.replace(
    /^\s*(?:independently\s+)?(?:design|plan|outline|specify|propose|describe)\b/i,
    'Implement',
  ).trim();
  if (!IMPLEMENTATION_ACTION_RE.test(normalized)) {
    normalized = `Implement ${normalized.replace(/^\s*(?:an?|the)\s+/i, '')}`;
  }
  return normalized.endsWith('.') ? normalized : `${normalized}.`;
}

export function resolveAuthoritativeWrfcScope(
  input: Pick<AgentInput, 'authoritativeTask' | 'task'>,
  proposedTask: string,
): { readonly task: string; readonly scopeMutation?: WrfcScopeMutation | undefined } {
  const authoritativeTask = normalizeTaskText(input.authoritativeTask) ?? normalizeTaskText(input.task);
  if (authoritativeTask && authoritativeTask !== proposedTask) {
    return {
      task: authoritativeTask,
      scopeMutation: {
        detected: true,
        action: 'used-authoritative-task',
        proposedTask,
        authoritativeTask,
        warnings: [
          'WRFC role-fanout collapse preserved the original user ask as the review scope instead of the model-proposed child task.',
          ...(looksLikeScopeNarrowing(proposedTask, authoritativeTask)
            ? ['The proposed child task appeared narrower than the original ask and was not allowed to limit the WRFC scope.']
            : []),
        ],
      },
    };
  }

  if (!authoritativeTask && looksLikeScopeNarrowing(proposedTask, undefined)) {
    const normalized = normalizeNarrowedTask(proposedTask);
    if (normalized !== proposedTask) {
      return {
        task: normalized,
        scopeMutation: {
          detected: true,
          action: 'normalized-narrowed-task',
          proposedTask,
          authoritativeTask: normalized,
          warnings: [
            'WRFC role-fanout collapse removed design-only/no-write narrowing from the owner scope because no authoritative original ask was supplied.',
            'Hosts should pass authoritativeTask with the exact user request so the SDK can preserve full WRFC scope without heuristic normalization.',
          ],
        },
      };
    }
  }

  return { task: authoritativeTask ?? proposedTask };
}

export function resolveNarrowedRootSpawnScope(
  input: Pick<AgentInput, 'authoritativeTask'>,
  proposedTask: string,
): { readonly task: string; readonly scopeMutation?: WrfcScopeMutation | undefined } {
  const authoritativeTask = normalizeTaskText(input.authoritativeTask);
  if (!authoritativeTask || authoritativeTask === proposedTask) {
    return { task: proposedTask };
  }
  if (!looksLikeScopeNarrowing(proposedTask, authoritativeTask)) {
    return { task: proposedTask };
  }
  return {
    task: authoritativeTask,
    scopeMutation: {
      detected: true,
      action: 'used-authoritative-task',
      proposedTask,
      authoritativeTask,
      warnings: [
        'Root agent spawn preserved the original user ask because the model-proposed task appeared to narrow implementation work into design-only/no-write work.',
      ],
    },
  };
}

export function resolveImplementationToolContract(args: {
  readonly tools: string[] | undefined;
  readonly restrictTools: boolean | undefined;
  readonly authoritativeTask: string;
  readonly proposedTask: string;
  readonly scopeMutation?: WrfcScopeMutation | undefined;
}): WrfcToolContractResolution {
  const implementationLike = IMPLEMENTATION_ACTION_RE.test(args.authoritativeTask)
    || IMPLEMENTATION_ACTION_RE.test(args.proposedTask);
  if (!args.restrictTools || !implementationLike || authoritativeTaskAllowsReadOnly(args.authoritativeTask)) {
    return {
      tools: args.tools,
      restrictTools: args.restrictTools,
      scopeMutation: args.scopeMutation,
    };
  }
  if (!removesImplementationCapability(args.tools)) {
    return {
      tools: args.tools,
      restrictTools: args.restrictTools,
      scopeMutation: args.scopeMutation,
    };
  }
  return {
    tools: undefined,
    restrictTools: false,
    scopeMutation: appendScopeMutationWarning(
      args.scopeMutation,
      args.proposedTask,
      args.authoritativeTask,
      'WRFC scope enforcement ignored restrictive child tool settings that removed write or execution capability from an implementation-like authoritative ask.',
    ),
  };
}

function uniqueStrings(values: Array<string[] | undefined>): string[] | undefined {
  const unique = [...new Set(values.flatMap((value) => value ?? []).filter((value) => value.trim().length > 0))];
  return unique.length > 0 ? unique : undefined;
}

function formatTask(task: BatchTask, index: number): string {
  const template = task.template ?? 'general';
  return `${index + 1}. [${template}] ${task.task}`;
}

function buildCollapsedContext(
  input: AgentInput,
  tasks: readonly BatchTask[],
  roleTaskIndexes: readonly number[],
  authoritativeTask: string,
  scopeMutation: WrfcScopeMutation | undefined,
): string {
  const roleIndexText = roleTaskIndexes.map((index) => index + 1).join(', ');
  const existing = input.context?.trim();
  return [
    existing ? `Caller context:\n${existing}` : null,
    'SDK WRFC topology enforcement collapsed this batch because root review/test/verification tasks are lifecycle phases, not independent root agents.',
    `Authoritative original ask for this WRFC chain:\n${authoritativeTask}`,
    `Collapsed role-task indexes: ${roleIndexText}.`,
    'The WRFC owner must keep one root chain for the original deliverable. The controller owns engineer, reviewer, tester/verifier, and fixer child lifecycle agents after owner output exists.',
    scopeMutation ? `Scope mutation warning: ${scopeMutation.warnings.join(' ')}` : null,
    scopeMutation ? `Model-proposed child scope that was not allowed to narrow review:\n${scopeMutation.proposedTask}` : null,
    'Original batch:',
    ...tasks.map(formatTask),
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function buildCompoundContext(
  input: AgentInput,
  tasks: readonly BatchTask[],
  authoritativeTask: string,
): string {
  const existing = input.context?.trim();
  return [
    existing ? `Caller context:\n${existing}` : null,
    'SDK compound WRFC topology enforcement collapsed this batch into one durable owner chain because multiple implementation deliverables share one higher-level reviewed outcome.',
    `Authoritative original ask for this WRFC chain:\n${authoritativeTask}`,
    'The WRFC owner must track every sub-deliverable. Engineer children may run concurrently. Reviewer/fixer phases must run only after the corresponding engineer has output. The integrator phase runs only after all sub-deliverables pass.',
    'Compound deliverables:',
    ...tasks.map(formatTask),
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function normalizeCompoundSubtask(task: BatchTask, authoritativeTask: string): BatchTask {
  const normalizedTask = looksLikeScopeNarrowing(task.task, authoritativeTask)
    ? normalizeNarrowedTask(task.task)
    : task.task;
  const toolContract = resolveImplementationToolContract({
    tools: task.tools,
    restrictTools: task.restrictTools,
    authoritativeTask,
    proposedTask: task.task,
  });
  return {
    ...task,
    task: normalizedTask,
    tools: toolContract.tools,
    restrictTools: toolContract.restrictTools,
  };
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
    const implementationTaskIndexes = tasks
      .map((task, index) => isImplementationLikeTask(task) ? index : -1)
      .filter((index) => index >= 0);
    const implementationTasksDisableWrfc = implementationTaskIndexes.length > 0
      && implementationTaskIndexes.every((index) => {
        const task = tasks[index]!;
        return task.dangerously_disable_wrfc === true || task.reviewMode === 'none';
      });
    const wantsWrfc = input.reviewMode === 'wrfc'
      || tasks.some((task) => task.reviewMode === 'wrfc')
      || (
        !implementationTasksDisableWrfc
        && input.dangerously_disable_wrfc !== true
        && input.reviewMode !== 'none'
        && implementationTaskIndexes.length > 0
      );
    if (!wantsWrfc || implementationTaskIndexes.length <= 1) {
      return { kind: 'independent' };
    }

    const authoritativeTask = normalizeTaskText(input.authoritativeTask)
      ?? normalizeTaskText(input.task)
      ?? `Complete and integrate ${implementationTaskIndexes.length} reviewed deliverables.`;
    const ownerInput: AgentInput = {
      mode: 'spawn',
      task: authoritativeTask,
      authoritativeTask,
      template: input.template ?? 'orchestrator',
      model: input.model,
      provider: input.provider,
      fallbackModels: input.fallbackModels,
      routing: input.routing,
      executionIntent: input.executionIntent,
      reasoningEffort: input.reasoningEffort,
      tools: input.tools,
      restrictTools: input.restrictTools,
      context: buildCompoundContext(input, tasks, authoritativeTask),
      successCriteria: uniqueStrings([
        input.successCriteria,
        ...tasks.map((task) => task.successCriteria),
        [`Satisfy the authoritative compound WRFC ask exactly: ${authoritativeTask}`],
        ['Keep every implementation deliverable under one owner chain; do not create sibling reviewer/tester/fixer roots.'],
        ['Run reviewer/fixer loops only after each corresponding engineer child has output, then integrate the passed deliverables before final full-scope review.'],
      ]),
      requiredEvidence: uniqueStrings([
        input.requiredEvidence,
        ...tasks.map((task) => task.requiredEvidence),
      ]),
      writeScope: uniqueStrings([
        input.writeScope,
        ...tasks.map((task) => task.writeScope),
      ]),
      executionProtocol: input.executionProtocol,
      reviewMode: 'wrfc',
      communicationLane: input.communicationLane,
      parentAgentId: input.parentAgentId,
      orchestrationGraphId: input.orchestrationGraphId,
      orchestrationNodeId: input.orchestrationNodeId,
      parentNodeId: input.parentNodeId,
      dangerously_disable_wrfc: false,
      cohort: input.cohort,
      wrfcSubtasks: implementationTaskIndexes.map((index) => normalizeCompoundSubtask(tasks[index]!, authoritativeTask)),
    };

    return {
      kind: 'collapse-to-wrfc',
      reason: 'batch-spawn contained multiple implementation deliverables that require one compound WRFC owner chain',
      ownerInput,
      roleTaskIndexes: [],
      compoundTaskIndexes: implementationTaskIndexes,
    };
  }

  const primaryIndex = tasks.findIndex((task, index) =>
    !roleTaskIndexes.includes(index) && isImplementationLikeTask(task));
  const ownerTask = tasks[primaryIndex >= 0 ? primaryIndex : 0]!;
  const ownerTemplate = isRootReviewRoleTemplate(ownerTask.template)
    ? 'engineer'
    : ownerTask.template ?? input.template ?? 'engineer';
  const template = isRootReviewRoleTemplate(ownerTemplate) ? 'engineer' : ownerTemplate;
  const scope = resolveAuthoritativeWrfcScope(input, ownerTask.task);
  const toolContract = resolveImplementationToolContract({
    tools: ownerTask.tools ?? input.tools,
    restrictTools: ownerTask.restrictTools ?? input.restrictTools,
    authoritativeTask: scope.task,
    proposedTask: ownerTask.task,
    scopeMutation: scope.scopeMutation,
  });

  const ownerInput: AgentInput = {
    mode: 'spawn',
    task: scope.task,
    authoritativeTask: scope.task,
    template,
    model: ownerTask.model ?? input.model,
    provider: ownerTask.provider ?? input.provider,
    fallbackModels: ownerTask.fallbackModels ?? input.fallbackModels,
    routing: ownerTask.routing ?? input.routing,
    executionIntent: ownerTask.executionIntent ?? input.executionIntent,
    reasoningEffort: ownerTask.reasoningEffort ?? input.reasoningEffort,
    tools: toolContract.tools,
    restrictTools: toolContract.restrictTools,
    context: buildCollapsedContext(input, tasks, roleTaskIndexes, scope.task, toolContract.scopeMutation),
    successCriteria: uniqueStrings([
      ownerTask.successCriteria,
      input.successCriteria,
      ...tasks.map((task) => task.successCriteria),
      [`Satisfy the authoritative WRFC ask exactly: ${scope.task}`],
      ['Do not treat model-invented design-only or no-write wording from collapsed child tasks as limiting scope unless it appears in the authoritative ask.'],
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
    scopeMutation: toolContract.scopeMutation,
  };
}
