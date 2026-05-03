import type {
  ProjectPlanningEvaluation,
  ProjectPlanningGap,
  ProjectPlanningQuestion,
  ProjectPlanningReadiness,
  ProjectPlanningState,
} from './types.js';

const VAGUE_TERMS = [
  'better',
  'improve',
  'improved',
  'setup',
  'integration',
  'agent channel',
  'remote',
  'thing',
  'stuff',
  'etc',
  'clean up',
  'fix it',
];

export function evaluateProjectPlanningReadiness(state: ProjectPlanningState): ProjectPlanningEvaluation {
  const gaps: ProjectPlanningGap[] = [];
  const goal = state.goal.trim();
  if (!goal) {
    gaps.push(blockingQuestion(
      'missing-goal',
      'The plan needs a concrete goal before it can be executed.',
      'What outcome should this plan produce?',
      'A clear outcome lets the TUI inspect the right code and ask only relevant follow-up questions.',
      'State the user-visible behavior or project change that should exist when the work is done.',
    ));
  }
  if (!state.scope?.trim() && state.constraints.length === 0) {
    gaps.push(blockingQuestion(
      'missing-scope',
      'The plan has no explicit boundary for what is included or excluded.',
      'What is in scope, and what should be left out for this pass?',
      'Scope boundaries prevent the planning loop from turning a focused change into unrelated work.',
      'Define the first-pass scope and record do-later items separately.',
    ));
  }
  for (const question of state.openQuestions) {
    if ((question.status ?? 'open') === 'open') {
      gaps.push({
        id: `open-question:${question.id}`,
        kind: 'open-question',
        severity: 'blocking',
        message: `Open planning question: ${question.prompt}`,
        question,
      });
    }
  }
  const vagueTerm = firstVagueTerm(goal);
  if (vagueTerm && state.answeredQuestions.length === 0 && state.decisions.length === 0) {
    gaps.push(blockingQuestion(
      'ambiguous-language',
      `The goal uses ambiguous language (${JSON.stringify(vagueTerm)}) without recorded clarification.`,
      `When you say ${JSON.stringify(vagueTerm)}, what concrete behavior should change?`,
      'GoodVibes should challenge vague words before work starts so future agents do not implement the wrong thing.',
      'Define the term in project language or replace it with concrete expected behavior.',
    ));
  }
  if (goal && state.tasks.length === 0) {
    gaps.push(blockingQuestion(
      'missing-tasks',
      'The plan has no decomposed tasks.',
      'What are the smallest useful implementation tasks for this goal?',
      'Task decomposition is what lets the TUI identify dependencies, parallel agent work, and verification gates.',
      'Create task records with likely files, dependencies, and verification notes.',
    ));
  }
  if (state.tasks.length > 1 && state.dependencies.length === 0) {
    gaps.push({
      id: 'missing-dependencies',
      kind: 'missing-dependencies',
      severity: 'advisory',
      message: 'Multiple tasks exist but no dependency graph has been recorded.',
    });
  }
  const tasksWithoutVerification = state.tasks
    .filter((task) => (task.verification?.length ?? 0) === 0)
    .map((task) => task.id);
  const hasRequiredGate = state.verificationGates.some((gate) => gate.required !== false);
  if (state.tasks.length > 0 && tasksWithoutVerification.length > 0 && !hasRequiredGate) {
    gaps.push({
      id: 'missing-verification',
      kind: 'missing-verification',
      severity: 'blocking',
      message: 'The plan has tasks but no verification gates or per-task verification.',
      question: {
        id: 'verification-gates',
        prompt: 'How should this plan prove that the work is correct?',
        whyItMatters: 'Verification gates keep execution from ending at code changes that were never checked.',
        recommendedAnswer: 'Record concrete tests, commands, manual checks, or release gates for the changed behavior.',
        consequence: 'The plan should not be executable until verification exists.',
      },
      relatedTaskIds: tasksWithoutVerification,
    });
  }
  const blocking = gaps.some((gap) => gap.severity === 'blocking');
  if (!blocking && !state.executionApproved) {
    gaps.push({
      id: 'unapproved-execution',
      kind: 'unapproved-execution',
      severity: 'blocking',
      message: 'The plan is structurally ready but has not been approved for execution.',
      question: {
        id: 'approve-execution',
        prompt: 'Is this plan approved for execution?',
        whyItMatters: 'The TUI owns user approval before local work or agent assignments begin.',
        recommendedAnswer: 'Approve only after the goal, scope, tasks, dependencies, and verification gates look right.',
      },
    });
  }
  const readiness = readinessFromGaps(gaps);
  return {
    ok: true,
    projectId: state.projectId,
    knowledgeSpaceId: state.knowledgeSpaceId,
    readiness,
    gaps,
    ...(gaps[0]?.question ? { nextQuestion: gaps[0].question } : {}),
    state: {
      ...state,
      readiness,
    },
  };
}

function readinessFromGaps(gaps: readonly ProjectPlanningGap[]): ProjectPlanningReadiness {
  if (gaps.length === 0) return 'executable';
  if (gaps.some((gap) => gap.severity === 'blocking')) return 'needs-user-input';
  return 'not-ready';
}

function firstVagueTerm(value: string): string | null {
  const normalized = value.toLowerCase();
  return VAGUE_TERMS.find((term) => normalized.includes(term)) ?? null;
}

function blockingQuestion(
  kind: ProjectPlanningGap['kind'],
  message: string,
  prompt: string,
  whyItMatters: string,
  recommendedAnswer: string,
): ProjectPlanningGap {
  const question: ProjectPlanningQuestion = {
    id: kind,
    prompt,
    whyItMatters,
    recommendedAnswer,
  };
  return {
    id: kind,
    kind,
    severity: 'blocking',
    message,
    question,
  };
}

