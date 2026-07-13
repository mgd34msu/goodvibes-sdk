/**
 * Approval decisions that persist and generalize — the rule side.
 *
 * An approval prompt can offer remember tiers beyond "this session":
 *   - 'exact'         — this exact command (exec)
 *   - 'command-class' — this command class, e.g. every `git ...` (exec)
 *   - 'path'          — edits/writes under the asked path's directory
 *   - 'tool'          — always allow/deny this tool in this project
 *   - 'session'       — the classic in-memory session cache only
 *
 * A tiered decision becomes a durable user-origin PolicyRule (the same shape
 * evaluateRuntimePolicy consults), stored per project. The session approval
 * map is a cache over these rules. The tier options ride on the broker's ask
 * payload so ANY surface can offer them.
 */

import { dirname } from 'node:path';
import type { PolicyRule } from '../runtime/permissions/types.js';
import {
  evaluateArgShapeRule,
  evaluateNetworkScopeRule,
  evaluatePathScopeRule,
  evaluatePrefixRule,
} from '../runtime/permissions/rules/index.js';
import { extractCommandArgs } from '../runtime/permissions/rules/prefix.js';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';

/** How far a remembered approval decision reaches. */
export type RememberTier = 'session' | 'exact' | 'command-class' | 'path' | 'tool';

/** One offerable remember tier, rendered by whatever surface shows the ask. */
export interface RememberTierOption {
  readonly tier: RememberTier;
  /** Human-readable option label, e.g. `Always allow git commands`. */
  readonly label: string;
  /** What the resulting durable rule will match, stated concretely. */
  readonly detail: string;
}

/** First whitespace token of a command — its class (git, npm, bun, ...). */
export function commandClassOf(command: string): string {
  return command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * The remember tiers that make sense for this call, most specific first.
 * 'session' is always offered; surfaces may also offer plain one-time
 * approve/deny (a decision with no remember at all).
 */
export function buildRememberOptions(toolName: string, args: Record<string, unknown>): RememberTierOption[] {
  const options: RememberTierOption[] = [];
  const commands = extractCommandArgs(args);
  const paths = extractPathArgs(args);

  if (toolName === 'exec' && commands.length > 0) {
    options.push({
      tier: 'exact',
      label: commands.length === 1 ? 'this exact command' : 'these exact commands',
      detail: commands.join(' ; '),
    });
    const classes = uniqueSorted(commands.map(commandClassOf).filter((cls) => cls.length > 0));
    if (classes.length > 0) {
      options.push({
        tier: 'command-class',
        label: `every ${classes.join(' / ')} command`,
        detail: classes.map((cls) => `${cls} ...`).join(' ; '),
      });
    }
  }

  if ((toolName === 'edit' || toolName === 'write') && paths.length > 0) {
    const dirs = uniqueSorted(paths.map((path) => dirname(path)));
    options.push({
      tier: 'path',
      label: dirs.length === 1 ? `edits under ${dirs[0]}` : 'edits under these directories',
      detail: dirs.map((dir) => `${dir}/**`).join(' ; '),
    });
  }

  options.push({
    tier: 'tool',
    label: `always for the ${toolName} tool in this project`,
    detail: `every ${toolName} call, any arguments`,
  });
  options.push({
    tier: 'session',
    label: 'for the rest of this session',
    detail: 'in-memory only; forgotten on restart',
  });
  return options;
}

/**
 * Build the durable user-origin rule a tiered decision persists.
 * Returns null for 'session' (cache-only) or when the tier cannot be
 * derived from the call's arguments (e.g. 'path' with no path args).
 */
export function buildDurableRuleForDecision(input: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly tier: RememberTier;
  readonly effect: 'allow' | 'deny';
  readonly now?: number | undefined;
}): PolicyRule | null {
  const { toolName, args, tier, effect } = input;
  const at = input.now ?? Date.now();
  const id = `user-${tier}-${toolName}-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const commands = extractCommandArgs(args);
  const paths = extractPathArgs(args);

  switch (tier) {
    case 'session':
      return null;
    case 'exact': {
      if (commands.length === 0) return null;
      return {
        type: 'prefix',
        id,
        origin: 'user',
        effect,
        toolPattern: toolName,
        exactCommands: uniqueSorted(commands.map((cmd) => cmd.trim())),
        description: `${effect} exactly: ${commands.join(' ; ')}`,
      };
    }
    case 'command-class': {
      const classes = uniqueSorted(commands.map(commandClassOf).filter((cls) => cls.length > 0));
      if (classes.length === 0) return null;
      return {
        type: 'prefix',
        id,
        origin: 'user',
        effect,
        toolPattern: toolName,
        // Token boundary: `git ` prefixes match every git invocation with
        // arguments; the bare class name is matched exactly so `git` alone is
        // covered but `gitfoo ...` never is.
        commandPrefixes: classes.map((cls) => `${cls} `),
        exactCommands: classes,
        description: `${effect} the ${classes.join('/')} command class`,
      };
    }
    case 'path': {
      if (paths.length === 0) return null;
      const dirs = uniqueSorted(paths.map((path) => dirname(path)));
      return {
        type: 'path-scope',
        id,
        origin: 'user',
        effect,
        toolPattern: ['edit', 'write'],
        pathPatterns: dirs.map((dir) => `${dir}/**`),
        description: `${effect} edits under ${dirs.join(', ')}`,
      };
    }
    case 'tool':
      return {
        type: 'prefix',
        id,
        origin: 'user',
        effect,
        toolPattern: toolName,
        description: `${effect} every ${toolName} call in this project`,
      };
    default:
      return null;
  }
}

export interface DurableRuleMatch {
  readonly effect: 'allow' | 'deny';
  readonly ruleId: string;
}

/**
 * First-match-wins evaluation of durable user rules against a call — the
 * lightweight matcher behind the session-cache layer (it must work with the
 * policy engine flag on OR off, so it does not go through the full layered
 * evaluator).
 */
export function matchDurableRules(
  rules: readonly PolicyRule[],
  toolName: string,
  args: Record<string, unknown>,
  options: { readonly projectRoot?: string | undefined } = {},
): DurableRuleMatch | null {
  for (const rule of rules) {
    let matched = false;
    switch (rule.type) {
      case 'prefix':
        matched = evaluatePrefixRule(rule, toolName, args).matched;
        break;
      case 'arg-shape':
        matched = evaluateArgShapeRule(rule, toolName, args).matched;
        break;
      case 'path-scope':
        matched = evaluatePathScopeRule(rule, toolName, args, options.projectRoot).matched;
        break;
      case 'network-scope':
        matched = evaluateNetworkScopeRule(rule, toolName, args).matched;
        break;
      case 'mode-constraint':
        // Mode-constraint rules are mode-layer policy, not approval-derived —
        // no remember tier produces one, and mode handling already lives in
        // checkDetailed before this matcher runs.
        matched = false;
        break;
    }
    if (matched) return { effect: rule.effect, ruleId: rule.id };
  }
  return null;
}
