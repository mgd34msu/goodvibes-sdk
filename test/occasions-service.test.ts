/**
 * occasions-service.test.ts
 *
 * The whole loop, over a real owner-profile file and a real state store: a date
 * heard in conversation is confirmed once and written as a line he owns, the
 * sweep raises it once its window opens, a yes opens a short interview grounded
 * in what the profile already knows, what he landed on is remembered, and a
 * removal takes one confirmation and drops everything with it.
 *
 * The through-line: the owner's file is only ever written by the profile's own
 * gated write path, the machine's bookkeeping never lands in it, and nothing
 * unresolved is dropped.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/store.ts';
import { OccasionStateStore } from '../packages/sdk/src/platform/occasions/state-store.ts';
import {
  OccasionsService,
  resolveNudgeDestination,
  type OccasionNudgeDeliverer,
} from '../packages/sdk/src/platform/occasions/service.ts';
import { OCCASIONS_DEFAULTS } from '../packages/sdk/src/platform/occasions/policy.ts';
import type { OccasionNudge } from '../packages/sdk/src/platform/occasions/types.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-occasions-service-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROFILE = `# Owner profile

## Location

timezone: Europe/London

## People

- Sarah is my sister. She has been doing pottery all year and loves it.
- Jane, my wife.

## Important dates

- Sarah's birthday · 03-14 · annual · gift-giving · for Sarah
- Dad · 11-02 · annual · remember-only
- Gran · 06-01 · annual · neither

## Plans

- Lisbon · 2026-09-12..2026-09-19 · away · in Lisbon
`;

interface Harness {
  readonly service: OccasionsService;
  readonly profile: OwnerProfileStore;
  readonly state: OccasionStateStore;
  readonly delivered: OccasionNudge[];
  readonly profilePath: string;
  setNow(ms: number): void;
  setConfig(key: string, value: unknown): void;
}

function harness(options: { readonly profileText?: string; readonly now?: number } = {}): Harness {
  const dir = tempDir();
  const profilePath = join(dir, 'owner-profile.md');
  writeFileSync(profilePath, options.profileText ?? PROFILE, 'utf-8');
  const profile = new OwnerProfileStore({ path: profilePath });
  profile.loadSync();

  const state = new OccasionStateStore(join(dir, 'occasions-state.json'));
  const delivered: OccasionNudge[] = [];
  const deliverer: OccasionNudgeDeliverer = {
    deliver: async ({ nudge }) => {
      delivered.push(nudge);
      return 'delivery-1';
    },
  };
  // A channel is configured here because the shipped default is empty — the
  // feature is pull-only until he names one, and the "no channel" case below
  // sets it back.
  const overrides = new Map<string, unknown>([
    ['daemon.timezone', 'Europe/London'],
    ['occasions.nudgeChannel', 'telegram'],
  ]);
  let now = options.now ?? Date.parse('2026-03-06T10:00:00Z');

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
        if (overrides.has(key)) return overrides.get(key);
        const short = key.startsWith('occasions.') ? key.slice('occasions.'.length) : key;
        return (OCCASIONS_DEFAULTS as Record<string, unknown>)[short];
      },
      set: () => undefined,
    },
    deliverer,
    now: () => now,
  });

  return {
    service,
    profile,
    state,
    delivered,
    profilePath,
    setNow: (ms) => { now = ms; },
    setConfig: (key, value) => { overrides.set(key, value); },
  };
}

describe('reading what he declared', () => {
  test('lists every occasion with its next occurrence and window', async () => {
    const { service } = harness();
    const result = await service.list();
    expect(result.today).toBe('2026-03-06');
    expect(result.timezone).toBe('Europe/London');
    const sarah = result.occasions.find((view) => view.occasion.title === "Sarah's birthday");
    expect(sarah?.nextOccurrence).toBe('2026-03-14');
    expect(sarah?.daysUntil).toBe(8);
    expect(sarah?.inLeadWindow).toBe(true);
    const dad = result.occasions.find((view) => view.occasion.title === 'Dad');
    expect(dad?.nextOccurrence).toBe('2026-11-02');
    expect(dad?.inLeadWindow).toBe(false);
  });

  test('a line with no kind is reported, not silently typed', async () => {
    const { service } = harness({
      profileText: `# P\n\n## Important dates\n\n- Mum · 04-02 · annual\n`,
    });
    const result = await service.list();
    expect(result.occasions).toHaveLength(0);
    expect(result.unparsed).toHaveLength(1);
    expect(result.unparsed[0]!.reason).toContain('no kind');
  });

  test('two different dates for one thing are a conflict, never a silent choice', async () => {
    const { service } = harness({
      profileText: '# P\n\n## Important dates\n\n'
        + '- Mum · 04-02 · annual · gift-giving\n'
        + '- Mum · 04-03 · annual · gift-giving\n',
    });
    const result = await service.list();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.dates).toEqual(['04-02', '04-03']);
    // The FIRST line stays the active occasion; the newer value is not taken.
    expect(result.occasions).toHaveLength(1);
    expect(result.occasions[0]!.nextOccurrence).toBe('2026-04-02');
  });

  test('plans are read, and the away window is known', () => {
    const { service } = harness();
    const result = service.listPlans();
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]!.destination).toBe('Lisbon');
    expect(result.awayNow).toBeNull();
  });
});

describe('capture — confirmed once, kind never inferred', () => {
  test('a proposal with no kind asks for one and writes nothing', async () => {
    const { service, profilePath } = harness();
    const before = readFileSync(profilePath, 'utf-8');
    const proposal = service.proposeOccasion({ title: 'Our anniversary', date: '09-12' });
    expect(proposal.ok).toBe(true);
    expect(proposal.needsKind).toBe(true);
    expect(proposal.confirmation).toContain('right?');
    expect(proposal.confirmation.toLowerCase()).toContain('remember');
    expect(readFileSync(profilePath, 'utf-8')).toBe(before);
  });

  test('confirming without a kind is refused rather than defaulted', async () => {
    const { service, profilePath } = harness();
    const before = readFileSync(profilePath, 'utf-8');
    const outcome = await service.confirmOccasion({
      title: 'Our anniversary',
      date: '09-12',
      kind: '',
      surface: 'agent',
      said: 'our anniversary is the 12th of September',
      authority: 'owner-direct',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('guess');
    expect(readFileSync(profilePath, 'utf-8')).toBe(before);
  });

  test('a confirmed occasion lands as one line under Important dates, with provenance', async () => {
    const { service, profilePath } = harness();
    const outcome = await service.confirmOccasion({
      title: 'Our anniversary',
      date: '09-12',
      kind: 'gift-giving',
      person: 'Jane',
      surface: 'agent',
      said: 'our anniversary is the 12th of September',
      authority: 'owner-direct',
    });
    expect(outcome.ok).toBe(true);
    const text = readFileSync(profilePath, 'utf-8');
    expect(text).toContain('- Our anniversary · 09-12 · annual · gift-giving · for Jane');
    expect(text).toContain('— agent, ');
    // And it is under the dates heading, not appended to the end of the file.
    const dateSection = text.slice(text.indexOf('## Important dates'), text.indexOf('## Plans'));
    expect(dateSection).toContain('Our anniversary');
  });

  test('a date already recorded differently comes back as a conflict on the proposal', () => {
    const { service } = harness();
    const proposal = service.proposeOccasion({
      title: "Sarah's birthday",
      date: '03-15',
      kind: 'gift-giving',
    });
    expect(proposal.conflictsWith).toEqual(['03-14']);
  });

  test('an unreadable date is refused with the shape it wanted', () => {
    const { service } = harness();
    const proposal = service.proposeOccasion({ title: 'X', date: 'next tuesday', kind: 'gift-giving' });
    expect(proposal.ok).toBe(false);
    expect(proposal.reason).toContain('MM-DD');
  });

  test('a plan is confirmed the same way, and away is opt-in', async () => {
    const { service, profilePath } = harness();
    const outcome = await service.confirmPlan({
      title: 'Kitchen refit',
      from: '2026-04-03',
      to: '2026-04-10',
      surface: 'agent',
      said: 'the kitchen is being redone the 3rd to the 10th',
      authority: 'owner-direct',
    });
    expect(outcome.ok).toBe(true);
    const text = readFileSync(profilePath, 'utf-8');
    expect(text).toContain('- Kitchen refit · 2026-04-03..2026-04-10');
    expect(text).not.toContain('Kitchen refit · 2026-04-03..2026-04-10 · away');
  });
});

describe('the sweep and the answer', () => {
  test('raises the occasion in its window, delivers once, and holds the rest', async () => {
    const h = harness();
    const outcome = await h.service.sweep();
    expect(outcome.hold).toBeNull();
    expect(outcome.nudge?.subjects).toHaveLength(1);
    expect(outcome.nudge?.subjects[0]!.title).toBe("Sarah's birthday");
    expect(outcome.delivered).toBe(true);
    expect(h.delivered).toHaveLength(1);
    // Delivered text carries no date in any form.
    expect(h.delivered[0]!.message).not.toMatch(/\d/);

    // Running again the same day does not nudge again.
    const again = await h.service.sweep();
    expect(again.nudge).toBeNull();
    expect(h.delivered).toHaveLength(1);
  });

  test('outside the active window it says nothing and drops nothing', async () => {
    const h = harness({ now: Date.parse('2026-03-06T03:00:00Z') });
    const held = await h.service.sweep();
    expect(held.hold).toBe('quiet-hours');
    expect(h.delivered).toHaveLength(0);
    // Housekeeping still ran — the reap does not depend on being allowed to speak.
    expect(held.housekeeping).not.toBeNull();

    h.setNow(Date.parse('2026-03-06T10:00:00Z'));
    const spoken = await h.service.sweep();
    expect(spoken.hold).toBeNull();
    expect(h.delivered).toHaveLength(1);
  });

  test('turned off, it still reaps and still answers, and raises nothing', async () => {
    const h = harness();
    h.setConfig('occasions.enabled', false);
    const outcome = await h.service.sweep();
    expect(outcome.hold).toBe('disabled');
    expect(outcome.housekeeping).not.toBeNull();
    // The dates are still held and still readable.
    expect((await h.service.list()).occasions.length).toBeGreaterThan(0);
  });

  test('a no silences this cycle and leaves nothing open', async () => {
    const h = harness();
    await h.service.sweep();
    const answered = await h.service.answer({ occasionId: "sarah's birthday", answer: 'no' });
    expect(answered.ok).toBe(true);
    expect(answered.interview).toBeNull();
    expect(await h.state.openItems()).toHaveLength(0);

    h.setNow(Date.parse('2026-03-12T10:00:00Z'));
    const later = await h.service.sweep();
    expect(later.nudge).toBeNull();
  });

  test('a later is not a decline — the item stays open and moves', async () => {
    const h = harness();
    await h.service.sweep();
    await h.service.answer({ occasionId: "sarah's birthday", answer: 'later' });
    const items = await h.state.openItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.dueOn).toBe('2026-03-10');

    h.setNow(Date.parse('2026-03-10T10:00:00Z'));
    const back = await h.service.sweep();
    expect(back.nudge?.subjects[0]!.title).toBe("Sarah's birthday");
  });

  test('the machine writes none of its bookkeeping into his file', async () => {
    const h = harness();
    const before = readFileSync(h.profilePath, 'utf-8');
    await h.service.sweep();
    await h.service.answer({ occasionId: "sarah's birthday", answer: 'yes' });
    await h.service.sweep();
    expect(readFileSync(h.profilePath, 'utf-8')).toBe(before);
  });
});

describe('the interview', () => {
  test('a yes opens it, grounded in what the profile already says about her', async () => {
    const h = harness();
    await h.service.sweep();
    const answered = await h.service.answer({ occasionId: "sarah's birthday", answer: 'yes' });
    const progress = answered.interview;
    expect(progress).not.toBeNull();
    expect(progress!.steps).toHaveLength(3);
    expect(progress!.steps[0]!.opensFrom).toContain('pottery');
    expect(progress!.nextStep?.id).toBe('direction');
    // It asks; it does not recommend.
    for (const step of progress!.steps) {
      expect(step.prompt.toLowerCase()).not.toContain('you should');
      expect(step.prompt).toContain('?');
    }
  });

  test('a remember-only yes does not open an interview', async () => {
    const h = harness({ now: Date.parse('2026-10-28T10:00:00Z') });
    const answered = await h.service.answer({ occasionId: 'dad', answer: 'yes' });
    expect(answered.ok).toBe(true);
    expect(answered.interview).toBeNull();
  });

  test('a thread he walked away from resumes at the question he did not answer', async () => {
    const h = harness();
    await h.service.sweep();
    const started = (await h.service.answer({ occasionId: "sarah's birthday", answer: 'yes' })).interview!;
    await h.service.answerInterview({
      interviewId: started.interviewId,
      stepId: 'direction',
      text: 'still pottery',
    });

    // Days later, without answering the rest.
    h.setNow(Date.parse('2026-03-09T10:00:00Z'));
    const resumed = await h.service.interview(started.interviewId);
    expect(resumed!.nextStep?.id).toBe('contrast');
    expect(resumed!.complete).toBe(false);
    // And the sweep raises it again rather than letting it die.
    const outcome = await h.service.sweep();
    expect(outcome.resumedInterviews).toContain(started.interviewId);
  });

  test('what he landed on is recorded, and steers the next year', async () => {
    const h = harness();
    await h.service.sweep();
    const started = (await h.service.answer({ occasionId: "sarah's birthday", answer: 'yes' })).interview!;
    const done = await h.service.recordGiftOutcome({
      interviewId: started.interviewId,
      landedOn: 'a wheel-throwing weekend',
    });
    expect(done!.complete).toBe(true);
    expect(done!.landedOn).toBe('a wheel-throwing weekend');

    const history = await h.service.giftHistory("sarah's birthday");
    expect(history).toHaveLength(1);
    expect(history[0]!.landedOn).toBe('a wheel-throwing weekend');

    // Next year's interview opens from it rather than from a blank form.
    h.setNow(Date.parse('2027-03-06T10:00:00Z'));
    const nextYear = (await h.service.answer({ occasionId: "sarah's birthday", answer: 'yes' })).interview!;
    expect(nextYear.steps[1]!.prompt).toContain('a wheel-throwing weekend');
  });
});

describe('removal', () => {
  test('an unconfirmed removal changes nothing and says what it needs', async () => {
    const h = harness();
    const before = readFileSync(h.profilePath, 'utf-8');
    const outcome = await h.service.removeOccasion({
      occasionId: "sarah's birthday",
      confirmed: false,
      authority: 'owner-direct',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('Confirm');
    expect(readFileSync(h.profilePath, 'utf-8')).toBe(before);
  });

  test('one confirmation removes the line and every record against it', async () => {
    const h = harness();
    await h.service.sweep();
    await h.service.answer({ occasionId: "sarah's birthday", answer: 'yes' });
    expect((await h.state.disclose()).acknowledgements).toBe(1);

    const outcome = await h.service.removeOccasion({
      occasionId: "sarah's birthday",
      confirmed: true,
      authority: 'owner-direct',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.droppedRecords).toBeGreaterThan(0);
    expect(readFileSync(h.profilePath, 'utf-8')).not.toContain("Sarah's birthday");
    const disclosure = await h.state.disclose();
    expect(disclosure).toMatchObject({ acknowledgements: 0, interviews: 0, openItems: 0 });
    // The other dates are untouched.
    expect(readFileSync(h.profilePath, 'utf-8')).toContain('- Dad · 11-02');
  });
});

describe('what is outstanding, and where it may go', () => {
  test('pending returns the nudge without delivering it again', async () => {
    const h = harness();
    await h.service.sweep();
    const pending = await h.service.pending();
    expect(pending.nudge?.subjects[0]!.title).toBe("Sarah's birthday");
    expect(h.delivered).toHaveLength(1);
  });

  test('with no delivery channel configured it is pull-only', async () => {
    const h = harness();
    h.setConfig('occasions.nudgeChannel', '');
    const outcome = await h.service.sweep();
    expect(outcome.delivered).toBe(false);
    expect(h.delivered).toHaveLength(0);
    expect((await h.service.pending()).nudge).not.toBeNull();
  });

  test('the TUI is refused as a destination, whatever is configured', async () => {
    expect(resolveNudgeDestination('telegram')).toBe('telegram');
    expect(resolveNudgeDestination('telegram:12345')).toBe('telegram:12345');
    expect(resolveNudgeDestination('tui')).toBeNull();
    expect(resolveNudgeDestination('TUI:main')).toBeNull();
    expect(resolveNudgeDestination('  ')).toBeNull();

    const h = harness();
    h.setConfig('occasions.nudgeChannel', 'tui');
    const outcome = await h.service.sweep();
    expect(outcome.delivered).toBe(false);
    expect(h.delivered).toHaveLength(0);
  });

  test('a conflict is raised and keeps being raised until it is closed', async () => {
    const h = harness({
      profileText: '# P\n\n## Important dates\n\n'
        + '- Mum · 04-02 · annual · gift-giving\n'
        + '- Mum · 04-03 · annual · gift-giving\n',
    });
    const first = await h.service.sweep();
    expect(first.conflictMessages).toHaveLength(1);
    expect(first.conflictMessages[0]).toContain('Mum');

    const pending = await h.service.pending();
    expect(pending.conflicts).toHaveLength(1);

    expect(await h.service.resolveConflict('mum')).toBe(true);
    expect((await h.service.pending()).conflicts).toHaveLength(0);
  });

  test('the state disclosure names the file and counts, never contents', async () => {
    const h = harness();
    await h.service.sweep();
    await h.service.answer({ occasionId: "sarah's birthday", answer: 'no' });
    const disclosure = await h.service.disclose();
    expect(disclosure.path).toContain('occasions-state.json');
    expect(disclosure.acknowledgements).toBe(1);
    expect(JSON.stringify(disclosure)).not.toContain('Sarah');
  });
});

describe('the calendar mirror', () => {
  test('writes each occurrence once, and never reads anything back', async () => {
    const dir = tempDir();
    const profilePath = join(dir, 'owner-profile.md');
    writeFileSync(profilePath, PROFILE, 'utf-8');
    const profile = new OwnerProfileStore({ path: profilePath });
    profile.loadSync();
    const state = new OccasionStateStore(join(dir, 'occasions-state.json'));
    const calls: string[] = [];
    const overrides = new Map<string, unknown>([
      ['daemon.timezone', 'Europe/London'],
      ['occasions.calendarMirror', true],
    ]);

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
          if (overrides.has(key)) return overrides.get(key);
          const short = key.startsWith('occasions.') ? key.slice('occasions.'.length) : key;
          return (OCCASIONS_DEFAULTS as Record<string, unknown>)[short];
        },
        set: () => undefined,
      },
      calendar: {
        mirror: async ({ occasion, occurrence }) => {
          calls.push(`${occasion.id}@${occurrence}`);
          return `evt-${calls.length}`;
        },
      },
      now: () => Date.parse('2026-03-06T10:00:00Z'),
    });

    const first = await service.sweep();
    // Both raisable kinds are mirrored; `neither` is not.
    expect(first.mirrored).toBe(2);
    expect(calls).toEqual(["sarah's birthday@2026-03-14", 'dad@2026-11-02']);

    const second = await service.sweep();
    expect(second.mirrored).toBe(0);
    expect(calls).toHaveLength(2);
    // And the file is unchanged: the mirror is a copy, never a source.
    expect(readFileSync(profilePath, 'utf-8')).toBe(PROFILE);
  });
});
