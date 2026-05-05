import type { Tool, ToolCall } from '../../../types/tools.js';
import type { ToolRuntimeContext } from '../context.js';
import type { PhaseResult, ToolExecutionRecord } from '../types.js';
import { summarizeError } from '../../../utils/error-display.js';
import { attachVisibleToolWarning } from './warnings.js';

/**
 * posthook — Phase 6 of the tool execution pipeline.
 *
 * Fires `Post:tool:<toolName>` hook via the HookDispatcher.
 *
 * Post-hook failures do not fail the tool call. The phase returns
 * success=true so the executor can proceed to `succeeded`, while hook
 * failures are surfaced as warnings on the phase and the tool result.
 */
export async function posthookPhase(
  call: ToolCall,
  _tool: Tool,
  context: ToolRuntimeContext,
  record: ToolExecutionRecord,
): Promise<PhaseResult> {
  const start = performance.now();

  try {
    const hookResult = await context.hookDispatcher.fire({
      path: `Post:tool:${call.name}`,
      phase: 'Post',
      category: 'tool',
      specific: call.name,
      sessionId: context.ids.sessionId,
      timestamp: Date.now(),
      payload: {
        callId: call.id,
        toolName: call.name,
        args: record._updatedArgs ?? call.arguments,
        result: record.result,
        success: record.result?.success ?? false,
      },
      agentId: context.agent?.agentId,
    });

    if (!hookResult.ok) {
      const warning = `Post-hook warning: ${hookResult.error ?? 'hook returned ok=false'}`;
      attachVisibleToolWarning(record.result, warning);
      return {
        phase: 'posthooked',
        success: true,
        durationMs: performance.now() - start,
        warnings: [warning],
      };
    }

    return {
      phase: 'posthooked',
      success: true,
      durationMs: performance.now() - start,
    };
  } catch (err) {
    // Hook infrastructure errors are surfaced without failing the tool result.
    const message = summarizeError(err);
    const warning = `Post-hook warning: ${message}`;
    attachVisibleToolWarning(record.result, warning);
    return {
      phase: 'posthooked',
      success: true,
      durationMs: performance.now() - start,
      warnings: [warning],
    };
  }
}
