// context_accounting — the model reading its OWN context composition honestly.
//
// STANDING RULE: recall-contract fields (floors, exclusions, degraded modes) and
// per-turn injection records already exist; this tool exposes them to the MODEL
// (not just the user) so it can distinguish "no memory exists" from "recall was
// floored" from "the index is unavailable." Everything reported is drawn from
// real recorded state — measured token counts are reported as fact; anything
// estimated (block token cost, context-used percent) is flagged as an estimate,
// never presented as measured.
import type { Tool, ToolDefinition, ToolResult } from '../../types/tools.js';
import type { TurnInjectionRecord } from '../../agents/turn-knowledge-injection.js';
import { summarizeError } from '../../utils/error-display.js';

/** Measured + configured token state for the bound session. */
export interface ContextTokenState {
  /** Provider-reported (MEASURED) cumulative token usage for the session. */
  readonly measured: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  /** MEASURED tokens the last request actually put in the context window (incl. cache). */
  readonly lastInputTokens: number;
  /** The active model's configured context window, or null when unknown. */
  readonly contextWindow: number | null;
}

/**
 * A reader onto ONE session's live context state. The interactive Orchestrator
 * binds itself as the source; the tool never fabricates — an unbound tool says
 * so rather than inventing an accounting.
 */
export interface ContextAccountingSource {
  /** A human-readable scope label so the model knows WHOSE context this is. */
  readonly scope: string;
  readonly sessionId?: string | undefined;
  /** The bounded ring of per-turn passive-injection honesty records. */
  getTurnInjections(): readonly TurnInjectionRecord[];
  getTokenState(): ContextTokenState;
  getCompactionState(): { readonly isCompacting: boolean; readonly compactionCount?: number | undefined };
}

/**
 * A settable holder for the active context-accounting source. Registered into
 * the tool roster once (so every consumer inherits the tool); the interactive
 * session binds its Orchestrator-backed source after construction. Unbound → the
 * tool reports honestly that no live session context is available.
 */
export class ContextAccountingHolder {
  private source: ContextAccountingSource | null = null;
  setSource(source: ContextAccountingSource | null): void {
    this.source = source;
  }
  getSource(): ContextAccountingSource | null {
    return this.source;
  }
}

function summarizeLatestInjection(record: TurnInjectionRecord | undefined) {
  if (!record) return null;
  return {
    turn: record.turn,
    injectedIds: record.injectedIds,
    injectedSources: record.injectedSources,
    candidatesConsidered: record.candidatesConsidered,
    codeCandidatesConsidered: record.codeCandidatesConsidered,
    // Flagged as an estimate below in `estimates`.
    tokenCostEstimated: record.tokenCost,
    ...(record.reason ? { nothingInjectedReason: record.reason } : {}),
  };
}

function buildRecallContract(record: TurnInjectionRecord | undefined) {
  if (!record) {
    return {
      note: 'No per-turn injection has been recorded yet — nothing has been passively injected this session.',
    };
  }
  const degraded = record.embeddingBackend === 'fallback-lexical';
  const notes: string[] = [];
  if (record.reason) notes.push(`Nothing injected this turn: ${record.reason}.`);
  else if (record.injectedIds.length > 0) notes.push(`${record.injectedIds.length} record(s) injected this turn.`);
  if (record.droppedForBudget.length > 0) {
    notes.push(`${record.droppedForBudget.length} record(s) cleared the relevance floor but were dropped to fit the token budget.`);
  }
  if (degraded) notes.push('Semantic recall degraded to lexical matching (no usable vector index).');
  if (record.codeInjectionSkipped) notes.push(`Code index contributed nothing: ${record.codeInjectionSkipped}.`);
  return {
    relevanceFloor: record.relevanceFloor,
    budgetTokens: record.budgetTokens,
    droppedForBudget: record.droppedForBudget,
    embeddingBackend: record.embeddingBackend,
    degraded,
    ...(record.codeInjectionSkipped ? { codeInjectionSkipped: record.codeInjectionSkipped } : {}),
    note: notes.length > 0 ? notes.join(' ') : 'Recall ran with no floor exclusions or degraded modes this turn.',
  };
}

const CONTEXT_ACCOUNTING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/**
 * Build the context_accounting tool bound to a source holder. Read-only.
 */
export function createContextAccountingTool(holder: ContextAccountingHolder): Tool {
  const definition: ToolDefinition = {
    name: 'context_accounting',
    description:
      'Report the current session\'s context composition honestly: what was passively injected this turn '
      + '(memory record ids, sources, and why), recall-contract outcomes (relevance floor, budget exclusions, '
      + 'degraded/lexical fallback, index-unavailable reasons), compaction state, and token-budget state. '
      + 'Measured token counts are reported as fact; estimated values are flagged. Call this to tell '
      + '"no memory exists" apart from "recall was floored" apart from "the index is unavailable". Read-only.',
    parameters: CONTEXT_ACCOUNTING_SCHEMA,
    sideEffects: ['read_fs'],
    concurrency: 'parallel',
  };

  async function execute(): Promise<Omit<ToolResult, 'callId'>> {
    try {
      const source = holder.getSource();
      if (!source) {
        return {
          success: true,
          output: JSON.stringify({
            available: false,
            reason: 'No live session context is bound to this tool instance. Context accounting is populated on the interactive session.',
          }),
        };
      }
      const injections = source.getTurnInjections();
      const latest = injections.length > 0 ? injections[injections.length - 1] : undefined;
      const tokens = source.getTokenState();
      const compaction = source.getCompactionState();
      const contextUsedPct = tokens.contextWindow && tokens.contextWindow > 0
        ? Math.round((tokens.lastInputTokens / tokens.contextWindow) * 1000) / 10
        : null;

      return {
        success: true,
        output: JSON.stringify({
          available: true,
          scope: source.scope,
          ...(source.sessionId ? { sessionId: source.sessionId } : {}),
          turn: {
            injectionRingSize: injections.length,
            latestInjection: summarizeLatestInjection(latest),
          },
          recallContract: buildRecallContract(latest),
          tokenBudget: {
            measured: tokens.measured,
            lastInputTokens: tokens.lastInputTokens,
            contextWindow: tokens.contextWindow,
            contextUsedPctEstimated: contextUsedPct,
          },
          compaction,
          estimates: {
            note: 'Fields named *Estimated (per-turn injection tokenCost, contextUsedPct) are heuristic estimates, '
              + 'not provider-measured. The tokenBudget.measured counts are provider-reported and authoritative.',
          },
        }),
      };
    } catch (err) {
      return { success: false, error: `context_accounting failed: ${summarizeError(err)}` };
    }
  }

  return { definition, execute };
}
