/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Shared construction of the structured, call-scoped {@link ToolDenial} that
 * rides on a refused tool call, plus the self-explaining error string the
 * asking agent reads. Centralised so the phased-executor permission phase and
 * the main orchestrator tool-runtime path produce identical denial data.
 */

import type { ToolDenial } from '../types/tools.js';

/**
 * Structured-denial reason surfaced for a plan-mode refusal.
 *
 * Distinct from the internal `PermissionCheckResult.reasonCode` value
 * (`'plan_mode'`): this is the wire-facing token surfaces branch on to render
 * the plan-mode pill/affordance, and it is the value the asking agent sees on
 * `ToolResult.denial.reason`.
 */
export const PLAN_MODE_DENIAL_REASON = 'plan-mode';

/** The reason code the permission layer emits for a plan-mode refusal. */
export const PLAN_MODE_REASON_CODE = 'plan_mode';

/** Minimal shape read from a resolved permission check to build a denial. */
export interface DenialSource {
  readonly reasonCode: string;
  readonly sourceLayer: string;
  /** The user's free-text note from the prompt decision, when one was given. */
  readonly userReason?: string | undefined;
}

/** True when this refusal was produced by plan mode. */
export function isPlanModeDenial(source: DenialSource): boolean {
  return source.reasonCode === PLAN_MODE_REASON_CODE;
}

/**
 * Build the structured, call-scoped denial for a refused tool call.
 *
 * Plan-mode refusals surface `reason: 'plan-mode'` so surfaces and the asking
 * agent recognise them specifically; every other refusal passes the permission
 * layer's reason code through unchanged.
 */
export function buildToolDenial(source: DenialSource): ToolDenial {
  return {
    denied: true,
    reason: isPlanModeDenial(source) ? PLAN_MODE_DENIAL_REASON : source.reasonCode,
    scope: source.sourceLayer,
    ...(source.userReason ? { detail: source.userReason } : {}),
  };
}

/**
 * Build the self-explaining error string for a refused tool call. Plan-mode
 * refusals steer the model toward presenting a plan rather than retrying the
 * tool; other refusals get the generic "continue without it" guidance.
 */
export function buildDenialErrorMessage(toolName: string, source: DenialSource): string {
  if (isPlanModeDenial(source)) {
    return (
      `Tool '${toolName}' was refused: you are in plan mode (reason: ${PLAN_MODE_DENIAL_REASON}, `
      + `scope: ${source.sourceLayer}). Do not attempt mutating or command-execution tools. `
      + `Present a concrete plan of the changes you intend to make and wait for the user to `
      + `approve it or switch out of plan mode.`
    );
  }
  const note = source.userReason ? ` The user said: "${source.userReason}".` : '';
  return (
    `Permission denied for tool '${toolName}' (reason: ${source.reasonCode}, scope: ${source.sourceLayer}).${note} `
    + `This call was refused; adapt to the user's feedback, continue without it, and report that it was not run.`
  );
}
