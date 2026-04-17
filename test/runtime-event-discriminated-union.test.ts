/**
 * runtime-event-discriminated-union.test.ts
 *
 * Runtime tests verifying that the discriminated union event types narrow
 * correctly in TypeScript. These tests also serve as compile-time checks:
 * if the types are wrong, bun's TypeScript support will fail at parse time.
 *
 * Type-level assertions (compile = pass) verify exhaustive narrowing via a
 * `never` assertion in the default branch of switch statements.
 *
 * Imports are from leaf event source files (no package-alias dependencies)
 * and from internal module paths that bun can resolve directly as TypeScript.
 */
import { describe, expect, test } from 'bun:test';

// Leaf event files with no package-alias imports: resolved directly by bun.
import type { AgentEvent } from '../packages/sdk/src/_internal/platform/runtime/events/agents.js';
import type { SessionEvent } from '../packages/sdk/src/_internal/platform/runtime/events/session.js';

// TurnEvent imports PartialToolCall from providers/interface — both relative, bun handles it.
import type { TurnEvent } from '../packages/sdk/src/_internal/platform/runtime/events/turn.js';

// WorkflowEvent imports WrfcState from agents/wrfc-types — relative, bun handles it.
import type { WorkflowEvent } from '../packages/sdk/src/_internal/platform/runtime/events/workflows.js';

// ---------------------------------------------------------------------------
// Type-level: compile-time narrowing assertions.
// These will emit TypeScript errors if the discriminated union is broken.
// ---------------------------------------------------------------------------

/** Verify AgentEvent narrows agentId and task on AGENT_SPAWNING without cast. */
type _AgentSpawning = Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>;
type _AssertAgentSpawningHasId = _AgentSpawning extends { agentId: string; task: string } ? true : never;
const _assertAgentSpawning: _AssertAgentSpawningHasId = true;
void _assertAgentSpawning;

/** Verify AgentEvent narrows durationMs on AGENT_COMPLETED without cast. */
type _AgentCompleted = Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>;
type _AssertAgentCompletedHasDuration = _AgentCompleted extends { agentId: string; durationMs: number } ? true : never;
const _assertAgentCompleted: _AssertAgentCompletedHasDuration = true;
void _assertAgentCompleted;

/** Verify TurnEvent narrows prompt on TURN_SUBMITTED without cast. */
type _TurnSubmitted = Extract<TurnEvent, { type: 'TURN_SUBMITTED' }>;
type _AssertTurnHasPrompt = _TurnSubmitted extends { turnId: string; prompt: string } ? true : never;
const _assertTurn: _AssertTurnHasPrompt = true;
void _assertTurn;

/** Verify SessionEvent narrows profileId on SESSION_STARTED without cast. */
type _SessionStarted = Extract<SessionEvent, { type: 'SESSION_STARTED' }>;
type _AssertSessionHasProfileId = _SessionStarted extends { sessionId: string; profileId: string; workingDir: string } ? true : never;
const _assertSession: _AssertSessionHasProfileId = true;
void _assertSession;

/** Verify WorkflowEvent narrows task on WORKFLOW_CHAIN_CREATED without cast. */
type _WorkflowChainCreated = Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_CREATED' }>;
type _AssertWorkflowHasTask = _WorkflowChainCreated extends { chainId: string; task: string } ? true : never;
const _assertWorkflow: _AssertWorkflowHasTask = true;
void _assertWorkflow;

// ---------------------------------------------------------------------------
// Helper: runtime narrowing without casts
// ---------------------------------------------------------------------------

/** Narrows AgentEvent using if-chains; each branch accesses fields specific to that type. */
function describeAgentEvent(event: AgentEvent): string {
  if (event.type === 'AGENT_SPAWNING') {
    // TypeScript narrows: agentId and task are accessible without cast
    return `spawning:${event.agentId}:${event.task}`;
  }
  if (event.type === 'AGENT_COMPLETED') {
    // TypeScript narrows: durationMs is a number, output is optional string
    return `completed:${event.agentId}:${event.durationMs}ms`;
  }
  if (event.type === 'AGENT_FAILED') {
    return `failed:${event.agentId}:${event.error}`;
  }
  if (event.type === 'AGENT_PROGRESS') {
    return `progress:${event.agentId}:${event.progress}`;
  }
  return `other:${event.type}`;
}

/** Narrows TurnEvent using if-chains. */
function describeTurnEvent(event: TurnEvent): string {
  if (event.type === 'TURN_SUBMITTED') {
    return `submitted:${event.turnId}:${event.prompt}`;
  }
  if (event.type === 'TURN_COMPLETED') {
    return `completed:${event.turnId}:${event.stopReason}`;
  }
  if (event.type === 'TURN_ERROR') {
    return `error:${event.turnId}:${event.error}`;
  }
  return `other:${event.type}`;
}

// ---------------------------------------------------------------------------
// Exhaustive switch — compile-time never check in default branch.
// If a new variant is added to AgentEvent without a matching case, TS errors.
// ---------------------------------------------------------------------------

function exhaustiveAgentSwitch(event: AgentEvent): string {
  switch (event.type) {
    case 'AGENT_SPAWNING':
      return event.agentId;
    case 'AGENT_RUNNING':
      return event.agentId;
    case 'AGENT_PROGRESS':
      return event.progress;
    case 'AGENT_STREAM_DELTA':
      return event.content;
    case 'AGENT_AWAITING_MESSAGE':
      return event.agentId;
    case 'AGENT_AWAITING_TOOL':
      return event.tool;
    case 'AGENT_FINALIZING':
      return event.agentId;
    case 'AGENT_COMPLETED':
      return `${event.durationMs}ms`;
    case 'AGENT_FAILED':
      return event.error;
    case 'AGENT_CANCELLED':
      return event.agentId;
    default: {
      // Exhaustiveness check: must be `never` here.
      // TypeScript will error if any AgentEvent variant is missing above.
      const _exhaustiveCheck: never = event;
      void _exhaustiveCheck;
      return 'unknown';
    }
  }
}

function exhaustiveTurnSwitch(event: TurnEvent): string {
  switch (event.type) {
    case 'TURN_SUBMITTED':
      return event.prompt;
    case 'PREFLIGHT_OK':
      return event.turnId;
    case 'PREFLIGHT_FAIL':
      return event.reason;
    case 'STREAM_START':
      return event.turnId;
    case 'STREAM_DELTA':
      return event.content;
    case 'STREAM_END':
      return event.turnId;
    case 'LLM_RESPONSE_RECEIVED':
      return event.model;
    case 'TOOL_BATCH_READY':
      return String(event.toolCalls.length);
    case 'TOOLS_DONE':
      return event.turnId;
    case 'POST_HOOKS_DONE':
      return event.turnId;
    case 'TURN_COMPLETED':
      return event.response;
    case 'TURN_ERROR':
      return event.error;
    case 'TURN_CANCEL':
      return event.turnId;
    default: {
      const _exhaustiveCheck: never = event;
      void _exhaustiveCheck;
      return 'unknown';
    }
  }
}

function exhaustiveWorkflowSwitch(event: WorkflowEvent): string {
  switch (event.type) {
    case 'WORKFLOW_CHAIN_CREATED':
      return event.chainId;
    case 'WORKFLOW_STATE_CHANGED':
      return `${event.from}->${event.to}`;
    case 'WORKFLOW_REVIEW_COMPLETED':
      return String(event.score);
    case 'WORKFLOW_FIX_ATTEMPTED':
      return String(event.attempt);
    case 'WORKFLOW_GATE_RESULT':
      return event.gate;
    case 'WORKFLOW_CHAIN_PASSED':
      return event.chainId;
    case 'WORKFLOW_CHAIN_FAILED':
      return event.reason;
    case 'WORKFLOW_AUTO_COMMITTED':
      return event.chainId;
    case 'WORKFLOW_CASCADE_ABORTED':
      return event.reason;
    default: {
      const _exhaustiveCheck: never = event;
      void _exhaustiveCheck;
      return 'unknown';
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime tests
// ---------------------------------------------------------------------------

describe('discriminated union — AgentEvent', () => {
  test('AGENT_SPAWNING: agentId and task are accessible without cast', () => {
    const event: AgentEvent = { type: 'AGENT_SPAWNING', agentId: 'agent-1', task: 'build feature' };
    expect(describeAgentEvent(event)).toBe('spawning:agent-1:build feature');
  });

  test('AGENT_COMPLETED: durationMs is typed as number, accessible without cast', () => {
    const event: AgentEvent = { type: 'AGENT_COMPLETED', agentId: 'agent-2', durationMs: 1500 };
    expect(describeAgentEvent(event)).toBe('completed:agent-2:1500ms');
  });

  test('AGENT_FAILED: error string is accessible without cast', () => {
    const event: AgentEvent = { type: 'AGENT_FAILED', agentId: 'agent-3', error: 'timeout', durationMs: 500 };
    expect(describeAgentEvent(event)).toBe('failed:agent-3:timeout');
  });

  test('exhaustive switch — all variants covered (never check in default)', () => {
    const events: AgentEvent[] = [
      { type: 'AGENT_SPAWNING', agentId: 'a1', task: 'task' },
      { type: 'AGENT_RUNNING', agentId: 'a1' },
      { type: 'AGENT_PROGRESS', agentId: 'a1', progress: '50%' },
      { type: 'AGENT_STREAM_DELTA', agentId: 'a1', content: 'chunk', accumulated: 'chunk' },
      { type: 'AGENT_AWAITING_MESSAGE', agentId: 'a1' },
      { type: 'AGENT_AWAITING_TOOL', agentId: 'a1', callId: 'c1', tool: 'bash' },
      { type: 'AGENT_FINALIZING', agentId: 'a1' },
      { type: 'AGENT_COMPLETED', agentId: 'a1', durationMs: 100 },
      { type: 'AGENT_FAILED', agentId: 'a1', error: 'err', durationMs: 50 },
      { type: 'AGENT_CANCELLED', agentId: 'a1' },
    ];
    for (const event of events) {
      expect(exhaustiveAgentSwitch(event)).not.toBe('unknown');
    }
  });
});

describe('discriminated union — TurnEvent', () => {
  test('TURN_SUBMITTED: turnId and prompt are accessible without cast', () => {
    const event: TurnEvent = { type: 'TURN_SUBMITTED', turnId: 'turn-1', prompt: 'hello world' };
    expect(describeTurnEvent(event)).toBe('submitted:turn-1:hello world');
  });

  test('TURN_COMPLETED: response and stopReason are accessible without cast', () => {
    const event: TurnEvent = { type: 'TURN_COMPLETED', turnId: 'turn-2', response: 'hi', stopReason: 'completed' };
    expect(describeTurnEvent(event)).toBe('completed:turn-2:completed');
  });

  test('exhaustive switch — all variants covered (never check in default)', () => {
    const events: TurnEvent[] = [
      { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hello' },
      { type: 'PREFLIGHT_OK', turnId: 't1' },
      { type: 'PREFLIGHT_FAIL', turnId: 't1', reason: 'overflow', stopReason: 'context_overflow' },
      { type: 'STREAM_START', turnId: 't1' },
      { type: 'STREAM_DELTA', turnId: 't1', content: 'hi', accumulated: 'hi' },
      { type: 'STREAM_END', turnId: 't1' },
      { type: 'LLM_RESPONSE_RECEIVED', turnId: 't1', provider: 'anthropic', model: 'claude-4', content: 'hi', toolCallCount: 0, inputTokens: 10, outputTokens: 5 },
      { type: 'TOOL_BATCH_READY', turnId: 't1', toolCalls: ['bash'] },
      { type: 'TOOLS_DONE', turnId: 't1' },
      { type: 'POST_HOOKS_DONE', turnId: 't1' },
      { type: 'TURN_COMPLETED', turnId: 't1', response: 'done', stopReason: 'completed' },
      { type: 'TURN_ERROR', turnId: 't1', error: 'fail', stopReason: 'provider_error' },
      { type: 'TURN_CANCEL', turnId: 't1', stopReason: 'cancelled' },
    ];
    for (const event of events) {
      expect(exhaustiveTurnSwitch(event)).not.toBe('unknown');
    }
  });
});

describe('discriminated union — SessionEvent', () => {
  test('SESSION_STARTED: sessionId, profileId, workingDir are accessible without cast', () => {
    const event: SessionEvent = { type: 'SESSION_STARTED', sessionId: 'sess-1', profileId: 'profile-a', workingDir: '/home/user' };
    if (event.type === 'SESSION_STARTED') {
      // All three fields narrowed correctly:
      expect(event.sessionId).toBe('sess-1');
      expect(event.profileId).toBe('profile-a');
      expect(event.workingDir).toBe('/home/user');
    }
  });

  test('SESSION_RESUMED: turnCount is accessible as number without cast', () => {
    const event: SessionEvent = { type: 'SESSION_RESUMED', sessionId: 'sess-2', turnCount: 5 };
    if (event.type === 'SESSION_RESUMED') {
      // turnCount narrowed as number:
      const count: number = event.turnCount;
      expect(count).toBe(5);
    }
  });
});

describe('discriminated union — WorkflowEvent', () => {
  test('WORKFLOW_CHAIN_CREATED: chainId and task are accessible without cast', () => {
    const event: WorkflowEvent = { type: 'WORKFLOW_CHAIN_CREATED', chainId: 'chain-1', task: 'implement feature' };
    if (event.type === 'WORKFLOW_CHAIN_CREATED') {
      expect(event.chainId).toBe('chain-1');
      expect(event.task).toBe('implement feature');
    }
  });

  test('WORKFLOW_REVIEW_COMPLETED: score and passed are accessible without cast', () => {
    const event: WorkflowEvent = { type: 'WORKFLOW_REVIEW_COMPLETED', chainId: 'chain-2', score: 9, passed: true };
    if (event.type === 'WORKFLOW_REVIEW_COMPLETED') {
      const score: number = event.score;
      const passed: boolean = event.passed;
      expect(score).toBe(9);
      expect(passed).toBe(true);
    }
  });

  test('exhaustive switch — all variants covered (never check in default)', () => {
    const events: WorkflowEvent[] = [
      { type: 'WORKFLOW_CHAIN_CREATED', chainId: 'c1', task: 'build' },
      { type: 'WORKFLOW_STATE_CHANGED', chainId: 'c1', from: 'engineering', to: 'reviewing' },
      { type: 'WORKFLOW_REVIEW_COMPLETED', chainId: 'c1', score: 9, passed: true },
      { type: 'WORKFLOW_FIX_ATTEMPTED', chainId: 'c1', attempt: 1, maxAttempts: 3 },
      { type: 'WORKFLOW_GATE_RESULT', chainId: 'c1', gate: 'typecheck', passed: true },
      { type: 'WORKFLOW_CHAIN_PASSED', chainId: 'c1' },
      { type: 'WORKFLOW_CHAIN_FAILED', chainId: 'c1', reason: 'max retries' },
      { type: 'WORKFLOW_AUTO_COMMITTED', chainId: 'c1' },
      { type: 'WORKFLOW_CASCADE_ABORTED', chainId: 'c1', reason: 'user cancelled' },
    ];
    for (const event of events) {
      expect(exhaustiveWorkflowSwitch(event)).not.toBe('unknown');
    }
  });
});
