/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * The standing instruction that tells the model it is in plan mode. It is
 * appended to the system prompt while plan mode is active, so it reaches the
 * model on every turn AND — because the system prompt is the instruction chain
 * the compaction pass re-injects (see buildReinjectedInstructions) — survives
 * compaction without any extra plumbing.
 */

import type { PermissionMode } from '../config/schema.js';

/** Marker so the block can be recognised in a composed system prompt / tests. */
export const PLAN_MODE_INSTRUCTION_MARKER = 'goodvibes:plan-mode-instruction';

/** The canonical plan-mode standing instruction text. */
export const PLAN_MODE_INSTRUCTION = [
  `<!-- ${PLAN_MODE_INSTRUCTION_MARKER} -->`,
  '# Plan mode is active',
  '',
  'You are in PLAN mode. Read-only tools (reading files, searching, analysis) are',
  'available, but every mutating or command-execution tool is refused by the',
  'permission layer with a structured `plan-mode` denial. Do not attempt file',
  'writes/edits, shell/exec commands, or agent delegation — they will not run.',
  '',
  'Instead: investigate as needed with read-only tools, then present a clear,',
  'concrete plan of the changes you intend to make and wait for the user to',
  'approve it or switch out of plan mode. Do not claim work is done that plan',
  'mode prevented you from doing.',
].join('\n');

/** True when the given permission mode is plan mode. */
export function isPlanMode(mode: PermissionMode | undefined): boolean {
  return mode === 'plan';
}

/**
 * Append the plan-mode standing instruction to a base system prompt when plan
 * mode is active; otherwise return the base prompt unchanged. Used to wrap the
 * orchestrator's `getSystemPrompt` so both the live turn and the compaction
 * instruction chain carry the plan-mode instruction.
 */
export function appendPlanModeInstruction(
  basePrompt: string,
  mode: PermissionMode | undefined,
): string {
  if (!isPlanMode(mode)) return basePrompt;
  const trimmed = basePrompt.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${PLAN_MODE_INSTRUCTION}` : PLAN_MODE_INSTRUCTION;
}
