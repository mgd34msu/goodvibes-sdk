/**
 * Command normalization pipeline — barrel export and primary entry point.
 *
 * Exposes the normalizeCommand() function and all supporting types.
 * Pipeline: tokenize → segment → classify → NormalizedCommand
 */

export type {
  CommandToken,
  CommandSegment,
  CommandClassification,
  NormalizedCommand,
} from './types.js';

export type {
  ShellNode,
  CommandNode,
  PipeNode,
  SequenceNode,
  SubshellNode,
} from './ast.js';

export type {
  SegmentVerdict,
  CompoundVerdict,
} from './verdict.js';

export { tokenize } from './tokenizer.js';
export { segment } from './segmenter.js';
export { canonicalize } from './canonicalizer.js';
export { classifySegment, classifyCommand, higherPriority } from './classifier.js';
export { collectCommandNodes, describeNode } from './ast.js';
export { parseAST, parseCommandAST } from './parser.js';
export { evaluateSegmentNode, evaluateCommandAST, buildDenialExplanation, DEFAULT_ALLOWED_CLASSES } from './verdict.js';

import { tokenize } from './tokenizer.js';
import { segment } from './segmenter.js';
import { classifyCommand } from './classifier.js';
import type { NormalizedCommand, CommandClassification } from './types.js';
import { parseCommandAST } from './parser.js';
import { evaluateCommandAST, DEFAULT_ALLOWED_CLASSES } from './verdict.js';
import type { CompoundVerdict } from './verdict.js';

/**
 * Normalizes a raw shell command string and evaluates per-segment verdicts.
 *
 * Uses the Shell AST parser to produce a CompoundVerdict with
 * per-segment classification and denial reasons. Requires the
 * `shell-ast-normalization` feature flag to be enabled; falls back to
 * `normalizeCommand` when the flag is disabled.
 *
 * @param command        - The raw shell command string to evaluate.
 * @param allowedClasses - Classification tiers to allow (default: read+write+network).
 * @returns A CompoundVerdict with per-segment breakdown.
 */
export function normalizeCommandWithVerdicts(
  command: string,
  allowedClasses: ReadonlySet<CommandClassification> = DEFAULT_ALLOWED_CLASSES,
): CompoundVerdict {
  const ast = parseCommandAST(command);
  return evaluateCommandAST(command, ast, allowedClasses);
}

export function normalizeCommand(command: string): NormalizedCommand {
  const trimmed = command.trim();
  const tokens = tokenize(trimmed);
  const segments = segment(tokens);
  const analysis = classifyCommand(trimmed, segments);

  return {
    original: command,
    segments,
    ...analysis,
  };
}
