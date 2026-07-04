// turn-knowledge-injection.ts — Wave-5 (wo801, W5.1) per-turn passive retrieval.
//
// Spawn-time knowledge injection (orchestrator-prompts.ts buildOrchestratorSystemPrompt)
// runs `selectKnowledgeForTask` exactly ONCE against the frozen `record.task`, caches
// the result on `record.knowledgeInjections`, and reuses it verbatim for the life of the
// agent run. That is correct for spawned sub-agents (task never changes) but wrong for the
// main interactive session, whose "task" evolves every time the operator steers or a new
// sub-topic enters the conversation.
//
// This module supplies the per-turn layer: it re-derives a query from the CURRENT
// conversation tail (not just the frozen task), reuses the exact same ranking pipeline
// (`selectKnowledgeForTaskScored`) so scoring semantics never diverge from the spawn-time
// baseline, then applies two things spawn-time selection does NOT have:
//   1. a relevance floor (kill low-signal filler that would otherwise pad every turn), and
//   2. a hard token budget (never silently balloon the system prompt — drop the
//      lowest-scored candidates first, and drop everything if even the single
//      highest-scored candidate cannot fit).
//
// The caller (orchestrator-runner.ts runAgentTask) owns the "did anything new happen this
// turn" cache-reuse guard and the AgentRecord/session-transcript recording; this module is
// a pure function of its inputs so it can be unit-tested without a live agent loop.
import type { ContentPart, ProviderMessage } from '../providers/interface.js';
import { estimateTokens } from '../core/context-compaction.js';
import { buildKnowledgeInjectionPrompt, selectKnowledgeForTaskScored } from '../state/index.js';
import type { MemoryRecord, MemoryRegistry, MemorySemanticSearchResult, MemoryVectorStats } from '../state/index.js';

/**
 * Default per-turn injection budget: min(800 tokens, 3% of the model's context window).
 * 800 is the static floor for models with an unknown/zero context window (0 short-circuits
 * the percentage term); the percentage term keeps the block a small, bounded slice of the
 * turn's own budget for large-context models rather than a fixed absolute cost.
 */
export const DEFAULT_TURN_KNOWLEDGE_BUDGET_TOKENS = 800;

/**
 * Default relevance floor: the minimum `scoreKnowledge` score required to survive stage 2
 * filtering (stage 1 is the existing confidence>=55 gate inside selectKnowledgeForTaskScored).
 * Derived directly from the scoreKnowledge weights (knowledge-injection.ts) rather than
 * picked arbitrarily: a record sitting exactly at the confidence floor (55) with the
 * weakest positive reviewState bonus ('fresh', +20) that matches at least one task token
 * (+20) scores 55 + 20 + 20 = 95. Below that, a record is either under-confidence, has no
 * reviewState credit, or matched nothing about the current turn — filler, not relevance.
 */
export const DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR = 95;

/** Default candidate breadth passed through to selectKnowledgeForTaskScored. */
export const DEFAULT_TURN_KNOWLEDGE_LIMIT = 3;

/** Bounded ring size for AgentRecord.turnInjections (see recordTurnInjection). */
export const DEFAULT_TURN_INJECTION_RING_SIZE = 20;

export function defaultTurnKnowledgeBudgetTokens(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return DEFAULT_TURN_KNOWLEDGE_BUDGET_TOKENS;
  }
  return Math.min(DEFAULT_TURN_KNOWLEDGE_BUDGET_TOKENS, Math.floor(contextWindow * 0.03));
}

/**
 * Per-turn honesty record for one agent turn's passive-injection attempt. Stored on
 * `AgentRecord.turnInjections` (bounded ring) and appended verbatim to the agent's
 * session transcript (`{type:'knowledge_injection', turn, ...record}`) — no new
 * event-contract member, per the brief's "prefer existing-event reuse" constraint.
 */
export interface TurnInjectionRecord {
  /** The agent turn number this retrieval ran on. */
  readonly turn: number;
  /** The derived query actually sent through the ranking pipeline (task + conversation tail). */
  readonly query: string;
  /** Count of scored, confidence-gated, not-already-injected candidates considered this turn. */
  readonly candidatesConsidered: number;
  /** Record ids actually injected into the prompt this turn (empty when block===null). */
  readonly injectedIds: readonly string[];
  /** Record ids that cleared the relevance floor but were dropped to fit the token budget. */
  readonly droppedForBudget: readonly string[];
  /** Estimated token cost of the rendered block (0 when block===null). */
  readonly tokenCost: number;
  /** The token budget this turn was evaluated against. */
  readonly budgetTokens: number;
  /** The relevance floor this turn was evaluated against. */
  readonly relevanceFloor: number;
  /** Ingest mode (keyword/semantic/hybrid) of each injected record, same order as injectedIds. */
  readonly ingestModes: readonly string[];
  /** Honest embeddings signal: 'available' when the registry's vector index is enabled and
   *  usable, 'fallback-lexical' when memory-store.ts's searchSemantic() degraded to keyword
   *  ranking (no vector index, or the registry does not expose vectorStats at all). */
  readonly embeddingBackend: 'available' | 'fallback-lexical';
  /** Present exactly when block===null: why nothing was injected. */
  readonly reason?: string | undefined;
}

/**
 * Structural registry surface, mirroring knowledge-injection.ts's private
 * `KnowledgeRegistrySource` plus one addition: optional `vectorStats`, the sole signal this
 * module uses to tell a real semantic search apart from memory-store.ts's silent lexical
 * fallback (searchSemantic() never throws on a missing/disabled vector index — it just
 * degrades to keyword ranking). Kept structural (not `Pick<MemoryRegistry, ...>`) so tests
 * can supply a minimal fake without constructing a real MemoryStore/SQLite.
 */
export type TurnKnowledgeRegistrySource = {
  getAll(): readonly MemoryRecord[];
  searchSemantic?(input: Parameters<MemoryRegistry['searchSemantic']>[0]): readonly MemorySemanticSearchResult[];
  vectorStats?(): MemoryVectorStats;
};

export interface BuildPerTurnKnowledgeInjectionInput {
  readonly memoryRegistry: TurnKnowledgeRegistrySource;
  /** The agent's (possibly frozen) task text — always included in the derived query. */
  readonly task: string;
  readonly writeScope?: readonly string[] | undefined;
  /** The current conversation, formatted for the LLM — the source of "what changed this turn". */
  readonly conversationTail: readonly ProviderMessage[];
  /** Hard token budget for the rendered block. budgetTokens<=0 is the caller's job to no-op on;
   *  this function still honors it correctly (an empty/null block, honest record). */
  readonly budgetTokens: number;
  readonly relevanceFloor: number;
  readonly limit?: number | undefined;
  /** Ids never to re-list (the spawn-time baseline plus every id injected on prior turns). */
  readonly alreadyInjectedIds: readonly string[];
  readonly turn: number;
}

export interface BuildPerTurnKnowledgeInjectionResult {
  readonly block: string | null;
  readonly record: TurnInjectionRecord;
}

function extractTextContent(content: string | readonly ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
}

/**
 * The one behavioral difference from spawn-time selection: derive the query from the
 * LATEST user-role message in the conversation tail (a steer, a drained directive, or —
 * on turn 1, before any steer exists — the initial task itself) concatenated with the
 * task, instead of the task alone. On turn 1 the latest user message IS the task (the
 * runner seeds it via `conversation.addUserMessage(record.task)` before the turn loop),
 * so this collapses to the task with no duplication.
 */
export function deriveTurnKnowledgeQuery(task: string, conversationTail: readonly ProviderMessage[]): string {
  let latestUserContent = '';
  for (let i = conversationTail.length - 1; i >= 0; i--) {
    const message = conversationTail[i];
    if (message?.role === 'user') {
      latestUserContent = extractTextContent(message.content).trim();
      break;
    }
  }
  const trimmedTask = task.trim();
  if (!latestUserContent || latestUserContent === trimmedTask) {
    return trimmedTask;
  }
  return `${trimmedTask} ${latestUserContent}`.trim();
}

function resolveEmbeddingBackend(registry: TurnKnowledgeRegistrySource): 'available' | 'fallback-lexical' {
  const stats = registry.vectorStats?.();
  if (!stats) return 'fallback-lexical';
  return stats.enabled && stats.available ? 'available' : 'fallback-lexical';
}

export function buildPerTurnKnowledgeInjection(
  input: BuildPerTurnKnowledgeInjectionInput,
): BuildPerTurnKnowledgeInjectionResult {
  const {
    memoryRegistry,
    task,
    writeScope = [],
    conversationTail,
    budgetTokens,
    relevanceFloor,
    limit = DEFAULT_TURN_KNOWLEDGE_LIMIT,
    alreadyInjectedIds,
    turn,
  } = input;

  const query = deriveTurnKnowledgeQuery(task, conversationTail);
  const alreadyInjectedIdSet = new Set(alreadyInjectedIds);
  const embeddingBackend = resolveEmbeddingBackend(memoryRegistry);

  const scored = selectKnowledgeForTaskScored(memoryRegistry, query, writeScope, limit)
    .filter((entry) => !alreadyInjectedIdSet.has(entry.injection.id));
  const candidatesConsidered = scored.length;

  const clearedFloor = scored.filter((entry) => entry.score >= relevanceFloor).slice(0, limit);
  if (clearedFloor.length === 0) {
    return {
      block: null,
      record: {
        turn,
        query,
        candidatesConsidered,
        injectedIds: [],
        droppedForBudget: [],
        tokenCost: 0,
        budgetTokens,
        relevanceFloor,
        ingestModes: [],
        embeddingBackend,
        reason: 'no records cleared relevance floor',
      },
    };
  }

  // Greedy budget trim: clearedFloor is already sorted best-first (selectKnowledgeForTaskScored's
  // contract), so dropping from the tail always drops the lowest-scored surviving entry.
  const kept = [...clearedFloor];
  const droppedForBudget: string[] = [];
  let tokenCost = estimateTokens(buildKnowledgeInjectionPrompt(kept.map((entry) => entry.injection)) ?? '');
  while (kept.length > 0 && tokenCost > budgetTokens) {
    const removed = kept.pop();
    if (!removed) break;
    droppedForBudget.push(removed.injection.id);
    tokenCost = kept.length > 0
      ? estimateTokens(buildKnowledgeInjectionPrompt(kept.map((entry) => entry.injection)) ?? '')
      : 0;
  }

  if (kept.length === 0) {
    return {
      block: null,
      record: {
        turn,
        query,
        candidatesConsidered,
        injectedIds: [],
        droppedForBudget,
        tokenCost: 0,
        budgetTokens,
        relevanceFloor,
        ingestModes: [],
        embeddingBackend,
        reason: 'single highest-scoring record exceeds budget',
      },
    };
  }

  const block = buildKnowledgeInjectionPrompt(kept.map((entry) => entry.injection));
  return {
    block,
    record: {
      turn,
      query,
      candidatesConsidered,
      injectedIds: kept.map((entry) => entry.injection.id),
      droppedForBudget,
      tokenCost,
      budgetTokens,
      relevanceFloor,
      ingestModes: kept.map((entry) => entry.injection.ingestMode),
      embeddingBackend,
    },
  };
}

/**
 * Push one entry onto a bounded ring, evicting the oldest entry once
 * `retention` is exceeded. Pure and exported so it is independently
 * unit-testable (and so orchestrator-runner.ts never has to hand-roll ring
 * eviction inline).
 */
export function recordTurnInjection(
  existing: readonly TurnInjectionRecord[] | undefined,
  entry: TurnInjectionRecord,
  retention: number = DEFAULT_TURN_INJECTION_RING_SIZE,
): TurnInjectionRecord[] {
  const next = existing ? [...existing, entry] : [entry];
  return next.length > retention ? next.slice(next.length - retention) : next;
}
