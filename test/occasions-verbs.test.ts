/**
 * occasions-verbs.test.ts, the `occasions.*` control-plane surface.
 *
 * Exercised over a real GatewayMethodCatalog with the handlers attached the way
 * the daemon attaches them, so the descriptors, the scopes, the required-field
 * arrays and the handler wiring are all in the assertion path rather than
 * assumed.
 *
 * Two properties this file exists to pin, because they are the ones a consumer
 * would otherwise be able to break by mistake:
 *
 *  - **The surface is complete.** Every operation a surface needs is a verb.
 *    A consumer that had to compute something is a second implementation of a
 *    rule that lives in the daemon.
 *  - **`authority` is required on every write.** It is a body parameter, so
 *    requiring it refuses nobody who was going to succeed and closes the case
 *    where omitting it meant a removal ran with no gate at all.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerOccasionsGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/occasions.ts';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/index.ts';
import { OccasionStateStore } from '../packages/sdk/src/platform/occasions/state-store.ts';
import { OccasionsService } from '../packages/sdk/src/platform/occasions/service.ts';
import { OCCASIONS_DEFAULTS } from '../packages/sdk/src/platform/occasions/policy.ts';

const VERB_IDS = [
  'occasions.list',
  'occasions.propose',
  'occasions.confirm',
  'occasions.remove',
  'occasions.answer',
  'occasions.interview.get',
  'occasions.interview.answer',
  'occasions.interview.record',
  'occasions.gifts',
  'occasions.pending',
  'occasions.sweep',
  'occasions.conflict.resolve',
  'occasions.plans.list',
  'occasions.plans.propose',
  'occasions.plans.confirm',
  'occasions.state',
] as const;

const FIXTURE = [
  "# Mike's profile",
  '',
  '## People',
  '',
  '- Sarah, sister. She loves pottery.',
  '',
  '## Important dates',
  '',
  "- Sarah's birthday · 03-14 · annual · gift-giving · for Sarah",
  '',
  '## Plans',
  '',
  '- Lisbon · 2026-09-12..2026-09-19 · away · in Lisbon',
  '',
].join('\n');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly catalog: GatewayMethodCatalog;
  readonly profilePath: string;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gv-occasions-verbs-'));
  dirs.push(dir);
  const profilePath = join(dir, 'owner-profile.md');
  writeFileSync(profilePath, FIXTURE, 'utf-8');
  const profile = new OwnerProfileStore({ path: profilePath });
  profile.loadSync();
  const state = new OccasionStateStore(join(dir, 'occasions-state.json'));
  const service = new OccasionsService({
    profile: {
      importantDates: () => profile.importantDates(),
      plans: () => profile.plans(),
      person: (name) => profile.person(name),
    },
    writer: {
      append: (input) => profile.append(input),
      forget: (input) => profile.forget(input),
    },
    state,
    config: {
      get: (key) => {
        if (key === 'daemon.timezone') return 'Europe/London';
        const short = key.startsWith('occasions.') ? key.slice('occasions.'.length) : key;
        return (OCCASIONS_DEFAULTS as Record<string, unknown>)[short];
      },
      set: () => undefined,
    },
    now: () => Date.parse('2026-03-06T10:00:00Z'),
  });
  const catalog = new GatewayMethodCatalog();
  registerOccasionsGatewayMethods(catalog, service);
  return { catalog, profilePath };
}

const ctx = { context: { admin: true } } as const;

describe('the catalog surface', () => {
  test('every verb is cataloged, handled, and carries a read or write scope', () => {
    const { catalog } = harness();
    for (const id of VERB_IDS) {
      const descriptor = catalog.get(id);
      expect(descriptor, `${id} is not cataloged`).not.toBeNull();
      expect(catalog.hasHandler(id), `${id} has no handler`).toBe(true);
      expect(descriptor?.scopes).toHaveLength(1);
      expect(['read:occasions', 'write:occasions']).toContain(descriptor!.scopes[0]!);
    }
  });

  test('reads are read-scoped and writes are write-scoped, with no crossover', () => {
    const { catalog } = harness();
    const readScoped = VERB_IDS.filter((id) => catalog.get(id)?.scopes.includes('read:occasions'));
    expect([...readScoped].sort()).toEqual([
      'occasions.gifts',
      'occasions.interview.get',
      'occasions.list',
      'occasions.pending',
      'occasions.plans.list',
      'occasions.state',
    ]);
  });

  test('removal is marked dangerous — it deletes a line he owns', () => {
    const { catalog } = harness();
    expect(catalog.get('occasions.remove')?.dangerous).toBe(true);
    expect(catalog.get('occasions.list')?.dangerous).toBeFalsy();
  });

  test('the confirm verbs require every field their handler enforces', () => {
    const { catalog } = harness();
    const confirm = catalog.get('occasions.confirm')?.inputSchema as { required?: string[] };
    expect(confirm.required).toEqual(['title', 'date', 'kind', 'surface', 'said', 'authority']);
    const plan = catalog.get('occasions.plans.confirm')?.inputSchema as { required?: string[] };
    expect(plan.required).toEqual(['title', 'from', 'to', 'surface', 'said', 'authority']);
    const remove = catalog.get('occasions.remove')?.inputSchema as { required?: string[] };
    expect(remove.required).toEqual(['occasionId', 'confirmed', 'authority']);
  });
});

describe('the verbs, invoked', () => {
  test('occasions.list answers with the dates — the owner asking his own system', async () => {
    const { catalog } = harness();
    const result = await catalog.invoke('occasions.list', { ...ctx, body: {} }) as {
      today: string;
      occasions: { nextOccurrence: string | null; daysUntil: number | null }[];
    };
    expect(result.today).toBe('2026-03-06');
    expect(result.occasions[0]!.nextOccurrence).toBe('2026-03-14');
    expect(result.occasions[0]!.daysUntil).toBe(8);
  });

  test('occasions.pending answers with a nudge that carries no date at all', async () => {
    const { catalog } = harness();
    await catalog.invoke('occasions.sweep', { ...ctx, body: {} });
    const result = await catalog.invoke('occasions.pending', { ...ctx, body: {} }) as {
      nudge: { message: string; subjects: { proximity: string }[] } | null;
    };
    expect(result.nudge).not.toBeNull();
    expect(result.nudge!.message).not.toMatch(/\d/);
    expect(result.nudge!.subjects[0]!.proximity).toBe('approaching');
    // The structured payload carries a WORD, and no day count anywhere.
    expect(JSON.stringify(result.nudge!.subjects)).not.toContain('daysUntil');
  });

  test('occasions.propose writes nothing and asks for the kind', async () => {
    const { catalog, profilePath } = harness();
    const before = readFileSync(profilePath, 'utf-8');
    const proposal = await catalog.invoke('occasions.propose', {
      ...ctx,
      body: { title: 'Our anniversary', date: '09-12' },
    }) as { needsKind: boolean; confirmation: string };
    expect(proposal.needsKind).toBe(true);
    expect(readFileSync(profilePath, 'utf-8')).toBe(before);
  });

  test('a write with no authority is refused before anything happens', async () => {
    const { catalog, profilePath } = harness();
    const before = readFileSync(profilePath, 'utf-8');
    await expect(catalog.invoke('occasions.confirm', {
      ...ctx,
      body: { title: 'X', date: '09-12', kind: 'gift-giving', surface: 'agent', said: 'x' },
    })).rejects.toThrow(/authority is required/);
    await expect(catalog.invoke('occasions.remove', {
      ...ctx,
      body: { occasionId: "sarah's birthday", confirmed: true },
    })).rejects.toThrow(/authority is required/);
    expect(readFileSync(profilePath, 'utf-8')).toBe(before);
  });

  test('an unrecognised authority is refused rather than defaulted to the trusted one', async () => {
    const { catalog } = harness();
    await expect(catalog.invoke('occasions.remove', {
      ...ctx,
      body: { occasionId: "sarah's birthday", confirmed: true, authority: 'owner_direct' },
    })).rejects.toThrow(/authority is required/);
  });

  test('a caller declaring this was not a user request is refused on every write to his file', async () => {
    const { catalog, profilePath } = harness();
    const before = readFileSync(profilePath, 'utf-8');
    for (const id of ['occasions.confirm', 'occasions.remove', 'occasions.plans.confirm']) {
      await expect(catalog.invoke(id, {
        context: { admin: true, metadata: { explicitUserRequest: false } },
        body: {
          title: 'X',
          date: '09-12',
          kind: 'gift-giving',
          from: '2026-09-12',
          to: '2026-09-19',
          occasionId: "sarah's birthday",
          confirmed: true,
          surface: 'agent',
          said: 'x',
          authority: 'owner-direct',
        },
      })).rejects.toThrow();
    }
    expect(readFileSync(profilePath, 'utf-8')).toBe(before);
  });

  test('an answer outside yes/no/later is refused, never folded into a decline', async () => {
    const { catalog } = harness();
    await expect(catalog.invoke('occasions.answer', {
      ...ctx,
      body: { occasionId: "sarah's birthday", answer: 'nope' },
    })).rejects.toThrow(/yes, no, later/);
  });

  test('the yes/interview/record chain runs entirely through verbs', async () => {
    const { catalog } = harness();
    await catalog.invoke('occasions.sweep', { ...ctx, body: {} });
    const answered = await catalog.invoke('occasions.answer', {
      ...ctx,
      body: { occasionId: "sarah's birthday", answer: 'yes' },
    }) as { interview: { interviewId: string; nextStep: { id: string } } | null };
    expect(answered.interview).not.toBeNull();
    const interviewId = answered.interview!.interviewId;
    expect(answered.interview!.nextStep.id).toBe('direction');

    const stepped = await catalog.invoke('occasions.interview.answer', {
      ...ctx,
      body: { interviewId, stepId: 'direction', text: 'pottery still' },
    }) as { present: boolean; interview: { nextStep: { id: string } } };
    expect(stepped.present).toBe(true);
    expect(stepped.interview.nextStep.id).toBe('contrast');

    const recorded = await catalog.invoke('occasions.interview.record', {
      ...ctx,
      body: { interviewId, landedOn: 'a kiln course' },
    }) as { interview: { complete: boolean; landedOn: string } };
    expect(recorded.interview.complete).toBe(true);

    const gifts = await catalog.invoke('occasions.gifts', {
      ...ctx,
      body: { occasionId: "sarah's birthday" },
    }) as { gifts: { landedOn: string }[] };
    expect(gifts.gifts[0]!.landedOn).toBe('a kiln course');
  });

  test('an unknown interview id answers present:false rather than throwing', async () => {
    const { catalog } = harness();
    const result = await catalog.invoke('occasions.interview.get', {
      ...ctx,
      body: { interviewId: 'nothing-like-this' },
    }) as { present: boolean; interview: unknown };
    expect(result.present).toBe(false);
    expect(result.interview).toBeNull();
  });

  test('occasions.state returns counts and a path, never a date or an answer', async () => {
    const { catalog } = harness();
    await catalog.invoke('occasions.sweep', { ...ctx, body: {} });
    await catalog.invoke('occasions.answer', {
      ...ctx,
      body: { occasionId: "sarah's birthday", answer: 'no' },
    });
    const state = await catalog.invoke('occasions.state', { ...ctx, body: {} }) as Record<string, unknown>;
    expect(state['acknowledgements']).toBe(1);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('Sarah');
    expect(serialized).not.toContain('03-14');
  });

  test('occasions.plans.list answers with the declared ranges', async () => {
    const { catalog } = harness();
    const result = await catalog.invoke('occasions.plans.list', { ...ctx, body: {} }) as {
      plans: { destination: string; away: boolean }[];
      awayNow: unknown;
    };
    expect(result.plans[0]!.destination).toBe('Lisbon');
    expect(result.plans[0]!.away).toBe(true);
    expect(result.awayNow).toBeNull();
  });
});
