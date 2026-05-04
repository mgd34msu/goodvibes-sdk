import { validateEventFields } from './shared.js';
import type { ContractResult } from './shared.js';

// TURN_SUBMITTED: { type: 'TURN_SUBMITTED'; turnId: string; prompt: string; origin? }
export function validateTurnStarted(v: unknown): ContractResult {
  return validateEventFields('TURN_SUBMITTED', v, [
    { key: 'turnId', kind: 'string' },
    { key: 'prompt', kind: 'string' },
  ]);
}

// STREAM_DELTA: { type: 'STREAM_DELTA'; turnId: string; content: string; accumulated: string; ... }
export function validateTurnStreaming(v: unknown): ContractResult {
  return validateEventFields('STREAM_DELTA', v, [
    { key: 'turnId', kind: 'string' },
    { key: 'content', kind: 'string' },
    { key: 'accumulated', kind: 'string' },
  ]);
}

// TURN_COMPLETED: { type: 'TURN_COMPLETED'; turnId: string; response: string; stopReason: ... }
export function validateTurnCompleted(v: unknown): ContractResult {
  return validateEventFields('TURN_COMPLETED', v, [
    { key: 'turnId', kind: 'string' },
    { key: 'response', kind: 'string' },
    { key: 'stopReason', kind: 'string' },
  ]);
}

// TURN_ERROR: { type: 'TURN_ERROR'; turnId: string; error: string; stopReason: ... }
export function validateTurnFailed(v: unknown): ContractResult {
  return validateEventFields('TURN_ERROR', v, [
    { key: 'turnId', kind: 'string' },
    { key: 'error', kind: 'string' },
  ]);
}

// TURN_CANCEL: { type: 'TURN_CANCEL'; turnId: string; reason?; stopReason: ... }
export function validateTurnCancelled(v: unknown): ContractResult {
  return validateEventFields('TURN_CANCEL', v, [
    { key: 'turnId', kind: 'string' },
  ]);
}

// TOOL_RECEIVED: { type: 'TOOL_RECEIVED'; callId: string; turnId: string; tool: string; args: ... }
export function validateToolReceived(v: unknown): ContractResult {
  return validateEventFields('TOOL_RECEIVED', v, [
    { key: 'callId', kind: 'string' },
    { key: 'turnId', kind: 'string' },
    { key: 'tool', kind: 'string' },
    { key: 'args', kind: 'object' },
  ]);
}

export function validateToolSucceeded(v: unknown): ContractResult {
  return validateEventFields('TOOL_SUCCEEDED', v, [
    { key: 'callId', kind: 'string' },
    { key: 'turnId', kind: 'string' },
    { key: 'durationMs', kind: 'number' },
  ]);
}

export function validateToolFailed(v: unknown): ContractResult {
  return validateEventFields('TOOL_FAILED', v, [
    { key: 'callId', kind: 'string' },
    { key: 'turnId', kind: 'string' },
    { key: 'error', kind: 'string' },
  ]);
}
