/**
 * Shell AST guard for the exec tool.
 *
 * Integrates the Shell AST normalization pipeline with the exec tool to
 * provide per-segment verdict evaluation and user-facing denial explanations.
 *
 * When AST command parsing is on (permissions.commandParser 'ast', the default), every exec
 * command is parsed into an AST, evaluated segment-by-segment, and denied
 * with a structured explanation if any segment fails policy.
 *
 * When the flag is disabled, this module falls back to the baseline
 * flat-token segmentation path.
 *
 * @module tools/exec/ast-guard
 */

import { parseCommandAST } from '../../runtime/permissions/normalization/parser.js';
import { collectCommandNodes } from '../../runtime/permissions/normalization/ast.js';
import { evaluateCommandAST, DEFAULT_ALLOWED_CLASSES } from '../../runtime/permissions/normalization/verdict.js';
import { normalizeCommand } from '../../runtime/permissions/normalization/index.js';
import { catastrophicReason } from '../../runtime/permissions/normalization/classifier.js';
import type { CompoundVerdict } from '../../runtime/permissions/normalization/verdict.js';
import type { CommandClassification } from '../../runtime/permissions/normalization/types.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';

type FlagManagerLike = Pick<FeatureFlagManager, 'isEnabled'>;

function isASTNormalizationEnabled(flagManager?: FlagManagerLike | null): boolean {
  return flagManager?.isEnabled('shell-ast-normalization') ?? false;
}

// ── Allowed classification set ─────────────────────────────────────────────────

// DEFAULT_ALLOWED_CLASSES is imported from verdict.ts

// ── Guard result ───────────────────────────────────────────────────────────────

/**
 * The result of an AST guard evaluation for a single exec command.
 */
export interface ASTGuardResult {
  /** Whether the command is permitted by the AST guard. */
  allowed: boolean;
  /**
   * Human-readable denial explanation for user display.
   * Only set when `allowed` is false.
   */
  denialMessage?: string | undefined;
  /**
   * The full CompoundVerdict, available for upstream audit logging.
   * Only set when AST normalization is active.
   */
  verdict?: CompoundVerdict | undefined;
  /** Whether AST normalization was active. */
  astModeActive: boolean;
}

// ── Baseline guard ─────────────────────────────────────────────────────────────

/**
 * Evaluates a command using the baseline flat segmentation pipeline.
 *
 * Catastrophic segments (root deletion, raw disk destruction, fork bombs —
 * see catastrophicReason in the classifier; that list is frozen) are denied
 * unconditionally. Everything else is gated by `allowedClasses`: the caller
 * decides which classification tiers pass, so class-level risk stays with
 * the permission layer rather than a second config-blind gate here.
 *
 * @param command        - The raw shell command string.
 * @param allowedClasses - Classification tiers the caller permits.
 * @returns ASTGuardResult with AST mode disabled.
 */
function baselineGuard(
  command: string,
  allowedClasses: ReadonlySet<CommandClassification>,
): ASTGuardResult {
  const normalized = normalizeCommand(command);

  for (const seg of normalized.segments) {
    const reason = catastrophicReason(seg);
    if (reason !== null) {
      return {
        allowed: false,
        denialMessage:
          `Command denied (safety block): "${command}"\n` +
          `Unconditionally blocked destructive command — ${reason}.\n` +
          `This block is not affected by permission settings.`,
        astModeActive: false,
      };
    }
  }

  const cls = normalized.highestClassification;
  if (!allowedClasses.has(cls)) {
    return {
      allowed: false,
      denialMessage:
        `Command denied (command-class policy): "${command}"\n` +
        `Classification: ${cls}\n` +
        `Classification "${cls}" is not in the caller's allowed set [${[...allowedClasses].join(', ')}].`,
      astModeActive: false,
    };
  }

  return { allowed: true, astModeActive: false };
}

// ── AST mode guard ─────────────────────────────────────────────────────────────

/**
 * Evaluates a command using the Shell AST pipeline.
 *
 * Parses the command into a ShellNode AST, evaluates each segment
 * independently, and returns a CompoundVerdict.
 *
 * @param command        - The raw shell command string.
 * @param allowedClasses - Classification tiers to allow.
 * @returns ASTGuardResult with full CompoundVerdict attached.
 */
function astGuard(
  command: string,
  allowedClasses: ReadonlySet<CommandClassification>,
): ASTGuardResult {
  const ast = parseCommandAST(command);

  // Parser failure → fall back to the baseline matcher. The parser records a
  // parseError on any command node it could not structure; when present, the
  // AST is unreliable, so we defer to the baseline flat-segmentation path
  // rather than trust a degraded tree. This is never a hard error and never a
  // blanket allow — baselineGuard applies the same frozen catastrophic block
  // and class gating the non-AST path always has.
  if (collectCommandNodes(ast).some((node) => node.parseError !== undefined)) {
    return baselineGuard(command, allowedClasses);
  }

  const verdict = evaluateCommandAST(command, ast, allowedClasses);

  if (!verdict.allowed) {
    return {
      allowed: false,
      denialMessage: verdict.denialExplanation,
      verdict,
      astModeActive: true,
    };
  }

  return {
    allowed: true,
    verdict,
    astModeActive: true,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Evaluates a shell command string through the AST guard.
 *
 * Routes to the AST pipeline when the `shell-ast-normalization` gate
 * is enabled, otherwise falls back to the baseline segmentation path.
 *
 * @param command        - The raw shell command string to evaluate.
 * @param allowedClasses - Classification tiers the caller permits (honored in
 *                         both AST and baseline modes). Callers fronted by the
 *                         permission layer pass ALL_COMMAND_CLASSES so class
 *                         risk is decided by user settings, not this guard.
 * @returns ASTGuardResult with allow/deny decision and optional denial message.
 *
 * @example
 * const result = guardExecCommand('ls /tmp && rm -rf /');
 * if (!result.allowed) {
 *   console.error(result.denialMessage);
 * }
 */
export async function guardExecCommand(
  command: string,
  allowedClasses: ReadonlySet<CommandClassification> = DEFAULT_ALLOWED_CLASSES,
  flagManager?: FlagManagerLike | null,
): Promise<ASTGuardResult> {
  if (isASTNormalizationEnabled(flagManager)) {
    try {
      return astGuard(command, allowedClasses);
    } catch {
      // Any unexpected fault in the AST path (parser, verdict, or evaluation)
      // falls back to the baseline matcher rather than surfacing a hard error
      // or defaulting to allow. The baseline path still enforces the frozen
      // catastrophic block and the caller's class gating.
      return baselineGuard(command, allowedClasses);
    }
  }
  return baselineGuard(command, allowedClasses);
}

/**
 * Formats an ASTGuardResult denial into a structured exec tool error response.
 *
 * @param result - A denied ASTGuardResult.
 * @param cmd    - The original command string (for the error message).
 * @returns A structured error object suitable for returning from the exec tool.
 */
export function formatDenialResponse(
  result: ASTGuardResult,
  cmd: string,
): Record<string, unknown> {
  const segmentDetails = result.verdict?.segments.map((s) => ({
    command: s.command,
    classification: s.classification,
    allowed: s.allowed,
    reason: s.reason,
    ...(s.hasObfuscation ? { obfuscation: s.obfuscationPatterns } : {}),
  }));

  return {
    success: false,
    cmd,
    denied: true,
    denial_reason: result.denialMessage ?? 'Command denied by policy',
    ...(segmentDetails ? { segments: segmentDetails } : {}),
    ast_mode: result.astModeActive,
  };
}
