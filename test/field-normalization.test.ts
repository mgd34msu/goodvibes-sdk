/**
 * Content/body field normalization tests.
 *
 * Exercises the real exported normalization helpers:
 *   - readCompanionChatMessageBody (companion-chat-routes.ts)
 *   - readSharedSessionMessageBody (daemon/runtime-session-routes.ts)
 *
 * These helpers are the canonical implementation of field preference order.
 */
import { describe, expect, test } from 'bun:test';
import { readCompanionChatMessageBody } from '../packages/sdk/src/platform/companion/companion-chat-routes.js';
import { readSharedSessionMessageBody } from '../packages/daemon-sdk/src/runtime-session-routes.js';

// ---------------------------------------------------------------------------
// Companion-chat normalization: body > content > ''
// ---------------------------------------------------------------------------

describe('companion-chat field normalization', () => {
  test('reads from body field', () => {
    expect(readCompanionChatMessageBody({ body: 'hello from body' })).toBe('hello from body');
  });

  test('falls back to content field', () => {
    expect(readCompanionChatMessageBody({ content: 'hello from content' })).toBe('hello from content');
  });

  test('prefers body over content when both present', () => {
    expect(readCompanionChatMessageBody({ body: 'body wins', content: 'content loses' })).toBe('body wins');
  });

  test('returns empty string when neither present', () => {
    expect(readCompanionChatMessageBody({})).toBe('');
  });

  test('returns empty string on empty body', () => {
    expect(readCompanionChatMessageBody({ body: '' })).toBe('');
  });

  test('400 semantic: non-empty required — empty result triggers rejection', () => {
    const result = readCompanionChatMessageBody({ other: 'ignored' });
    expect(result).toBe('');
    // Caller must check for empty and return 400
    expect(result.trim()).toBe('');
  });

  test('does not trim content (caller responsibility)', () => {
    expect(readCompanionChatMessageBody({ body: '  padded  ' })).toBe('  padded  ');
  });

  test('ignores message field (not in companion-chat normalization)', () => {
    expect(readCompanionChatMessageBody({ message: 'ignored' })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Shared-session normalization: body > ''
// ---------------------------------------------------------------------------

describe('shared-session field normalization', () => {
  test('reads from body field (canonical)', () => {
    expect(readSharedSessionMessageBody({ body: 'hello' })).toBe('hello');
  });

  test('trims whitespace from body', () => {
    expect(readSharedSessionMessageBody({ body: '  padded  ' })).toBe('padded');
  });

  test('ignores message field', () => {
    expect(readSharedSessionMessageBody({ message: 'from message' })).toBe('');
  });

  test('ignores text field', () => {
    expect(readSharedSessionMessageBody({ text: 'from text' })).toBe('');
  });

  test('prefers body over message and text', () => {
    expect(readSharedSessionMessageBody({ body: 'body', message: 'msg', text: 'txt' })).toBe('body');
  });

  test('returns empty when body absent even if message and text are present', () => {
    expect(readSharedSessionMessageBody({ message: 'msg', text: 'txt' })).toBe('');
  });

  test('returns empty string when all fields absent', () => {
    expect(readSharedSessionMessageBody({})).toBe('');
  });

  test('returns empty string when body is empty string', () => {
    expect(readSharedSessionMessageBody({ body: '   ' })).toBe('');
  });

  test('does not fall through to content field (not in shared-session normalization)', () => {
    // shared-session uses body/message/text; content is companion-chat only
    expect(readSharedSessionMessageBody({ content: 'companion only' })).toBe('');
  });

  test('non-string values are ignored', () => {
    expect(readSharedSessionMessageBody({ body: 42 as unknown as string })).toBe('');
    expect(readSharedSessionMessageBody({ message: null as unknown as string })).toBe('');
  });
});
