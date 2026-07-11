// repo_map — a model-invoked, token-budgeted repository map.
//
// STANDING RULE: this is a tool the model CALLS, not passive always-on context
// injection. It returns a ranked outline of the repo (a directory summary plus
// the highest-centrality source files and their top-level exports), prioritized
// by import-graph centrality with file size as a tie-break, and capped to a
// token budget. It reuses the SDK's existing ImportGraph for structure and a
// cheap regex for exports — no tree-sitter, no LLM, no process spawn.
import { statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Tool, ToolDefinition, ToolResult } from '../../types/tools.js';
import { ImportGraph } from '../../intelligence/index.js';
import { estimateTokens } from '../../core/compaction-types.js';
import { summarizeError } from '../../utils/error-display.js';
import { accessRestrictedNote, type ReadAccessFilter } from '../shared/read-access.js';

const DEFAULT_BUDGET_TOKENS = 2_000;
const MIN_BUDGET_TOKENS = 200;
const MAX_BUDGET_TOKENS = 32_000;
const MAX_EXPORTS_PER_FILE = 12;

interface RankedFile {
  readonly rel: string;
  readonly dependents: number;
  readonly bytes: number;
}

/**
 * Extract top-level exported names from source text with a cheap regex. Handles
 * `export const/let/var/function/class/interface/type/enum` (incl. `async`,
 * `default`, `abstract class`) and named re-exports `export { a, b as c }`.
 * Deliberately shallow: this is a map, not a parser.
 */
export function extractTopLevelExports(source: string): string[] {
  const names = new Set<string>();
  const declRe = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    if (m[1]) names.add(m[1]);
  }
  const namedRe = /^\s*export\s*\{([^}]*)\}/gm;
  while ((m = namedRe.exec(source)) !== null) {
    for (const part of (m[1] ?? '').split(',')) {
      const token = part.trim();
      if (!token) continue;
      const asMatch = /\sas\s+([A-Za-z_$][\w$]*)/.exec(token);
      const name = asMatch ? asMatch[1]! : token.split(/\s+/)[0]!;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  if (/^\s*export\s+default\b(?!\s+(?:async\s+)?(?:abstract\s+)?(?:function|class))/m.test(source)) {
    names.add('default');
  }
  return [...names];
}

/** Rank the graph's files by centrality (dependents), then size, then path. */
function rankFiles(relGraph: Record<string, string[]>, root: string): RankedFile[] {
  // Invert the forward import map into a dependent count per file.
  const dependents = new Map<string, number>();
  for (const file of Object.keys(relGraph)) dependents.set(file, 0);
  for (const imports of Object.values(relGraph)) {
    for (const imported of imports) {
      dependents.set(imported, (dependents.get(imported) ?? 0) + 1);
    }
  }
  const ranked: RankedFile[] = [];
  for (const rel of Object.keys(relGraph)) {
    let bytes = 0;
    try { bytes = statSync(resolve(root, rel)).size; } catch { bytes = 0; }
    ranked.push({ rel, dependents: dependents.get(rel) ?? 0, bytes });
  }
  ranked.sort((a, b) =>
    b.dependents - a.dependents ||
    b.bytes - a.bytes ||
    a.rel.localeCompare(b.rel),
  );
  return ranked;
}

/** Summarize files per immediate top-level directory (or '.' for root files). */
function directorySummary(files: readonly RankedFile[]): string[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const dir = f.rel.includes(sep) ? f.rel.split(sep)[0]! : '.';
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([dir, n]) => `  ${dir}/  (${n} source file${n === 1 ? '' : 's'})`);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function clampBudget(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_BUDGET_TOKENS;
  return Math.max(MIN_BUDGET_TOKENS, Math.min(MAX_BUDGET_TOKENS, n));
}

const REPO_MAP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Subdirectory to map, relative to the project root (default: the whole project).',
    },
    budgetTokens: {
      type: 'number',
      description: `Approximate token budget for the map (default ${DEFAULT_BUDGET_TOKENS}, clamped to ${MIN_BUDGET_TOKENS}–${MAX_BUDGET_TOKENS}). Lower budgets return fewer key files.`,
    },
  },
  additionalProperties: false,
};

/**
 * Build the repo_map tool bound to a project root. The tool is read-only and
 * safe to run in parallel.
 */
export function createRepoMapTool(options: {
  projectRoot: string;
  /**
   * Per-file read-permission decision (wired to PermissionManager.previewReadAccess).
   * A restricted file keeps its ranked path line but its exported symbols — which
   * require reading the file — are withheld and the line is flagged.
   */
  readAccessFilter?: ReadAccessFilter;
}): Tool {
  const projectRoot = options.projectRoot;
  const readAccessFilter = options.readAccessFilter;
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
    throw new Error('createRepoMapTool requires projectRoot');
  }

  const definition: ToolDefinition = {
    name: 'repo_map',
    description:
      'Return a token-budgeted map of the repository: a per-directory source-file count plus the '
      + 'highest-centrality source files (ranked by how many other files import them, size as a '
      + 'tie-break) with their top-level exported symbols. Call this to orient in an unfamiliar '
      + 'codebase before reading files. Read-only; covers TypeScript/JavaScript source files.',
    parameters: REPO_MAP_SCHEMA,
    sideEffects: ['read_fs'],
    concurrency: 'parallel',
  };

  async function execute(args: Record<string, unknown>): Promise<Omit<ToolResult, 'callId'>> {
    try {
      const budgetTokens = clampBudget(args['budgetTokens']);
      const rawPath = typeof args['path'] === 'string' ? args['path'].trim() : '';
      const requested = rawPath ? (isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath)) : projectRoot;
      // Keep the scan inside the project root (read-only, but no reason to escape it).
      const root = requested === projectRoot || requested.startsWith(projectRoot + sep) ? requested : projectRoot;

      const graph = new ImportGraph();
      await graph.build(root);
      const relGraph = graph.toRelativeGraph(root);
      const stats = graph.stats();
      const ranked = rankFiles(relGraph, root);

      const header = [
        `# Repository map: ${relative(projectRoot, root) || '.'}`,
        `${stats.files} source file(s), ${stats.edges} import edge(s). Budget: ${budgetTokens} tokens.`,
        '',
        'Directories:',
        ...directorySummary(ranked),
        '',
        'Key files (by import centrality):',
      ].join('\n');

      let output = header;
      let included = 0;
      let restrictedCount = 0;
      for (const file of ranked) {
        const absolute = resolve(root, file.rel);
        let block: string;
        if (readAccessFilter && !readAccessFilter(absolute)) {
          // Read-side deny enforcement: keep the ranked path (existence is not a
          // leak) but withhold the exported symbols, which would require reading
          // the file's content.
          block = `\n  ${file.rel}  (dependents: ${file.dependents}, ${formatBytes(file.bytes)}) [access-restricted]`;
          restrictedCount++;
        } else {
          try {
            const exports = extractTopLevelExports(readFileSync(absolute, 'utf-8')).slice(0, MAX_EXPORTS_PER_FILE);
            const exportsLine = exports.length > 0 ? `\n    exports: ${exports.join(', ')}` : '';
            block = `\n  ${file.rel}  (dependents: ${file.dependents}, ${formatBytes(file.bytes)})${exportsLine}`;
          } catch {
            block = `\n  ${file.rel}  (dependents: ${file.dependents}, ${formatBytes(file.bytes)})`;
          }
        }
        if (estimateTokens(output + block) > budgetTokens) break;
        output += block;
        included++;
      }

      if (included < ranked.length) {
        output += `\n  … ${ranked.length - included} more file(s) omitted to stay within the token budget.`;
      }

      const restrictedNote = accessRestrictedNote(restrictedCount);
      if (restrictedNote) output += `\n\n${restrictedNote} (paths shown, exported symbols withheld).`;

      return { success: true, output };
    } catch (err) {
      return { success: false, error: `repo_map failed: ${summarizeError(err)}` };
    }
  }

  return { definition, execute };
}
