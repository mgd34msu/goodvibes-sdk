/**
 * owner-profile-forget-by-content.test.ts, docs/owner-profile.md §9.2.
 *
 * A prose line is addressed by its content, never by its position.
 *
 * The hazard is §3's: the owner is a concurrent writer. A line index is only
 * valid against the exact file state that produced it, so between his
 * `profile.read` and his `profile.forget` he can insert a line in his editor
 * and shift everything below it. A positional delete then removes the wrong
 * line and reports success, a false receipt on a delete, which is the class
 * §9.2 exists to prevent, arriving through the front door.
 *
 * No validation closes this. The malformed-index cases (NaN, fractional,
 * negative, out of range, a heading, a blank line) are all guarded already, and
 * none of those guards can help here: a stale index is a perfectly well-formed
 * integer that is in range and points at a real prose line. It is just the
 * wrong one. Only content addressing closes it, and the resolution has to
 * happen inside the commit callback so that a replay after a concurrent edit
 * re-resolves rather than reusing an answer computed from the old document.
 *
 * The first two cases below are the ones that fail against any positional
 * implementation, and they are written the way the hazard actually happens
 * rather than by calling an internal directly.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerOwnerProfileGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/owner-profile.ts';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/index.ts';
import type { ProfileWriteResult } from '../packages/sdk/src/platform/owner-profile/index.ts';

const FIXTURE = [
  "# Mike's profile",
  '',
  '## Commerce',
  '',
  'shipping address: 401 Home St, Lansing, MI 48933, US',
  '',
  '## People',
  '',
  '- Sarah Whitfield, sister, sarah@example.com',
  '- Dave from work, handles the Pellux contracts',
  '',
  '## Notes',
  '',
  '- Allergic to shellfish',
  '- Prefers aisle seats',
  '',
].join('\n');

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-forget-content-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly catalog: GatewayMethodCatalog;
  readonly store: OwnerProfileStore;
  readonly path: string;
}

async function harness(text: string = FIXTURE): Promise<Harness> {
  const dir = mkTemp();
  const path = join(dir, 'owner-profile.md');
  writeFileSync(path, text, 'utf-8');
  const store = new OwnerProfileStore({ path });
  await store.load();
  const catalog = new GatewayMethodCatalog();
  registerOwnerProfileGatewayMethods(catalog, store);
  return { catalog, store, path };
}

const ctx = { context: { admin: true } } as const;
const OWNER = { authority: 'owner-direct' } as const;

/** The line index `profile.read` reports for a line, as a caller would see it. */
function reportedIndexOf(store: OwnerProfileStore, heading: string, text: string): number {
  const section = store.read().sections.find((entry) => entry.heading === heading);
  const line = section?.prose.find((entry) => entry.text.trim() === text);
  return line?.lineIndex ?? -1;
}

describe('§9.2 — the concurrent-edit hazard a positional delete cannot survive', () => {
  test('he inserts a line above it between the read and the forget; the RIGHT line goes', async () => {
    const { catalog, store, path } = await harness();

    // 1. He reads. The line he wants gone is at this position, right now.
    const staleIndex = reportedIndexOf(store, 'Notes', '- Prefers aisle seats');
    expect(staleIndex).toBeGreaterThan(0);

    // 2. He edits the file in his editor, inserting a line ABOVE it. Everything
    //    below shifts down by one, so `staleIndex` now names a different line.
    const shifted = FIXTURE.replace(
      '- Allergic to shellfish\n',
      '- Allergic to shellfish\n- Keeps a spare key with the neighbour\n',
    );
    writeFileSync(path, shifted, 'utf-8');

    // What the old positional call would have deleted: not the line he named.
    const nowAtStaleIndex = shifted.split('\n')[staleIndex];
    expect(nowAtStaleIndex).toBe('- Keeps a spare key with the neighbour');

    // 3. He forgets by CONTENT. The commit detects his write, reloads, and
    //    re-resolves the text against the new document.
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, section: 'Notes', text: '- Prefers aisle seats' },
    }) as ProfileWriteResult;

    expect(result.ok).toBe(true);
    const after = readFileSync(path, 'utf-8');
    expect(after).not.toContain('Prefers aisle seats');
    // His inserted line survived, a positional delete would have eaten it.
    expect(after).toContain('- Keeps a spare key with the neighbour');
    expect(after).toContain('- Allergic to shellfish');
  });

  test('text that no longer exists removes nothing and says so', async () => {
    const { catalog, path } = await harness();

    // He deleted it himself in his editor a moment ago.
    writeFileSync(path, FIXTURE.replace('- Prefers aisle seats\n', ''), 'utf-8');
    const before = readFileSync(path);

    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, section: 'Notes', text: '- Prefers aisle seats' },
    }) as ProfileWriteResult;

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not in Notes any more');
    expect(result.changes).toEqual([]);
    expect(result.disclosure).toBe('');
    // Nothing was written at all.
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test('a near miss is a refusal, never the nearest line', async () => {
    const { catalog, path } = await harness();
    const before = readFileSync(path);
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      // One word off. A fuzzy matcher would take "Prefers aisle seats".
      body: { ...OWNER, section: 'Notes', text: '- Prefers window seats' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('the verb no longer accepts a position at all', () => {
  test('lineIndex is refused rather than ignored', async () => {
    const { catalog, store, path } = await harness();
    const index = reportedIndexOf(store, 'Notes', '- Prefers aisle seats');
    const before = readFileSync(path);

    await expect(catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, lineIndex: index },
    })).rejects.toThrow(/does not take a lineIndex/);

    // Silently ignoring it would have been worse: the caller would believe a
    // positional delete happened.
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test('the input schema exposes section and text, and no lineIndex', async () => {
    const { catalog } = await harness();
    const schema = catalog.get('profile.forget')?.inputSchema as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    expect(schema?.properties).toHaveProperty('section');
    expect(schema?.properties).toHaveProperty('text');
    expect(schema?.properties).not.toHaveProperty('lineIndex');
    expect(schema?.required ?? []).toContain('authority');
  });

  test('neither a fieldId nor a section+text pair is a 400 naming both forms', async () => {
    const { catalog } = await harness();
    await expect(catalog.invoke('profile.forget', { ...ctx, body: { ...OWNER } }))
      .rejects.toThrow(/needs either a fieldId, or a section and the exact text/);
    // A half-pair is not a pair.
    await expect(catalog.invoke('profile.forget', { ...ctx, body: { ...OWNER, section: 'Notes' } }))
      .rejects.toThrow(/needs either a fieldId/);
    await expect(catalog.invoke('profile.forget', { ...ctx, body: { ...OWNER, text: '- x' } }))
      .rejects.toThrow(/needs either a fieldId/);
  });

  test('read output still reports lineIndex — the model keeps it, the verb does not', async () => {
    const { catalog } = await harness();
    const document = await catalog.invoke('profile.read', { ...ctx, body: {} }) as {
      sections: readonly { heading: string; prose: readonly { lineIndex: number }[] }[];
    };
    const notes = document.sections.find((entry) => entry.heading === 'Notes');
    expect(notes?.prose[0]?.lineIndex).toBeGreaterThan(0);
  });
});

describe('content addressing across the closed sections it has to serve', () => {
  test.each([
    ['People', '- Dave from work, handles the Pellux contracts'],
    ['Notes', '- Allergic to shellfish'],
  ])('a line in %s is removable by its text', async (section, text) => {
    const { catalog, path } = await harness();
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, section, text },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf-8')).not.toContain(text.replace('- ', ''));
  });

  test('People stays reachable for deletion even though section() refuses it', async () => {
    // `store.section('People')` returns undefined by design, no enumerate-all
    // call exists. Deleting one named line must still work.
    const { store } = await harness();
    expect(store.section('People')).toBeUndefined();
    const result = await store.forget({
      ...OWNER,
      section: 'People',
      text: '- Sarah Whitfield, sister, sarah@example.com',
    });
    expect(result.ok).toBe(true);
  });

  test('surrounding whitespace is equality, not fuzziness', async () => {
    const { catalog, path } = await harness();
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, section: 'Notes', text: '   - Allergic to shellfish   ' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf-8')).not.toContain('shellfish');
  });

  test('a section that does not exist removes nothing and says which one', async () => {
    const { catalog, path } = await harness();
    const before = readFileSync(path);
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, section: 'Boat', text: '- anything' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Boat');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test('two identical lines refuse rather than remove one and report success', async () => {
    const { catalog, path } = await harness([
      "# Mike's profile",
      '',
      '## Notes',
      '',
      '- Allergic to shellfish',
      '- Allergic to shellfish',
      '',
    ].join('\n'));
    const before = readFileSync(path);
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, section: 'Notes', text: '- Allergic to shellfish' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('2 lines');
    // Removing "one of them" would report a deletion with the text still there.
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('the mechanical-field path is unchanged', () => {
  test('forget by fieldId still removes the value and its history', async () => {
    const { catalog, path } = await harness();
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, fieldId: 'commerce.shippingAddress' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf-8')).not.toContain('401 Home St');
  });

  test('a field delete survives a concurrent edit by replaying, as it did before', async () => {
    const { catalog, path } = await harness();
    writeFileSync(path, `${FIXTURE}\n- A line he added just now\n`, 'utf-8');
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, fieldId: 'commerce.shippingAddress' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    const after = readFileSync(path, 'utf-8');
    expect(after).not.toContain('401 Home St');
    expect(after).toContain('- A line he added just now');
  });
});

describe('§9.2 — the list marker is syntax, not content', () => {
  test('the bare prose he actually said deletes the line', async () => {
    const { catalog, path } = await harness();
    // He says "forget that I'm allergic to shellfish". The `- ` in front of it
    // in the file is a Markdown artefact he never uttered, and requiring it
    // back would be asking a model to guess at our storage format.
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, section: 'Notes', text: 'Allergic to shellfish' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf-8')).not.toContain('shellfish');
  });

  test('the stored form deletes the same line', async () => {
    const { catalog, path } = await harness();
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, section: 'Notes', text: '- Allergic to shellfish' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf-8')).not.toContain('shellfish');
  });

  test.each(['* Starred note', '+ Plus note', '1. Ordered note', '1) Paren note'])(
    'the %s marker style normalises on both sides',
    async (stored) => {
      const bare = stored.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
      const { catalog, path } = await harness([
        "# Mike's profile", '', '## Notes', '', stored, '',
      ].join('\n'));
      const result = await catalog.invoke('profile.forget', {
        ...ctx,
        body: { ...OWNER, section: 'Notes', text: bare },
      }) as ProfileWriteResult;
      expect(result.ok).toBe(true);
      expect(readFileSync(path, 'utf-8')).not.toContain(bare);
    },
  );

  test('a leading minus that is NOT a marker is preserved', async () => {
    // `-5 degrees` has no space after the minus, so it is content, not syntax.
    const { catalog, path } = await harness([
      "# Mike's profile", '', '## Notes', '', '- Freezer runs at -5 degrees', '',
    ].join('\n'));
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, section: 'Notes', text: 'Freezer runs at -5 degrees' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf-8')).not.toContain('Freezer');
  });

  test('normalising cannot delete the wrong line — ambiguity still refuses', async () => {
    // `- Foo` and a bare `Foo` now both normalise to `Foo`. That is two
    // matches, which is a refusal, not a guess. Deleting the wrong one of two
    // identical lines is unrecoverable; asking is not.
    const { catalog, path } = await harness([
      "# Mike's profile", '', '## Notes', '', '- Allergic to shellfish', 'Allergic to shellfish', '',
    ].join('\n'));
    const before = readFileSync(path);
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, section: 'Notes', text: 'Allergic to shellfish' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('2 lines');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test('a marker with nothing after it is not a way to match everything', async () => {
    const { catalog, path } = await harness();
    const before = readFileSync(path);
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { ...OWNER, section: 'Notes', text: '-' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});
