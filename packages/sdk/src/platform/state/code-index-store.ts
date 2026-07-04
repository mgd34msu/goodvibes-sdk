/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * CodeIndexStore — an incremental, tree-sitter-chunked, embedding-backed index
 * of a repo's source tree (Wave-5, W5.3, Stage A).
 *
 * Deliberately MIRRORS MemoryStore + SqliteVecMemoryIndex (state/memory-store.ts,
 * state/memory-vector-store.ts) rather than reusing them: those classes are
 * hard-keyed to MemoryRecord (schema columns, memoryVectorSourceHash,
 * buildMemoryEmbeddingText, record-shaped search filters). Code chunks are a
 * different record shape entirely, so this module is a parallel, independent
 * implementation that reuses only:
 *   - the sqlite-vec native extension loader (sqlite-vec-loader.ts)
 *   - MEMORY_VECTOR_DIMS / the shared MemoryEmbeddingProviderRegistry instance,
 *     so code and memory embeddings share one provider and one dimensionality.
 *   - CodeIntelligence.getSymbols (tree-sitter-backed chunking; the chunking
 *     itself lives in code-index-chunking.ts)
 *   - the file-walk helpers already shipped for the `find` tool
 *     (tools/find/shared.ts: buildGitignoreMatcher, findNestedGitignoreFiles,
 *     collectGlobFiles, isBinary, readTextFile) — no new ignore-file parsing
 *     or directory-walk logic. Ignore rules: the ROOT .gitignore plus nested
 *     .gitignore files (each applied relative to its own directory). Nested
 *     coverage is bounded by findNestedGitignoreFiles' own cap (currently the
 *     first 5 nested files found, in walk order) — a repo with more nested
 *     .gitignore files than that has the excess UNAPPLIED, same as the find
 *     tool itself.
 *
 * Storage: a single bun:sqlite database (schema + all table ops live in
 * code-index-db.ts) — `code_chunks` (chunk metadata), `code_vectors` (vec0
 * virtual table), and `code_index_meta` (build provenance: the embedding
 * provider id the index was last fully built with). When the current default
 * embedding provider differs from the stored one, search() refuses to run the
 * vector path — a query embedded in provider-Y space compared against
 * provider-X vectors is meaningless — and degrades to an honestly-labeled
 * lexical match over chunk symbol/path metadata until a rebuild re-embeds
 * (buildFull() detects the mismatch and forces a full re-embed).
 *
 * Incremental reindex is LAZY, never a watcher: a recursive fs.watch over a
 * repo tree is a per-file-descriptor liability and races the agent's own
 * writes. `reindexFile()` re-chunks and re-embeds a single path on demand.
 * `buildFull()` walks the whole tree once; concurrent calls coalesce through a
 * single-flight promise guard, mirroring MemoryStore.rebuildVectorIndexAsync.
 *
 * Lifecycle honesty: `reroot()`/`close()` bump an epoch counter; an in-flight
 * build re-checks the epoch after every await and aborts cleanly when stale
 * (per-file writes are atomic — all of a file's chunks are embedded before any
 * row is written — so an aborted build never writes wrong-rooted chunks into
 * the new database). Aborted builds return stats carrying
 * `abortReason: 'build aborted by reroot'` and never become `lastBuild`.
 *
 * The index never blocks a turn: buildFull() awaits `embedAsync` on a bounded
 * per-file queue with periodic event-loop yields, and every read (`search`,
 * `stats`) returns whatever is currently indexed — it never waits on an
 * in-flight build.
 */

import { dirname, join, relative, sep } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { loadSqliteVecExtension } from './sqlite-vec-loader.js';
import {
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
  normalizeMemoryEmbeddingVector,
} from './memory-embeddings.js';
import { MEMORY_VECTOR_DIMS } from './memory-vector-store.js';
import { CodeIntelligence } from '../intelligence/facade.js';
import {
  chunkFileContent,
  sha256,
  type CodeChunk,
  type CodeChunkMode,
} from './code-index-chunking.js';
import {
  CHUNK_ROW_COLUMNS,
  EMBEDDING_PROVIDER_META_KEY,
  createCodeIndexSchema,
  countChunksForPath,
  countIndexedChunks,
  countIndexedFiles,
  deleteChunksForPath,
  getChunkById,
  getCodeIndexMeta,
  getFileHash,
  listIndexedPaths,
  rowToChunk,
  setCodeIndexMeta,
  writeChunk,
  type ChunkRow,
  type VectorRow,
} from './code-index-db.js';
import {
  buildGitignoreMatcher,
  collectGlobFiles,
  createFindDiagnostics,
  findNestedGitignoreFiles,
  isBinary,
  readTextFile,
  type FindDiagnostics,
} from '../tools/find/shared.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export type { CodeChunk, CodeChunkMode } from './code-index-chunking.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const BUILD_ABORTED_BY_REROOT = 'build aborted by reroot';

function distanceToSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, Math.min(1, 1 - distance / 2));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 0);
    timer.unref?.();
  });
}

type MutableSkipReport = {
  tooLarge: number;
  overFileCap: number;
  overTotalBytes: number;
  binary: number;
  ignoredByGitignore: number;
  readErrors: number;
  chunkedByWindow: number;
};

function emptySkipReport(): MutableSkipReport {
  return { tooLarge: 0, overFileCap: 0, overTotalBytes: 0, binary: 0, ignoredByGitignore: 0, readErrors: 0, chunkedByWindow: 0 };
}

// ---------------------------------------------------------------------------
// CodeIndexStore
// ---------------------------------------------------------------------------

export class CodeIndexStore {
  private db: Database | null = null;
  private available = false;
  private error: string | undefined;
  private building = false;
  private buildStartedAtMs: number | null = null;
  private buildPromise: Promise<CodeIndexBuildStats> | null = null;
  private lastBuild: CodeIndexBuildStats | null = null;
  private progress: CodeIndexBuildProgress | null = null;
  private readonly intelligence: CodeIntelligence;
  private intelligenceReadyPromise: Promise<void> | null = null;
  /**
   * Lifecycle generation counter. Bumped by reroot() and close(); an in-flight
   * runBuild() captures the value at start and re-checks it after EVERY await,
   * aborting cleanly when stale so a build started against one root can never
   * write wrong-rooted chunks into a database opened for a different root.
   */
  private epoch = 0;

  private rootDir: string;
  private dbPath: string;

  constructor(
    rootDir: string,
    dbPath: string,
    private readonly embeddingRegistry: MemoryEmbeddingProviderRegistry,
    private readonly options: CodeIndexOptions = {},
  ) {
    this.rootDir = rootDir;
    this.dbPath = dbPath;
    this.intelligence = new CodeIntelligence();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  init(): void {
    if (this.db) return;
    try {
      if (this.dbPath !== ':memory:') {
        mkdirSync(dirname(this.dbPath), { recursive: true });
      }
      this.db = new Database(this.dbPath);
      loadSqliteVecExtension(this.db);
      this.available = true;
      createCodeIndexSchema(this.db);
    } catch (err) {
      this.close();
      this.available = false;
      this.error = summarizeError(err);
      logger.warn('Code index unavailable', { backend: 'sqlite-vec', error: this.error });
    }
  }

  close(): void {
    if (!this.db) return;
    this.epoch++;
    this.db.close();
    this.db = null;
    this.available = false;
  }

  /**
   * Re-root the store to a new working directory + db path (workspace swap).
   * Bumps the build epoch (aborting any in-flight build at its next await),
   * closes existing handles, reopens at the new path, and clears in-memory
   * build state. Does NOT re-trigger a build — the caller decides when to
   * call scheduleBuild()/buildFull() again, exactly as it decided to open the
   * store originally.
   */
  async reroot(newRootDir: string, newDbPath: string): Promise<void> {
    this.epoch++;
    this.close();
    this.buildPromise = null;
    this.building = false;
    this.buildStartedAtMs = null;
    this.lastBuild = null;
    this.progress = null;
    this.rootDir = newRootDir;
    this.dbPath = newDbPath;
    this.init();
  }

  // ── Status ───────────────────────────────────────────────────────────────

  isBuilding(): boolean {
    return this.building;
  }

  buildProgress(): CodeIndexBuildProgress | null {
    return this.building ? this.progress : null;
  }

  /** Wall-clock start time of the in-flight build, or null when idle. */
  buildStartedAt(): number | null {
    return this.building ? this.buildStartedAtMs : null;
  }

  /** True unless the only active embedding provider is the deterministic hashed fallback. */
  hasSemanticProvider(): boolean {
    return this.embeddingRegistry.getDefaultProviderId() !== HASHED_MEMORY_EMBEDDING_PROVIDER.id;
  }

  /** Stated once, honest: why Stage-B auto-retrieval (a later wave) would be absent right now. Null when a real provider is active. */
  describeDegradation(): string | null {
    return this.hasSemanticProvider()
      ? null
      : 'code auto-retrieval disabled: no semantic embedding provider configured';
  }

  /**
   * Human-readable provider-space mismatch, or null when the stored vectors
   * were built with the current default provider (or provenance is unknown —
   * an index that predates provenance tracking keeps its legacy behavior
   * until the next build stamps it).
   */
  getProviderMismatch(): string | null {
    if (!this.db || !this.available) return null;
    const stored = getCodeIndexMeta(this.db, EMBEDDING_PROVIDER_META_KEY);
    const current = this.embeddingRegistry.getDefaultProviderId();
    if (stored === null || stored === current) return null;
    return `embeddings built with ${stored}, current provider ${current} — rebuild to re-embed`;
  }

  stats(): CodeIndexStats {
    const provider = this.embeddingRegistry.getDefaultProviderOrNull();
    const mismatch = this.getProviderMismatch();
    return {
      backend: 'sqlite-vec',
      enabled: this.available,
      available: this.available,
      path: this.dbPath,
      dimensions: MEMORY_VECTOR_DIMS,
      indexedFiles: this.db && this.available ? countIndexedFiles(this.db) : 0,
      indexedChunks: this.db && this.available ? countIndexedChunks(this.db) : 0,
      embeddingProviderId: provider?.id ?? this.embeddingRegistry.getDefaultProviderId(),
      embeddingProviderLabel: provider?.label ?? `Unregistered (${this.embeddingRegistry.getDefaultProviderId()})`,
      semanticRetrievalAvailable: this.hasSemanticProvider(),
      ...(mismatch ? { embeddingProviderMismatch: mismatch } : {}),
      building: this.building,
      lastBuild: this.lastBuild,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  // ── Search (Stage A explicit query) ─────────────────────────────────────

  search(query: string, opts: { limit?: number } = {}): CodeContextResult[] {
    if (!this.db || !this.available) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const limit = Math.max(1, Math.min(50, opts.limit ?? 10));

    // Provider-space honesty: a query embedded under the CURRENT provider is
    // meaningless against vectors stored under a DIFFERENT one — skip the
    // vector path entirely and degrade to lexical metadata matching.
    if (this.getProviderMismatch() !== null) {
      return this.searchLexical(trimmed, limit);
    }

    let embedding: Float32Array;
    try {
      const result = this.embeddingRegistry.embedSync({
        text: trimmed,
        dimensions: MEMORY_VECTOR_DIMS,
        usage: 'query',
      });
      embedding = normalizeMemoryEmbeddingVector(result.vector, MEMORY_VECTOR_DIMS);
    } catch (err) {
      logger.warn('Code index query embedding failed', { error: summarizeError(err) });
      return [];
    }

    const rows = this.db.query<VectorRow, SQLQueryBindings[]>(
      'SELECT rowid, chunk_id, distance FROM code_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance',
    ).all(embedding, limit) as VectorRow[];

    const label: CodeContextResult['label'] = this.hasSemanticProvider() ? 'semantic' : 'lexical';
    const results: CodeContextResult[] = [];
    for (const row of rows) {
      const chunk = getChunkById(this.db, row.chunk_id);
      if (!chunk) continue;
      results.push({
        chunk,
        distance: Number(row.distance),
        similarity: distanceToSimilarity(Number(row.distance)),
        label,
      });
    }
    return results;
  }

  /**
   * Lexical fallback used when the vector path is disabled by a provider
   * mismatch: token match over chunk symbol/path metadata (chunk text is not
   * stored, so this is name/path matching only — labeled 'lexical', never
   * 'semantic'). Similarity is the matched-token fraction.
   */
  private searchLexical(query: string, limit: number): CodeContextResult[] {
    if (!this.db) return [];
    const tokens = Array.from(new Set(
      query.toLowerCase().split(/[^a-z0-9_$]+/).filter((token) => token.length >= 2),
    ));
    if (tokens.length === 0) return [];

    const where = tokens.map(() => '(lower(symbol) LIKE ? OR lower(path) LIKE ?)').join(' OR ');
    const bindings: SQLQueryBindings[] = tokens.flatMap((token) => [`%${token}%`, `%${token}%`]);
    const rows = this.db.query<ChunkRow, SQLQueryBindings[]>(
      `SELECT ${CHUNK_ROW_COLUMNS} FROM code_chunks WHERE ${where} LIMIT ?`,
    ).all(...bindings, limit * 5) as ChunkRow[];

    const scored = rows.map((row) => {
      const haystack = `${row.symbol} ${row.path}`.toLowerCase();
      const matched = tokens.filter((token) => haystack.includes(token)).length;
      const similarity = matched / tokens.length;
      return {
        chunk: rowToChunk(row),
        distance: 2 * (1 - similarity),
        similarity,
        label: 'lexical' as const,
      };
    });
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  }

  // ── Build / reindex ──────────────────────────────────────────────────────

  /** Fire-and-forget kickoff; concurrent/repeated calls while a build is running are no-ops. Never awaited by the caller — never blocks a turn. */
  scheduleBuild(): void {
    if (this.building) return;
    void this.buildFull().catch((err) => {
      logger.warn('Code index build failed', { error: summarizeError(err) });
    });
  }

  /** Full source-tree walk. Concurrent calls coalesce onto the same in-flight promise (mirrors MemoryStore.rebuildVectorIndexAsync). */
  async buildFull(): Promise<CodeIndexBuildStats> {
    if (!this.db || !this.available) {
      return this.lastBuild ?? emptyBuildStats();
    }
    if (!this.buildPromise) {
      const buildEpoch = this.epoch;
      this.building = true;
      this.buildStartedAtMs = Date.now();
      this.progress = { scanned: 0, total: 0 };
      this.buildPromise = this.runBuild(buildEpoch).finally(() => {
        // A reroot() already reset these for the NEW lifecycle; a stale
        // build's cleanup must not clobber state belonging to a newer epoch.
        if (this.epoch === buildEpoch) {
          this.building = false;
          this.buildStartedAtMs = null;
          this.buildPromise = null;
          this.progress = null;
        }
      });
    }
    return this.buildPromise;
  }

  /**
   * Reindex a single file on demand. Intended to be called from the file
   * read/write tool paths and from an explicit reindex command — wiring
   * those call sites is out of scope for this module (see module doc).
   * A no-op (chunks removed) if the path is gitignored or no longer exists.
   */
  async reindexFile(absPath: string): Promise<{ indexed: boolean; mode: CodeChunkMode }> {
    if (!this.db || !this.available) return { indexed: false, mode: 'empty' };
    const callEpoch = this.epoch;
    const rel = relative(this.rootDir, absPath);
    if (rel.startsWith('..')) return { indexed: false, mode: 'empty' };

    const diagnostics = createFindDiagnostics();
    const isIgnored = this.buildIgnoreMatcher(diagnostics);
    if (isIgnored(absPath, rel)) {
      deleteChunksForPath(this.db, rel);
      return { indexed: false, mode: 'empty' };
    }

    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      deleteChunksForPath(this.db, rel);
      return { indexed: false, mode: 'empty' };
    }

    const maxFileBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (stat.size > maxFileBytes) return { indexed: false, mode: 'empty' };
    if (await isBinary(absPath, diagnostics)) return { indexed: false, mode: 'empty' };

    const text = await readTextFile(absPath, diagnostics);
    if (text === null) return { indexed: false, mode: 'empty' };

    const outcome = await this.indexFileContent(rel, absPath, text, stat.mtimeMs, callEpoch, false);
    if (outcome === null) return { indexed: false, mode: 'empty' };
    return { indexed: outcome.indexed, mode: outcome.mode };
  }

  // ── Build internals ──────────────────────────────────────────────────────

  private async runBuild(buildEpoch: number): Promise<CodeIndexBuildStats> {
    const startedAt = Date.now();
    const diagnostics = createFindDiagnostics();
    const maxFiles = this.options.maxFiles ?? DEFAULT_MAX_FILES;
    const maxFileBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxTotalBytes = this.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

    const skip = emptySkipReport();

    // Provider-space honesty: if the stored vectors were embedded under a
    // different provider than the current default, the unchanged-file
    // shortcut would silently keep stale-space vectors — force a full
    // re-embed so a completed build always leaves a single-provider index.
    const currentProviderId = this.embeddingRegistry.getDefaultProviderId();
    const storedProviderId = this.db ? getCodeIndexMeta(this.db, EMBEDDING_PROVIDER_META_KEY) : null;
    const forceReembed = storedProviderId !== null && storedProviderId !== currentProviderId;

    const isIgnored = this.buildIgnoreMatcher(diagnostics);
    const scanned = await collectGlobFiles(this.rootDir, ['**/*'], false, false, diagnostics);
    if (this.epoch !== buildEpoch) return abortedBuildStats(startedAt, scanned.size, skip);
    // Deterministic order so identical trees always chunk identically (chunking determinism test).
    const candidateFiles = Array.from(scanned).sort();

    const keepPaths = new Set<string>();
    let filesIndexed = 0;
    let filesUnchanged = 0;
    let chunksIndexed = 0;
    let chunksUnchanged = 0;
    let totalBytes = 0;
    let acceptedCount = 0;

    for (const absPath of candidateFiles) {
      const rel = relative(this.rootDir, absPath);
      if (isIgnored(absPath, rel)) {
        skip.ignoredByGitignore++;
        continue;
      }

      if (acceptedCount >= maxFiles) {
        skip.overFileCap++;
        continue;
      }

      let stat;
      try {
        stat = statSync(absPath);
      } catch {
        skip.readErrors++;
        continue;
      }
      if (stat.size > maxFileBytes) {
        skip.tooLarge++;
        continue;
      }
      if (totalBytes + stat.size > maxTotalBytes) {
        skip.overTotalBytes++;
        continue;
      }
      const binary = await isBinary(absPath, diagnostics);
      if (this.epoch !== buildEpoch) return abortedBuildStats(startedAt, candidateFiles.length, skip);
      if (binary) {
        skip.binary++;
        continue;
      }

      const text = await readTextFile(absPath, diagnostics);
      if (this.epoch !== buildEpoch) return abortedBuildStats(startedAt, candidateFiles.length, skip);
      if (text === null) {
        skip.readErrors++;
        continue;
      }

      acceptedCount++;
      totalBytes += stat.size;
      keepPaths.add(rel);

      const outcome = await this.indexFileContent(rel, absPath, text, stat.mtimeMs, buildEpoch, forceReembed);
      if (outcome === null) return abortedBuildStats(startedAt, candidateFiles.length, skip);
      if (outcome.mode === 'window') skip.chunkedByWindow++;
      if (outcome.mode === 'unchanged') {
        filesUnchanged++;
        chunksUnchanged += outcome.chunkCount;
      } else {
        if (outcome.indexed) filesIndexed++;
        chunksIndexed += outcome.chunkCount;
      }

      this.progress = { scanned: acceptedCount, total: candidateFiles.length };
      if (acceptedCount % 20 === 0) {
        await yieldToEventLoop();
        if (this.epoch !== buildEpoch) return abortedBuildStats(startedAt, candidateFiles.length, skip);
      }
    }

    // Final staleness check before the destructive sweep: a stale build's
    // keepPaths describes the OLD tree and must never delete the new one's rows.
    if (this.epoch !== buildEpoch || !this.db) {
      return abortedBuildStats(startedAt, candidateFiles.length, skip);
    }

    // Sweep: a file that no longer exists (deleted, renamed, or newly gitignored) loses its chunks.
    let filesRemoved = 0;
    for (const path of listIndexedPaths(this.db)) {
      if (!keepPaths.has(path)) {
        deleteChunksForPath(this.db, path);
        filesRemoved++;
      }
    }

    // Stamp provenance only on a COMPLETED build — every chunk that survives
    // to this point is either freshly embedded under currentProviderId or was
    // verified same-provider by the forceReembed logic above.
    setCodeIndexMeta(this.db, EMBEDDING_PROVIDER_META_KEY, currentProviderId);

    const completedAt = Date.now();
    const stats: CodeIndexBuildStats = {
      filesScanned: candidateFiles.length,
      filesIndexed,
      filesUnchanged,
      chunksIndexed,
      chunksUnchanged,
      filesRemoved,
      skip: Object.freeze({ ...skip }),
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
    };
    this.lastBuild = stats;
    return stats;
  }

  /**
   * Compose the root .gitignore with any nested .gitignore files (each nested
   * file's patterns apply relative to its own directory, per git semantics).
   * Nested coverage is bounded by findNestedGitignoreFiles' cap (see module doc).
   */
  private buildIgnoreMatcher(diagnostics: FindDiagnostics): (absPath: string, rel: string) => boolean {
    const rootGitignorePath = join(this.rootDir, '.gitignore');
    const rootMatcher = buildGitignoreMatcher(rootGitignorePath, diagnostics);
    const nested = findNestedGitignoreFiles(this.rootDir, rootGitignorePath)
      .map((path) => ({ dir: dirname(path), matcher: buildGitignoreMatcher(path, diagnostics) }))
      .filter((entry): entry is { dir: string; matcher: (rel: string) => boolean } => entry.matcher !== null);
    return (absPath: string, rel: string): boolean => {
      if (rootMatcher !== null && rootMatcher(rel)) return true;
      for (const entry of nested) {
        if (absPath.startsWith(entry.dir + sep) && entry.matcher(relative(entry.dir, absPath))) {
          return true;
        }
      }
      return false;
    };
  }

  /**
   * Index one file's content. Short-circuits on an unchanged file_hash (no
   * re-chunk, no re-embed) — the "content_hash stable across re-index of
   * unchanged file" contract — unless forceReembed is set (provider mismatch).
   *
   * Epoch honesty: all of a file's chunks are embedded (every await) BEFORE
   * any row is deleted or written, and the epoch is re-checked after each
   * await — so a reroot() mid-file aborts with the database untouched for
   * that file (returns null; the caller abandons the build).
   */
  private async indexFileContent(
    relPath: string,
    absPath: string,
    content: string,
    mtimeMs: number,
    callEpoch: number,
    forceReembed: boolean,
  ): Promise<{ indexed: boolean; mode: CodeChunkMode; chunkCount: number } | null> {
    if (!this.db) return null;
    const fileHash = sha256(content);
    if (!forceReembed) {
      const existingHash = getFileHash(this.db, relPath);
      if (existingHash === fileHash) {
        return { indexed: true, mode: 'unchanged', chunkCount: countChunksForPath(this.db, relPath) };
      }
    }

    await this.ensureIntelligenceReady();
    if (this.epoch !== callEpoch) return null;
    const { drafts, mode } = await chunkFileContent({
      intelligence: this.intelligence,
      absPath,
      relPath,
      content,
      fileHash,
      mtimeMs,
      windowLines: this.options.windowLines,
      windowOverlapLines: this.options.windowOverlapLines,
    });
    if (this.epoch !== callEpoch) return null;

    const embeddings: Float32Array[] = [];
    for (const draft of drafts) {
      const embedding = await this.embedChunkAsync(draft.embedText);
      if (this.epoch !== callEpoch) return null;
      embeddings.push(embedding);
    }

    // All awaits are done — the delete+write below is synchronous, so the
    // whole file lands atomically with respect to reroot()/close().
    if (!this.db) return null;
    deleteChunksForPath(this.db, relPath);
    for (let i = 0; i < drafts.length; i++) {
      writeChunk(this.db, drafts[i]!.chunk, embeddings[i]!);
    }
    return { indexed: drafts.length > 0 || mode === 'empty', mode, chunkCount: drafts.length };
  }

  private async ensureIntelligenceReady(): Promise<void> {
    if (!this.intelligenceReadyPromise) {
      this.intelligenceReadyPromise = this.intelligence.initialize().catch((err) => {
        logger.warn('CodeIndexStore: tree-sitter init failed', { error: summarizeError(err) });
      });
    }
    return this.intelligenceReadyPromise;
  }

  private async embedChunkAsync(text: string): Promise<Float32Array> {
    const result = await this.embeddingRegistry.embedAsync({
      text,
      dimensions: MEMORY_VECTOR_DIMS,
      usage: 'record',
    });
    return normalizeMemoryEmbeddingVector(result.vector, MEMORY_VECTOR_DIMS);
  }
}

function abortedBuildStats(startedAt: number, filesScanned: number, skip: MutableSkipReport): CodeIndexBuildStats {
  const completedAt = Date.now();
  logger.warn('Code index build aborted by reroot', { filesScanned });
  return {
    filesScanned,
    filesIndexed: 0,
    filesUnchanged: 0,
    chunksIndexed: 0,
    chunksUnchanged: 0,
    filesRemoved: 0,
    skip: Object.freeze({ ...skip }),
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    abortReason: BUILD_ABORTED_BY_REROOT,
  };
}

function emptyBuildStats(): CodeIndexBuildStats {
  const now = Date.now();
  return {
    filesScanned: 0,
    filesIndexed: 0,
    filesUnchanged: 0,
    chunksIndexed: 0,
    chunksUnchanged: 0,
    filesRemoved: 0,
    skip: emptySkipReport(),
    startedAt: now,
    completedAt: now,
    durationMs: 0,
  };
}
