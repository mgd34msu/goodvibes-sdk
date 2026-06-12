/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * KnowledgeEvent — structured knowledge ingest, extraction, packet, projection, and job lifecycle events.
 */

export type KnowledgeEvent =
  | {
      type: 'KNOWLEDGE_INGEST_STARTED';
      sourceId: string;
      connectorId: string;
      sourceType: string;
      uri?: string | undefined;
    }
  /**
   * Granular progress update during a knowledge ingest pipeline run.
   *
   * Emitted by the knowledge ingest engine at each processing phase so UIs can
   * render live progress bars for long-running ingest operations (e.g. large
   * document sets, semantic indexing).
   *
   * **Integration note:** Emission sites live in `platform/knowledge`. Wire by calling
   * `bus.emit('knowledge', { type: 'KNOWLEDGE_INGEST_PROGRESS', ... })` at each
   * phase-transition or item-complete checkpoint in the ingest pipeline. The contract
   * is defined here so SDK consumers can subscribe without depending on the internal
   * knowledge module.
   *
   * **Scope note:** `operationId` is operation-scoped (not task-scoped). See `lifecycle.ts`
   * for the guard that ties progress events to their originating operation lifecycle.
   */
  | {
      type: 'KNOWLEDGE_INGEST_PROGRESS';
      /** Stable ingest operation identifier (matches KNOWLEDGE_INGEST_STARTED.sourceId). */
      operationId: string;
      /** Current pipeline phase (e.g. `'downloading'`, `'parsing'`, `'chunking'`, `'embedding'`, `'indexing'`). */
      phase: string;
      /** Items processed in the current phase so far. */
      completed: number;
      /** Total items for this phase (undefined if not yet determined). */
      total?: number | undefined;
      /** Completion percentage 0–100 (undefined if total unknown). */
      percent?: number | undefined;
      /** Optional human-readable status message (e.g. current file name). */
      message?: string | undefined;
    }
  | {
      type: 'KNOWLEDGE_INGEST_COMPLETED';
      sourceId: string;
      status: string;
      artifactId?: string | undefined;
      title?: string | undefined;
    }
  | {
      type: 'KNOWLEDGE_INGEST_FAILED';
      sourceId: string;
      error: string;
    }
  | {
      type: 'KNOWLEDGE_EXTRACTION_COMPLETED';
      sourceId: string;
      extractionId: string;
      format: string;
      estimatedTokens: number;
    }
  | {
      type: 'KNOWLEDGE_EXTRACTION_FAILED';
      sourceId: string;
      error: string;
    }
  | {
      type: 'KNOWLEDGE_COMPILE_COMPLETED';
      sourceId: string;
      nodeCount: number;
      edgeCount: number;
    }
  | {
      type: 'KNOWLEDGE_LINT_COMPLETED';
      issueCount: number;
    }
  | {
      type: 'KNOWLEDGE_PACKET_BUILT';
      task: string;
      itemCount: number;
      estimatedTokens: number;
      detail: 'compact' | 'standard' | 'detailed';
    }
  | {
      type: 'KNOWLEDGE_PROJECTION_RENDERED';
      targetId: string;
      pageCount: number;
    }
  | {
      type: 'KNOWLEDGE_PROJECTION_MATERIALIZED';
      targetId: string;
      artifactId: string;
      pageCount: number;
    }
  | {
      type: 'KNOWLEDGE_JOB_QUEUED';
      jobId: string;
      runId: string;
      mode: 'inline' | 'background';
    }
  | {
      type: 'KNOWLEDGE_JOB_STARTED';
      jobId: string;
      runId: string;
      mode: 'inline' | 'background';
    }
  | {
      type: 'KNOWLEDGE_JOB_COMPLETED';
      jobId: string;
      runId: string;
      durationMs: number;
    }
  | {
      type: 'KNOWLEDGE_JOB_FAILED';
      jobId: string;
      runId: string;
      error: string;
      durationMs: number;
    };

export type KnowledgeEventType = KnowledgeEvent['type'];
