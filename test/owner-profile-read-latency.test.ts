/**
 * owner-profile-read-latency.test.ts — docs/owner-profile.md §5.2, test plan #21.
 *
 * The owner's ruling was "it needs to be extremely fast and probably faster than
 * the knowledge system will allow", and the design turned that into an
 * acceptance criterion with a number attached: a mechanical-field read must be
 * effectively free, target sub-microsecond, measured against a realistic
 * document of ~200 lines. Not an assertion that it is fast — a number, printed,
 * that goes in the round report.
 *
 * This is a test rather than only a bench file so the criterion is enforced by
 * the same gate everything else is. The assertion is set at 1000 ns, which is
 * roughly two orders of magnitude above what a `Map.get` costs, so it fails only
 * if someone puts a `stat`, a parse or a lock back on the read path — which is
 * the regression it exists to catch, not a stopwatch contest with the host.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/index.ts';

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-profile-bench-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A realistic 200-line profile: every mechanical field, provenance suffixes on
 * many of them, superseded history comments, prose bullets under every
 * prose-only section, and enough filler notes to reach the target length.
 *
 * "Realistic" matters because the read path is a Map lookup only if the parse
 * genuinely built the map once. A three-line fixture would prove nothing about
 * a document with history comments and unknown headings in it.
 */
function buildRealisticProfile(): string {
  const lines: string[] = [
    '# Mike\'s profile',
    '',
    '<!-- GoodVibes keeps this file. Edit it by hand whenever you like. -->',
    '',
    '## Identity',
    '',
    'name: Mike Davis',
    'goes by: Mike',
    'pronouns: he/him',
    '',
    '## Contact',
    '',
    'email: owner@example.com — tui, 2026-07-20, "my email is owner@example.com"',
    'phone: +1 517 555 0134',
    'agent alias: agent@example.com',
    '- Prefers Telegram for anything urgent — agent, 2026-07-27, "ping me on telegram if it\'s urgent"',
    '',
    '## Location',
    '',
    'timezone: America/Detroit',
    'city: Lansing, MI',
    'home address: 401 Home St, Lansing, MI 48933, US',
    '',
    '## Commerce',
    '',
    'shipping address: 200 Office Way, Lansing, MI 48933, US — tui, 2026-07-27, "ship it to my office instead"',
    'billing address: 401 Home St, Lansing, MI 48933, US',
    'currency: USD',
    'shipping tier: standard',
    '',
    '<!-- was: shipping address: 401 Home St, Lansing, MI 48933, US — tui, 2026-07-20, "ship to 401 Home St" (superseded 2026-07-27) -->',
    '',
    '## Preferences',
    '',
    'units: imperial',
    'date format: iso',
    'locale: en-US',
    '',
    '## Contacting me',
    '',
    'channel: telegram',
    'quiet hours: 22:00-07:00',
    '',
    '## Style',
    '',
    'verbosity: brief',
    'formality: casual',
    '- Keep replies short unless I ask for detail — tui, 2026-07-26, "keep it short unless I ask"',
    '',
    '## Defaults',
    '',
    'approval window: 30',
    '',
    '## People',
    '',
    '- Sarah, sister, sarah@example.com — tui, 2026-07-27, "my sister Sarah, sarah@example.com"',
    '- Dave from work, handles the Pellux contracts',
    '',
    '## Places',
    '',
    '- Gym: the Y on Michigan Ave — agent, 2026-07-27, "I go to the Y on Michigan Ave"',
    '',
    '## Work',
    '',
    '- Runs Pellux, founder — tui, 2026-07-27, "I run Pellux"',
    '',
    '## Notes',
    '',
  ];
  let n = 1;
  while (lines.length < 199) {
    lines.push(`- Note ${n}: something he mentioned in passing — tui, 2026-07-2${n % 10}, "note ${n}"`);
    n += 1;
  }
  lines.push('');
  return lines.join('\n');
}

describe('owner profile read latency (§5.2 acceptance criterion)', () => {
  test('a mechanical-field read is sub-microsecond, and the measured figure is printed', async () => {
    const dir = mkTemp();
    const path = join(dir, 'owner-profile.md');
    const text = buildRealisticProfile();
    writeFileSync(path, text, 'utf-8');
    expect(text.split('\n').length).toBeGreaterThanOrEqual(200);

    const store = new OwnerProfileStore({ path });
    const state = await store.load();
    expect(state.kind).toBe('loaded');
    expect(store.get('location.timezone')?.value).toBe('America/Detroit');

    // Rotate over several field ids so the measurement cannot collapse into one
    // monomorphic lookup the engine hoists out of the loop.
    const fieldIds = [
      'location.timezone',
      'commerce.shippingAddress',
      'preferences.units',
      'contactMe.quietHours',
      'identity.goesBy',
    ];

    // Warm up: the first reads pay for the JIT, not for the design.
    let sink = 0;
    for (let i = 0; i < 50_000; i++) {
      sink += store.get(fieldIds[i % fieldIds.length]!) === undefined ? 0 : 1;
    }

    const iterations = 1_000_000;
    const startedAt = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      sink += store.get(fieldIds[i % fieldIds.length]!) === undefined ? 0 : 1;
    }
    const elapsedNs = Number(process.hrtime.bigint() - startedAt);
    const nsPerRead = elapsedNs / iterations;

    // Proves the loop was not optimised away: every read found its field.
    expect(sink).toBe(50_000 + iterations);

    // The number the design asks for, printed so it can be quoted in the report.
    // eslint-disable-next-line no-console
    console.log(
      `[owner-profile] mechanical-field read: ${nsPerRead.toFixed(1)} ns/read `
      + `over ${iterations.toLocaleString('en-US')} reads of a ${text.split('\n').length}-line profile`,
    );

    expect(nsPerRead).toBeLessThan(1000);
  });
});
