/**
 * bookmark-modal.test.ts — BookmarkModal list state.
 *
 * The modal owns three numbers that must stay consistent with each other and
 * with a list that mutates underneath them: selectedIndex, scrollOffset, and
 * the entries snapshot. Removal is the interesting case — the manager's list
 * shrinks, and an index that pointed at the last row would otherwise point off
 * the end. These tests pin the wrap-around navigation, the post-removal clamp,
 * and the scroll window that follows the selection.
 *
 * Runs against a real BookmarkManager over a temp directory rather than a
 * stub: the modal calls back into `list()` after every mutation, so a stub
 * that does not re-derive its list would hide exactly the clamping bug this is
 * here to catch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BookmarkManager } from '@pellux/goodvibes-sdk/platform/bookmarks';
import { BookmarkModal } from '@pellux/goodvibes-terminal-shell';

let baseDir: string;
let bookmarkManager: BookmarkManager;
let modal: BookmarkModal;

function seedBookmarks(count: number): void {
  for (let i = 0; i < count; i++) {
    bookmarkManager.toggle(`key_${i}`, `label_${i}`);
  }
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'gv-bookmark-modal-test-'));
  bookmarkManager = new BookmarkManager(baseDir);
  bookmarkManager.clear();
  modal = new BookmarkModal(bookmarkManager);
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('BookmarkModal', () => {
  describe('open()', () => {
    test('sets active to true', () => {
      modal.open();
      expect(modal.active).toBe(true);
    });

    test('loads entries from bookmark manager', () => {
      seedBookmarks(3);
      modal.open();
      expect(modal.entries.length).toBe(3);
    });

    test('resets selectedIndex and scrollOffset', () => {
      seedBookmarks(3);
      modal.open();
      modal.moveDown();
      modal.open();
      expect(modal.selectedIndex).toBe(0);
      expect(modal.scrollOffset).toBe(0);
    });

    test('entries are empty when no bookmarks', () => {
      modal.open();
      expect(modal.entries).toHaveLength(0);
    });
  });

  describe('close()', () => {
    test('sets active to false', () => {
      modal.open();
      modal.close();
      expect(modal.active).toBe(false);
    });
  });

  describe('moveUp() / moveDown()', () => {
    test('moveDown increments selectedIndex', () => {
      seedBookmarks(3);
      modal.open();
      modal.moveDown();
      expect(modal.selectedIndex).toBe(1);
    });

    test('moveDown wraps around', () => {
      seedBookmarks(2);
      modal.open();
      modal.moveDown();
      modal.moveDown();
      expect(modal.selectedIndex).toBe(0);
    });

    test('moveUp wraps to last', () => {
      seedBookmarks(3);
      modal.open();
      modal.moveUp();
      expect(modal.selectedIndex).toBe(2);
    });

    test('no-op when no entries', () => {
      modal.moveDown();
      modal.moveUp();
      expect(modal.selectedIndex).toBe(0);
    });
  });

  describe('getSelected()', () => {
    test('returns null when no entries', () => {
      expect(modal.getSelected()).toBeNull();
    });

    test('returns first entry after open', () => {
      seedBookmarks(2);
      modal.open();
      const sel = modal.getSelected();
      expect(sel).not.toBeNull();
      expect(sel!.key).toBe('key_0');
    });

    test('returns correct entry after navigation', () => {
      seedBookmarks(3);
      modal.open();
      modal.moveDown();
      const sel = modal.getSelected();
      expect(sel!.key).toBe('key_1');
    });
  });

  describe('removeSelected()', () => {
    test('removes the selected entry', () => {
      seedBookmarks(3);
      modal.open();
      const removed = modal.removeSelected();
      expect(removed).not.toBeNull();
      expect(removed!.key).toBe('key_0');
      expect(modal.entries.length).toBe(2);
    });

    test('returns null when no entries', () => {
      modal.open();
      expect(modal.removeSelected()).toBeNull();
    });

    test('clamps selectedIndex after removal', () => {
      seedBookmarks(2);
      modal.open();
      modal.moveDown(); // selectedIndex = 1
      modal.removeSelected();
      // After removing the last entry, the index must clamp back into range.
      expect(modal.selectedIndex).toBe(0);
    });

    test('updates entries after removal', () => {
      seedBookmarks(3);
      modal.open();
      modal.removeSelected();
      expect(modal.entries.every((entry) => entry.key !== 'key_0')).toBe(true);
    });
  });

  describe('scroll clamping', () => {
    test('scrollOffset follows selectedIndex when it exceeds VISIBLE_ROWS', () => {
      const count = BookmarkModal.VISIBLE_ROWS + 3;
      seedBookmarks(count);
      modal.open();
      for (let i = 0; i < BookmarkModal.VISIBLE_ROWS; i++) {
        modal.moveDown();
      }
      expect(modal.scrollOffset).toBeGreaterThan(0);
    });

    test('scrollOffset goes back to 0 when the selection wraps to the top', () => {
      const count = BookmarkModal.VISIBLE_ROWS + 3;
      seedBookmarks(count);
      modal.open();
      for (let i = 0; i < count; i++) {
        modal.moveDown();
      }
      expect(modal.selectedIndex).toBe(0);
      expect(modal.scrollOffset).toBe(0);
    });

    test('setVisibleRows floors at 3 and re-clamps the scroll window', () => {
      seedBookmarks(12);
      modal.open();
      for (let i = 0; i < 11; i++) {
        modal.moveDown();
      }
      modal.setVisibleRows(1);
      expect(modal.visibleRows).toBe(3);
      // selectedIndex 11 with a 3-row window puts the window's top at 9.
      expect(modal.scrollOffset).toBe(9);
    });
  });
});
