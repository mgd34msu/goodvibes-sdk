/**
 * owner-profile-containment.test.ts — docs/owner-profile.md §10, §11.2, §11.3.
 *
 * Covers test-plan items 9 (not in logs), 10 (not in exports), 12 (not injected
 * outbound) and 19 (third-party containment), plus the footgun that makes a
 * naive version of this feature worse than not having it: a short or common
 * profile value must never become a redaction pattern that blanks unrelated
 * text.
 *
 * The four containment paths §11.3 names — session export, at-rest persistence,
 * telemetry helpers, error display — all reach `redactSensitiveData` or
 * `redactStructuredData`, so making those two profile-aware is the ONE change
 * that covers all four. This file exercises the shared functions plus the real
 * session-export entry points, rather than adding a fifth mechanism to test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  redactSensitiveData,
  redactStructuredData,
  registerProfileRedactionValues,
} from '../packages/sdk/src/platform/utils/redaction.ts';
import { redactedErrorMessage } from '../packages/sdk/src/platform/utils/error-display.ts';
import { redactAtRestLine } from '../packages/sdk/src/platform/runtime/at-rest-persistence.ts';
import { exportToJSON, exportToMarkdownExtended } from '../packages/sdk/src/platform/export/session-export.ts';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/index.ts';
import { installOwnerProfileConsumers } from '../packages/sdk/src/platform/owner-profile/consumers.ts';
import {
  openTierContextBlock,
  registerOpenTierContextBlock,
  renderOpenTierBlock,
} from '../packages/sdk/src/platform/owner-profile/context-block.ts';
import { withOpenTierProfileBlock } from '../packages/sdk/src/platform/agents/orchestrator-prompts.ts';
import { registerSignupBaseAddressFallback } from '../packages/sdk/src/platform/google/account-registry.ts';

const FIXTURE = [
  '# Mike\'s profile',
  '',
  '## Identity',
  '',
  'name: Mike Davis',
  'goes by: Mike',
  'pronouns: he/him',
  '',
  '## Contact',
  '',
  'email: owner@example.com',
  'phone: +1 517 555 0134',
  '',
  '## Location',
  '',
  'timezone: America/Detroit',
  'city: Lansing, MI',
  'home address: 401 Home St, Lansing, MI 48933, US',
  '',
  '## Commerce',
  '',
  'shipping address: 200 Office Way, Lansing, MI 48933, US',
  'currency: USD',
  'shipping tier: standard',
  '',
  '## Preferences',
  '',
  'units: imperial',
  'date format: iso',
  '',
  '## Contacting me',
  '',
  'channel: telegram',
  'quiet hours: 22:00-07:00',
  '',
  '## Style',
  '',
  '- Keep replies short unless I ask for detail',
  '',
  '## People',
  '',
  '- Sarah Whitfield, sister, sarah@example.com',
  '- Bob Lee',
  '',
  '## Notes',
  '',
  '- Allergic to shellfish',
  '',
  '## Boat',
  '',
  '- Home is the blue house on the corner of Elm',
  '',
].join('\n');

const CLOSED_VALUES = [
  'Mike Davis',
  'owner@example.com',
  '+1 517 555 0134',
  '401 Home St, Lansing, MI 48933, US',
  '200 Office Way, Lansing, MI 48933, US',
  '22:00-07:00',
  'Sarah Whitfield, sister, sarah@example.com',
  'Allergic to shellfish',
];

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-profile-contain-'));
  tmpDirs.push(dir);
  return dir;
}

function clearRegistrations(): void {
  registerProfileRedactionValues(null);
  registerOpenTierContextBlock(null);
  registerSignupBaseAddressFallback(null);
}

// Both sides, deliberately: `beforeEach` because another file in the same
// process may have left a reader installed, `afterEach` because this one must
// not do that to anybody else.
beforeEach(clearRegistrations);

afterEach(() => {
  clearRegistrations();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function installedStore(text: string = FIXTURE): Promise<OwnerProfileStore> {
  const dir = mkTemp();
  const path = join(dir, 'owner-profile.md');
  writeFileSync(path, text, 'utf-8');
  const store = new OwnerProfileStore({ path });
  await store.load();
  installOwnerProfileConsumers(store, {
    attachProfileFallback: () => undefined,
    consumerFallbackEnabled: () => true,
    injectOpenTierEnabled: () => true,
  });
  return store;
}

describe('§11.3 — closed-tier values are redacted wherever redaction runs', () => {
  test('with nothing registered, redaction behaves exactly as it did before', () => {
    expect(redactSensitiveData('ship to 200 Office Way, Lansing, MI 48933, US'))
      .toBe('ship to 200 Office Way, Lansing, MI 48933, US');
    expect(redactSensitiveData('token sk-ABCDEFGHIJKLMNOPQRSTUVWX'))
      .toBe('token [REDACTED_API_KEY]');
  });

  test('every closed-tier value becomes [REDACTED_PROFILE] in free text', async () => {
    await installedStore();
    for (const value of CLOSED_VALUES) {
      const redacted = redactSensitiveData(`the answer is ${value} ok`);
      expect(redacted, `not redacted: ${value}`).not.toContain(value);
      expect(redacted).toContain('[REDACTED_PROFILE]');
    }
  });

  test('open-tier values are NOT redacted — they are already in context by design', async () => {
    await installedStore();
    expect(redactSensitiveData('timezone America/Detroit')).toContain('America/Detroit');
    expect(redactSensitiveData('he goes by Mike')).toContain('Mike');
  });

  test('a profile-shaped object key is redacted whatever it holds', async () => {
    await installedStore();
    const redacted = redactStructuredData({
      shippingAddress: '200 Office Way, Lansing, MI 48933, US',
      billing_address: { line1: '401 Home St', city: 'Lansing' },
      quietHours: '22:00-07:00',
      note: 'ordinary text',
    }) as Record<string, unknown>;
    expect(redacted.shippingAddress).toBe('[REDACTED_PROFILE]');
    expect(redacted.billing_address).toBe('[REDACTED_PROFILE]');
    expect(redacted.quietHours).toBe('[REDACTED_PROFILE]');
    expect(JSON.stringify(redacted)).not.toContain('401 Home St');
    expect(redacted.note).toBe('ordinary text');
  });

  test('the profile survives a reload: patterns follow the current values', async () => {
    const dir = mkTemp();
    const path = join(dir, 'owner-profile.md');
    writeFileSync(path, FIXTURE, 'utf-8');
    const store = new OwnerProfileStore({ path });
    await store.load();
    installOwnerProfileConsumers(store, {
      attachProfileFallback: () => undefined,
      consumerFallbackEnabled: () => true,
      injectOpenTierEnabled: () => true,
    });
    expect(redactSensitiveData('at 200 Office Way, Lansing, MI 48933, US')).toContain('[REDACTED_PROFILE]');

    writeFileSync(path, FIXTURE.replace('200 Office Way', '300 Other Way'), 'utf-8');
    await store.load();
    expect(redactSensitiveData('at 300 Other Way, Lansing, MI 48933, US')).toContain('[REDACTED_PROFILE]');
  });
});

describe('the footgun: a short or common value must never become a pattern', () => {
  test('currency, shipping tier, channel and units do not blank unrelated text', async () => {
    await installedStore();
    // All four are closed-tier or open-tier values that are ordinary words.
    // Redacting them would destroy the diagnostic an export exists to carry.
    expect(redactSensitiveData('the USD amount was standard')).toBe('the USD amount was standard');
    expect(redactSensitiveData('sent over telegram')).toBe('sent over telegram');
    expect(redactSensitiveData('imperial units, iso dates')).toBe('imperial units, iso dates');
  });

  test('a profile of only short values registers no patterns at all', async () => {
    await installedStore([
      '## Commerce',
      '',
      'currency: USD',
      'shipping tier: std',
      '',
      '## Contacting me',
      '',
      'channel: sms',
      '',
    ].join('\n'));
    const corpus = 'USD std sms a b c the quick brown fox';
    expect(redactSensitiveData(corpus)).toBe(corpus);
  });

  test('an empty or one-character value cannot blank the corpus', async () => {
    await installedStore([
      '## Identity',
      '',
      'name: M',
      'goes by: ',
      '',
    ].join('\n'));
    const corpus = 'M is a letter that appears in Many words';
    expect(redactSensitiveData(corpus)).toBe(corpus);
  });
});

describe('§14 #10 — a session export redacts profile values', () => {
  const messages = [
    {
      role: 'user' as const,
      content: 'send the parcel to 200 Office Way, Lansing, MI 48933, US and cc owner@example.com',
    },
    {
      role: 'assistant' as const,
      content: 'Noted. Sarah Whitfield, sister, sarah@example.com is the recipient.',
    },
  ];

  test('markdown and JSON exports both redact when redaction is on', async () => {
    await installedStore();
    const markdown = exportToMarkdownExtended(messages, undefined, { redact: true });
    const json = exportToJSON(messages, undefined, { redact: true });
    for (const text of [markdown, json]) {
      expect(text).not.toContain('200 Office Way');
      expect(text).not.toContain('owner@example.com');
      expect(text).not.toContain('Sarah Whitfield');
      expect(text).toContain('[REDACTED_PROFILE]');
    }
  });
});

describe('§14 #9 — the at-rest journal and error display carry no profile value', () => {
  test('an at-rest line with a profile value is masked at write time', async () => {
    await installedStore();
    const line = JSON.stringify({
      role: 'user',
      body: 'ship to 200 Office Way, Lansing, MI 48933, US',
    });
    const redacted = redactAtRestLine(line);
    expect(redacted).not.toContain('200 Office Way');
    expect(redacted).toContain('[REDACTED_PROFILE]');
  });

  test('a thrown value carrying a profile string does not surface it', async () => {
    await installedStore();
    const message = redactedErrorMessage(
      new Error('failed to reach 401 Home St, Lansing, MI 48933, US'),
    );
    expect(message).not.toContain('401 Home St');
    expect(message).toContain('[REDACTED_PROFILE]');
  });
});

describe('§11.2 / §14 #12 — the open tier is injected, the closed tier never is', () => {
  test('the rendered block carries the open tier and not one closed-tier value', async () => {
    const store = await installedStore();
    const block = renderOpenTierBlock(store);

    expect(block).toContain('Goes by: Mike');
    expect(block).toContain('Pronouns: he/him');
    expect(block).toContain('City: Lansing, MI');
    expect(block).toContain('Timezone: America/Detroit');
    expect(block).toContain('Units: imperial');
    expect(block).toContain('Style: Keep replies short unless I ask for detail');

    for (const value of CLOSED_VALUES) {
      expect(block, `closed-tier value leaked into context: ${value}`).not.toContain(value);
    }
  });

  test('an outbound composition with no named accessor call contains no closed-tier value', async () => {
    await installedStore();
    // The system prompt an agent turn actually composes, through the same
    // function both orchestrator seams call.
    const composed = withOpenTierProfileBlock('You are an assistant.\n\n## Task\nEmail the vendor.');
    expect(composed).toContain('## About the person you are working for');
    for (const value of CLOSED_VALUES) {
      expect(composed, `closed-tier value reached an outbound composition: ${value}`).not.toContain(value);
    }
  });

  test('profile.injectOpenTier off leaves the prompt byte-identical', async () => {
    const dir = mkTemp();
    const path = join(dir, 'owner-profile.md');
    writeFileSync(path, FIXTURE, 'utf-8');
    const store = new OwnerProfileStore({ path });
    await store.load();
    installOwnerProfileConsumers(store, {
      attachProfileFallback: () => undefined,
      consumerFallbackEnabled: () => true,
      injectOpenTierEnabled: () => false,
    });
    expect(openTierContextBlock()).toBe('');
    expect(withOpenTierProfileBlock('base prompt')).toBe('base prompt');
  });

  test('no profile at all leaves the prompt byte-identical, with no placeholder', () => {
    expect(openTierContextBlock()).toBe('');
    expect(withOpenTierProfileBlock('base prompt')).toBe('base prompt');
  });

  test('an unavailable profile renders nothing rather than an error line', () => {
    const store = new OwnerProfileStore({ path: join(mkTemp(), 'missing-dir', 'owner-profile.md') });
    expect(renderOpenTierBlock(store)).toBe('');
    expect(store.status().kind).toBe('unavailable');
  });

  test('an invalid open-tier value is skipped, not injected for the model to act on', async () => {
    const store = await installedStore(FIXTURE.replace('timezone: America/Detroit', 'timezone: Mars/Olympus'));
    const block = renderOpenTierBlock(store);
    expect(block).not.toContain('Mars/Olympus');
    expect(block).toContain('City: Lansing, MI');
  });
});

describe('§10 / §14 #19 — third-party personal data', () => {
  test('People content is absent from context and from exports, and reachable only by name', async () => {
    const store = await installedStore();

    // Not in context.
    expect(renderOpenTierBlock(store)).not.toContain('Sarah');

    // Not in an export.
    const exported = exportToJSON(
      [{ role: 'user' as const, content: 'Sarah Whitfield, sister, sarah@example.com' }],
      undefined,
      { redact: true },
    );
    expect(exported).not.toContain('Sarah Whitfield');

    // The generic section accessor refuses the closed tier, so there is no
    // enumerate-all-people call; the by-name lookup is the only route in.
    expect(store.section('People')).toBeUndefined();
    expect(store.person('')).toEqual([]);
    expect(store.person('   ')).toEqual([]);
    expect(store.person('Sarah')).toHaveLength(1);
    expect(store.person('Nobody')).toEqual([]);
  });
});

describe('closed-tier prose is redacted from EVERY closed section, not four of them', () => {
  test('a section the owner invented is closed, and its prose is redacted', async () => {
    await installedStore();
    // `## Boat` is not a canonical section. `profileSectionTier` makes every
    // heading except Style closed, and an earlier version collected prose only
    // from People/Places/Work/Notes — so this line left an export in the clear
    // while the People lines beside it were redacted.
    const redacted = redactSensitiveData('log: Home is the blue house on the corner of Elm');
    expect(redacted).not.toContain('blue house on the corner of Elm');
    expect(redacted).toContain('[REDACTED_PROFILE]');
  });

  test('it is gone from a session export too', async () => {
    await installedStore();
    const exported = exportToJSON(
      [{ role: 'user' as const, content: 'Home is the blue house on the corner of Elm' }],
      undefined,
      { redact: true },
    );
    expect(exported).not.toContain('blue house');
  });

  test('Style prose stays in the clear — it is the one open section', async () => {
    await installedStore();
    expect(redactSensitiveData('Keep replies short unless I ask for detail'))
      .toContain('Keep replies short unless I ask for detail');
  });
});

describe('§10 is absolute: a short People line is redacted despite the floor', () => {
  test('a seven-character People line does not survive redactSensitiveData', async () => {
    await installedStore();
    const redacted = redactSensitiveData('cc Bob Lee on the thread');
    expect(redacted).not.toContain('Bob Lee');
    expect(redacted).toContain('[REDACTED_PROFILE]');
  });

  test('and not redactStructuredData either', async () => {
    await installedStore();
    const redacted = redactStructuredData({ note: 'ask Bob Lee about it' }) as { note: string };
    expect(redacted.note).not.toContain('Bob Lee');
  });

  test('and not a session export', async () => {
    await installedStore();
    const exported = exportToJSON(
      [{ role: 'assistant' as const, content: 'I will ask Bob Lee.' }],
      undefined,
      { redact: true },
    );
    expect(exported).not.toContain('Bob Lee');
  });

  test('the absolute set matches whole tokens, so a short name cannot eat a word', async () => {
    await installedStore([
      '## People',
      '',
      '- Al',
      '',
    ].join('\n'));
    // `Al` must not blank the "Al" out of "Already" / "Although".
    const corpus = 'Already although Alberta';
    expect(redactSensitiveData(corpus)).toBe(corpus);
    // But the name itself, standing alone, is redacted.
    expect(redactSensitiveData('ask Al about it')).not.toContain(' Al ');
  });

  test('the floor still protects ordinary closed-tier values', async () => {
    await installedStore();
    expect(redactSensitiveData('the USD amount was standard')).toBe('the USD amount was standard');
    expect(redactSensitiveData('imperial units, iso dates')).toBe('imperial units, iso dates');
  });
});

describe('the redaction value set is not rebuilt on every call', () => {
  test('a repeated redaction reads the document once per load, not once per call', async () => {
    const dir = mkTemp();
    const path = join(dir, 'owner-profile.md');
    writeFileSync(path, FIXTURE, 'utf-8');
    const store = new OwnerProfileStore({ path });
    await store.load();

    let reads = 0;
    const counting = {
      status: () => store.status(),
      get: (fieldId: string) => store.get(fieldId),
      section: (name: string) => store.section(name),
      read: () => {
        reads += 1;
        return store.read();
      },
    };
    installOwnerProfileConsumers(counting, {
      attachProfileFallback: () => undefined,
      consumerFallbackEnabled: () => true,
      injectOpenTierEnabled: () => true,
    });

    for (let i = 0; i < 50; i++) redactSensitiveData(`line ${i} with no profile value in it`);
    expect(reads).toBe(1);

    // A reload is a new generation, so exactly one more read happens.
    await store.load();
    redactSensitiveData('another line');
    expect(reads).toBe(2);
  });
});
