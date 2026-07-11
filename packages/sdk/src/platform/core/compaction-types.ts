/**
 * compaction-types.ts
 *
 * Shared types for the prompt compaction engine.
 */

import type { ProviderMessage } from '../providers/interface.js';
import type { SessionMemory } from './session-memory.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { WrfcChain } from '../agents/wrfc-types.js';
import type { ExecutionPlan } from './execution-plan.js';

/**
 * Which conversation-compaction strategy produces the handoff.
 *
 * - `structured` — the default in-place strategy: assemble a handoff from many
 *   targeted extraction calls over the existing message history.
 * - `distiller`  — the fresh-context strategy: one fresh model call distills the
 *   conversation into a structured continuation brief that seeds a new context.
 *   Graduates through the `compaction-distiller-strategy` feature flag; when the
 *   flag is dark the requested `distiller` selection resolves back to
 *   `structured`.
 */
export type CompactionStrategyChoice = 'structured' | 'distiller';

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

/** A single compacted output section. */
export interface CompactionSection {
  /** Unique identifier for this section (e.g. 'handoff-header', 'current-task'). */
  id: string;
  /** Section heading text (e.g. '## Current Task'). Empty string for the handoff header. */
  header: string;
  /** Body content for this section. */
  content: string;
  /** Estimated token count for this section. */
  tokens: number;
}

/** Per-section token budgets and threshold configuration. */
export interface CompactionConfig {
  /** Max tokens for recent conversation gather (default: 3000). */
  recentConversationBudget: number;
  /** Max tokens for tool results section (default: 1500). */
  toolResultsBudget: number;
  /** Max tokens for agent activity table (default: 1500). */
  agentActivityBudget: number;
  /** Max tokens for older agent summary (default: 500). */
  olderAgentSummaryBudget: number;
  /** Max tokens for resolved problems section (default: 300). */
  resolvedProblemsBudget: number;
  /** Overall ceiling for entire compacted output (default: 6500). */
  totalCeiling: number;
}

/** Default compaction configuration. */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  recentConversationBudget: 3000,
  toolResultsBudget: 1500,
  agentActivityBudget: 1500,
  olderAgentSummaryBudget: 500,
  resolvedProblemsBudget: 300,
  totalCeiling: 6500,
};

// ---------------------------------------------------------------------------
// Session memory (re-exported for consumers of this module)
// ---------------------------------------------------------------------------

export type { SessionMemory };

// ---------------------------------------------------------------------------
// Token estimation utility (here to avoid circular imports)
// ---------------------------------------------------------------------------

/** Rough token estimate for a string: 4 chars ≈ 1 token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Rough token cost for a single image content part. Image parts carry real provider
 * token cost (Anthropic bills up to ~1600 tokens per image) but contribute no text,
 * so threshold and overflow estimates must not treat them as free.
 */
export const IMAGE_TOKEN_ESTIMATE = 1600;

// ---------------------------------------------------------------------------
// Context data sources (read-only, passed in as plain data — no singletons)
// ---------------------------------------------------------------------------

/** All data sources needed for compaction. Accept as plain data; do not import singletons. */
export interface CompactionContext {
  /** Current conversation messages (as sent to LLM — no system messages). */
  messages: ProviderMessage[];

  /** Pinned session memories (survive all compactions). */
  sessionMemories: readonly SessionMemory[];

  /** All agent records from AgentManager.list(). */
  agents: AgentRecord[];

  /** All WRFC chains from WrfcController.listChains(). */
  wrfcChains: WrfcChain[];

  /** Active execution plan, or null if none. */
  activePlan: ExecutionPlan | null;

  /** Append-only session lineage log entries (one per prior compaction). */
  lineageEntries: string[];

  /** Original task description for lineage. Set on first compaction. */
  originalTask?: string | undefined;

  /** Number of compactions already recorded before this one (excludes the in-flight compaction). */
  compactionCount: number;

  /** Context window size for the current model (used for threshold scaling). */
  contextWindow: number;

  /** Whether this compaction was triggered automatically or manually. */
  trigger: 'auto' | 'manual';

  /** Provider-qualified registryKey used for LLM extraction calls. */
  extractionModelId: string;

  /** Optional provider name for extraction model disambiguation. */
  extractionProvider?: string | undefined;

  /**
   * The standing system instruction chain to re-include at the compaction
   * boundary so compaction never silently strips it. Optional: when absent,
   * no system-instruction block is re-injected.
   */
  instructionChain?: string | undefined;

  /**
   * Frontmatter of the active skill (if any) to re-include at the compaction
   * boundary alongside the instruction chain. Optional: when absent, no
   * active-skill block is re-injected.
   */
  activeSkillFrontmatter?: string | undefined;

  /**
   * Which compaction strategy to run. Absent → `structured` (the default). The
   * caller resolves this from the `behavior.compactionStrategy` config key
   * gated by the `compaction-distiller-strategy` feature flag, so a `distiller`
   * value here already means the flag is on.
   */
  strategy?: CompactionStrategyChoice | undefined;
}

// ---------------------------------------------------------------------------
// Compaction events and results
// ---------------------------------------------------------------------------

/** Record of a completed compaction event. */
export interface CompactionEvent {
  timestamp: number;
  messagesBeforeCompaction: number;
  messagesAfterCompaction: number;
  tokensBeforeEstimate: number;
  tokensAfterEstimate: number;
  modelId: string;
  trigger: 'auto' | 'manual';
  /** Sections included in this compaction (IDs). */
  sectionsIncluded?: string[] | undefined;
  /** Whether post-compaction validation passed. */
  validationPassed?: boolean | undefined;
  /**
   * Whether the standing instruction chain and/or active skill frontmatter
   * were re-injected into the compacted context. Part of the compaction
   * receipt so a stripped-instructions regression is visible in the log.
   */
  instructionsReinjected?: boolean | undefined;
}

/**
 * Post-compaction receipt — the mandatory, visible record emitted after every
 * automatic compaction path (and the manual one). Surfaces render it so a
 * compaction is never silent: it names what happened, the token counts before
 * and after, the strategy, the quality score/grade the guard computed, whether
 * the standing instruction chain was re-injected, and the outcome — `applied`
 * when the compacted context replaced the conversation, or `kept-original`
 * when the quality guard rejected a bad compaction and the full conversation
 * was retained instead.
 */
export interface CompactionReceipt {
  /** Whether this compaction was automatic or manually requested. */
  trigger: 'auto' | 'manual';
  /** The compaction strategy that produced this result. */
  strategy: string;
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  /** Composite quality score (0–1) from the compaction quality scorer. */
  qualityScore: number;
  /** Letter grade (A–F) derived from the quality score. */
  qualityGrade: string;
  /** Whether the quality scorer flagged the compaction as low quality. */
  lowQuality: boolean;
  /** Whether the standing instruction chain / active skill was re-injected. */
  instructionsReinjected: boolean;
  /** Whether post-compaction structural validation passed (no warnings). */
  validationPassed: boolean;
  /** IDs of the sections included in the compacted output. */
  sectionsIncluded: string[];
  /**
   * The strategy the caller REQUESTED (from config), when it differs from the
   * strategy that actually produced the applied result. Present only on a
   * distiller→structured fallback; `strategy` names what actually ran.
   */
  requestedStrategy?: string | undefined;
  /**
   * Why the requested strategy fell back to `strategy` (e.g. the distillation
   * scored below the quality floor, or the fresh model call was unavailable).
   * Present only when `requestedStrategy` differs from `strategy`.
   */
  strategyFallbackReason?: string | undefined;
  /**
   * Outcome: `applied` — the compacted context replaced the conversation;
   * `kept-original` — the quality guard rejected the result and the full
   * conversation was retained (honest fallback); `failed` — compaction threw
   * before producing a usable result.
   */
  outcome: 'applied' | 'kept-original' | 'failed';
  /** Human-readable failure detail when outcome is `kept-original` / `failed`. */
  detail?: string | undefined;
}

/**
 * Thrown by the compactor when the quality scorer rejects a compaction. Carries
 * the `kept-original` receipt so the conversation is retained and the caller can
 * surface the failure honestly (never a silent bad compaction).
 */
export class CompactionQualityError extends Error {
  constructor(readonly receipt: CompactionReceipt) {
    super(receipt.detail ?? 'Compaction rejected by quality guard; conversation retained.');
    this.name = 'CompactionQualityError';
  }
}

/** Result of a compaction operation. */
export interface CompactionResult {
  /** The new compacted message list (single user message containing the handoff). */
  messages: ProviderMessage[];
  /** The full compacted context text. */
  summary: string;
  /** Token estimates before and after compaction. */
  tokensBeforeEstimate: number;
  tokensAfterEstimate: number;
  /** The compaction event record for tracking. */
  event: CompactionEvent;
  /** Sections that were included (for debugging). */
  sections: CompactionSection[];
  /** Post-compaction validation warnings (empty = all checks passed). */
  validationWarnings: string[];
}
