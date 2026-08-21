/**
 * delete-key-policy.test.ts, isTextBackspace / isTextForwardDelete.
 *
 * These two predicates are the whole reason Backspace and Delete mean the same
 * thing in every text-editing context a terminal front-end puts on screen. The
 * pair is deliberately asymmetric: Backspace always removes a character,
 * Delete only forward-deletes where a moveable cursor exists, so a cursorless
 * end-anchored buffer can treat it as a no-op, or route it to a
 * confirmation-gated clear, without either surface inventing its own rule.
 *
 * The surfaces that consume these (search filters, selection modals, draft
 * buffers) are tested where they live; what is pinned here is the vocabulary
 * they all agree on.
 */
import { describe, expect, test } from 'bun:test';
import { isTextBackspace, isTextForwardDelete } from '@pellux/goodvibes-terminal-shell';

describe('delete-key policy predicates', () => {
  test('isTextBackspace: backspace returns true', () => {
    expect(isTextBackspace('backspace')).toBe(true);
  });

  test('isTextBackspace: delete returns false', () => {
    expect(isTextBackspace('delete')).toBe(false);
  });

  test('isTextBackspace: other keys return false', () => {
    expect(isTextBackspace('a')).toBe(false);
    expect(isTextBackspace('escape')).toBe(false);
    expect(isTextBackspace('')).toBe(false);
  });

  test('isTextForwardDelete: delete returns true', () => {
    expect(isTextForwardDelete('delete')).toBe(true);
  });

  test('isTextForwardDelete: backspace returns false', () => {
    expect(isTextForwardDelete('backspace')).toBe(false);
  });

  test('isTextForwardDelete: other keys return false', () => {
    expect(isTextForwardDelete('a')).toBe(false);
    expect(isTextForwardDelete('escape')).toBe(false);
  });

  test('the two predicates never both claim the same key', () => {
    for (const key of ['backspace', 'delete', 'a', 'escape', 'left', '']) {
      expect(isTextBackspace(key) && isTextForwardDelete(key)).toBe(false);
    }
  });
});
