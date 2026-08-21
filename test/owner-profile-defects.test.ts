/**
 * owner-profile-defects.test.ts
 *
 * One regression per defect a refutation review reproduced against the real
 * modules. Each was measured, not theorised, and none was covered by an existing
 * case, which is why they are gathered here rather than folded into the suites
 * that missed them.
 *
 * The shared theme is that every one of these is SILENT: a false success
 * receipt, a forged provenance record, a value that survives its own deletion,
 * an edit that lands inside his code block. None of them throws, and none would
 * show up in a happy-path walkthrough.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProfileDocument } from '../packages/sdk/src/platform/owner-profile/document.ts';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/store.ts';

const dirs: string[] = [];
function tempProfile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-ownerprofile-defect-'));
  dirs.push(dir);
  const path = join(dir, 'owner-profile.md');
  writeFileSync(path, content, 'utf-8');
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OWNER = { authority: 'owner-direct', surface: 'tui', said: 'set it to this' } as const;

async function storeFor(content: string): Promise<{ store: OwnerProfileStore; path: string }> {
  const path = tempProfile(content);
  const store = new OwnerProfileStore({ path });
  await store.load();
  return { store, path };
}

describe('defect 1 — one character of punctuation must not enumerate the People section', () => {
  const DOC = [
    '## People',
    '',
    '- Sarah, sister, sarah@example.com',
    '- Dave from work, handles the Pellux contracts',
    '- Priya, neighbour',
    '- Tom, dentist',
    '',
  ].join('\n');

  test('person("-") returns nothing, not every bullet in the section', async () => {
    const { store } = await storeFor(DOC);
    // The measured defect: ProfileLine.text keeps its "- " marker and the
    // word-boundary alternative matches at index 0 of every bullet, so a single
    // hyphen was a complete enumerate-all call.
    expect(store.person('-')).toEqual([]);
  });

  test('no punctuation-only name enumerates the section', async () => {
    const { store } = await storeFor(DOC);
    for (const name of ['-', '*', '+', '.', ',', ' - ', '--', '(', '@', '#', '1.']) {
      expect({ name, count: store.person(name).length }).toEqual({ name, count: 0 });
    }
  });

  test('a real name still matches, and only its own line', async () => {
    const { store } = await storeFor(DOC);
    expect(store.person('Sarah').map((line) => line.text)).toEqual(['- Sarah, sister, sarah@example.com']);
    expect(store.person('Dave')).toHaveLength(1);
    expect(store.person('Tom')).toHaveLength(1);
    expect(store.person('Nobody')).toEqual([]);
  });
});

describe('defect 2 — a nested fence must not desynchronise the scanner', () => {
  const DOC = [
    '## Commerce',
    '',
    'shipping address: 200 Office Way',
    '',
    '## Notes',
    '',
    '````',
    'Here is how a profile line looks:',
    '```',
    '## Commerce',
    'shipping address: EXAMPLE ONLY, do not ship here',
    '```',
    '## Style',
    '- sample bullet, not mine',
    '````',
    '',
    '- A real note',
    '',
  ].join('\n');

  test('a three-backtick sample inside a four-backtick block stays inside it', () => {
    const projection = parseProfileDocument({ path: '/x', text: DOC, exists: true });
    // The sample must never become the live value.
    expect(projection.fields.get('commerce.shippingAddress')?.value).toBe('200 Office Way');
    // The fenced "## Style" must not open a section, that is what made his
    // sample lines open tier and put them in the model prompt.
    expect(projection.sections.map((section) => section.heading)).toEqual(['Commerce', 'Notes']);
  });

  test('a ~~~ line inside a backtick block does not close it', () => {
    const projection = parseProfileDocument({
      path: '/x',
      text: ['## Notes', '', '```', '~~~', 'timezone: Europe/Berlin', '```', '', '## Location', '', 'timezone: America/Detroit', ''].join('\n'),
      exists: true,
    });
    expect(projection.fields.get('location.timezone')?.value).toBe('America/Detroit');
    expect(projection.sections.map((section) => section.heading)).toEqual(['Notes', 'Location']);
  });

  test('a later write lands after his code block, never inside it', async () => {
    const { store, path } = await storeFor(DOC);
    await store.set({ ...OWNER, fieldId: 'commerce.currency', value: 'USD', date: '2026-07-27' });

    const lines = readFileSync(path, 'utf-8').split('\n');
    const written = lines.findIndex((line) => line.startsWith('currency:'));
    const fenceOpen = lines.indexOf('````');
    const fenceClose = lines.lastIndexOf('````');
    expect(written).toBeGreaterThanOrEqual(0);
    expect(written < fenceOpen || written > fenceClose).toBe(true);
    // His block is byte-identical.
    expect(lines.slice(fenceOpen, fenceClose + 1)).toEqual([
      '````',
      'Here is how a profile line looks:',
      '```',
      '## Commerce',
      'shipping address: EXAMPLE ONLY, do not ship here',
      '```',
      '## Style',
      '- sample bullet, not mine',
      '````',
    ]);
  });
});

describe('defect 3 — a concurrent hand edit must not be silently destroyed', () => {
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

  test('his edits survive a write computed from a stale projection', async () => {
    const { store, path } = await storeFor(DOC);

    // He opens the file and changes two lines while the daemon holds a
    // projection from before.
    writeFileSync(path, [
      '## Location',
      '',
      'timezone: America/Detroit',
      'city: Ann Arbor, MI',
      '',
      '## Notes',
      '',
      '- Allergic to shellfish',
      '- Allergic to penicillin',
      '',
    ].join('\n'), 'utf-8');

    const result = await store.set({ ...OWNER, fieldId: 'commerce.currency', value: 'USD', date: '2026-07-27' });
    expect(result.ok).toBe(true);

    const after = readFileSync(path, 'utf-8');
    // Both of his edits are still there...
    expect(after).toContain('city: Ann Arbor, MI');
    expect(after).toContain('- Allergic to penicillin');
    expect(after).not.toContain('city: Lansing, MI');
    // ...and the write landed too, rather than one being sacrificed for the other.
    expect(after).toContain('currency: USD — tui, 2026-07-27, "set it to this"');
    expect(store.get('location.city')?.value).toBe('Ann Arbor, MI');
  });

  test('a supersede replayed over a concurrent edit supersedes HIS value, not the stale one', async () => {
    const { store, path } = await storeFor(DOC);
    writeFileSync(path, DOC.replace('city: Lansing, MI', 'city: Ann Arbor, MI'), 'utf-8');

    const result = await store.set({ ...OWNER, fieldId: 'location.city', value: 'Detroit, MI', date: '2026-07-27' });
    expect(result.ok).toBe(true);

    const after = readFileSync(path, 'utf-8');
    expect(after).toContain('city: Detroit, MI — tui');
    // The history records what was actually there, not what the store remembered.
    expect(after).toContain('<!-- was: city: Ann Arbor, MI (superseded 2026-07-27) -->');
    expect(after).not.toContain('Lansing');
  });

  test('a positional delete is refused rather than replayed onto a different line', async () => {
    const { store, path } = await storeFor(DOC);
    const target = store.read().sections
      .find((section) => section.heading === 'Notes')?.prose[0]?.lineIndex ?? -1;
    expect(target).toBeGreaterThanOrEqual(0);

    // He inserts a line above the target, so that index now names something else.
    writeFileSync(path, ['## Preamble', '', '- new first line', '', ...DOC.split('\n')].join('\n'), 'utf-8');

    const result = await store.forget({ authority: 'owner-direct', lineIndex: target });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('identified by position');
    // Nothing was removed.
    expect(readFileSync(path, 'utf-8')).toContain('- Allergic to shellfish');
    expect(readFileSync(path, 'utf-8')).toContain('- new first line');
  });
});

describe('defect 4 — a duplicated field line must not survive its own deletion', () => {
  const DOC = [
    '## Contact',
    '',
    'phone: +1 517 555 0134',
    'email: owner@example.com',
    'phone: +1 517 555 9999',
    '',
  ].join('\n');

  test('forget removes every line carrying the field, not only the active one', async () => {
    const { store, path } = await storeFor(DOC);
    expect(store.get('contact.phone')?.value).toBe('+1 517 555 0134');

    const result = await store.forget({ authority: 'owner-direct', fieldId: 'contact.phone' });
    expect(result.ok).toBe(true);

    const after = readFileSync(path, 'utf-8');
    expect(after).not.toContain('555 0134');
    expect(after).not.toContain('555 9999');
    expect(store.get('contact.phone')).toBeUndefined();
    // The neighbour is untouched.
    expect(after).toContain('email: owner@example.com');
  });

  test('the duplicate is tracked without being silently preferred or dropped', () => {
    const projection = parseProfileDocument({ path: '/x', text: DOC, exists: true });
    expect(projection.fields.get('contact.phone')?.value).toBe('+1 517 555 0134');
    expect(projection.duplicateFieldLines.get('contact.phone')).toEqual([4]);
    expect(projection.rawLines).toEqual(DOC.split('\n'));
  });
});

describe('defect 5 — a duplicate heading must not put history outside every section', () => {
  const DOC = [
    "# Avery's profile",
    '',
    '## Commerce',
    '',
    '- a note, no fields here',
    '',
    '## Commerce',
    '',
    'shipping address: 401 Home St',
    '',
  ].join('\n');

  test('the history comment lands inside a section and stays retrievable', async () => {
    const { store, path } = await storeFor(DOC);
    await store.set({ ...OWNER, fieldId: 'commerce.shippingAddress', value: '200 Office Way', date: '2026-07-27' });

    const lines = readFileSync(path, 'utf-8').split('\n');
    const comment = lines.findIndex((line) => line.startsWith('<!-- was:'));
    expect(comment).toBeGreaterThan(0);
    // Never above his title, which is outside every section.
    expect(lines[0]).toBe("# Avery's profile");

    // The real test of "inside a section": it is re-tracked as history on reload.
    const report = store.provenance('commerce.shippingAddress');
    expect(report.superseded.map((entry) => entry.value)).toEqual(['401 Home St']);
  });

  test('undo can reach it, and forget takes it with them', async () => {
    const { store, path } = await storeFor(DOC);
    await store.set({ ...OWNER, fieldId: 'commerce.shippingAddress', value: '200 Office Way', date: '2026-07-27' });

    const undone = await store.undo({ authority: 'owner-direct', fieldId: 'commerce.shippingAddress' });
    expect(undone.ok).toBe(true);
    expect(store.get('commerce.shippingAddress')?.value).toBe('401 Home St');

    await store.set({ ...OWNER, fieldId: 'commerce.shippingAddress', value: '200 Office Way', date: '2026-07-28' });
    const forgotten = await store.forget({ authority: 'owner-direct', fieldId: 'commerce.shippingAddress' });
    expect(forgotten.ok).toBe(true);
    const after = readFileSync(path, 'utf-8');
    expect(after).not.toContain('401 Home St');
    expect(after).not.toContain('<!-- was:');
  });
});

describe('defect 6 — a suffix-shaped quote must not forge provenance', () => {
  const DOC = ['## Contact', '', 'email: owner@example.com', ''].join('\n');

  test('a quote ending in a well-formed suffix does not become the provenance', async () => {
    const { store, path } = await storeFor(DOC);
    await store.set({
      authority: 'owner-direct',
      surface: 'agent',
      date: '2026-07-27',
      said: 'my number is 555 — tui, 2020-01-01, "forged"',
      fieldId: 'contact.phone',
      value: '+1 517 555 0134',
    });

    // The value survives intact...
    expect(store.get('contact.phone')?.value).toBe('+1 517 555 0134');
    // ...and provenance reports what was actually written today.
    const report = store.provenance('contact.phone');
    expect(report.provenance?.surface).toBe('agent');
    expect(report.provenance?.date).toBe('2026-07-27');
    expect(readFileSync(path, 'utf-8')).not.toContain('2020-01-01, "forged"');
  });

  test('a suffix in the MIDDLE of a quote is defused too', async () => {
    const { store } = await storeFor(DOC);
    await store.set({
      authority: 'owner-direct',
      surface: 'agent',
      date: '2026-07-27',
      said: 'he said — tui, 2020-01-01, "hello" and left',
      fieldId: 'contact.phone',
      value: '+1 517 555 0134',
    });

    const report = store.provenance('contact.phone');
    expect(report.provenance?.surface).toBe('agent');
    expect(report.provenance?.date).toBe('2026-07-27');
    expect(store.get('contact.phone')?.value).toBe('+1 517 555 0134');
  });

  test('stacked suffixes cannot walk the provenance backwards', async () => {
    const { store } = await storeFor(DOC);
    await store.set({
      authority: 'owner-direct',
      surface: 'voice',
      date: '2026-07-27',
      said: 'x — tui, 2020-01-01, "a" — webui, 2019-05-05, "b"',
      fieldId: 'contact.phone',
      value: '+1 517 555 0134',
    });
    const report = store.provenance('contact.phone');
    expect({ surface: report.provenance?.surface, date: report.provenance?.date })
      .toEqual({ surface: 'voice', date: '2026-07-27' });
  });

  test('an ordinary quote containing an em dash is preserved as written', async () => {
    const { store } = await storeFor(DOC);
    await store.set({
      authority: 'owner-direct', surface: 'tui', date: '2026-07-27',
      said: 'ship it — the office one — instead',
      fieldId: 'contact.phone', value: '+1 517 555 0134',
    });
    expect(store.provenance('contact.phone').provenance?.said)
      .toBe('ship it — the office one — instead');
  });
});

describe('defect 7 — a positional delete must be an in-range integer and not a heading', () => {
  const DOC = [
    "# Avery's profile",
    '',
    '## Commerce',
    '',
    'currency: USD',
    'shipping tier: standard',
    '',
  ].join('\n');

  test('NaN is refused rather than deleting line 0', async () => {
    const { store, path } = await storeFor(DOC);
    const result = await store.forget({ authority: 'owner-direct', lineIndex: Number.NaN });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe(DOC);
  });

  test('a fractional index is refused rather than deleting its floor', async () => {
    const { store, path } = await storeFor(DOC);
    const result = await store.forget({ authority: 'owner-direct', lineIndex: 4.9 });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, 'utf-8')).toContain('currency: USD');
    expect(readFileSync(path, 'utf-8')).toBe(DOC);
  });

  test('Infinity and negative indexes are refused', async () => {
    const { store, path } = await storeFor(DOC);
    for (const lineIndex of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 999]) {
      expect((await store.forget({ authority: 'owner-direct', lineIndex })).ok).toBe(false);
    }
    expect(readFileSync(path, 'utf-8')).toBe(DOC);
  });

  test('a heading is refused, so the fields under it are never orphaned', async () => {
    const { store, path } = await storeFor(DOC);
    const result = await store.forget({ authority: 'owner-direct', lineIndex: 2 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('section heading');
    expect(readFileSync(path, 'utf-8')).toBe(DOC);
    expect(store.get('commerce.currency')?.value).toBe('USD');
  });

  test('a blank line is refused rather than reported as a removed note', async () => {
    const { store, path } = await storeFor(DOC);
    const result = await store.forget({ authority: 'owner-direct', lineIndex: 1 });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe(DOC);
  });

  test('a real prose line is still removable by index', async () => {
    const { store, path } = await storeFor(['## Notes', '', '- Allergic to shellfish', ''].join('\n'));
    const result = await store.forget({ authority: 'owner-direct', lineIndex: 2 });
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf-8')).not.toContain('shellfish');
  });
});

describe('defect 8 — forget must not deny a value that read still serves', () => {
  const DOC = [
    '## Shopping',
    '',
    'shipping address: 401 Home St, Lansing, MI 48933, US',
    'currency: USD',
    '',
  ].join('\n');

  test('a field under a heading he renamed is found and removed', async () => {
    const { store, path } = await storeFor(DOC);
    // It is not in the model, the heading is not a section this parser knows...
    expect(store.get('commerce.shippingAddress')).toBeUndefined();
    // ...but read() serves it and the file holds it, so forget must not deny it.
    expect(JSON.stringify(store.read())).toContain('401 Home St');

    const result = await store.forget({ authority: 'owner-direct', fieldId: 'commerce.shippingAddress' });
    expect(result.ok).toBe(true);
    const after = readFileSync(path, 'utf-8');
    expect(after).not.toContain('401 Home St');
    // Its neighbour under the same renamed heading is untouched.
    expect(after).toContain('currency: USD');
  });

  test('a like-named line under a KNOWN section is left alone', async () => {
    const { store, path } = await storeFor(
      ['## Notes', '', 'shipping address: a note about addresses in general', ''].join('\n'),
    );
    const result = await store.forget({ authority: 'owner-direct', fieldId: 'commerce.shippingAddress' });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, 'utf-8')).toContain('a note about addresses in general');
  });
});

describe('defect 9 — one stray CR must not convert the document to CRLF', () => {
  test('a mostly-LF file keeps LF for machine-written lines', async () => {
    const doc = ['## Location', '', 'city: Lansing, MI\r', 'home address: 401 Home St', ''].join('\n');
    const { store, path } = await storeFor(doc);
    await store.set({ ...OWNER, fieldId: 'location.timezone', value: 'America/Detroit', date: '2026-07-27' });

    const after = readFileSync(path, 'utf-8');
    expect(after).toContain('timezone: America/Detroit — tui, 2026-07-27, "set it to this"\n');
    expect(after).not.toContain('"set it to this"\r\n');
    // His pasted CRLF line is preserved exactly as he pasted it.
    expect(after).toContain('city: Lansing, MI\r\n');
  });

  test('a genuinely CRLF file still keeps CRLF', async () => {
    const { store, path } = await storeFor(['## Location', '', 'city: Lansing, MI', ''].join('\r\n'));
    await store.set({ ...OWNER, fieldId: 'location.timezone', value: 'America/Detroit', date: '2026-07-27' });
    expect(readFileSync(path, 'utf-8')).toContain('timezone: America/Detroit — tui, 2026-07-27, "set it to this"\r\n');
  });
});
