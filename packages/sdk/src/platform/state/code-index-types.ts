/**
 * Public types for the repo source-tree code index (CodeIndexStore).
 * Split from code-index-store.ts purely to keep that file inside the
 * line-count discipline; the store re-exports everything here, so existing
 * importers are unaffected.
 */
import type { CodeChunk } from './code-index-chunking.js';

/** Honest per-build skip/degrade counters — every excluded or fallback file is counted, never silently dropped. */
export interface CodeIndexSkipReport {
  readonly tooLarge: number;
  /** Files skipped because the per-build file-count bound (maxFiles) was already reached. */
  readonly overFileCap: number;
  /** Files skipped because accepting them would exceed the per-build cumulative byte budget (maxTotalBytes). */
  readonly overTotalBytes: number;
  readonly binary: number;
  readonly ignoredByGitignore: number;
  readonly readErrors: number;
  readonly chunkedByWindow: number;
}

export interface CodeIndexBuildStats {
  readonly filesScanned: number;
  readonly filesIndexed: number;
  readonly filesUnchanged: number;
  /** Chunks embedded and written by THIS build (changed/new files only — unchanged files' pre-existing chunks are counted separately). */
  readonly chunksIndexed: number;
  /** Pre-existing chunks belonging to files this build found unchanged (no re-chunk, no re-embed). */
  readonly chunksUnchanged: number;
  readonly filesRemoved: number;
  readonly skip: CodeIndexSkipReport;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  /** Present exactly when the build was aborted (reroot()/close() during the walk) — partial results were discarded, not recorded as lastBuild. */
  readonly abortReason?: string | undefined;
}

export interface CodeIndexBuildProgress {
  readonly scanned: number;
  readonly total: number;
}

export interface CodeIndexStats {
  readonly backend: 'sqlite-vec';
  readonly enabled: boolean;
  readonly available: boolean;
  readonly path: string;
  readonly dimensions: number;
  readonly indexedFiles: number;
  readonly indexedChunks: number;
  readonly embeddingProviderId: string;
  readonly embeddingProviderLabel: string;
  /** False when the only active provider is the deterministic hashed one — semantic retrieval is a weak lexical-ish signal in that mode. */
  readonly semanticRetrievalAvailable: boolean;
  /**
   * Present exactly when the stored vectors were embedded under a DIFFERENT
   * provider than the current default — the vector search path is disabled
   * (lexical fallback only) until a rebuild re-embeds. Human-readable, e.g.
   * "embeddings built with X, current provider Y — rebuild to re-embed".
   */
  readonly embeddingProviderMismatch?: string | undefined;
  readonly building: boolean;
  readonly lastBuild: CodeIndexBuildStats | null;
  readonly error?: string | undefined;
}

/** A single search hit: the matched chunk plus its distance/similarity and an honest retrieval-quality label. */
export interface CodeContextResult {
  readonly chunk: CodeChunk;
  readonly distance: number;
  readonly similarity: number;
  /** 'lexical' when the hit did not come from a true semantic vector match: the hashed fallback provider is active, or a provider mismatch disabled the vector path. */
  readonly label: 'semantic' | 'lexical';
}

export interface CodeIndexOptions {
  /** Maximum number of files walked per build. Default 5000. */
  readonly maxFiles?: number | undefined;
  /** Files larger than this are skipped and counted as `tooLarge`. Default 512KB. */
  readonly maxFileBytes?: number | undefined;
  /** Cumulative byte budget for one build; once exceeded, remaining files count as `overTotalBytes`. Default 256MB. */
  readonly maxTotalBytes?: number | undefined;
  /** Fallback window size (lines) for unsupported/parse-failed/symbol-less files. Default 60. */
  readonly windowLines?: number | undefined;
  /** Overlap (lines) between consecutive fallback windows. Default 10. */
  readonly windowOverlapLines?: number | undefined;
}
