/**
 * owner-profile-document.test.ts
 *
 * Parsing is lenient by construction and loud only about the two conditions that
 * genuinely mean "I could not read your file". Design §14 items 13 and 18, plus
 * the provenance grammar (§4.2) and the preservation rules (§4.4) the rest of
 * the module depends on.
 *
 * The through-line: there is no input for which the parser drops a line, and no
 * input for which it throws.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseProfileDocument,
  splitProvenanceSuffix,
} from '../packages/sdk/src/platform/owner-profile/document.ts';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/store.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-ownerprofile-doc-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function parse(text: string) {
  return parseProfileDocument({ path: '/profile.md', text, exists: true });
}

describe('§4.2 — the provenance suffix is recognised only when the whole shape matches', () => {
  test('a well-formed suffix on a bullet and on a field line', () => {
    const bullet = splitProvenanceSuffix('- Allergic to shellfish — tui, 2026-07-27, "I\'m allergic to shellfish"');
    expect(bullet.text).toBe('- Allergic to shellfish');
    expect(bullet.provenance).toEqual({ surface: 'tui', date: '2026-07-27', said: "I'm allergic to shellfish" });

    const field = splitProvenanceSuffix('shipping address: 200 Office Way, Lansing, MI 48933, US — tui, 2026-07-27, "ship it to my office instead"');
    expect(field.text).toBe('shipping address: 200 Office Way, Lansing, MI 48933, US');
    expect(field.provenance?.said).toBe('ship it to my office instead');
  });

  test('em dashes in his own prose are prose', () => {
    const line = '- He said — and I quote — that it was fine';
    expect(splitProvenanceSuffix(line)).toEqual({ text: line, provenance: null });
  });

  test('a malformed date, an unknown surface and a bare trailing quote are all prose', () => {
    for (const line of [
      '- Something — tui, 2026-7-2, "short date"',
      '- Something — slack, 2026-07-27, "unknown surface"',
      '- Something — tui, 2026-07-27, "unterminated',
      '- Something — tui, 2026-07-27 "no comma"',
      '- Something ending in a quote "',
    ]) {
      expect(splitProvenanceSuffix(line)).toEqual({ text: line, provenance: null });
    }
  });

  test('a quote character inside the verbatim needs no escaping', () => {
    const split = splitProvenanceSuffix('- Note — tui, 2026-07-27, "he said "hello" loudly"');
    expect(split.provenance?.said).toBe('he said "hello" loudly');
    expect(split.text).toBe('- Note');
  });

  test('two suffixes on one line resolve to the RIGHTMOST, newest one', () => {
    // Matching from the left swallows the whole tail into the quote and produces
    // a provenance record that is quietly wrong. Rightmost keeps the newest
    // provenance and leaves the older one visible as ordinary text, nothing is
    // silently destroyed.
    const split = splitProvenanceSuffix('- Two suffixes — tui, 2026-07-01, "first" — agent, 2026-07-27, "second"');
    expect(split.provenance).toEqual({ surface: 'agent', date: '2026-07-27', said: 'second' });
    expect(split.text).toBe('- Two suffixes — tui, 2026-07-01, "first"');
  });
});

describe('§4.4 — everything is preserved and nothing is an error', () => {
  const ODD = [
    '# Title',
    '',
    '<!-- his own comment -->',
    '',
    '## Something I invented',
    '',
    'not a known field: but a key line',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '### A sub-heading',
    '',
    '- outer',
    '  - nested',
    '    - deeper',
    '',
    '~~~',
    '## Fake heading',
    'timezone: Europe/Berlin',
    '~~~',
    '',
    '## Identity',
    '',
    'name: Mike Davis',
    'nickname: not a field',
    '',
  ].join('\n');

  test('every raw line survives, in order, byte-for-byte', () => {
    const projection = parse(ODD);
    expect(projection.rawLines).toEqual(ODD.split('\n'));
    expect(projection.rawLines.join('\n')).toBe(ODD);
  });

  test('an unknown heading is a section whose content is all prose', () => {
    const projection = parse(ODD);
    const invented = projection.sections.find((section) => section.heading === 'Something I invented');
    expect(invented?.fields).toEqual([]);
    expect(invented?.prose.map((line) => line.text)).toContain('not a known field: but a key line');
    expect(invented?.prose.map((line) => line.text)).toContain('| a | b |');
    expect(invented?.prose.map((line) => line.text)).toContain('    - deeper');
  });

  test('a fenced heading does not open a section and a fenced field is not a field', () => {
    const projection = parse(ODD);
    expect(projection.sections.map((section) => section.heading)).toEqual([
      '',
      'Something I invented',
      'Identity',
    ]);
    expect(projection.fields.has('location.timezone')).toBe(false);
  });

  test('an unknown key under a known heading is prose, not an error', () => {
    const projection = parse(ODD);
    expect(projection.fields.get('identity.name')?.value).toBe('Mike Davis');
    const identity = projection.sections.find((section) => section.heading === 'Identity');
    expect(identity?.prose.map((line) => line.text)).toEqual(['nickname: not a field']);
  });

  test('a mechanical field is recognised at column 0 only', () => {
    const projection = parse(['## Places', '', '- Outer', '    Gym: the Y', '', '## Location', '', '  city: indented', 'city: Lansing, MI', ''].join('\n'));
    expect(projection.fields.get('location.city')?.value).toBe('Lansing, MI');
    expect(projection.fields.get('location.city')?.lineIndex).toBe(8);
  });

  test('parsing never throws, on anything', () => {
    for (const text of ['', '\n', '## ', '##', '```', '<!-- was: -->', ':', 'a:', '## Identity\nname:', '\u0000\u0001', ' ']) {
      expect(() => parse(text)).not.toThrow();
    }
  });
});

describe('§14.18 — an invalid mechanical value is preserved and reported, never dropped', () => {
  test('timezone: Mars/Olympus stays in the file and is reported with a reason', async () => {
    const dir = tempDir();
    const path = join(dir, 'owner-profile.md');
    const text = ['## Location', '', 'timezone: Mars/Olympus', 'city: Lansing, MI', ''].join('\n');
    writeFileSync(path, text, 'utf-8');

    const store = new OwnerProfileStore({ path });
    const state = await store.load();

    const value = store.get('location.timezone');
    expect(value?.value).toBe('Mars/Olympus');
    expect(value?.valid).toBe(false);
    expect(value?.invalidReason).toBe('not an IANA time zone name');

    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') {
      expect(state.invalidFields).toEqual([{ fieldId: 'location.timezone', reason: 'not an IANA time zone name' }]);
      // The diagnostic verb names the field and the reason and NEVER the value.
      expect(JSON.stringify(state)).not.toContain('Mars/Olympus');
      expect(JSON.stringify(state)).not.toContain('Lansing');
    }
  });

  test('a consumer falls back exactly as if the field were unset', () => {
    const projection = parse(['## Location', '', 'timezone: Mars/Olympus', ''].join('\n'));
    const field = projection.fields.get('location.timezone');
    // The fallback rule a consumer applies: use the value only when it validated.
    const resolved = field !== undefined && field.valid ? field.value : 'UTC';
    expect(resolved).toBe('UTC');
  });

  test('every other validator reports its own reason without dropping the line', () => {
    const projection = parse([
      '## Commerce',
      '',
      'currency: dollars',
      '',
      '## Preferences',
      '',
      'units: furlongs',
      'date format: klingon',
      'locale: not a locale!',
      '',
      '## Contacting me',
      '',
      'quiet hours: 10pm to 7am',
      '',
      '## Contact',
      '',
      'email: not-an-address',
      '',
      '## Defaults',
      '',
      'approval window: half an hour',
      '',
    ].join('\n'));

    const invalid = [...projection.fields.values()].filter((field) => !field.valid);
    expect(invalid.map((field) => field.fieldId).sort()).toEqual([
      'commerce.currency',
      'contact.email',
      'contactMe.quietHours',
      'defaults.approvalWindow',
      'preferences.dateFormat',
      'preferences.locale',
      'preferences.units',
    ]);
    for (const field of invalid) {
      expect(field.invalidReason).toBeTruthy();
      expect(field.value.length).toBeGreaterThan(0);
    }
  });

  test('valid values validate, including a time zone in the wrong case', () => {
    const projection = parse([
      '## Location', '', 'timezone: america/detroit', '',
      '## Preferences', '', 'units: Imperial', 'date format: iso', 'locale: en-US', '',
      '## Commerce', '', 'currency: USD', '',
      '## Contacting me', '', 'quiet hours: 22:00-07:00', '',
      '## Defaults', '', 'approval window: 30', '',
    ].join('\n'));
    for (const field of projection.fields.values()) {
      expect({ id: field.fieldId, valid: field.valid }).toEqual({ id: field.fieldId, valid: true });
    }
  });
});

describe('§14.13 — an unreadable file degrades loudly, never to an empty profile', () => {
  async function loadBytes(bytes: Uint8Array): Promise<OwnerProfileStore> {
    const dir = tempDir();
    const path = join(dir, 'owner-profile.md');
    writeFileSync(path, bytes);
    const store = new OwnerProfileStore({ path });
    await store.load();
    return store;
  }

  test('a file saved as UTF-16LE reports unavailable with a reason naming the path', async () => {
    // The realistic accident: an editor mis-save. A lenient decoder would turn
    // this into plausible-looking mojibake and the profile would load
    // "successfully" full of garbage.
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...'## Identity\n\nname: Mike\n'].flatMap((ch) => [ch.charCodeAt(0), 0x00])]);
    const store = await loadBytes(utf16);

    const state = store.status();
    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') {
      expect(state.reason).toContain('could not be read');
      expect(state.reason).toContain(state.path);
      expect(state.reason.toLowerCase()).toContain('utf-8');
    }
  });

  test('no verb answers with an empty-but-successful profile', async () => {
    const store = await loadBytes(new Uint8Array([0x23, 0x23, 0x20, 0x41, 0x0a, 0x80]));
    expect(store.status().kind).toBe('unavailable');
    expect(store.get('identity.name')).toBeUndefined();
    // Style is the open-tier section, so it is the one that WOULD be served if
    // this store were serving anything at all.
    expect(store.section('Style')).toBeUndefined();
    expect(store.person('Sarah')).toEqual([]);
    // read() carries the unavailable STATE rather than presenting zero sections
    // as though the profile were simply empty.
    const view = store.read();
    expect(view.sections).toEqual([]);
    expect(view.state.kind).toBe('unavailable');

    // And a write refuses with that same reason rather than creating a fresh file.
    const result = await store.set({
      authority: 'owner-direct', surface: 'tui', said: 'x',
      fieldId: 'identity.name', value: 'Mike',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('could not be read');
  });

  test('the other invalid encodings degrade the same way', async () => {
    for (const bytes of [
      new Uint8Array([0x80]),
      new Uint8Array([0xe2, 0x80]),
      new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0xe9]),
    ]) {
      const store = await loadBytes(bytes);
      expect(store.status().kind).toBe('unavailable');
    }
  });

  test('valid UTF-8 with an em dash and accents loads normally', async () => {
    const dir = tempDir();
    const path = join(dir, 'owner-profile.md');
    writeFileSync(path, ['## Notes', '', '- Café — tui, 2026-07-27, "café"', ''].join('\n'), 'utf-8');
    const store = new OwnerProfileStore({ path });
    const state = await store.load();

    expect(state.kind).toBe('loaded');
    // Via read(): Notes is closed tier, so section() does not serve it.
    const notes = store.read().sections.find((section) => section.heading === 'Notes');
    expect(notes?.prose[0]?.text).toBe('- Café');
    expect(notes?.prose[0]?.provenance?.said).toBe('café');
  });

  test('a file that is simply not there is loaded and empty, not unavailable', async () => {
    const store = new OwnerProfileStore({ path: join(tempDir(), 'owner-profile.md') });
    const state = await store.load();
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') {
      expect(state.exists).toBe(false);
      expect(state.fieldCount).toBe(0);
    }
  });

  test('a disabled profile is a stated state, not an empty one', async () => {
    const dir = tempDir();
    const path = join(dir, 'owner-profile.md');
    writeFileSync(path, ['## Identity', '', 'name: Mike Davis', ''].join('\n'), 'utf-8');
    const store = new OwnerProfileStore({ path, enabled: false });
    await store.load();

    expect(store.status().kind).toBe('disabled');
    expect(store.get('identity.name')).toBeUndefined();
    const result = await store.set({
      authority: 'owner-direct', surface: 'tui', said: 'x',
      fieldId: 'identity.name', value: 'Someone Else',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('turned off');
  });
});

describe('the `<!-- was: … -->` history comment', () => {
  test('is parsed as history for the field it names, with its own provenance', () => {
    const projection = parse([
      '## Commerce',
      '',
      'shipping address: 200 Office Way',
      '',
      '<!-- was: shipping address: 401 Home St — tui, 2026-07-20, "ship to 401 Home St" (superseded 2026-07-27) -->',
      '',
    ].join('\n'));

    const history = projection.superseded.get('commerce.shippingAddress');
    expect(history).toHaveLength(1);
    expect(history?.[0]?.value).toBe('401 Home St');
    expect(history?.[0]?.supersededOn).toBe('2026-07-27');
    expect(history?.[0]?.provenance).toEqual({ surface: 'tui', date: '2026-07-20', said: 'ship to 401 Home St' });
  });

  test('one of his own HTML comments is prose, not machinery', () => {
    const projection = parse(['## Notes', '', '<!-- reminder to self -->', ''].join('\n'));
    expect(projection.superseded.size).toBe(0);
    expect(projection.sections.find((section) => section.heading === 'Notes')?.prose[0]?.text)
      .toBe('<!-- reminder to self -->');
  });
});
