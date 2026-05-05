import { resolve, relative, join } from 'node:path';
import { stat as statAsync } from 'node:fs/promises';
import { statSync, lstatSync, existsSync, readFileSync, realpathSync, readdirSync, type Dirent } from 'node:fs';
import { walkDir, WALK_SKIP_DIRS as SKIP_DIRS } from '../../utils/walk-dir.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';

export type OutputFormat = 'count_only' | 'files_only' | 'locations' | 'matches' | 'context' | 'with_stats' | 'with_preview' | 'signatures' | 'full';
export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant' | 'enum';

export interface QueryBase {
  id: string;
  mode: 'files' | 'content' | 'symbols' | 'references' | 'structural';
  path?: string | undefined;
}

async function statCachedSearchFile(filePath: string): Promise<Awaited<ReturnType<typeof statAsync>> | null> {
  try {
    return await statAsync(filePath);
  } catch {
    return null;
  }
}

export interface FilesQuery extends QueryBase {
  mode: 'files';
  patterns?: string[] | undefined;
  exclude?: string[] | undefined;
  min_size?: number | undefined;
  max_size?: number | undefined;
  modified_after?: string | undefined;
  modified_before?: string | undefined;
  respect_gitignore?: boolean | undefined;
  sort_by?: 'name' | 'size' | 'modified' | undefined;
  sort_order?: 'asc' | 'desc' | undefined;
  has_content?: string | undefined;
  is_empty?: boolean | undefined;
  follow_symlinks?: boolean | undefined;
  include_hidden?: boolean | undefined;
}

export interface ContentQuery extends QueryBase {
  mode: 'content';
  pattern?: string | undefined;
  pattern_base64?: string | undefined;
  glob?: string | undefined;
  case_sensitive?: boolean | undefined;
  whole_word?: boolean | undefined;
  multiline?: boolean | undefined;
  negate?: boolean | undefined;
  ranked?: boolean | undefined;
  preview_replace?: string | undefined;
  relationships?: boolean | undefined;
}

export interface SymbolsQuery extends QueryBase {
  mode: 'symbols';
  query?: string | undefined;
  kinds?: SymbolKind[] | undefined;
  exported_only?: boolean | undefined;
  include_private?: boolean | undefined;
  group_by?: 'file' | 'kind' | 'none' | undefined;
}

export interface ReferencesQuery extends QueryBase {
  mode: 'references';
  symbol: string;
  file: string;
  line: number;
  column: number;
}

export interface StructuralQuery extends QueryBase {
  mode: 'structural';
  pattern: string;
  lang?: 'ts' | 'tsx' | 'js' | 'jsx' | 'css' | 'html' | undefined;
  glob?: string | undefined;
}

export type FindQuery = FilesQuery | ContentQuery | SymbolsQuery | ReferencesQuery | StructuralQuery;

export interface OutputOptions {
  format?: OutputFormat | undefined;
  context_before?: number | undefined;
  context_after?: number | undefined;
  expand_to?: 'line' | 'block' | 'function' | 'class' | undefined;
  max_results?: number | undefined;
  max_per_item?: number | undefined;
  max_total_matches?: number | undefined;
  max_tokens?: number | undefined;
  preview_lines?: number | undefined;
  max_line_length?: number | undefined;
}

export interface FindInput {
  queries: FindQuery[];
  output?: OutputOptions | undefined;
  parallel?: boolean | undefined;
}

type CountResult = { count: number; file_count?: number; source?: string };
type FilesResult = { files: string[]; count: number; source?: string };
type LocationsResult<TLocation> = { locations: TLocation[]; count: number; source?: string };

interface CacheKey {
  pattern: string;
  glob: string;
  path: string;
  flags: string;
}

interface CacheValue {
  files: string[];
  matchedFiles: Map<string, { content: string; matches: ContentMatch[] }>;
  totalMatches: number;
  fileMtimes: Map<string, number>;
}

export interface FindDiagnostics {
  warnings: string[];
}

export interface ContentMatch {
  file: string;
  line: number;
  text: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
  context_before?: string[] | undefined;
  context_after?: string[] | undefined;
}

const MAX_FIND_WARNINGS = 20;

export function createFindDiagnostics(): FindDiagnostics {
  return { warnings: [] };
}

export function addFindWarning(diagnostics: FindDiagnostics | undefined, warning: string): void {
  if (!diagnostics) return;
  if (diagnostics.warnings.includes(warning)) return;
  if (diagnostics.warnings.length < MAX_FIND_WARNINGS) {
    diagnostics.warnings.push(warning);
    return;
  }
  const cappedWarning = `Additional find warnings suppressed after ${MAX_FIND_WARNINGS} entries.`;
  if (!diagnostics.warnings.includes(cappedWarning)) diagnostics.warnings.push(cappedWarning);
}

export function withFindWarnings<T extends Record<string, unknown>>(
  result: T,
  warnings: readonly string[],
): T {
  if (warnings.length === 0) return result;
  const existingWarnings = Array.isArray(result.warnings)
    ? result.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  return {
    ...result,
    warnings: [...existingWarnings, ...warnings],
  } as T;
}

export function makeCountResult(count: number, source?: string, fileCount?: number): CountResult {
  return fileCount !== undefined
    ? { count, file_count: fileCount, ...(source ? { source } : {}) }
    : { count, ...(source ? { source } : {}) };
}

export function makeFilesResult(files: string[], count: number, source?: string): FilesResult {
  return { files, count, ...(source ? { source } : {}) };
}

export function makeLocationsResult<TLocation>(locations: TLocation[], count: number, source?: string): LocationsResult<TLocation> {
  return { locations, count, ...(source ? { source } : {}) };
}

export const VALID_SYMBOL_KINDS = new Set(['function', 'class', 'interface', 'type', 'variable', 'constant', 'enum']);
const BINARY_CHECK_BYTES = 8192;

export function isHiddenOrSkippedSegment(segment: string, includeHidden: boolean): boolean {
  return SKIP_DIRS.has(segment) || (!includeHidden && segment.startsWith('.') && segment !== '.');
}

export function shouldSkipRelativePath(relativePath: string, includeHidden: boolean): boolean {
  return relativePath.split('/').some((segment) => isHiddenOrSkippedSegment(segment, includeHidden));
}

export async function isBinary(filePath: string, diagnostics?: FindDiagnostics): Promise<boolean> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return false;
    const chunk = await file.slice(0, BINARY_CHECK_BYTES).arrayBuffer();
    const bytes = new Uint8Array(chunk);
    for (const byte of bytes) {
      if (byte === 0) return true;
    }
    return false;
  } catch (err) {
    addFindWarning(diagnostics, `Skipped '${filePath}' because binary detection failed: ${summarizeError(err)}`);
    return true;
  }
}

export async function collectTextFiles(dirPath: string, diagnostics?: FindDiagnostics): Promise<string[]> {
  const files: string[] = [];
  for await (const filePath of walkDir(dirPath)) {
    if (!(await isBinary(filePath, diagnostics))) {
      files.push(filePath);
    }
  }
  return files;
}

export async function readTextFile(filePath: string, diagnostics?: FindDiagnostics): Promise<string | null> {
  try {
    return await Bun.file(filePath).text();
  } catch (err) {
    addFindWarning(diagnostics, `Skipped unreadable file '${filePath}': ${summarizeError(err)}`);
    return null;
  }
}

export async function collectGlobFiles(
  basePath: string,
  patterns: string[],
  includeHidden: boolean,
  followSymlinks: boolean,
  diagnostics?: FindDiagnostics,
): Promise<Set<string>> {
  const matchedFiles = new Set<string>();
  const visitedRealPaths = new Set<string>();

  for (const pattern of patterns) {
    let glob: InstanceType<typeof Bun.Glob>;
    try {
      glob = new Bun.Glob(pattern);
    } catch (err) {
      addFindWarning(diagnostics, `Skipped invalid glob pattern '${pattern}': ${summarizeError(err)}`);
      continue;
    }

    try {
      for await (const file of glob.scan({ cwd: basePath, onlyFiles: true, absolute: true, followSymlinks })) {
        if (followSymlinks) {
          try {
            const real = realpathSync(file);
            if (visitedRealPaths.has(real)) continue;
            visitedRealPaths.add(real);
          } catch (err) {
            addFindWarning(diagnostics, `Skipped '${file}' because symlink resolution failed: ${summarizeError(err)}`);
            continue;
          }
        }

        const rel = relative(basePath, file);
        if (shouldSkipRelativePath(rel, includeHidden)) continue;
        matchedFiles.add(file);
      }
    } catch (err) {
      addFindWarning(diagnostics, `Glob scan failed for pattern '${pattern}': ${summarizeError(err)}`);
    }
  }

  return matchedFiles;
}

export function matchesGlob(glob: InstanceType<typeof Bun.Glob>, filePath: string, basePath: string): boolean {
  const rel = relative(basePath, filePath);
  return glob.match(rel) || glob.match(filePath);
}

export function toSymbolKind(kind: string | undefined): SymbolKind {
  const kindMap: Record<string, SymbolKind> = {
    method: 'function',
    property: 'variable',
    namespace: 'variable',
  };
  const mappedKind = (kindMap[kind ?? ''] ?? kind ?? 'variable') as SymbolKind;
  return VALID_SYMBOL_KINDS.has(mappedKind) ? mappedKind : 'variable';
}

export function matchesSymbolQuery(name: string, queryRegex: RegExp | null): boolean {
  return queryRegex ? queryRegex.test(name) : true;
}

export async function loadFileLines(filePath: string): Promise<string[]> {
  const raw = await readTextFile(filePath);
  return raw === null ? [] : raw.split('\n');
}

export function groupByKey<T extends { file: string; kind: string }>(
  items: T[],
  groupBy: 'file' | 'kind' | 'none',
): Record<string, T[]> | null {
  if (groupBy === 'none') return null;
  const grouped: Record<string, T[]> = {};
  for (const item of items) {
    const key = groupBy === 'file' ? item.file : item.kind;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  }
  return grouped;
}

export function validateSearchPath(
  path: string | undefined,
  projectRoot: string,
): string | { error: string } {
  const resolved = path ? resolve(projectRoot, path) : projectRoot;
  if (!resolved.startsWith(projectRoot + '/') && resolved !== projectRoot) {
    return { error: `Path '${path}' resolves outside the project root.` };
  }
  return resolved;
}

export function buildGitignoreMatcher(gitignorePath: string, diagnostics?: FindDiagnostics): ((rel: string) => boolean) | null {
  if (!existsSync(gitignorePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(gitignorePath, 'utf8');
  } catch (err) {
    addFindWarning(diagnostics, `Could not read root .gitignore '${gitignorePath}': ${summarizeError(err)}`);
    return null;
  }

  interface GitignoreRule { negate: boolean; glob: InstanceType<typeof Bun.Glob> }
  const rules: GitignoreRule[] = [];

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let negate = false;
    let pat = line;
    if (pat.startsWith('!')) {
      negate = true;
      pat = pat.slice(1);
    }
    if (pat.endsWith('/')) pat = pat.slice(0, -1);
    if (!pat.includes('/')) pat = `**/${pat}`;
    else if (pat.startsWith('/')) pat = pat.slice(1);

    try {
      rules.push({ negate, glob: new Bun.Glob(pat) });
    } catch (err) {
      addFindWarning(diagnostics, `Skipped malformed .gitignore pattern '${line}': ${summarizeError(err)}`);
    }
  }

  if (rules.length === 0) return null;

  return (rel: string): boolean => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.glob.match(rel)) {
        ignored = !rule.negate;
      }
    }
    return ignored;
  };
}

export function findNestedGitignoreFiles(basePath: string, rootGitignorePath: string): string[] {
  const nested: string[] = [];
  const maxNested = 5;

  const visit = (dir: string): void => {
    if (nested.length >= maxNested) return;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (nested.length >= maxNested) return;
      if (SKIP_DIRS.has(entry.name)) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && entry.name === '.gitignore' && full !== rootGitignorePath) {
        nested.push(full);
      }
    }
  };

  visit(basePath);
  return nested;
}

export async function collectFilesForSearch(
  basePath: string,
  queryGlob: string | undefined,
  diagnostics?: FindDiagnostics,
): Promise<string[]> {
  if (!queryGlob) {
    return collectTextFiles(basePath, diagnostics);
  }
  return Array.from(await collectGlobFiles(basePath, [queryGlob], false, false, diagnostics));
}

const SEARCH_CACHE_MAX = 50;
const IMPORT_GRAPH_TTL = 30_000;

function makeSearchCacheKey(key: CacheKey): string {
  return JSON.stringify([key.pattern, key.glob, key.path, key.flags]);
}

export interface ImportGraphLike {
  findImports(file: string): string[];
  findDependents(file: string): string[];
  getWarnings?(): string[];
}

export class FindRuntimeService {
  private readonly searchCache = new Map<string, { value: CacheValue; accessedAt: number }>();
  private importGraph: ImportGraphLike | null = null;
  private importGraphBuiltAt = 0;

  searchCacheGet(key: CacheKey): CacheValue | null {
    const cacheKey = makeSearchCacheKey(key);
    const entry = this.searchCache.get(cacheKey);
    if (!entry) return null;
    entry.accessedAt = Date.now();
    return entry.value;
  }

  searchCacheSet(key: CacheKey, value: CacheValue): void {
    const cacheKey = makeSearchCacheKey(key);
    if (this.searchCache.size >= SEARCH_CACHE_MAX && !this.searchCache.has(cacheKey)) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [candidateKey, candidateValue] of this.searchCache) {
        if (candidateValue.accessedAt < oldestTime) {
          oldestTime = candidateValue.accessedAt;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey) this.searchCache.delete(oldestKey);
    }
    this.searchCache.set(cacheKey, { value, accessedAt: Date.now() });
  }

  async searchCacheIsValid(cached: CacheValue): Promise<boolean> {
    const entries = Array.from(cached.fileMtimes.entries());
    const stats = await Promise.all(entries.map(([filePath]) => statCachedSearchFile(filePath)));
    for (let i = 0; i < entries.length; i++) {
      const stat = stats[i]!;
      if (!stat || stat.mtimeMs !== entries[i]![1]) return false;
    }
    return true;
  }

  async getImportGraph(projectRoot: string): Promise<ImportGraphLike> {
    const now = Date.now();
    if (this.importGraph !== null && now - this.importGraphBuiltAt <= IMPORT_GRAPH_TTL) {
      return this.importGraph;
    }
    const { ImportGraph } = await import('../../intelligence/import-graph.js');
    const graph = new ImportGraph() as ImportGraphLike & {
      build(projectRoot: string): Promise<void>;
    };
    try {
      await graph.build(projectRoot);
    } catch (err) {
      const warning = `Import graph build failed; relationship results may be incomplete: ${summarizeError(err)}`;
      logger.warn('[find] Import graph build failed', { projectRoot, error: summarizeError(err) });
      const degradedGraph = {
        findImports: (file: string) => graph.findImports(file),
        findDependents: (file: string) => graph.findDependents(file),
        getWarnings: () => [
          warning,
          ...(graph.getWarnings?.() ?? []),
        ],
      } satisfies ImportGraphLike;
      this.importGraph = degradedGraph;
      this.importGraphBuiltAt = now;
      return degradedGraph;
    }
    this.importGraph = graph;
    this.importGraphBuiltAt = now;
    return graph;
  }
}
