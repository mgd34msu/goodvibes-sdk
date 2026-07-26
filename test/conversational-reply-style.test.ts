/**
 * A conversational spawn must not be asked for a completion report.
 *
 * The reported defect: "Hey, are you there?" sent to the owner's ntfy topic
 * came back as a filled-in report — a Summary heading, `Changes: None`,
 * `Decisions:`, `Issues:`, `Uncertainties:` — because the conversation gate
 * classified the message as conversation and then spawned an agent under the
 * standard base prompt, which orders EVERY agent to close with that report.
 *
 * The boundary stripper (channels/completion-report-prose.ts) is the backstop.
 * This is the source: the instruction is not issued in the first place.
 */
import { describe, expect, test } from 'bun:test';
import { buildOrchestratorSystemPrompt } from '../packages/sdk/src/platform/agents/orchestrator-prompts.js';
import { continuationChainOptions } from '../packages/sdk/src/platform/agents/conversation-continuation.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-1',
    task: 'Hey, are you there?',
    template: 'general',
    tools: ['read', 'find'],
    status: 'running',
    startedAt: 0,
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'gather-plan-apply',
    reviewMode: 'none',
    communicationLane: 'direct',
    ...overrides,
  } as AgentRecord;
}

/**
 * Text that appears ONLY when the report contract is being issued. Deliberately
 * not the bare phrase "completion report": the conversational prompt says that
 * phrase too, in the sentence forbidding one.
 */
const REPORT_MARKERS = [
  'You MUST end your final message with a JSON completion report',
  'Structured Output',
  '"archetype"',
  '- Changes: files created/modified',
  '- Uncertainties: anything the caller should verify',
];

describe('a conversational spawn is asked for a reply, not a report', () => {
  test('the report contract is absent from a conversational prompt', () => {
    const prompt = buildOrchestratorSystemPrompt(record({ replyStyle: 'conversational' }));
    for (const marker of REPORT_MARKERS) {
      expect(prompt).not.toContain(marker);
    }
  });

  test('the prompt says plainly what not to emit', () => {
    const prompt = buildOrchestratorSystemPrompt(record({ replyStyle: 'conversational' }));
    expect(prompt).toContain('No completion report, no JSON block');
    expect(prompt).toContain('no "Summary:"');
    // The autonomous opening is false here: someone IS waiting for this answer.
    expect(prompt).not.toContain('No human is monitoring you');
    expect(prompt).toContain('replying to a person');
  });

  test('an archetype that demands a report is overridden, and the override reads last', () => {
    // The built-in engineer role text ends with "Your final message MUST
    // include a structured EngineerReport JSON block", and it is pushed AFTER
    // the output section.
    const prompt = buildOrchestratorSystemPrompt(record({ template: 'engineer', replyStyle: 'conversational' }));
    const override = prompt.indexOf('## Reply style');
    expect(override).toBeGreaterThan(-1);
    expect(prompt.indexOf('EngineerReport')).toBeLessThan(override);
    expect(prompt.slice(override)).toContain('does not apply here');
  });

  test('an ordinary work spawn still carries the whole report contract', () => {
    const prompt = buildOrchestratorSystemPrompt(record({ template: 'engineer' }));
    for (const marker of REPORT_MARKERS) {
      expect(prompt).toContain(marker);
    }
    expect(prompt).not.toContain('## Reply style');
    expect(prompt).toContain('No human is monitoring you');
  });

  test('replyStyle defaults to the report contract when unset', () => {
    expect(buildOrchestratorSystemPrompt(record())).toContain('Structured Output');
  });
});

describe('the continuation half of the gate pairs the same two decisions', () => {
  test('a channel follow-up gets a conversational reply and no chain', () => {
    expect(continuationChainOptions({ surfaceKind: 'ntfy', body: 'and what about the tests?' })).toEqual({
      dangerously_disable_wrfc: true,
      replyStyle: 'conversational',
    });
  });

  test('authorized work keeps the chain and the report', () => {
    expect(continuationChainOptions({
      surfaceKind: 'ntfy',
      metadata: { 'goodvibes.workAuthorized': true },
    })).toEqual({});
  });

  test('a local surface keeps the chain and the report', () => {
    expect(continuationChainOptions({ surfaceKind: 'tui' })).toEqual({});
  });
});
