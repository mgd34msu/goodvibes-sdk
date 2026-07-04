/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Code-index chunking — pure content → chunk transformation for CodeIndexStore
 * (Wave-5, W5.3 Stage A; extracted from code-index-store.ts to keep that file
 * within the 800-line source discipline).
 *
 * Everything here is side-effect-free with respect to the store: given file
 * content plus a tree-sitter surface (ChunkingIntelligence), produce DraftChunk
 * lists deterministically. The store owns storage, embedding, and lifecycle.
 *
 * Chunking contract (unchanged from the original in-store implementation):
 *  - Files with top-level tree-sitter symbols chunk one-per-symbol ('symbols').
 *  - Unsupported languages, parse failures, and symbol-less files fall back to
 *    fixed-size line windows ('window') — a non-empty file is never silently
 *    dropped.
 *  - Whitespace-only content yields zero chunks ('empty').
 *  - chunk_id is a deterministic function of path + line span + content hash,
 *    so identical trees always chunk identically.
 */

import { createHash } from 'node:crypto';
import type { SymbolInfo } from '../intelligence/tree-sitter/queries.js';

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

/** A chunk plus the exact text its embedding is computed from. */
export interface DraftChunk {
  readonly chunk: CodeChunk;
  readonly embedText: string;
}

/** The minimal tree-sitter surface chunking needs (structural, so tests can fake it). */
export interface ChunkingIntelligence {
  detectLanguage(filePath: string): string | null;
  getSymbols(filePath: string, content: string): Promise<SymbolInfo[]>;
}

export const DEFAULT_WINDOW_LINES = 60;
export const DEFAULT_WINDOW_OVERLAP_LINES = 10;
/** Languages extractSymbols() actually understands (tree-sitter/queries.ts extractSymbols). Everything else always falls back to windowed chunking. */
const SYMBOL_SUPPORTED_LANGS = new Set(['typescript', 'tsx', 'javascript', 'python']);

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface ChunkFileInput {
  readonly intelligence: ChunkingIntelligence;
  readonly absPath: string;
  readonly relPath: string;
  readonly content: string;
  readonly fileHash: string;
  readonly mtimeMs: number;
  readonly windowLines?: number | undefined;
  readonly windowOverlapLines?: number | undefined;
}

/**
 * Chunk one file's content. The caller is responsible for having initialized
 * the intelligence facade (tree-sitter grammars) before calling.
 */
export async function chunkFileContent(
  input: ChunkFileInput,
): Promise<{ drafts: DraftChunk[]; mode: CodeChunkMode }> {
  const { intelligence, absPath, relPath, content, fileHash, mtimeMs } = input;
  if (!content.trim()) return { drafts: [], mode: 'empty' };

  const lang = intelligence.detectLanguage(absPath) ?? 'unknown';

  let symbols: SymbolInfo[] = [];
  if (SYMBOL_SUPPORTED_LANGS.has(lang)) {
    symbols = await intelligence.getSymbols(absPath, content);
  }
  const topLevel = symbols.filter((symbol) => !symbol.container);

  if (topLevel.length > 0) {
    const lines = content.split('\n');
    const drafts = topLevel.map((symbol) => makeSymbolChunk(relPath, lang, symbol, lines, fileHash, mtimeMs));
    return { drafts, mode: 'symbols' };
  }

  // Unsupported language, parse failure, or a supported-language file with
  // zero top-level declarations (e.g. a pure re-export barrel) — the index
  // must never silently drop a non-empty file, so it falls back to windows.
  const drafts = makeWindowChunks(
    relPath,
    lang,
    content,
    fileHash,
    mtimeMs,
    input.windowLines,
    input.windowOverlapLines,
  );
  return { drafts, mode: 'window' };
}

function makeSymbolChunk(
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

function makeWindowChunks(
  relPath: string,
  lang: string,
  content: string,
  fileHash: string,
  mtimeMs: number,
  windowLinesOption?: number | undefined,
  windowOverlapOption?: number | undefined,
): DraftChunk[] {
  const lines = content.split('\n');
  const windowSize = Math.max(1, windowLinesOption ?? DEFAULT_WINDOW_LINES);
  const overlap = Math.max(0, Math.min(windowSize - 1, windowOverlapOption ?? DEFAULT_WINDOW_OVERLAP_LINES));
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
