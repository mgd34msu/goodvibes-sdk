import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../packages/sdk/src/platform/core/conversation.js';
import { classifyIntent } from '../packages/sdk/src/platform/core/intent-classifier.js';
import { prepareConversationForTurn } from '../packages/sdk/src/platform/core/orchestrator-turn-helpers.js';

function providerRegistry() {
  return {
    getCurrentModel: () => ({
      displayName: 'test-model',
      provider: 'test',
      capabilities: { multimodal: false },
    }),
  };
}

function systemMessages(conversation: ConversationManager): string[] {
  return conversation.getMessageSnapshot()
    .filter((message): message is { role: 'system'; content: string } => message.role === 'system')
    .map((message) => message.content);
}

describe('intent classifier project priming', () => {
  test.each([
    'list all of the things you did, from start to finish, to get qemu working. we will need to make a workflow to follow for other installations of goodvibes. additionally you should list the things that should be installed in the qemu image that were not already there, like the other repls for example. I want to make an easy to follow instruction guide that can be fed to llms so setup can be easier.',
    'write an instruction guide for installing the QEMU image on another laptop.',
    'summarize the workflow we used to get QEMU working.',
    'document the setup steps and list what should be installed in the image.',
    'make an easy to follow guide for future installations.',
  ])('does not classify retrospective documentation as project: %s', (prompt) => {
    const result = classifyIntent(prompt);
    expect(result.signals).toContain('documentation_request');
    expect(result.intent).not.toBe('project');
  });

  test('does not inject project mode for retrospective documentation requests', () => {
    const conversation = new ConversationManager();

    prepareConversationForTurn(
      conversation,
      providerRegistry(),
      'list all of the things you did, from start to finish, to get qemu working. we will need to make a workflow to follow for other installations of goodvibes. additionally you should list the things that should be installed in the qemu image that were not already there. I want to make an easy to follow instruction guide that can be fed to llms so setup can be easier.',
      undefined,
      'session-1',
      null,
    );

    expect(systemMessages(conversation).some((message) => message.includes('[Project mode]'))).toBe(false);
  });

  test('keeps implementation projects eligible for project mode', () => {
    const prompt = 'Build the payment retry workflow, add src/retry.ts and tests, and update CI.';
    const classification = classifyIntent(prompt);
    expect(classification.intent).toBe('project');

    const conversation = new ConversationManager();
    prepareConversationForTurn(
      conversation,
      providerRegistry(),
      prompt,
      undefined,
      'session-1',
      null,
    );

    expect(systemMessages(conversation).some((message) => message.includes('[Project mode]'))).toBe(true);
  });
});
