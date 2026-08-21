import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { logger } from '../../utils/logger.js';
import { loadOptionalDependency } from '../../utils/optional-dependency.js';
import {
  collectMarkdownReferences,
  extractMarkdownPreview,
  normalizeFrontmatterList,
  parseMarkdownFrontmatter,
  readMarkdownDisclosure,
  materializeMarkdownBody,
} from '../../utils/markdown-disclosure.js';
import type { Tool, ToolDefinition } from '../../types/tools.js';
import type { ToolRegistry } from '../registry.js';
import { REGISTRY_TOOL_SCHEMA } from './schema.js';
import { toRecord } from '../../utils/record-coerce.js';
import type { RegistryInput } from './schema.js';
import { summarizeError } from '../../utils/error-display.js';

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) result[key.trim()] = rest.join(':').trim();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Directory scanning helpers
// ---------------------------------------------------------------------------

interface RegistryMatch {
  name: string;
  type: 'skill' | 'agent' | 'tool';
  description: string;
  path: string;
  preview?: string | undefined;
  dependencies?: string[] | undefined;
  includes?: string[] | undefined;
  sections?: string[] | undefined;
}

export interface RegistryToolRoots {
  readonly workingDirectory: string;
  readonly homeDirectory?: string | undefined;
}

async function scanDirectory(
  dir: string,
  itemType: 'skill' | 'agent',
  query: string,
): Promise<FuzzyFilterOutcome> {
  if (!existsSync(dir)) return { items: [] };
  const all = scanDirectoryAll(dir, itemType);
  if (!query) return { items: all };
  return await fuzzyFilter(all, query);
}

function scanDirectoryAll(
  dir: string,
  itemType: 'skill' | 'agent',
): RegistryMatch[] {
  if (!existsSync(dir)) return [];
  const results: RegistryMatch[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    // Strategy 1: flat .md file (e.g., skills/foo.md)
    if (entry.endsWith('.md')) {
      const filePath = join(dir, entry);
      let content = '';
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);
      const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : entry.replace(/\.md$/, '');
      const description = typeof frontmatter['description'] === 'string' ? frontmatter['description'] : '';
      results.push({
        name,
        type: itemType,
        description,
        path: filePath,
        preview: extractMarkdownPreview(body),
        dependencies: normalizeFrontmatterList(frontmatter['depends_on']),
        includes: collectMarkdownReferences(body),
      });
      continue;
    }

    // Strategy 2: directory with SKILL.md or AGENT.md (e.g., skills/foo/SKILL.md)
    const markerFile = itemType === 'skill' ? 'SKILL.md' : 'AGENT.md';
    const markerPath = join(dir, entry, markerFile);
    if (existsSync(markerPath)) {
      let content = '';
      try {
        content = readFileSync(markerPath, 'utf-8');
      } catch {
        continue;
      }
      const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);
      const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : entry;
      const description = typeof frontmatter['description'] === 'string' ? frontmatter['description'] : '';
      results.push({
        name,
        type: itemType,
        description,
        path: markerPath,
        preview: extractMarkdownPreview(body),
        dependencies: normalizeFrontmatterList(frontmatter['depends_on']),
        includes: collectMarkdownReferences(body),
      });
    }
  }
  return results;
}

/** A filtered list, plus the reason it was filtered the lesser way. */
interface FuzzyFilterOutcome {
  readonly items: RegistryMatch[];
  readonly degradedReason?: string;
}

/**
 * Fuzzy-filter a list of RegistryMatch items using Fuse.js.
 * Weights: name (3) > path/filename (2) > description (1).
 * Results are sorted by ascending Fuse score (lower = better match).
 *
 * `fuse.js` is an optionalDependency, so it is reached through a dynamic
 * import at the moment a query needs it rather than at module init, a static
 * import of an optional package takes down every graph that reaches this
 * module when the package is absent, which for this one includes the daemon
 * (see utils/optional-dependency.ts for the measured failure). Without it the
 * search still answers, by exact substring, and says which ranking it used.
 */
async function fuzzyFilter(items: RegistryMatch[], query: string): Promise<FuzzyFilterOutcome> {
  if (!query || items.length === 0) return { items };
  const loaded = await loadOptionalDependency('fuse.js', () => import('fuse.js'));
  if (!loaded.available) {
    const needle = query.toLowerCase();
    const substring = items.filter((item) => (
      `${item.name} ${item.path} ${item.description}`.toLowerCase().includes(needle)
    ));
    return {
      items: substring,
      degradedReason: `Ranked by exact substring instead of fuzzy match: ${loaded.reason}`,
    };
  }
  const Fuse = loaded.module.default;
  const fuse = new Fuse(items, {
    keys: [
      { name: 'name', weight: 3 },
      { name: 'path', weight: 2 },
      { name: 'description', weight: 1 },
    ],
    threshold: 0.4,
    includeScore: true,
    minMatchCharLength: 1,
  });
  return { items: fuse.search(query).map((r) => r.item) };
}

function getSkillDirs(roots: RegistryToolRoots): string[] {
  const dirs = [
    join(roots.workingDirectory, '.goodvibes', 'skills'),
  ];
  if (roots.homeDirectory) {
    dirs.push(
      join(roots.homeDirectory, '.goodvibes', 'skills'),
    );
  }
  return dirs;
}

function getAgentDirs(roots: RegistryToolRoots): string[] {
  const dirs = [
    join(roots.workingDirectory, '.goodvibes', 'agents'),
  ];
  if (roots.homeDirectory) {
    dirs.push(
      join(roots.homeDirectory, '.goodvibes', 'agents'),
    );
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the `registry` tool bound to the given ToolRegistry.
 *
 * Returns a Tool object conforming to the Tool interface.
 * Never throws from execute().
 */
export function createRegistryTool(toolRegistry: ToolRegistry, roots: RegistryToolRoots): Tool {
  const definition: ToolDefinition = {
    name: 'registry',
    description:
      'Discover and inspect skills, agents, and tools.'
      + ' Modes: search finds items by keyword; recommend lists items sorted by relevance;'
      + ' dependencies reads a skill\'s dependency chain; content returns full markdown file.',
    parameters: toRecord(REGISTRY_TOOL_SCHEMA),
    sideEffects: ['read_fs'],
    concurrency: 'parallel',
  };

  async function execute(
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      if (!args.mode || typeof args.mode !== 'string') {
        return { success: false, error: 'Missing required "mode" field' };
      }
      const input = args as unknown as RegistryInput;
      const { mode } = input;

      switch (mode) {
        case 'search':       return runSearch(input, toolRegistry, roots);
        case 'recommend':    return runRecommend(input, toolRegistry, roots);
        case 'dependencies': return runDependencies(input, roots);
        case 'preview':      return runPreview(input, roots);
        case 'content':      return runContent(input, roots);
        default: {
          return { success: false, error: `Unknown mode: ${String(mode)}` };
        }
      }
    } catch (err) {
      const message = summarizeError(err);
      logger.error('registry tool: unexpected error', { error: message });
      return { success: false, error: `Unexpected error: ${message}` };
    }
  }

  return { definition, execute };
}

// ---------------------------------------------------------------------------
// Mode handlers
// ---------------------------------------------------------------------------

async function runSearch(
  input: RegistryInput,
  toolRegistry: ToolRegistry,
  roots: RegistryToolRoots,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const query = input.query ?? '';
  let degradedReason: string | undefined;
  const typeFilter = input.type ?? 'all';
  const matches: RegistryMatch[] = [];

  if (typeFilter === 'skills' || typeFilter === 'all') {
    for (const dir of getSkillDirs(roots)) {
      const scanned = await scanDirectory(dir, 'skill', query);
      degradedReason ??= scanned.degradedReason;
      matches.push(...scanned.items);
    }
  }

  if (typeFilter === 'agents' || typeFilter === 'all') {
    for (const dir of getAgentDirs(roots)) {
      const scanned = await scanDirectory(dir, 'agent', query);
      degradedReason ??= scanned.degradedReason;
      matches.push(...scanned.items);
    }
  }

  if (typeFilter === 'tools' || typeFilter === 'all') {
    const allTools: RegistryMatch[] = toolRegistry.list().map((t) => ({
      name: t.definition.name,
      type: 'tool' as const,
      description: t.definition.description,
      path: '',
    }));
    if (query) {
      const filtered = await fuzzyFilter(allTools, query);
      degradedReason = filtered.degradedReason;
      matches.push(...filtered.items);
    } else {
      matches.push(...allTools);
    }
  }

  // Deduplicate: project-local entries override global (first seen wins)
  const seen = new Set<string>();
  const deduped = matches.filter((r) => {
    const key = `${r.type}:${r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    success: true,
    output: JSON.stringify({
      mode: 'search',
      query,
      count: deduped.length,
      results: deduped,
      ...(degradedReason ? { warning: degradedReason } : {}),
    }),
  };
}

async function runRecommend(
  input: RegistryInput,
  toolRegistry: ToolRegistry,
  roots: RegistryToolRoots,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const task = input.task ?? '';
  let degradedReason: string | undefined;
  const scope = input.scope ?? 'skills';
  const lowerTask = task.toLowerCase();

  let candidates: RegistryMatch[];

  if (scope === 'tools') {
    candidates = toolRegistry.list().map((t) => ({
      name: t.definition.name,
      type: 'tool' as const,
      description: t.definition.description,
      path: '',
    }));
  } else {
    candidates = [];
    for (const dir of getSkillDirs(roots)) {
      candidates.push(...scanDirectoryAll(dir, 'skill'));
    }
    // Deduplicate: project-local entries override global (first seen wins)
    const seen = new Set<string>();
    candidates = candidates.filter((r) => {
      const key = `${r.type}:${r.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Use Fuse.js for fuzzy scoring when task is given; otherwise sort alphabetically
  let sorted: RegistryMatch[];
  if (task) {
    const filtered = await fuzzyFilter(candidates, task);
    degradedReason = filtered.degradedReason;
    sorted = filtered.items;
    // For items not matched by fuzzy (below threshold), append alphabetically
    const matchedNames = new Set(sorted.map((r) => `${r.type}:${r.name}`));
    const unmatched = candidates
      .filter((c) => !matchedNames.has(`${c.type}:${c.name}`))
      .sort((a, b) => a.name.localeCompare(b.name));
    sorted = [...sorted, ...unmatched];
  } else {
    // No task, fall back to simple word-overlap scoring.
    const lowerTask2 = lowerTask; // already empty string
    const taskWords = lowerTask2.split(/\s+/).filter(Boolean);
    const scored = candidates.map((item) => {
      const target = `${item.name} ${item.description}`.toLowerCase();
      const score = taskWords.reduce((acc, word) => acc + (target.includes(word) ? 1 : 0), 0);
      return { ...item, score };
    });
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    sorted = scored;
  }

  return {
    success: true,
    output: JSON.stringify({
      mode: 'recommend',
      task,
      scope,
      count: sorted.length,
      results: sorted.map(({ score: _score, ...item }: { score?: number } & RegistryMatch) => item),
      ...(degradedReason ? { warning: degradedReason } : {}),
    }),
  };
}

function runDependencies(
  input: RegistryInput,
  roots: RegistryToolRoots,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const skillName = input.skillName;
  if (!skillName) {
    return Promise.resolve({
      success: false,
      error: 'mode "dependencies" requires "skillName"',
    });
  }

  let filePath: string | null = null;

  for (const dir of getSkillDirs(roots)) {
    const candidate = join(dir, `${skillName}.md`);
    if (existsSync(candidate)) {
      filePath = candidate;
      break;
    }
    // Also try exact match without .md appended (caller may have included extension)
    const candidateExact = join(dir, skillName);
    if (existsSync(candidateExact)) {
      filePath = candidateExact;
      break;
    }
  }

  if (!filePath) {
    return Promise.resolve({
      success: false,
      error: `Skill not found: ${skillName}`,
    });
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return Promise.resolve({
      success: false,
      error: `Failed to read skill file: ${summarizeError(err)}`,
    });
  }

  const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);

  // Parse depends_on: can be a comma-separated string or single name
  const dependencies = normalizeFrontmatterList(frontmatter['depends_on']);
  const includes = collectMarkdownReferences(body);

  return Promise.resolve({
    success: true,
    output: JSON.stringify({
      mode: 'dependencies',
      skillName,
      path: filePath,
      depends_on: dependencies,
      includes,
    }),
  });
}

function runPreview(
  input: RegistryInput,
  roots: RegistryToolRoots,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const resolvedPath = resolveRegistryPath(input.path, roots);
  if (!resolvedPath.ok) return Promise.resolve({ success: false, error: resolvedPath.error });

  try {
    const disclosure = readMarkdownDisclosure(resolvedPath.path);
    return Promise.resolve({
      success: true,
      output: JSON.stringify({
        mode: 'preview',
        path: disclosure.path,
        metadata: disclosure.metadata,
        preview: disclosure.preview,
        includes: disclosure.includes,
        sections: disclosure.sections,
        dependencies: normalizeFrontmatterList(disclosure.metadata['depends_on']),
      }),
    });
  } catch (err) {
    return Promise.resolve({
      success: false,
      error: `Failed to preview file: ${summarizeError(err)}`,
    });
  }
}

function runContent(
  input: RegistryInput,
  roots: RegistryToolRoots,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const resolvedPath = resolveRegistryPath(input.path, roots);
  if (!resolvedPath.ok) return Promise.resolve({ success: false, error: resolvedPath.error });

  return Promise.resolve({
    success: true,
    output: JSON.stringify({
      mode: 'content',
      path: resolvedPath.path,
      metadata: readMarkdownDisclosure(resolvedPath.path).metadata,
      content: materializeMarkdownBody(resolvedPath.path),
    }),
  });
}

function resolveRegistryPath(path: string | undefined, roots: RegistryToolRoots):
  | { ok: true; path: string }
  | { ok: false; error: string } {
  if (!path) {
    return {
      ok: false,
      error: 'mode requires "path"',
    };
  }

  const resolvedPath = isAbsolute(path)
    ? path
    : resolve(roots.workingDirectory, path);

  if (!resolvedPath.includes('.goodvibes/')) {
    return {
      ok: false,
      error: 'mode can only read files within .goodvibes/ directories',
    };
  }

  if (!existsSync(resolvedPath)) {
    return {
      ok: false,
      error: `File not found: ${resolvedPath}`,
    };
  }

  return { ok: true, path: resolvedPath };
}
