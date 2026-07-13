/**
 * Prefix matching policy rule evaluator.
 *
 * PrefixRule matches tool calls by tool name and optionally the command prefix
 * of the first string argument. Independently testable — no external dependencies.
 */

import type {
  PrefixRule,
  EvaluationStep,
} from '../types.js';

/** Result returned by evaluatePrefixRule. */
export interface PrefixRuleResult {
  matched: boolean;
  step: EvaluationStep;
}

/**
 * toolMatchesPrefixPattern — Returns true if `toolName` is matched by the rule's
 * `toolPattern` field (which may be a single string, `'*'`, or an array).
 */
function toolMatchesPrefixPattern(
  toolName: string,
  toolPattern: string | string[],
): boolean {
  if (Array.isArray(toolPattern)) {
    return toolPattern.some((p) => p === '*' || p === toolName);
  }
  return toolPattern === '*' || toolPattern === toolName;
}

/**
 * extractCommandArgs — Extracts EVERY command string from args.
 * Understands the exec tool's real shape (`commands: [{ cmd }, ...]`) as well
 * as flat `command`/`cmd` strings; falls back to the first string value.
 */
export function extractCommandArgs(args: Record<string, unknown>): string[] {
  const commands = args['commands'];
  if (Array.isArray(commands)) {
    const cmds = commands
      .map((entry) => (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>)['cmd'] === 'string'
        ? (entry as Record<string, unknown>)['cmd'] as string
        : null))
      .filter((cmd): cmd is string => cmd !== null);
    if (cmds.length > 0) return cmds;
  }
  if (typeof args['command'] === 'string') return [args['command']];
  if (typeof args['cmd'] === 'string') return [args['cmd']];
  for (const v of Object.values(args)) {
    if (typeof v === 'string') return [v];
  }
  return [];
}

/**
 * evaluatePrefixRule — Evaluates a single PrefixRule against a tool call.
 *
 * Returns `matched: true` only when:
 *   1. The tool name matches the rule's `toolPattern`, AND
 *   2. Either no command constraint is specified, OR the call's command
 *      string(s) match the rule's exactCommands / commandPrefixes
 *      (case-insensitive; allow rules need EVERY command to match, deny
 *      rules need ANY).
 *
 * @param rule     — The PrefixRule to evaluate.
 * @param toolName — Name of the tool being called.
 * @param args     — Arguments passed to the tool.
 */
export function evaluatePrefixRule(
  rule: PrefixRule,
  toolName: string,
  args: Record<string, unknown>,
): PrefixRuleResult {
  const toolMatches = toolMatchesPrefixPattern(toolName, rule.toolPattern);

  if (!toolMatches) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `prefix-rule:${rule.id}`,
        matched: false,
        detail: `tool "${toolName}" does not match pattern "${rule.toolPattern}"`,
      },
    };
  }

  const hasPrefixes = (rule.commandPrefixes?.length ?? 0) > 0;
  const hasExact = (rule.exactCommands?.length ?? 0) > 0;

  // No command constraint — tool name match alone is sufficient
  if (!hasPrefixes && !hasExact) {
    return {
      matched: true,
      step: {
        layer: 'policy',
        check: `prefix-rule:${rule.id}`,
        matched: true,
        detail: `tool "${toolName}" matched (no prefix constraint)`,
      },
    };
  }

  const commandArgs = extractCommandArgs(args);
  if (commandArgs.length === 0) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `prefix-rule:${rule.id}`,
        matched: false,
        detail: 'no string argument found to match prefix against',
      },
    };
  }

  const commandMatches = (command: string): boolean => {
    const normalized = command.trim().toLowerCase();
    if (rule.exactCommands?.some((exact) => normalized === exact.trim().toLowerCase())) return true;
    return rule.commandPrefixes?.some((prefix) => normalized.startsWith(prefix.toLowerCase())) ?? false;
  };

  // Effect-aware batch semantics: an allow rule only matches when EVERY
  // command in the call matches (a mixed batch must not ride in on a partial
  // grant); a deny rule matches when ANY command does.
  const matched = rule.effect === 'deny'
    ? commandArgs.some(commandMatches)
    : commandArgs.every(commandMatches);

  return {
    matched,
    step: {
      layer: 'policy',
      check: `prefix-rule:${rule.id}`,
      matched,
      detail: matched
        ? `command(s) matched rule "${rule.id}" (${rule.effect})`
        : `command(s) did not match [${[...(rule.exactCommands ?? []), ...(rule.commandPrefixes ?? [])].join(', ')}]`,
    },
  };
}
