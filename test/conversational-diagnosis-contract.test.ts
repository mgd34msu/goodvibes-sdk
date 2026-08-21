/**
 * conversational-diagnosis-contract.test.ts, what a turn owes when something
 * is broken, pinned as text.
 *
 * Two failures in one session put these lines in the contract:
 *
 *  1. A turn "fixed" a stalled agent by driving the owner's tmux pane,
 *     send-keys into the shell he was using, escape-sequence garbage across his
 *     prompt, and a relaunch typed into his terminal. He had asked what was
 *     wrong, not for a restart.
 *  2. A turn declared the wake word fixed ONE MESSAGE after measuring -90 dB,
 *     silence, from the same microphone.
 *
 * The exec guard now refuses the first mechanically (owner-terminal-guard.ts).
 * The second has no mechanism and never will: it is a claim, and the only place
 * a claim can be governed is the contract. So both are stated, and the text is
 * pinned here, in the CONVERSATIONAL prompt and in a hosted session's base
 * prompt, and NOT smuggled into the autonomous one, where a different contract
 * applies.
 */
import { describe, expect, test } from 'bun:test';
import { CONVERSATIONAL_DIAGNOSIS_SECTION } from '../packages/sdk/src/platform/agents/conversational-contract.ts';
import { buildOrchestratorSystemPrompt } from '../packages/sdk/src/platform/agents/orchestrator-prompts.ts';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.ts';

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-1',
    task: 'why is the wake word not working?',
    template: 'general',
    tools: ['read', 'exec'],
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

describe('the diagnosis contract text', () => {
  test('proportionality: report and propose, do not restart the owner applications', () => {
    expect(CONVERSATIONAL_DIAGNOSIS_SECTION).toContain('Report the state and propose the fix');
    expect(CONVERSATIONAL_DIAGNOSIS_SECTION).toContain("restart the owner's applications");
    expect(CONVERSATIONAL_DIAGNOSIS_SECTION).toContain('type into their terminal');
  });

  test('the terminal rule is named, in the same words the exec guard refuses in', () => {
    expect(CONVERSATIONAL_DIAGNOSIS_SECTION).toContain('untouchable');
    expect(CONVERSATIONAL_DIAGNOSIS_SECTION).toContain('tmux session you did not create');
  });

  test('a "fixed" claim requires the live evidence it rests on', () => {
    expect(CONVERSATIONAL_DIAGNOSIS_SECTION).toContain('requires the live evidence it rests on');
    expect(CONVERSATIONAL_DIAGNOSIS_SECTION).toContain('one message after the measurement');
  });
});

describe('where the contract is issued', () => {
  test('a conversational spawn carries it', () => {
    const prompt = buildOrchestratorSystemPrompt(record({ replyStyle: 'conversational' }));
    expect(prompt).toContain(CONVERSATIONAL_DIAGNOSIS_SECTION);
  });

  test('an autonomous spawn does not — a working agent runs under its own contract', () => {
    const prompt = buildOrchestratorSystemPrompt(record());
    expect(prompt).not.toContain(CONVERSATIONAL_DIAGNOSIS_SECTION);
  });

  test('it survives the archetype overlay, which is appended after it', () => {
    const prompt = buildOrchestratorSystemPrompt(record({ replyStyle: 'conversational', template: 'engineer' }));
    expect(prompt).toContain('Report the state and propose the fix');
  });
});
