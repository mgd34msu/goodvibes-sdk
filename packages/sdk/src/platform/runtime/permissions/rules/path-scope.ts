/**
 * Permissions v2, Path scope restriction policy rule evaluator.
 *
 * PathScopeRule matches tool calls that operate on file paths, restricting
 * or allowing access based on whether the path argument matches any of the
 * specified path patterns. Supports glob-style `**` wildcards.
 * Independently testable.
 */

import { resolve, normalize } from 'node:path';
import type {
  PathScopeRule,
  EvaluationStep,
} from '../types.js';
import { globBodyToRegexSource } from '../../../utils/glob-to-regex.js';

/** Result returned by evaluatePathScopeRule. */
export interface PathScopeRuleResult {
  matched: boolean;
  step: EvaluationStep;
}

/**
 * toolMatchesPathPattern, Returns true if `toolName` matches the rule's toolPattern.
 */
function toolMatchesPathPattern(
  toolName: string,
  toolPattern: string | string[],
): boolean {
  if (Array.isArray(toolPattern)) {
    return toolPattern.some((p) => p === '*' || p === toolName);
  }
  return toolPattern === '*' || toolPattern === toolName;
}

/**
 * extractPathArgs, Extracts EVERY path string from args.
 * Understands the edit tool's real shape (`edits: [{ path }, ...]`) as well
 * as flat `path`/`file`/`target` strings.
 */
export function extractPathArgs(args: Record<string, unknown>): string[] {
  const edits = args['edits'];
  if (Array.isArray(edits)) {
    const paths = edits
      .map((entry) => (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>)['path'] === 'string'
        ? (entry as Record<string, unknown>)['path'] as string
        : null))
      .filter((path): path is string => path !== null);
    if (paths.length > 0) return paths;
  }
  if (typeof args['path'] === 'string') return [args['path']];
  if (typeof args['file'] === 'string') return [args['file']];
  if (typeof args['target'] === 'string') return [args['target']];
  return [];
}

/**
 * globToRegex, Converts a simple glob pattern to a RegExp.
 *
 * Supports:
 *   - `**`, matches any sequence of characters including path separators
 *   - `*` , matches any sequence of characters within a single path component
 *   - `?` , matches any single character
 *
 * This is intentionally minimal, for full micromatch support, replace this
 * with a micromatch dependency if needed.
 */
function globToRegex(pattern: string): RegExp {
  // `**` crosses path separators (`.*`), a lone `*` stays within a segment
  // (`[^/]*`), and `?` matches a single non-separator character. Built in a
  // single forward pass (see globBodyToRegexSource) so heavy repeated use never
  // trips the lastIndex-leak a `/g` sentinel round-trip is prone to.
  return new RegExp(`^${globBodyToRegexSource(pattern, '[^/]*', '.*', '[^/]')}$`);
}

/**
 * pathMatchesPattern, Returns true if `absolutePath` matches `pattern`.
 *
 * Relative patterns are resolved against cwd before matching.
 */
function pathMatchesPattern(absolutePath: string, pattern: string, projectRoot?: string): boolean {
  if (!pattern.startsWith('/') && !projectRoot) {
    return false;
  }
  const resolvedPattern = pattern.startsWith('/') ? pattern : resolve(projectRoot as string, pattern);
  const regex = globToRegex(resolvedPattern);
  return regex.test(absolutePath);
}

/**
 * evaluatePathScopeRule, Evaluates a single PathScopeRule against a tool call.
 *
 * Returns `matched: true` when:
 *   1. The tool name matches the rule's `toolPattern`, AND
 *   2. A path argument is found, AND
 *   3. The normalized absolute path matches at least one of the rule's `pathPatterns`.
 *
 * @param rule    , The PathScopeRule to evaluate.
 * @param toolName, Name of the tool being called.
 * @param args    , Arguments passed to the tool.
 */
export function evaluatePathScopeRule(
  rule: PathScopeRule,
  toolName: string,
  args: Record<string, unknown>,
  projectRoot?: string,
): PathScopeRuleResult {
  const toolMatches = toolMatchesPathPattern(toolName, rule.toolPattern);

  if (!toolMatches) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `path-scope-rule:${rule.id}`,
        matched: false,
        detail: `tool "${toolName}" does not match pattern "${rule.toolPattern}"`,
      },
    };
  }

  const rawPaths = extractPathArgs(args);
  if (rawPaths.length === 0) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `path-scope-rule:${rule.id}`,
        matched: false,
        detail: 'no path argument found in args',
      },
    };
  }

  if (rawPaths.some((rawPath) => !rawPath.startsWith('/')) && !projectRoot) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `path-scope-rule:${rule.id}`,
        matched: false,
        detail: 'relative path-scope evaluation requires an explicit project root',
      },
    };
  }

  const absolutePaths = rawPaths.map((rawPath) =>
    normalize(rawPath.startsWith('/') ? rawPath : resolve(projectRoot as string, rawPath)));
  const pathMatches = (absolutePath: string): boolean =>
    rule.pathPatterns.some((p) => pathMatchesPattern(absolutePath, p, projectRoot));

  // Effect-aware batch semantics: an allow rule only matches when EVERY path
  // in the call is inside scope (one out-of-scope edit must not ride in on a
  // partial grant); a deny rule matches when ANY path does.
  const matched = rule.effect === 'deny'
    ? absolutePaths.some(pathMatches)
    : absolutePaths.every(pathMatches);

  return {
    matched,
    step: {
      layer: 'policy',
      check: `path-scope-rule:${rule.id}`,
      matched,
      detail: matched
        ? `path(s) matched rule "${rule.id}" (${rule.effect})`
        : `path(s) [${absolutePaths.join(', ')}] did not all match [${rule.pathPatterns.join(', ')}]`,
    },
  };
}
