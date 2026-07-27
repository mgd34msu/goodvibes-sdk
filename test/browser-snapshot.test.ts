import { describe, expect, test } from 'bun:test';
import type { Locator, Page } from 'playwright-core';
import { resolveRef, SnapshotStore, StaleElementError } from '../packages/sdk/src/platform/browser/browser-snapshot.js';
import type { BrowserSnapshot } from '../packages/sdk/src/platform/browser/browser-types.js';

function snapshotWith(url: string): BrowserSnapshot {
  return {
    sessionId: 'b1',
    pageId: 'b1p1',
    url,
    title: 'Test',
    snapshotId: 's1',
    elements: [
      { ref: 'e1', role: 'button', name: 'Send it', tag: 'button', selector: 'html > body button', depth: 3, submits: true, frameChain: [] },
    ],
    truncated: false,
  };
}

function fakePage(options: {
  readonly url: string;
  readonly count: number;
  readonly actual?: { readonly tag: string; readonly name: string };
}): Page {
  const locator = {
    evaluate: async () => options.actual ?? { tag: 'button', name: 'Send it' },
    first: () => locator,
  } as unknown as Locator;
  return {
    url: () => options.url,
    locator: () => ({ ...locator, count: async () => options.count, first: () => locator }),
  } as unknown as Page;
}

describe('element refs', () => {
  test('a ref resolves when the element is still the one the snapshot recorded', async () => {
    const page = fakePage({ url: 'https://example.com/', count: 1 });
    const resolved = await resolveRef(page, snapshotWith('https://example.com/'), 'e1');
    expect(resolved.element.name).toBe('Send it');
  });

  test('acting without a snapshot is refused rather than guessed', async () => {
    const page = fakePage({ url: 'https://example.com/', count: 1 });
    await expect(resolveRef(page, null, 'e1')).rejects.toThrow(StaleElementError);
  });

  test('a ref that is not in the snapshot is refused', async () => {
    const page = fakePage({ url: 'https://example.com/', count: 1 });
    await expect(resolveRef(page, snapshotWith('https://example.com/'), 'e99')).rejects.toThrow(/not in the current snapshot/);
  });

  test('a ref is refused once the page has navigated away from the snapshot', async () => {
    const page = fakePage({ url: 'https://example.com/other', count: 1 });
    await expect(resolveRef(page, snapshotWith('https://example.com/'), 'e1')).rejects.toThrow(/moved from/);
  });

  test('a ref whose element has disappeared is refused', async () => {
    const page = fakePage({ url: 'https://example.com/', count: 0 });
    await expect(resolveRef(page, snapshotWith('https://example.com/'), 'e1')).rejects.toThrow(/no longer present/);
  });

  test('a ref that now points at a different element is refused instead of clicked', async () => {
    const page = fakePage({
      url: 'https://example.com/',
      count: 1,
      actual: { tag: 'button', name: 'Delete everything' },
    });
    await expect(resolveRef(page, snapshotWith('https://example.com/'), 'e1'))
      .rejects.toThrow(/points at a different element/);
  });

  test('every refusal tells the caller how to recover', async () => {
    const page = fakePage({ url: 'https://example.com/', count: 0 });
    try {
      await resolveRef(page, snapshotWith('https://example.com/'), 'e1');
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as StaleElementError).fix).toContain('snapshot');
    }
  });
});

describe('snapshot store', () => {
  test('snapshots are kept per page and cleared independently', () => {
    const store = new SnapshotStore();
    store.set(snapshotWith('https://example.com/'));
    expect(store.get('b1', 'b1p1')?.url).toBe('https://example.com/');
    expect(store.get('b1', 'b1p2')).toBeNull();
    store.clear('b1', 'b1p1');
    expect(store.get('b1', 'b1p1')).toBeNull();
  });
});
