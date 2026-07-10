import { existsSync, readFileSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { logger } from './logger.js';
import { summarizeError } from './error-display.js';

/**
 * Read a prompt file, resolving `@path/to/file` includes recursively.
 * Missing files, unreadable files, circular includes, and depth-limited
 * includes are skipped and logged.
 * Max include depth: 5 (depths 0-4 inclusive; depth >= 5 returns '').
 *
 * The `visited` Set is intentionally shared across all recursive calls
 * within one top-level invocation. This means a file included from one
 * branch is never re-included from a sibling branch, preventing duplicate
 * content and infinite loops across non-trivially circular graphs.
 */
export function readPromptFile(
  filePath: string,
  visited?: Set<string>,
  depth?: number,
): string {
  const maxDepth = 5;
  const currentDepth = depth ?? 0;
  const seen = visited ?? new Set<string>();
  const resolved = resolve(filePath);

  // Fix #3: >= maxDepth so depths 0-4 are valid (5 levels of nesting)
  if (currentDepth >= maxDepth) {
    logger.debug('System prompt include skipped because max depth was reached', {
      path: resolved,
      depth: currentDepth,
      maxDepth,
    });
    return '';
  }

  if (seen.has(resolved)) {
    logger.debug('System prompt include skipped because it was already visited', { path: resolved });
    return '';
  }
  seen.add(resolved);

  let content: string;
  try {
    content = readFileSync(resolved, 'utf-8');
  } catch (err) {
    // Fix #5: distinguish ENOENT (expected miss) from other errors (unexpected)
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      logger.debug('System prompt file not found', { path: resolved });
    } else {
      logger.error('Failed to read system prompt file', { path: resolved, error: summarizeError(err) });
    }
    return '';
  }

  // Process @ includes
  const baseDir = dirname(resolved);
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('@') && !trimmed.startsWith('@@')) {
      // @ include directive — resolve and inline the referenced file
      const includePath = trimmed.slice(1).trim();
      if (includePath) {
        const includeResolved = resolve(baseDir, includePath);
        const included = readPromptFile(includeResolved, seen, currentDepth + 1);
        if (included) result.push(included);
      }
    } else {
      // Fix #1: unescape @@ to literal @ (preserving leading whitespace)
      const atIdx = line.indexOf('@@');
      if (trimmed.startsWith('@@') && atIdx >= 0) {
        result.push(line.slice(0, atIdx) + line.slice(atIdx + 1));
      } else {
        result.push(line);
      }
    }
  }

  return result.join('\n');
}

/**
 * Load system prompt by chain-loading SYSTEM.md + global + project GOODVIBES.md files.
 *
 * @param getConfigPath Optional injector for the config-specified systemPromptFile path.
 *                      Defaults to reading from configManager (used in production).
 */
export interface LoadSystemPromptOptions {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly getConfigPath?: (() => string | undefined) | undefined;
  readonly argv?: readonly string[] | undefined;
}

/**
 * Which instruction file a loaded chain segment came from.
 *
 *  - `cli`     — an explicit `--system-prompt-file` argument (exclusive path)
 *  - `base`    — `~/.goodvibes/SYSTEM.md`
 *  - `global`  — `~/.goodvibes/GOODVIBES.md`
 *  - `agents`  — the nearest `AGENTS.md` walking up from the working directory
 *  - `project` — `<workingDirectory>/.goodvibes/GOODVIBES.md`
 *  - `config`  — the `provider.systemPromptFile` config value
 */
export type PromptSourceKind = 'cli' | 'base' | 'global' | 'agents' | 'project' | 'config';

/** One instruction file that actually contributed content to the system prompt. */
export interface PromptSource {
  readonly kind: PromptSourceKind;
  /** Absolute path of the file that was read. */
  readonly path: string;
}

/** The assembled system prompt plus the provenance of every file that fed it. */
export interface SystemPromptResult {
  readonly prompt: string;
  /** Loaded instruction files, in the order they were concatenated. */
  readonly sources: readonly PromptSource[];
}

/**
 * Walk from `startDir` upward toward the filesystem root and return the path of
 * the nearest `AGENTS.md` (nearest-file-wins). Returns `null` when none is
 * found on the way up. The walk stops at the root (when `dirname(dir) === dir`)
 * so it always terminates.
 */
export function findNearestAgentsFile(startDir: string): string | null {
  let current = resolve(startDir);
  // Bounded by the filesystem depth: dirname eventually fixes at the root.
  for (;;) {
    const candidate = join(current, 'AGENTS.md');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Load the system prompt chain and report the provenance of every file that
 * contributed. See {@link loadSystemPrompt} for the plain-string variant.
 *
 * Layering (each present, non-empty file is concatenated in this order):
 *   1. `--system-prompt-file` CLI arg — exclusive; when set and readable it is
 *      the only source.
 *   2. `~/.goodvibes/SYSTEM.md`
 *   3. `~/.goodvibes/GOODVIBES.md`
 *   4. nearest `AGENTS.md` (walking up from the working directory) — a
 *      convention fallback/addition. It is placed BEFORE the project's own
 *      `GOODVIBES.md` so the project-specific file keeps precedence (it is
 *      concatenated later, and later sources win in the append order).
 *   5. `<workingDirectory>/.goodvibes/GOODVIBES.md`
 *   6. `provider.systemPromptFile` (appended last)
 */
export function loadSystemPromptWithSources(
  options: LoadSystemPromptOptions,
): SystemPromptResult {
  const parts: string[] = [];
  const sources: PromptSource[] = [];
  const argv = options.argv ?? process.argv;

  const add = (kind: PromptSourceKind, path: string, content: string): void => {
    parts.push(content);
    sources.push({ kind, path: resolve(path) });
  };

  // 1. CLI arg override — exclusive, does not chain with other sources
  const argIdx = argv.indexOf('--system-prompt-file');
  if (argIdx !== -1 && argv[argIdx + 1]) {
    const cliPath = argv[argIdx + 1]!;
    const content = readPromptFile(cliPath);
    if (content) {
      return { prompt: content, sources: [{ kind: 'cli', path: resolve(cliPath) }] };
    }
  }

  // 2. ~/.goodvibes/SYSTEM.md (base)
  const basePath = join(options.homeDirectory, '.goodvibes', 'SYSTEM.md');
  const systemContent = readPromptFile(basePath);
  if (systemContent) add('base', basePath, systemContent);

  // 3. ~/.goodvibes/GOODVIBES.md (global extensions)
  const globalPath = join(options.homeDirectory, '.goodvibes', 'GOODVIBES.md');
  const globalContent = readPromptFile(globalPath);
  if (globalContent) add('global', globalPath, globalContent);

  // 4. Nearest AGENTS.md (nearest-file-wins upward from the working directory).
  //    Additive convention fallback; placed before the project GOODVIBES.md so
  //    the project's own instruction file keeps precedence.
  const agentsPath = findNearestAgentsFile(options.workingDirectory);
  if (agentsPath) {
    const agentsContent = readPromptFile(agentsPath);
    if (agentsContent) add('agents', agentsPath, agentsContent);
  }

  // 5. .goodvibes/GOODVIBES.md (project)
  const projectPath = join(options.workingDirectory, '.goodvibes', 'GOODVIBES.md');
  const projectContent = readPromptFile(projectPath);
  if (projectContent) add('project', projectPath, projectContent);

  // 6. Config-specified file (additional, appended last)
  const configPath = options.getConfigPath?.();
  if (typeof configPath === 'string' && configPath) {
    const configContent = readPromptFile(configPath);
    if (configContent) add('config', configPath, configContent);
  }

  return { prompt: parts.join('\n\n'), sources };
}

/**
 * Load system prompt by chain-loading SYSTEM.md + global + nearest AGENTS.md +
 * project GOODVIBES.md files. Returns the concatenated prompt string.
 *
 * @param getConfigPath Optional injector for the config-specified systemPromptFile path.
 *                      Defaults to reading from configManager (used in production).
 */
export function loadSystemPrompt(
  options: LoadSystemPromptOptions,
): string {
  return loadSystemPromptWithSources(options).prompt;
}
