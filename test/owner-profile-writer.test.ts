/**
 * owner-profile-writer.test.ts
 *
 * The writer's central promise: a write changes exactly the lines it should and
 * leaves every other byte identical. Design §14 items 4, 5, 7, 8, 14, 15 and 17,
 * plus the directory-level watch that keeps hand edits visible after the file's
 * inode has been replaced by an atomic write.
 *
 * Items 14 and 15 are written first and deliberately: they are the ones a
 * plausible-looking implementation gets wrong, and they are what forced the
 * writer to be index-addressed rather than a re-serialisation of the model.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/store.ts';
import { parseProfileDocument } from '../packages/sdk/src/platform/owner-profile/document.ts';
import {
  persistProfileText,
  setField,
  type ProfilePersistIo,
} from '../packages/sdk/src/platform/owner-profile/writer.ts';

const dirs: string[] = [];
function tempProfile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-ownerprofile-'));
  dirs.push(dir);
  const path = join(dir, 'owner-profile.md');
  writeFileSync(path, content, 'utf-8');
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** owner-direct write identity, so each case says only what it is about. */
const OWNER = { authority: 'owner-direct', surface: 'tui', said: 'set it to this' } as const;

async function loadedStore(path: string): Promise<OwnerProfileStore> {
  const store = new OwnerProfileStore({ path });
  await store.load();
  return store;
}

/**
 * A document carrying every hazard §4.4 promises to preserve: an HTML comment he
 * wrote, a markdown table, a fenced block containing a FAKE heading and a FAKE
 * field, a deeply indented child bullet, and a section he invented.
 */
const HAZARDS = [
  "# Mike's profile",
  '',
  '<!-- my own note, not machinery -->',
  '',
  '## Location',
  '',
  'timezone: America/Detroit',
  'city: Lansing, MI',
  '',
  '## Notes',
  '',
  '| thing | value |',
  '|---|---|',
  '| gym | the Y |',
  '',
  '```',
  '## Notes',
  'timezone: Europe/Berlin',
  '```',
  '',
  '- Outer bullet',
  '    - Gym: the Y on Michigan Ave',
  '',
  '## Something I invented',
  '',
  'units: metric',
  'some key: some value',
  '',
].join('\n');

describe('§14.14 — odd content survives a write to another section byte-for-byte', () => {
  test('a fenced fake heading and fake field are never treated as real', () => {
    const projection = parseProfileDocument({ path: '/x', text: HAZARDS, exists: true });

    // The fenced "## Notes" did not open a section, so section tracking survived
    // it and the invented heading below is still found.
    expect(projection.sections.map((section) => section.heading)).toEqual([
      '',
      'Location',
      'Notes',
      'Something I invented',
    ]);
    // The fenced `timezone:` is NOT the timezone field — the real one is.
    expect(projection.fields.get('location.timezone')?.value).toBe('America/Detroit');
    expect(projection.fields.get('location.timezone')?.lineIndex).toBe(6);
    // `units: metric` sits under a heading that is not a known section, so it is
    // prose, not `preferences.units`.
    expect(projection.fields.has('preferences.units')).toBe(false);
    // A four-space-indented `Gym:` under a bullet is prose, not a field.
    expect(projection.fields.size).toBe(2);
  });

  test('writing one field leaves every other line byte-identical', async () => {
    const path = tempProfile(HAZARDS);
    const store = await loadedStore(path);

    const result = await store.set({ ...OWNER, fieldId: 'location.timezone', value: 'Europe/Lisbon', date: '2026-07-27' });
    expect(result.ok).toBe(true);

    const before = HAZARDS.split('\n');
    const after = readFileSync(path, 'utf-8').split('\n');

    // The exact expected document: line 6 rewritten, and the history comment
    // plus one blank inserted below the Location field block. Asserting the
    // whole array is what makes this a byte-for-byte claim rather than a
    // spot-check that a re-serialising writer could still pass.
    const expected = [...before];
    expected[6] = 'timezone: Europe/Lisbon — tui, 2026-07-27, "set it to this"';
    expected.splice(9, 0, '<!-- was: timezone: America/Detroit (superseded 2026-07-27) -->', '');
    expect(after).toEqual(expected);

    // The fenced content specifically is untouched.
    expect(after.join('\n')).toContain('```\n## Notes\ntimezone: Europe/Berlin\n```');
    expect(after.join('\n')).toContain('| gym | the Y |');
    expect(after.join('\n')).toContain('    - Gym: the Y on Michigan Ave');
    expect(after.join('\n')).toContain('<!-- my own note, not machinery -->');
  });

  test('the invented section and its lines are still located after the write', async () => {
    const path = tempProfile(HAZARDS);
    const store = await loadedStore(path);
    await store.set({ ...OWNER, fieldId: 'location.timezone', value: 'Europe/Lisbon', date: '2026-07-27' });

    const invented = store.section('Something I invented');
    expect(invented).toBeDefined();
    expect(invented?.prose.map((line) => line.text)).toEqual(['units: metric', 'some key: some value']);
  });
});

describe('§14.15 — his edits are authoritative and are never restored', () => {
  const DOC = [
    '## Location',
    '',
    'timezone: America/Detroit',
    'city: Lansing, MI',
    '',
    '## Notes',
    '',
    '- Allergic to shellfish',
    '',
  ].join('\n');

  test('an externally rewritten line is served as he rewrote it', async () => {
    const path = tempProfile(DOC);
    const store = await loadedStore(path);
    expect(store.get('location.city')?.value).toBe('Lansing, MI');

    writeFileSync(path, DOC.replace('city: Lansing, MI', 'city: Ann Arbor, MI  # mine now'), 'utf-8');
    await store.load();

    expect(store.get('location.city')?.value).toBe('Ann Arbor, MI  # mine now');
  });

  test('a line he deleted stays deleted across later writes', async () => {
    const path = tempProfile(DOC);
    const store = await loadedStore(path);
    // A machine write first, so there is a superseded record that could try to
    // resurrect the value later.
    await store.set({ ...OWNER, fieldId: 'location.city', value: 'Detroit, MI', date: '2026-07-26' });
    expect(readFileSync(path, 'utf-8')).toContain('<!-- was: city: Lansing, MI (superseded 2026-07-26) -->');

    // He deletes both the line and its history by hand.
    const handEdited = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((line) => !line.startsWith('city:') && !line.startsWith('<!-- was:'))
      .join('\n');
    writeFileSync(path, handEdited, 'utf-8');
    await store.load();
    expect(store.get('location.city')).toBeUndefined();

    // An unrelated write must not bring it back.
    await store.set({ ...OWNER, fieldId: 'location.timezone', value: 'Europe/Lisbon', date: '2026-07-27' });
    const after = readFileSync(path, 'utf-8');
    expect(after).not.toContain('Lansing, MI');
    expect(after).not.toContain('Detroit, MI');
    expect(store.get('location.city')).toBeUndefined();
  });

  test('a deleted line is never re-learned from its own superseded record', async () => {
    const path = tempProfile(DOC);
    const store = await loadedStore(path);
    await store.set({ ...OWNER, fieldId: 'location.city', value: 'Detroit, MI', date: '2026-07-26' });

    // He deletes the active line and LEAVES the history comment, which is the
    // case §4.5 is really about: the record of the old value is still on disk,
    // and nothing may resurrect the field from it.
    writeFileSync(
      path,
      readFileSync(path, 'utf-8').split('\n').filter((line) => !line.startsWith('city:')).join('\n'),
      'utf-8',
    );
    await store.load();

    expect(store.get('location.city')).toBeUndefined();
    expect(store.provenance('location.city').present).toBe(false);
    // The history is still readable — it is his, and deleting it is his call —
    // but it is history, not a value.
    expect(store.provenance('location.city').superseded).toHaveLength(1);

    await store.set({ ...OWNER, fieldId: 'location.timezone', value: 'Europe/Lisbon', date: '2026-07-27' });
    expect(store.get('location.city')).toBeUndefined();
    expect(readFileSync(path, 'utf-8').split('\n').some((line) => line.startsWith('city:'))).toBe(false);
  });

  test('a line whose provenance suffix he stripped reports no provenance', async () => {
    const path = tempProfile(DOC);
    const store = await loadedStore(path);
    await store.set({ ...OWNER, fieldId: 'location.city', value: 'Detroit, MI', date: '2026-07-26' });
    expect(store.provenance('location.city').provenance?.surface).toBe('tui');

    writeFileSync(
      path,
      readFileSync(path, 'utf-8').replace(/^city: .*$/m, 'city: Detroit, MI'),
      'utf-8',
    );
    await store.load();

    const report = store.provenance('location.city');
    expect(report.present).toBe(true);
    expect(report.provenance).toBeNull();
    expect(report.handEdited).toBe(true);
  });
});

describe('§14.4 and §14.5 — provenance round-trips and is retrievable', () => {
  const DOC = ['## Commerce', '', 'currency: USD', ''].join('\n');

  test('surface, date and verbatim survive the file', async () => {
    const path = tempProfile(DOC);
    const store = await loadedStore(path);

    await store.set({
      authority: 'owner-direct',
      surface: 'agent',
      said: 'ship it to my office instead',
      date: '2026-07-27',
      fieldId: 'commerce.shippingAddress',
      value: '200 Office Way, Lansing, MI 48933, US',
    });

    expect(readFileSync(path, 'utf-8')).toContain(
      'shipping address: 200 Office Way, Lansing, MI 48933, US — agent, 2026-07-27, "ship it to my office instead"',
    );
    const reloaded = await loadedStore(path);
    expect(reloaded.get('commerce.shippingAddress')?.provenance).toEqual({
      surface: 'agent',
      date: '2026-07-27',
      said: 'ship it to my office instead',
    });
  });

  test('provenance returns the suffix plus every superseded predecessor', async () => {
    const path = tempProfile(DOC);
    const store = await loadedStore(path);

    await store.set({ authority: 'owner-direct', surface: 'tui', said: 'first', date: '2026-07-20', fieldId: 'commerce.shippingTier', value: 'standard' });
    await store.set({ authority: 'owner-direct', surface: 'tui', said: 'second', date: '2026-07-25', fieldId: 'commerce.shippingTier', value: 'express' });
    await store.set({ authority: 'owner-direct', surface: 'voice', said: 'third', date: '2026-07-27', fieldId: 'commerce.shippingTier', value: 'overnight' });

    const report = store.provenance('commerce.shippingTier');
    expect(report.provenance).toEqual({ surface: 'voice', date: '2026-07-27', said: 'third' });
    expect(report.superseded.map((entry) => entry.value)).toEqual(['standard', 'express']);
    expect(report.superseded.map((entry) => entry.supersededOn)).toEqual(['2026-07-25', '2026-07-27']);
    expect(report.superseded[0]?.provenance?.said).toBe('first');
  });
});

describe('§14.7 — deletion deletes, including its history', () => {
  test('after forget the value is gone from memory and from the bytes', async () => {
    const path = tempProfile(['## Contact', '', 'phone: +1 517 555 0134', ''].join('\n'));
    const store = await loadedStore(path);

    await store.set({ ...OWNER, fieldId: 'contact.phone', value: '+1 517 555 9999', date: '2026-07-27' });
    expect(readFileSync(path, 'utf-8')).toContain('<!-- was: phone: +1 517 555 0134');

    const result = await store.forget({ authority: 'owner-direct', fieldId: 'contact.phone' });
    expect(result.ok).toBe(true);

    const bytes = readFileSync(path, 'utf-8');
    expect(store.get('contact.phone')).toBeUndefined();
    expect(bytes).not.toContain('555 0134');
    expect(bytes).not.toContain('555 9999');
    expect(bytes).not.toContain('<!-- was:');
    expect(store.provenance('contact.phone').superseded).toHaveLength(0);
  });

  test('forgetting something that was not there does not report success', async () => {
    const path = tempProfile(['## Contact', '', 'phone: +1 517 555 0134', ''].join('\n'));
    const store = await loadedStore(path);

    const result = await store.forget({ authority: 'owner-direct', fieldId: 'contact.email' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('nothing to forget');
  });
});

describe('§14.8 — supersede keeps history and undo restores it', () => {
  test('the old value survives as a comment and undo puts it back', async () => {
    const path = tempProfile(['## Commerce', '', 'shipping address: 401 Home St, Lansing, MI 48933, US', 'currency: USD', ''].join('\n'));
    const store = await loadedStore(path);

    await store.set({
      authority: 'owner-direct',
      surface: 'tui',
      said: 'ship it to my office instead',
      date: '2026-07-27',
      fieldId: 'commerce.shippingAddress',
      value: '200 Office Way, Lansing, MI 48933, US',
    });

    expect(store.get('commerce.shippingAddress')?.value).toBe('200 Office Way, Lansing, MI 48933, US');
    expect(readFileSync(path, 'utf-8')).toContain(
      '<!-- was: shipping address: 401 Home St, Lansing, MI 48933, US (superseded 2026-07-27) -->',
    );

    const undone = await store.undo({ authority: 'owner-direct', fieldId: 'commerce.shippingAddress' });
    expect(undone.ok).toBe(true);
    expect(store.get('commerce.shippingAddress')?.value).toBe('401 Home St, Lansing, MI 48933, US');

    const bytes = readFileSync(path, 'utf-8');
    expect(bytes).not.toContain('200 Office Way');
    expect(bytes).not.toContain('<!-- was:');
    // The untouched neighbour is still exactly where it was.
    expect(bytes.split('\n')[3]).toBe('currency: USD');
  });
});

describe('§14.17 — an interrupted write leaves the previous complete file', () => {
  test('a failed rename leaves the original bytes and removes the temp file', async () => {
    const original = ['## Location', '', 'timezone: America/Detroit', ''].join('\n');
    const path = tempProfile(original);
    const attempted: string[] = [];
    const io: ProfilePersistIo = {
      mkdir: async () => undefined,
      writeFile: async (tmpPath, content) => { attempted.push(tmpPath); writeFileSync(tmpPath, content, 'utf-8'); },
      rename: async () => { throw new Error('interrupted'); },
      remove: async (tmpPath) => { rmSync(tmpPath, { force: true }); },
    };

    const store = new OwnerProfileStore({ path, persistIo: io });
    await store.load();
    const result = await store.set({ ...OWNER, fieldId: 'location.city', value: 'Lansing, MI', date: '2026-07-27' });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('could not be written');
    // The file on disk is the previous complete file, byte-for-byte.
    expect(readFileSync(path, 'utf-8')).toBe(original);
    // The in-memory model still agrees with the disk.
    expect(store.get('location.city')).toBeUndefined();
    // The temp file was named per the pattern and cleaned up.
    expect(attempted[0]).toMatch(/owner-profile\.md\.tmp\.\d+\./);
    expect(() => readFileSync(attempted[0] ?? '', 'utf-8')).toThrow();
  });

  test('persistProfileText writes to a temp path and renames over the target', async () => {
    const path = tempProfile('original\n');
    const order: string[] = [];
    await persistProfileText(path, 'replacement\n', {
      mkdir: async () => { order.push('mkdir'); },
      writeFile: async (tmpPath, content) => { order.push('write'); writeFileSync(tmpPath, content, 'utf-8'); },
      rename: async (from, to) => { order.push('rename'); writeFileSync(to, readFileSync(from, 'utf-8')); rmSync(from); },
      remove: async () => { order.push('remove'); },
    });
    expect(order).toEqual(['mkdir', 'write', 'rename']);
    expect(readFileSync(path, 'utf-8')).toBe('replacement\n');
  });
});

describe('the watch survives the inode replacement an atomic write causes', () => {
  test('an external edit after two atomic writes is still observed', async () => {
    const path = tempProfile(['## Location', '', 'timezone: America/Detroit', ''].join('\n'));
    const store = new OwnerProfileStore({ path, reloadThrottleMs: 25 });
    await store.load();
    store.watch();

    // Two atomic writes: each replaces the file's inode via rename().
    await store.set({ ...OWNER, fieldId: 'location.city', value: 'Lansing, MI', date: '2026-07-26' });
    await store.set({ ...OWNER, fieldId: 'location.city', value: 'Detroit, MI', date: '2026-07-27' });
    expect(store.get('location.city')?.value).toBe('Detroit, MI');

    // Let the watcher settle. Without this the reload queued by the second
    // write's own rename event fires AFTER the hand edit below and picks it up
    // incidentally, which would make this case pass against a file-level watch
    // for the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Now he edits the file by hand. A file-level watch is bound to an inode
    // that the two renames above replaced, so it is blind to this; a
    // directory-level watch filtered by filename sees it.
    writeFileSync(
      path,
      ['## Location', '', 'timezone: America/Detroit', 'city: Ann Arbor, Michigan, edited by hand', ''].join('\n'),
      'utf-8',
    );

    const seen = await waitFor(() => store.get('location.city')?.value === 'Ann Arbor, Michigan, edited by hand');
    store.unwatch();
    expect(seen).toBe(true);
  });
});

/** Poll a predicate until it holds or the budget runs out. */
async function waitFor(predicate: () => boolean, budgetMs = 5000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

describe('placement and caps', () => {
  test('a write to a missing section appends the canonical heading at the end', async () => {
    const path = tempProfile(['## Location', '', 'city: Lansing, MI', ''].join('\n'));
    const store = await loadedStore(path);
    await store.set({ ...OWNER, fieldId: 'preferences.units', value: 'imperial', date: '2026-07-27' });

    expect(readFileSync(path, 'utf-8')).toBe(
      ['## Location', '', 'city: Lansing, MI', '', '## Preferences', '', 'units: imperial — tui, 2026-07-27, "set it to this"', ''].join('\n'),
    );
  });

  test('a write to a heading he renamed goes to the renamed one', async () => {
    const path = tempProfile(['## LOCATION', '', 'city: Lansing, MI', ''].join('\n'));
    const store = await loadedStore(path);
    await store.set({ ...OWNER, fieldId: 'location.timezone', value: 'America/Detroit', date: '2026-07-27' });

    const lines = readFileSync(path, 'utf-8').split('\n');
    expect(lines[0]).toBe('## LOCATION');
    expect(lines.filter((line) => line.startsWith('## '))).toHaveLength(1);
    expect(lines[3]).toBe('timezone: America/Detroit — tui, 2026-07-27, "set it to this"');
  });

  test('an existing label keeps his capitalisation when the value is rewritten', async () => {
    const path = tempProfile(['## Commerce', '', 'Shipping Address: 401 Home St', ''].join('\n'));
    const store = await loadedStore(path);
    expect(store.get('commerce.shippingAddress')?.value).toBe('401 Home St');

    await store.set({ ...OWNER, fieldId: 'commerce.shippingAddress', value: '200 Office Way', date: '2026-07-27' });
    expect(readFileSync(path, 'utf-8')).toContain('Shipping Address: 200 Office Way — tui');
  });

  test('a machine write caps the line and collapses newlines in the value', () => {
    const projection = parseProfileDocument({
      path: '/x',
      text: ['## Notes', '', '- something', ''].join('\n'),
      exists: true,
    });
    const result = setField(projection, {
      fieldId: 'location.homeAddress',
      value: `${'a'.repeat(5000)}\nsecond line`,
      provenance: { surface: 'tui', date: '2026-07-27', said: 'x'.repeat(3000) },
    });
    expect(result.ok).toBe(true);
    const written = result.lines.find((line) => line.startsWith('home address:'));
    expect(written).toBeDefined();
    expect(written?.length).toBeLessThanOrEqual(4096);
    expect(written).not.toContain('\n');
  });

  test('a prose bullet is appended to its section with provenance', async () => {
    const path = tempProfile(['## People', '', '- Dave from work', '', '## Notes', '', '- Allergic to shellfish', ''].join('\n'));
    const store = await loadedStore(path);
    await store.append({
      authority: 'owner-direct',
      surface: 'agent',
      said: 'my sister Sarah',
      date: '2026-07-27',
      section: 'People',
      text: 'Sarah, sister',
    });

    const lines = readFileSync(path, 'utf-8').split('\n');
    expect(lines[3]).toBe('- Sarah, sister — agent, 2026-07-27, "my sister Sarah"');
    // The next section did not move relative to its own content.
    expect(lines[5]).toBe('## Notes');
    expect(lines[7]).toBe('- Allergic to shellfish');
    expect(store.person('Sarah').map((line) => line.text)).toEqual(['- Sarah, sister']);
    expect(store.person('Dave')).toHaveLength(1);
    expect(store.person('Nobody')).toHaveLength(0);
  });

  test('a CRLF document keeps its line endings', async () => {
    const path = tempProfile(['## Location', '', 'city: Lansing, MI', ''].join('\r\n'));
    const store = await loadedStore(path);
    await store.set({ ...OWNER, fieldId: 'location.timezone', value: 'America/Detroit', date: '2026-07-27' });

    const bytes = readFileSync(path, 'utf-8');
    expect(bytes).toContain('timezone: America/Detroit — tui, 2026-07-27, "set it to this"\r\n');
    expect(bytes.split('\n').every((line) => line.length === 0 || line.endsWith('\r'))).toBe(true);
  });
});
