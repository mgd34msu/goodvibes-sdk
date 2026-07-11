/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * CompactionEvent — discriminated union covering all context compaction events.
 *
 * Covers compaction lifecycle events for the runtime event bus.
 */

export type CompactionEvent =
  /** A compaction threshold check was triggered. */
  | { type: 'COMPACTION_CHECK'; sessionId: string; tokenCount: number; threshold: number }
  /** Micro-compaction: lightweight summary of recent turns only. */
  | { type: 'COMPACTION_MICROCOMPACT'; sessionId: string; turnCount: number; tokensBefore: number; tokensAfter: number }
  /** Collapse: full context collapsed into a single summary message. */
  | { type: 'COMPACTION_COLLAPSE'; sessionId: string; messageCount: number; tokensBefore: number; tokensAfter: number }
  /** Auto-compaction: automatic compaction triggered by threshold breach. */
  | { type: 'COMPACTION_AUTOCOMPACT'; sessionId: string; strategy: string; tokensBefore: number; tokensAfter: number }
  /** Reactive compaction: triggered by an imminent context overflow. */
  | { type: 'COMPACTION_REACTIVE'; sessionId: string; tokenCount: number; limit: number }
  /** Compaction boundary commit: the compacted state has been persisted. */
  | { type: 'COMPACTION_BOUNDARY_COMMIT'; sessionId: string; checkpointId: string }
  /** Compaction completed successfully. */
  | { type: 'COMPACTION_DONE'; sessionId: string; strategy: string; tokensBefore: number; tokensAfter: number; durationMs: number }
  /** Compaction failed. */
  | { type: 'COMPACTION_FAILED'; sessionId: string; strategy: string; error: string }
  /** Session resume repair pipeline completed. */
  | { type: 'COMPACTION_RESUME_REPAIR'; sessionId: string; repaired: boolean; actionsCount: number; safeToResume: boolean }
  /** Quality score computed after a strategy run. */
  | { type: 'COMPACTION_QUALITY_SCORE'; sessionId: string; strategy: string; score: number; grade: string; compressionRatio: number; retentionScore: number; isLowQuality: boolean; description: string }
  /** Strategy switched automatically due to low quality score. */
  | { type: 'COMPACTION_STRATEGY_SWITCH'; sessionId: string; fromStrategy: string; toStrategy: string; reason: string; score: number }
  /**
   * Mandatory post-compaction receipt: emitted after every automatic (and the
   * manual) compaction path so a compaction is never silent. Carries what was
   * compacted, token/message counts before and after, the strategy, the quality
   * score/grade the guard computed, whether the standing instruction chain was
   * re-injected, and the outcome — `applied` (compacted context committed),
   * `kept-original` (quality guard rejected it, conversation retained), or
   * `failed` (compaction threw before producing a usable result).
   */
  | {
      type: 'COMPACTION_RECEIPT';
      sessionId: string;
      trigger: 'auto' | 'manual';
      strategy: string;
      tokensBefore: number;
      tokensAfter: number;
      messagesBefore: number;
      messagesAfter: number;
      qualityScore: number;
      qualityGrade: string;
      lowQuality: boolean;
      instructionsReinjected: boolean;
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
      outcome: 'applied' | 'kept-original' | 'failed';
      detail?: string | undefined;
    };

/** All compaction event type literals as a union. */
export type CompactionEventType = CompactionEvent['type'];
