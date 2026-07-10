// Background/subagent tool-call permission gate.
//
// Extracted from orchestrator-runner.ts so the runner stays focused on the
// turn loop. This module owns the single rule: a background agent's tool calls
// are brokered through the SAME session permission mode as the foreground turn
// loop, unless the escape-hatch config exempts them.
import type { PermissionManager } from '../permissions/manager.js';
import type { PermissionAttribution } from '../permissions/prompt.js';
import { buildToolDenial, buildDenialErrorMessage } from '../permissions/denial.js';
import type { ToolDenial } from '../types/tools.js';
import type { AgentRecord } from '../tools/agent/index.js';

/** The narrow slice of PermissionManager the background gate consults. */
export type BackgroundPermissionManager = Pick<
  PermissionManager,
  'checkDetailed' | 'check' | 'getBackgroundAgentsMode'
>;

export type BackgroundPermissionOutcome =
  | { readonly approved: true; readonly modifiedArgs?: Record<string, unknown> | undefined }
  | { readonly approved: false; readonly error: string; readonly denial: ToolDenial };

/**
 * Broker a background/subagent tool call through the session permission mode.
 *
 * Mirrors the foreground tool-runtime's permission handling so a background
 * agent is subject to the SAME mode: 'inherit' (default) applies the mode's
 * allow/ask/refuse matrix (allow-all approves everything with zero new
 * friction; prompt/plan/accept-edits/custom apply as configured, with any ask
 * bubbling through the injected requestPermission handler carrying subagent
 * attribution). The escape-hatch `permissions.backgroundAgents: 'allow-all'`
 * exempts background agents entirely. When no manager is wired the call is left
 * ungated (unchanged legacy behavior for isolated contexts/tests).
 */
export async function gateBackgroundToolCall(
  context: { readonly permissionManager?: BackgroundPermissionManager | undefined },
  record: Pick<AgentRecord, 'id' | 'template'>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<BackgroundPermissionOutcome> {
  const manager = context.permissionManager;
  if (!manager) return { approved: true };
  if (manager.getBackgroundAgentsMode() === 'allow-all') return { approved: true };

  const attribution: PermissionAttribution = {
    kind: 'background-agent',
    agentId: record.id,
    ...(record.template ? { template: record.template } : {}),
  };
  const result = await manager.checkDetailed(toolName, args, attribution);
  if (result.approved) {
    return result.modifiedArgs ? { approved: true, modifiedArgs: result.modifiedArgs } : { approved: true };
  }
  const source = { reasonCode: result.reasonCode, sourceLayer: result.sourceLayer };
  return {
    approved: false,
    error: buildDenialErrorMessage(toolName, source),
    denial: buildToolDenial(source),
  };
}
