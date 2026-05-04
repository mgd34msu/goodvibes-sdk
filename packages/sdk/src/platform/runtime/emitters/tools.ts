/**
 * Tool emitters — typed emission wrappers for ToolEvent domain.
 */
import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from './index.js';

/** Emit TOOL_RECEIVED when a tool call is received from the LLM. */
export function emitToolReceived(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string; args: Record<string, unknown> }
): void {
  bus.emit('tools', createEventEnvelope('TOOL_RECEIVED', { type: 'TOOL_RECEIVED', ...data }, ctx));
}

/** Emit TOOL_VALIDATED when tool arguments pass schema validation. */
export function emitToolValidated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string }
): void {
  bus.emit('tools', createEventEnvelope('TOOL_VALIDATED', { type: 'TOOL_VALIDATED', ...data }, ctx));
}

/** Emit TOOL_PREHOOKED after pre-execution hooks have run. */
export function emitToolPrehooked(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string }
): void {
  bus.emit('tools', createEventEnvelope('TOOL_PREHOOKED', { type: 'TOOL_PREHOOKED', ...data }, ctx));
}

/** Emit TOOL_PERMISSIONED after permission check completes. */
export function emitToolPermissioned(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string; approved: boolean }
): void {
  bus.emit('tools', createEventEnvelope('TOOL_PERMISSIONED', { type: 'TOOL_PERMISSIONED', ...data }, ctx));
}

/** Emit TOOL_EXECUTING when the tool starts executing. */
export function emitToolExecuting(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string; startedAt: number }
): void {
  bus.emit('tools', createEventEnvelope('TOOL_EXECUTING', { type: 'TOOL_EXECUTING', ...data }, ctx));
}

/** Emit TOOL_MAPPED after the result is mapped for the provider. */
export function emitToolMapped(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string }
): void {
  bus.emit('tools', createEventEnvelope('TOOL_MAPPED', { type: 'TOOL_MAPPED', ...data }, ctx));
}

/** Emit TOOL_POSTHOOKED after post-execution hooks have run. */
export function emitToolPosthooked(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string }
): void {
  bus.emit('tools', createEventEnvelope('TOOL_POSTHOOKED', { type: 'TOOL_POSTHOOKED', ...data }, ctx));
}

/**
 * Convert any tool result (ToolResult, SyntheticToolResult, etc.) to a ToolResultSummary
 * for safe emission in the event stream. Never leaks raw output; provides kind, byteSize, preview.
 */
export function toToolResultSummary(
  result: { success?: boolean | undefined; output?: string | undefined; error?: string | undefined }
): import('../../../events/tools.js').ToolResultSummary {
  if (!result.success) {
    const errStr = result.error ?? 'unknown error';
    return {
      kind: 'error',
      byteSize: errStr.length,
      preview: errStr.slice(0, 100),
    };
  }
  const output = result.output ?? '';
  let kind: string;
  let preview: string | undefined;
  try {
    JSON.parse(output);
    kind = 'json';
    preview = output.slice(0, 100);
  } catch {
    kind = 'text';
    preview = output.slice(0, 100);
  }
  return { kind, byteSize: output.length, preview };
}

/** Emit TOOL_SUCCEEDED when a tool call completes successfully. */
export function emitToolSucceeded(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string; durationMs: number; result?: import('../../../events/tools.js').ToolResultSummary }
): void {
  bus.emit('tools', createEventEnvelope('TOOL_SUCCEEDED', { type: 'TOOL_SUCCEEDED', ...data }, ctx));
}

/** Emit TOOL_FAILED when a tool call fails. */
export function emitToolFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string; error: string; durationMs: number; result?: import('../../../events/tools.js').ToolResultSummary }
): void {
  bus.emit('tools', createEventEnvelope('TOOL_FAILED', { type: 'TOOL_FAILED', ...data }, ctx));
}

/** Emit TOOL_RECONCILED when unresolved tool calls are synthesized. */
export function emitToolReconciled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    turnId: string;
    count: number;
    callIds: string[];
    toolNames: string[];
    reason: string;
    timestamp: number;
    isMalformed?: boolean | undefined;
  }
): void {
  bus.emit('tools', createEventEnvelope('TOOL_RECONCILED', { type: 'TOOL_RECONCILED', ...data }, ctx));
}

/** Emit TOOL_CANCELLED when a tool call is cancelled. */
export function emitToolCancelled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string; reason?: string | undefined }
): void {
  bus.emit('tools', createEventEnvelope('TOOL_CANCELLED', { type: 'TOOL_CANCELLED', ...data }, ctx));
}

/** Emit BUDGET_EXCEEDED_MS when wall-clock time limit is breached. */
export function emitBudgetExceededMs(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string; phase: string; limitMs: number; elapsedMs: number }
): void {
  bus.emit('tools', createEventEnvelope('BUDGET_EXCEEDED_MS', { type: 'BUDGET_EXCEEDED_MS', ...data }, ctx));
}

/** Emit BUDGET_EXCEEDED_TOKENS when token consumption limit is breached. */
export function emitBudgetExceededTokens(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string; phase: string; limitTokens: number; usedTokens: number }
): void {
  bus.emit('tools', createEventEnvelope('BUDGET_EXCEEDED_TOKENS', { type: 'BUDGET_EXCEEDED_TOKENS', ...data }, ctx));
}

/** Emit BUDGET_EXCEEDED_COST when cost-in-USD limit is breached. */
export function emitBudgetExceededCost(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; turnId: string; tool: string; phase: string; limitCostUsd: number; usedCostUsd: number }
): void {
  bus.emit('tools', createEventEnvelope('BUDGET_EXCEEDED_COST', { type: 'BUDGET_EXCEEDED_COST', ...data }, ctx));
}
