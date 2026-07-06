/**
 * conversation-tool-result-content.test.ts
 *
 * Regression coverage: ConversationManager.addToolResults() must never
 * silently discard `result.output` when `result.success` is false. Before the
 * fix, any failing tool result with `output` set but `error` unset rendered as
 * the literal string "Unknown error" to the model, even though `output` held
 * the full diagnostic payload (e.g. exec's exit code / stdout / stderr).
 */

import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../packages/sdk/src/platform/core/conversation.js';

describe('ConversationManager.addToolResults — content selection', () => {
  test('failure with output present and error absent surfaces the output, not "Unknown error"', () => {
    const cm = new ConversationManager();
    const output = JSON.stringify({ exit_code: 1, stdout: 'running tests...', stderr: 'FAIL: 2 tests failed' });
    cm.addToolResults([{ callId: 'c1', success: false, output }]);

    const msgs = cm.getMessagesForLLM();
    const content = (msgs[0] as { content: string }).content;
    expect(content).toContain(output);
    expect(content).not.toContain('Unknown error');
  });

  test('failure with error only (no output) still shows the error message — regression guard', () => {
    const cm = new ConversationManager();
    cm.addToolResults([{ callId: 'c2', success: false, error: 'permission denied' }]);

    const msgs = cm.getMessagesForLLM();
    expect((msgs[0] as { content: string }).content).toBe('Error: permission denied');
  });

  test('failure with both output and error present shows both, not just one', () => {
    const cm = new ConversationManager();
    cm.addToolResults([{ callId: 'c3', success: false, output: 'partial', error: 'timeout' }]);

    const msgs = cm.getMessagesForLLM();
    const content = (msgs[0] as { content: string }).content;
    expect(content).toContain('partial');
    expect(content).toContain('timeout');
  });

  test('success with neither output nor error uses the default message — unchanged', () => {
    const cm = new ConversationManager();
    cm.addToolResults([{ callId: 'c4', success: true }]);

    const msgs = cm.getMessagesForLLM();
    expect((msgs[0] as { content: string }).content).toBe('Tool completed successfully.');
  });

  test('success with output present shows the output — unchanged', () => {
    const cm = new ConversationManager();
    cm.addToolResults([{ callId: 'c5', success: true, output: 'file content' }]);

    const msgs = cm.getMessagesForLLM();
    expect((msgs[0] as { content: string }).content).toBe('file content');
  });
});
