/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Intent Classifier — pure heuristic, no LLM calls.
 *
 * Classifies user messages as 'chat', 'task', or 'project' based on
 * weighted signal scoring.
 */

export type Intent = 'chat' | 'task' | 'project';

export interface ClassificationResult {
  intent: Intent;
  confidence: number; // 0-1
  signals: string[]; // which heuristics fired
}

// ---------------------------------------------------------------------------
// Signal matchers
// ---------------------------------------------------------------------------

const ACTION_VERBS = /\b(build|create|implement|set up|setup|make|develop|design|add|write|generate|refactor|migrate|scaffold|configure|integrate|deploy|fix|update|delete|remove|rename)\b/i;

const QUESTION_WORDS = /^\s*(what|how|why|when|where|who|which|can you explain|could you|would you|do you|is there|are there|tell me|show me|what's|what is|how do|how does|why does|why is|help me understand)/i;

const SPEC_PLAN_WORDS = /\b(spec|plan|architecture|design doc|roadmap|blueprint|requirement|specification|phase|milestone|diagram|schema|erd)\b/i;

const PARALLELISM_WORDS = /\b(agent|parallel|phase|step|stage|pipeline|batch|concurrent|simultaneously|workflow)\b/i;

const FILE_REFERENCES = /(\.ts|\.[jt]sx?|\.py|\.go|\.rs|\.json|\.yaml|\.yml|\.toml|\.md|\.sh|\bfile\b|\bfolder\b|\bdirectory\b|\bdir\b|src\/|lib\/|app\/|test\/|pkg\/)/i;

const DELIVERABLE_SEPARATORS = /\band\b.+\band\b|;|\n-\s|\n\*\s|\n\d+\.\s/i;

// Multiple sentences: two or more sentence-ending punctuation marks (. ! ?) followed by whitespace + capital
const MULTI_SENTENCE = /[.!?][\s]+[A-Z].*[.!?][\s]+[A-Z]/;

const RETROSPECTIVE_DOCUMENTATION_REQUEST = /(\bthings you did\b|\bfrom start to finish\b|\bwhat (?:you|we) did\b|\bsetup steps\b|\binstruction guide\b|\beasy to follow guide\b|\bfed to llms?\b|\bworkflow to follow\b|\bsummarize(?: the)? workflow\b|\bdocument(?: the)? setup\b|\blist\b.{0,120}\b(?:things|steps|installed|installations?|workflow|setup)\b|\b(?:write|draft|create|make|produce|generate|document|summarize)\b.{0,100}\b(?:instruction guide|guide|runbook|playbook|checklist|documentation|docs|setup steps|workflow summary|workflow to follow)\b)/i;

const CONCRETE_IMPLEMENTATION_ACTION = /\b(build|implement|develop|add|refactor|migrate|scaffold|configure|integrate|deploy|fix|update|delete|remove|rename)\b/i;

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify user message intent using heuristics.
 * Runs in the harness — no LLM call needed.
 */
export function classifyIntent(message: string): ClassificationResult {
  const signals: string[] = [];
  let projectScore = 0;
  let chatScore = 0;

  const trimmed = message.trim();

  // ── Project signals (each +1 to projectScore) ──────────────────────────────

  if (trimmed.length > 200) {
    projectScore += 1;
    signals.push('long_message');
  }

  if (ACTION_VERBS.test(trimmed)) {
    projectScore += 1;
    signals.push('action_verb');
  }

  if (DELIVERABLE_SEPARATORS.test(trimmed)) {
    projectScore += 1;
    signals.push('multiple_deliverables');
  }

  if (FILE_REFERENCES.test(trimmed)) {
    projectScore += 1;
    signals.push('file_references');
  }

  if (PARALLELISM_WORDS.test(trimmed)) {
    projectScore += 1;
    signals.push('parallelism_keywords');
  }

  // Multiple sentences with different actions
  if (MULTI_SENTENCE.test(trimmed)) {
    projectScore += 1;
    signals.push('multi_sentence_actions');
  }

  if (SPEC_PLAN_WORDS.test(trimmed)) {
    projectScore += 1;
    signals.push('spec_plan_reference');
  }

  const isRetrospectiveDocumentationRequest = RETROSPECTIVE_DOCUMENTATION_REQUEST.test(trimmed);
  if (isRetrospectiveDocumentationRequest) {
    signals.push('documentation_request');
    chatScore += 2;

    if (!CONCRETE_IMPLEMENTATION_ACTION.test(trimmed)) {
      projectScore = Math.min(projectScore, 2);
    }
  }

  // ── Chat signals ───────────────────────────────────────────────────────────

  if (QUESTION_WORDS.test(trimmed)) {
    chatScore += 2;
    signals.push('question_word');
  }

  if (trimmed.length < 80 && !ACTION_VERBS.test(trimmed)) {
    chatScore += 1;
    signals.push('short_no_action');
  }

  // ── Intent resolution ──────────────────────────────────────────────────────

  let intent: Intent;
  let confidence: number;

  if (chatScore >= 2 && projectScore < 2) {
    // Strong chat signal overrides low project score
    intent = 'chat';
    confidence = Math.min(0.95, 0.5 + chatScore * 0.15);
  } else if (projectScore >= 3) {
    intent = 'project';
    // Confidence scales with score: 3→0.70, 4→0.80, 5→0.88, 6→0.94, 7→0.98
    confidence = Math.min(0.98, 0.50 + projectScore * 0.08);
  } else if (projectScore >= 1) {
    intent = 'task';
    confidence = Math.min(0.85, 0.50 + projectScore * 0.10);
  } else {
    intent = 'chat';
    confidence = 0.60;
  }

  return { intent, confidence, signals };
}
