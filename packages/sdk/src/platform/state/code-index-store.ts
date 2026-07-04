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
 *   - CodeIntelligence.getSymbols (tree-sitter-backed chunking)
 *   - the gitignore-aware file walk already shipped for the `find` tool
 *     (tools/find/shared.ts: buildGitignoreMatcher, collectGlobFiles, isBinary,
 *     readTextFile) — no new ignore-file parsing or directory-walk logic.
 *
 * Storage: a single bun:sqlite database with two tables — `code_chunks`
 * (chunk metadata: path/lang/symbol/kind/lines/hashes) and `code_vectors`
 * (a vec0 virtual table keyed by rowid), exactly the two-table shape
 * SqliteVecMemoryIndex uses internally. Unlike MemoryStore, there is no
 * separate non-vector SQL engine here (no SQLiteStore/sql.js layer) — bun:sqlite
 * already owns both tables, so one file suffices instead of memory's
 * `memory.sqlite` + `memory.vec.sqlite` split (that split exists because
 * MemoryStore's record table lives in a *different* SQL engine than its vector
 * table; CodeIndexStore has no such split to mirror).
 *
 * Incremental reindex is LAZY, never a watcher: a recursive fs.watch over a
 * repo tree is a per-file-descriptor liability and races the agent's own
 * writes. `reindexFile()` re-chunks and re-embeds a single path on demand
 * (intended to be called from file read/write tool paths and from an explicit
 * `/codebase reindex` command — wiring those call sites is out of scope for
 * this module; see the Wave-5 W5.3 work-order report for the exact boundary).
 * `buildFull()` walks the whole tree once; concurrent calls coalesce through a
 * single-flight promise guard, mirroring MemoryStore.rebuildVectorIndexAsync.
 *
 * The index never blocks a turn: buildFull() awaits `embedAsync` on a bounded
 * per-file queue with periodic event-loop yields, and every read (`search`,
 * `stats`) returns whatever is currently indexed — it never waits on an
 * in-flight build.
 */

import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
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
import type { SymbolInfo } from '../intelligence/tree-sitter/queries.js';
import {
  buildGitignoreMatcher,
  collectGlobFiles,
  createFindDiagnostics,
  isBinary,
  readTextFile,
} from '../tools/find/shared.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One chunk of source: either a top-level tree-sitter symbol or a fixed-size line window. */
export interface CodeChunk {
  readonly chunkId: string;
  readonly path: string;
  readonly lang: string;
  readonly symbol: string;
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contentHash: string;
  readonly mtimeMs: number;
  readonly fileHash: string;
}

/** How a file's chunks were produced. 'window' means "never silently dropped" fell back to fixed-size windows. */
export type CodeChunkMode = 'symbols' | 'window' | 'empty' | 'unchanged';

/** Honest per-build skip/degrade counters — every excluded or fallback file is counted, never silently dropped. */
export interface CodeIndexSkipReport {
  readonly tooLarge: number;
  readonly overCap: number;
  readonly binary: number;
  readonly ignoredByGitignore: number;
  readonly readErrors: number;
  readonly chunkedByWindow: number;
}

export interface CodeIndexBuildStats {
  readonly filesScanned: number;
  readonly filesIndexed: number;
  readonly filesUnchanged: number;
  readonly chunksIndexed: number;
  readonly filesRemoved: number;
  readonly skip: CodeIndexSkipReport;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
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
  readonly building: boolean;
  readonly lastBuild: CodeIndexBuildStats | null;
  readonly error?: string | undefined;
}

/** A single search hit: the matched chunk plus its distance/similarity and an honest retrieval-quality label. */
export interface CodeContextResult {
  readonly chunk: CodeChunk;
  readonly distance: number;
  readonly similarity: number;
  /** 'lexical' when the active embedding provider is the deterministic hashed fallback (low precision, stated once). */
  readonly label: 'semantic' | 'lexical';
}

export interface CodeIndexOptions {
  /** Maximum number of files walked per build. Default 5000. */
  readonly maxFiles?: number | undefined;
  /** Files larger than this are skipped and counted as `tooLarge`. Default 512KB. */
  readonly maxFileBytes?: number | undefined;
  /** Cumulative byte budget for one build; once exceeded, remaining files count as `overCap`. Default 256MB. */
  readonly maxTotalBytes?: number | undefined;
  /** Fallback window size (lines) for unsupported/parse-failed/symbol-less files. Default 60. */
  readonly windowLines?: number | undefined;
  /** Overlap (lines) between consecutive fallback windows. Default 10. */
  readonly windowOverlapLines?: number | undefined;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

type ChunkRow = {
  rowid: number;
  chunk_id: string;
  path: string;
  lang: string;
  symbol: string;
  kind: string;
  start_line: number;
  end_line: number;
  content_hash: string;
  mtime: number;
  file_hash: string;
};

type VectorRow = {
  rowid: number;
  chunk_id: string;
  distance: number;
};

interface DraftChunk {
  readonly chunk: CodeChunk;
  readonly embedText: string;
}

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_WINDOW_LINES = 60;
const DEFAULT_WINDOW_OVERLAP_LINES = 10;
/** Languages extractSymbols() actually understands (tree-sitter/queries.ts extractSymbols). Everything else always falls back to windowed chunking. */
const SYMBOL_SUPPORTED_LANGS = new Set(['typescript', 'tsx', 'javascript', 'python']);

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

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
      this.createSchema();
    } catch (err) {
      this.close();
      this.available = false;
      this.error = summarizeError(err);
      logger.warn('Code index unavailable', { backend: 'sqlite-vec', error: this.error });
    }
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    this.available = false;
  }

  /**
   * Re-root the store to a new working directory + db path (workspace swap).
   * Closes existing handles, reopens at the new path, and clears in-memory
   * build state. Does NOT re-trigger a build — the caller decides when to
   * call scheduleBuild()/buildFull() again, exactly as it decided to open the
   * store originally.
   */
  async reroot(newRootDir: string, newDbPath: string): Promise<void> {
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

  stats(): CodeIndexStats {
    const provider = this.embeddingRegistry.getDefaultProviderOrNull();
    return {
      backend: 'sqlite-vec',
      enabled: this.available,
      available: this.available,
      path: this.dbPath,
      dimensions: MEMORY_VECTOR_DIMS,
      indexedFiles: this.countIndexedFiles(),
      indexedChunks: this.countIndexedChunks(),
      embeddingProviderId: provider?.id ?? this.embeddingRegistry.getDefaultProviderId(),
      embeddingProviderLabel: provider?.label ?? `Unregistered (${this.embeddingRegistry.getDefaultProviderId()})`,
      semanticRetrievalAvailable: this.hasSemanticProvider(),
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
      const chunk = this.getChunkById(row.chunk_id);
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
      this.building = true;
      this.buildStartedAtMs = Date.now();
      this.progress = { scanned: 0, total: 0 };
      this.buildPromise = this.runBuild().finally(() => {
        this.building = false;
        this.buildStartedAtMs = null;
        this.buildPromise = null;
        this.progress = null;
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
    const rel = relative(this.rootDir, absPath);
    if (rel.startsWith('..')) return { indexed: false, mode: 'empty' };

    const diagnostics = createFindDiagnostics();
    const gitignoreMatcher = buildGitignoreMatcher(join(this.rootDir, '.gitignore'), diagnostics);
    if (gitignoreMatcher && gitignoreMatcher(rel)) {
      this.deleteChunksForPath(rel);
      return { indexed: false, mode: 'empty' };
    }

    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      this.deleteChunksForPath(rel);
      return { indexed: false, mode: 'empty' };
    }

    const maxFileBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (stat.size > maxFileBytes) return { indexed: false, mode: 'empty' };
    if (await isBinary(absPath, diagnostics)) return { indexed: false, mode: 'empty' };

    const text = await readTextFile(absPath, diagnostics);
    if (text === null) return { indexed: false, mode: 'empty' };

    const outcome = await this.indexFileContent(rel, absPath, text, stat.mtimeMs);
    return { indexed: outcome.indexed, mode: outcome.mode };
  }

  // ── Build internals ──────────────────────────────────────────────────────

  private async runBuild(): Promise<CodeIndexBuildStats> {
    const startedAt = Date.now();
    const diagnostics = createFindDiagnostics();
    const maxFiles = this.options.maxFiles ?? DEFAULT_MAX_FILES;
    const maxFileBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxTotalBytes = this.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

    const skip = {
      tooLarge: 0,
      overCap: 0,
      binary: 0,
      ignoredByGitignore: 0,
      readErrors: 0,
      chunkedByWindow: 0,
    };

    const gitignoreMatcher = buildGitignoreMatcher(join(this.rootDir, '.gitignore'), diagnostics);
    const scanned = await collectGlobFiles(this.rootDir, ['**/*'], false, false, diagnostics);
    // Deterministic order so identical trees always chunk identically (chunking determinism test).
    const candidateFiles = Array.from(scanned).sort();

    const keepPaths = new Set<string>();
    let filesIndexed = 0;
    let filesUnchanged = 0;
    let chunksIndexed = 0;
    let totalBytes = 0;
    let acceptedCount = 0;

    for (const absPath of candidateFiles) {
      const rel = relative(this.rootDir, absPath);
      if (gitignoreMatcher && gitignoreMatcher(rel)) {
        skip.ignoredByGitignore++;
        continue;
      }

      if (acceptedCount >= maxFiles) {
        skip.overCap++;
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
        skip.overCap++;
        continue;
      }
      if (await isBinary(absPath, diagnostics)) {
        skip.binary++;
        continue;
      }

      const text = await readTextFile(absPath, diagnostics);
      if (text === null) {
        skip.readErrors++;
        continue;
      }

      acceptedCount++;
      totalBytes += stat.size;
      keepPaths.add(rel);

      const outcome = await this.indexFileContent(rel, absPath, text, stat.mtimeMs);
      if (outcome.mode === 'window') skip.chunkedByWindow++;
      if (outcome.mode === 'unchanged') filesUnchanged++;
      else if (outcome.indexed) filesIndexed++;
      chunksIndexed += outcome.chunkCount;

      this.progress = { scanned: acceptedCount, total: candidateFiles.length };
      if (acceptedCount % 20 === 0) await yieldToEventLoop();
    }

    // Sweep: a file that no longer exists (deleted, renamed, or newly gitignored) loses its chunks.
    let filesRemoved = 0;
    for (const path of this.listIndexedPaths()) {
      if (!keepPaths.has(path)) {
        this.deleteChunksForPath(path);
        filesRemoved++;
      }
    }

    const completedAt = Date.now();
    const stats: CodeIndexBuildStats = {
      filesScanned: candidateFiles.length,
      filesIndexed,
      filesUnchanged,
      chunksIndexed,
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
   * Index one file's content. Short-circuits on an unchanged file_hash (no
   * re-chunk, no re-embed) — the "content_hash stable across re-index of
   * unchanged file" contract.
   */
  private async indexFileContent(
    relPath: string,
    absPath: string,
    content: string,
    mtimeMs: number,
  ): Promise<{ indexed: boolean; mode: CodeChunkMode; chunkCount: number }> {
    const fileHash = sha256(content);
    const existingHash = this.getFileHash(relPath);
    if (existingHash === fileHash) {
      return { indexed: true, mode: 'unchanged', chunkCount: this.countChunksForPath(relPath) };
    }

    const { drafts, mode } = await this.chunkFile(absPath, relPath, content, fileHash, mtimeMs);
    this.deleteChunksForPath(relPath);
    for (const draft of drafts) {
      const embedding = await this.embedChunkAsync(draft.embedText);
      this.writeChunk(draft.chunk, embedding);
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

  private async chunkFile(
    absPath: string,
    relPath: string,
    content: string,
    fileHash: string,
    mtimeMs: number,
  ): Promise<{ drafts: DraftChunk[]; mode: CodeChunkMode }> {
    if (!content.trim()) return { drafts: [], mode: 'empty' };

    await this.ensureIntelligenceReady();
    const lang = this.intelligence.detectLanguage(absPath) ?? 'unknown';

    let symbols: SymbolInfo[] = [];
    if (SYMBOL_SUPPORTED_LANGS.has(lang)) {
      symbols = await this.intelligence.getSymbols(absPath, content);
    }
    const topLevel = symbols.filter((symbol) => !symbol.container);

    if (topLevel.length > 0) {
      const lines = content.split('\n');
      const drafts = topLevel.map((symbol) => this.makeSymbolChunk(relPath, lang, symbol, lines, fileHash, mtimeMs));
      return { drafts, mode: 'symbols' };
    }

    // Unsupported language, parse failure, or a supported-language file with
    // zero top-level declarations (e.g. a pure re-export barrel) — the index
    // must never silently drop a non-empty file, so it falls back to windows.
    const drafts = this.makeWindowChunks(relPath, lang, content, fileHash, mtimeMs);
    return { drafts, mode: 'window' };
  }

  private makeSymbolChunk(
    relPath: string,
    lang: string,
    symbol: SymbolInfo,
    lines: readonly string[],
    fileHash: string,
    mtimeMs: number,
  ): DraftChunk {
    const startLine = symbol.line;
    const endLine = Math.max(symbol.endLine, symbol.line);
    const slice = lines.slice(Math.max(0, startLine - 1), endLine).join('\n');
    const embedText = `${lang} ${symbol.kind} ${symbol.name}\n${slice}`;
    const contentHash = sha256(embedText);
    const chunkId = sha256(`${relPath}:${startLine}-${endLine}:${contentHash}`);
    return {
      embedText,
      chunk: {
        chunkId,
        path: relPath,
        lang,
        symbol: symbol.name,
        kind: symbol.kind,
        startLine,
        endLine,
        contentHash,
        mtimeMs,
        fileHash,
      },
    };
  }

  private makeWindowChunks(
    relPath: string,
    lang: string,
    content: string,
    fileHash: string,
    mtimeMs: number,
  ): DraftChunk[] {
    const lines = content.split('\n');
    const windowSize = Math.max(1, this.options.windowLines ?? DEFAULT_WINDOW_LINES);
    const overlap = Math.max(0, Math.min(windowSize - 1, this.options.windowOverlapLines ?? DEFAULT_WINDOW_OVERLAP_LINES));
    const step = Math.max(1, windowSize - overlap);

    const drafts: DraftChunk[] = [];
    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(lines.length, start + windowSize);
      const slice = lines.slice(start, end).join('\n');
      if (slice.trim()) {
        const startLine = start + 1;
        const endLine = end;
        const embedText = `${lang} window ${relPath}\n${slice}`;
        const contentHash = sha256(embedText);
        const chunkId = sha256(`${relPath}:${startLine}-${endLine}:${contentHash}`);
        drafts.push({
          embedText,
          chunk: {
            chunkId,
            path: relPath,
            lang,
            symbol: '',
            kind: 'window',
            startLine,
            endLine,
            contentHash,
            mtimeMs,
            fileHash,
          },
        });
      }
      if (end >= lines.length) break;
    }
    return drafts;
  }

  private async embedChunkAsync(text: string): Promise<Float32Array> {
    const result = await this.embeddingRegistry.embedAsync({
      text,
      dimensions: MEMORY_VECTOR_DIMS,
      usage: 'record',
    });
    return normalizeMemoryEmbeddingVector(result.vector, MEMORY_VECTOR_DIMS);
  }

  // ── SQL ──────────────────────────────────────────────────────────────────

  private createSchema(): void {
    if (!this.db) return;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS code_chunks (
        rowid        INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id     TEXT NOT NULL UNIQUE,
        path         TEXT NOT NULL,
        lang         TEXT NOT NULL,
        symbol       TEXT NOT NULL DEFAULT '',
        kind         TEXT NOT NULL DEFAULT '',
        start_line   INTEGER NOT NULL,
        end_line     INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        mtime        INTEGER NOT NULL,
        file_hash    TEXT NOT NULL
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS code_chunks_path_idx ON code_chunks(path)');
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS code_vectors USING vec0(
        embedding float[${MEMORY_VECTOR_DIMS}],
        +chunk_id text
      )
    `);
  }

  private ensureChunkRowId(chunk: CodeChunk): number {
    if (!this.db) throw new Error('Code index is not initialized');
    this.db.query(
      `INSERT OR IGNORE INTO code_chunks
         (chunk_id, path, lang, symbol, kind, start_line, end_line, content_hash, mtime, file_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      chunk.chunkId,
      chunk.path,
      chunk.lang,
      chunk.symbol,
      chunk.kind,
      chunk.startLine,
      chunk.endLine,
      chunk.contentHash,
      chunk.mtimeMs,
      chunk.fileHash,
    );
    const row = this.db.query<{ rowid: number }, [string]>(
      'SELECT rowid FROM code_chunks WHERE chunk_id = ? LIMIT 1',
    ).get(chunk.chunkId);
    if (!row) throw new Error(`Code index row id not found for ${chunk.chunkId}`);
    return Number(row.rowid);
  }

  private writeChunk(chunk: CodeChunk, embedding: Float32Array): void {
    if (!this.db) return;
    const rowid = this.ensureChunkRowId(chunk);
    this.db.query('DELETE FROM code_vectors WHERE rowid = ?').run(rowid);
    this.db.query('INSERT INTO code_vectors (rowid, embedding, chunk_id) VALUES (?, ?, ?)').run(
      rowid,
      embedding,
      chunk.chunkId,
    );
  }

  private deleteChunksForPath(relPath: string): void {
    if (!this.db) return;
    const rows = this.db.query<{ rowid: number }, [string]>(
      'SELECT rowid FROM code_chunks WHERE path = ?',
    ).all(relPath);
    for (const row of rows) {
      this.db.query('DELETE FROM code_vectors WHERE rowid = ?').run(row.rowid);
    }
    this.db.query('DELETE FROM code_chunks WHERE path = ?').run(relPath);
  }

  private getFileHash(relPath: string): string | null {
    if (!this.db) return null;
    const row = this.db.query<{ file_hash: string }, [string]>(
      'SELECT file_hash FROM code_chunks WHERE path = ? LIMIT 1',
    ).get(relPath);
    return row?.file_hash ?? null;
  }

  private getChunkById(chunkId: string): CodeChunk | null {
    if (!this.db) return null;
    const row = this.db.query<ChunkRow, [string]>(
      `SELECT rowid, chunk_id, path, lang, symbol, kind, start_line, end_line, content_hash, mtime, file_hash
         FROM code_chunks WHERE chunk_id = ? LIMIT 1`,
    ).get(chunkId);
    return row ? rowToChunk(row) : null;
  }

  private countChunksForPath(relPath: string): number {
    if (!this.db) return 0;
    const row = this.db.query<{ count: number }, [string]>(
      'SELECT count(*) AS count FROM code_chunks WHERE path = ?',
    ).get(relPath);
    return Number(row?.count ?? 0);
  }

  private countIndexedFiles(): number {
    if (!this.db || !this.available) return 0;
    const row = this.db.query<{ count: number }, []>(
      'SELECT count(DISTINCT path) AS count FROM code_chunks',
    ).get();
    return Number(row?.count ?? 0);
  }

  private countIndexedChunks(): number {
    if (!this.db || !this.available) return 0;
    const row = this.db.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM code_chunks',
    ).get();
    return Number(row?.count ?? 0);
  }

  private listIndexedPaths(): string[] {
    if (!this.db) return [];
    const rows = this.db.query<{ path: string }, []>('SELECT DISTINCT path FROM code_chunks').all();
    return rows.map((row) => row.path);
  }
}

function rowToChunk(row: ChunkRow): CodeChunk {
  return {
    chunkId: row.chunk_id,
    path: row.path,
    lang: row.lang,
    symbol: row.symbol,
    kind: row.kind,
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    contentHash: row.content_hash,
    mtimeMs: Number(row.mtime),
    fileHash: row.file_hash,
  };
}

function emptyBuildStats(): CodeIndexBuildStats {
  const now = Date.now();
  return {
    filesScanned: 0,
    filesIndexed: 0,
    filesUnchanged: 0,
    chunksIndexed: 0,
    filesRemoved: 0,
    skip: { tooLarge: 0, overCap: 0, binary: 0, ignoredByGitignore: 0, readErrors: 0, chunkedByWindow: 0 },
    startedAt: now,
    completedAt: now,
    durationMs: 0,
  };
}
