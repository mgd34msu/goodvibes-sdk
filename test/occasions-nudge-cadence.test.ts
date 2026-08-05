/**
 * occasions-nudge-cadence.test.ts
 *
 * The round that followed the owner being told about his own birthday five
 * times in one day and counting, by a sweep running every hour.
 *
 * Four defects, all in the same family, all pinned here:
 *
 *  1. The sweep raised any open item whose due date had arrived, on EVERY pass.
 *     A nudge's due date is clamped to the occurrence, so on the day itself it
 *     was due forever and an hourly sweep meant an hourly reminder.
 *  2. An acknowledgement could not be written by anything he could actually
 *     reach. The state file has held the array since day one; the only writer
 *     was a CLI/webui verb, and the nudge lands on Telegram and in the agent's
 *     conversation, where the reply to it is a sentence.
 *  3. Nothing knew an occasion could be about HIM. He does not need to be told
 *     when his own birthday is.
 *  4. Asked to stop, the conversational turn switched the entire feature off —
 *     silencing his wife's gift-giving occasion along with his own birthday.
 *
 * And one delivery defect found alongside them: the nudge was landed in the
 * agent's conversation as a bare sentence, which the model then wove into
 * unrelated troubleshooting as though it were a thought of its own.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/store.ts';
import { OccasionStateStore } from '../packages/sdk/src/platform/occasions/state-store.ts';
import {
  OccasionsService,
  type OccasionNudgeDeliverer,
} from '../packages/sdk/src/platform/occasions/service.ts';
import { nudgeDeliveryText } from '../packages/sdk/src/platform/occasions/destinations.ts';
import { AGENT_NOTICE_HEADING } from '../packages/sdk/src/platform/occasions/nudge.ts';
import { reconcileRaiseLedger } from '../packages/sdk/src/platform/occasions/cadence.ts';
import {
  possessiveSubject,
  pushableSubject,
  resolveOccasionSubject,
} from '../packages/sdk/src/platform/occasions/subject.ts';
import { parseOccasionLine } from '../packages/sdk/src/platform/occasions/grammar.ts';
import { OCCASIONS_DEFAULTS } from '../packages/sdk/src/platform/occasions/policy.ts';
import {
  buildConversationalTurnContext,
  OCCASION_ACKNOWLEDGEMENT_INSTRUCTION,
  OCCASION_COMPLAINT_LADDER,
} from '../packages/sdk/src/platform/personal-capture/spawn-contract.ts';
import { PROFILE_TOOL_SCHEMA } from '../packages/sdk/src/platform/tools/profile/schema.ts';
import type { OccasionNudge, OpenItem } from '../packages/sdk/src/platform/occasions/types.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-occasion-cadence-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The owner's own file, in the shape his machine actually holds.
 *
 * His birthday is written the way he wrote it: no `for` attribution at all, so
 * the subject has to be resolved through the Identity section rather than
 * spotted by a name literal. His wife's carries the `for` form, is gift-giving,
 * and is the occasion that must keep working through every silence below.
 */
const PROFILE = `# Owner profile

## Identity

name: Mike Davis
goes by: Mike

## Location

timezone: Europe/London

## People

- Natalie Sons, my wife.

## Important dates

- Mike's birthday · 08-06 · annual · remember-only
- Natalie Sons's birthday · 08-20 · annual · gift-giving · for Natalie Sons
`;

interface Harness {
  readonly service: OccasionsService;
  readonly state: OccasionStateStore;
  readonly pushes: { readonly channel: string; readonly nudge: OccasionNudge }[];
  setNow(ms: number): void;
  setConfig(key: string, value: unknown): void;
}

function harness(options: {
  readonly profileText?: string;
  readonly now?: number;
  readonly statePath?: string;
} = {}): Harness {
  const dir = tempDir();
  const profilePath = join(dir, 'owner-profile.md');
  writeFileSync(profilePath, options.profileText ?? PROFILE, 'utf-8');
  const profile = new OwnerProfileStore({ path: profilePath });
  profile.loadSync();

  const state = new OccasionStateStore(options.statePath ?? join(dir, 'occasions-state.json'));
  const pushes: { readonly channel: string; readonly nudge: OccasionNudge }[] = [];
  const deliverer: OccasionNudgeDeliverer = {
    deliver: async ({ channel, nudge }) => {
      pushes.push({ channel, nudge });
      return `delivery-${pushes.length}`;
    },
  };
  const overrides = new Map<string, unknown>([
    ['daemon.timezone', 'Europe/London'],
    ['occasions.nudgeChannel', 'telegram,agent'],
  ]);
  let now = options.now ?? Date.parse('2026-07-30T10:00:00Z');

  const service = new OccasionsService({
    // The same four reads the real composition binds, `ownerNames` included —
    // that is the whole linkage that lets his own birthday be recognised.
    profile: {
      importantDates: () => profile.importantDates(),
      plans: () => profile.plans(),
      person: (name) => profile.person(name),
      ownerNames: () => [
        profile.get('identity.name')?.value ?? '',
        profile.get('identity.goesBy')?.value ?? '',
      ].filter((name) => name.trim().length > 0),
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
    state,
    pushes,
    setNow: (ms) => { now = ms; },
    setConfig: (key, value) => { overrides.set(key, value); },
  };
}

/** Run the sweep once an hour, every waking hour, across a span of days. */
async function sweepHourly(h: Harness, from: string, days: number): Promise<void> {
  for (let day = 0; day < days; day += 1) {
    const date = new Date(Date.parse(`${from}T00:00:00Z`) + day * 86_400_000);
    const iso = date.toISOString().slice(0, 10);
    for (let hour = 8; hour < 22; hour += 1) {
      h.setNow(Date.parse(`${iso}T${String(hour).padStart(2, '0')}:00:00Z`));
      await h.service.sweep();
    }
  }
}

function occasionLine(line: string) {
  const parsed = parseOccasionLine(0, `- ${line}`);
  if (!parsed.ok) throw new Error(parsed.unparsed.reason);
  return parsed.occasion;
}

// ---------------------------------------------------------------------------

describe('the two-raise ceiling', () => {
  test('an hourly sweep across the whole lead window pushes exactly twice', async () => {
    const h = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    // Natalie's birthday is 08-20 with a ten-day lead, so the window opens on
    // the 10th. Fourteen sweeps a day for eleven days is 154 passes, ending on
    // the day itself — one more day and the housekeeping pass would reap the
    // item as expired, which is correct and would hide what is being asserted.
    await sweepHourly(h, '2026-08-10', 11);

    const wife = h.pushes.filter((push) => push.channel === 'telegram');
    expect(wife).toHaveLength(2);
    const item = (await h.state.openItems()).find((entry) => entry.occurrence === '2026-08-20');
    expect(item?.raiseCount).toBe(2);
    expect(item?.servedBoundaries).toEqual(['lead', 'day-of']);
  });

  test('the two pushes land at the lead boundary and on the day itself', async () => {
    const h = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    const first = await h.service.sweep();
    expect(first.nudge?.subjects[0]?.title).toBe("Natalie Sons's birthday");

    // Every day in between is silent. Not "quieter" — silent.
    for (const day of ['2026-08-11', '2026-08-14', '2026-08-17', '2026-08-19']) {
      h.setNow(Date.parse(`${day}T10:00:00Z`));
      expect((await h.service.sweep()).nudge).toBeNull();
    }

    h.setNow(Date.parse('2026-08-20T10:00:00Z'));
    expect((await h.service.sweep()).nudge?.subjects[0]?.title).toBe("Natalie Sons's birthday");

    // And the day itself does not become a new hourly loop, which is the exact
    // shape of the original defect: the due date could never move past the
    // occurrence, so on the day it was due on every pass forever.
    for (let hour = 11; hour < 22; hour += 1) {
      h.setNow(Date.parse(`2026-08-20T${hour}:00:00Z`));
      expect((await h.service.sweep()).nudge).toBeNull();
    }
    expect(h.pushes.filter((push) => push.channel === 'telegram')).toHaveLength(2);
  });

  test('the open item survives the silence and stays enumerable', async () => {
    const h = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    await h.service.sweep();
    h.setNow(Date.parse('2026-08-15T10:00:00Z'));
    expect((await h.service.sweep()).nudge).toBeNull();

    // Nothing unresolved dropped. It stopped shouting; it did not go away.
    const pending = await h.service.pending();
    expect(pending.nudge?.subjects.map((entry) => entry.title))
      .toContain("Natalie Sons's birthday");
  });
});

describe('an acknowledgement mutes the push and never the pull', () => {
  test('after acknowledging, no sweep pushes it again — and the pull still has it', async () => {
    const h = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    await h.service.sweep();
    expect(h.pushes).not.toHaveLength(0);
    const before = h.pushes.length;

    const ack = await h.service.acknowledge({
      occasionId: "natalie sons's birthday",
      source: 'conversation',
    });
    expect(ack.ok).toBe(true);

    await sweepHourly(h, '2026-08-11', 10);
    expect(h.pushes).toHaveLength(before);

    const pending = await h.service.pending();
    expect(pending.nudge).toBeNull();
    expect(pending.acknowledged.map((entry) => entry.title))
      .toContain("Natalie Sons's birthday");
    expect(pending.acknowledged[0]?.acknowledged).toBe(true);
  });

  test('the reply names what was silenced and says the rest still runs', async () => {
    const h = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    const ack = await h.service.acknowledge({
      occasionId: "natalie sons's birthday",
      source: 'conversation',
    });
    expect(ack.reply).toContain("Natalie Sons's birthday");
    expect(ack.reply.toLowerCase()).toContain('other dates');
  });

  test('acknowledging leaves the open item standing, unlike a yes or a no', async () => {
    const h = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    await h.service.sweep();
    await h.service.acknowledge({ occasionId: "natalie sons's birthday", source: 'explicit' });
    const items = (await h.state.openItems()).filter((entry) => entry.kind === 'nudge');
    expect(items.some((entry) => entry.occasionId === "natalie sons's birthday")).toBe(true);

    // A `no`, by contrast, ends the question and removes the item.
    await h.service.answer({ occasionId: "natalie sons's birthday", answer: 'no' });
    const after = (await h.state.openItems()).filter((entry) => entry.kind === 'nudge');
    expect(after.some((entry) => entry.occasionId === "natalie sons's birthday")).toBe(false);
  });

  test('the recorded answer carries how it was acknowledged', async () => {
    const h = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    await h.service.acknowledge({ occasionId: "natalie sons's birthday", source: 'conversation' });
    const entry = (await h.state.acknowledgements())
      .find((record) => record.occasionId === "natalie sons's birthday");
    expect(entry?.answer).toBe('acknowledged');
    expect(entry?.source).toBe('conversation');
  });
});

describe('the conversational turn can acknowledge, and is told to', () => {
  test('the profile tool exposes acknowledge_occasion', () => {
    const properties = PROFILE_TOOL_SCHEMA.parameters.properties as
      Record<string, { enum?: readonly string[] }> | undefined;
    expect(properties?.['action']?.enum).toContain('acknowledge_occasion');
    // And the parameters it needs to name one.
    expect(properties?.['occasionId']).toBeDefined();
  });

  test('the turn contract tells it to record an acknowledgement in the same turn', () => {
    const context = buildConversationalTurnContext({ sessionId: 's1' });
    expect(context).toContain('acknowledge_occasion');
    // The failure mode being corrected: offering rather than doing.
    expect(context).toContain('Do not ask him whether to record it');
    for (const line of OCCASION_ACKNOWLEDGEMENT_INSTRUCTION) {
      expect(context).toContain(line);
    }
  });

  test('the remedy ladder is in the contract, smallest rung first', () => {
    const context = buildConversationalTurnContext({ sessionId: 's1' });
    for (const line of OCCASION_COMPLAINT_LADDER) expect(context).toContain(line);

    const text = OCCASION_COMPLAINT_LADDER.join('\n');
    const ackRung = text.indexOf('Acknowledge that one occurrence');
    const occasionRung = text.indexOf('Change that one occasion');
    const featureRung = text.indexOf('Turn the whole occasions feature off');
    expect(ackRung).toBeGreaterThan(-1);
    expect(occasionRung).toBeGreaterThan(ackRung);
    expect(featureRung).toBeGreaterThan(occasionRung);

    // Switching the feature off needs him to have named the feature, and
    // swearing is not consent to it. Both were the actual failure.
    expect(text).toContain('ONLY when he has said so explicitly and named');
    expect(text).toContain('neither is a complaint with swearing in it');
    // And whatever happens, he is told what stayed on.
    expect(text).toContain('his other dates still run');
  });
});

describe('gift-flow activity acknowledges by itself', () => {
  test('answering a gift question mutes the push for that occurrence', async () => {
    const h = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    await h.service.sweep();
    const opened = await h.service.answer({
      occasionId: "natalie sons's birthday",
      answer: 'yes',
    });
    const step = opened.interview?.nextStep;
    expect(step).not.toBeNull();

    await h.service.answerInterview({
      interviewId: opened.interview!.interviewId,
      stepId: step!.id,
      text: 'something for the garden',
    });

    const entry = (await h.state.acknowledgements())
      .find((record) => record.occasionId === "natalie sons's birthday");
    // A `yes` outranks an acknowledgement and is left alone — it is what opened
    // the interview, and the resume path reads it.
    expect(entry?.answer).toBe('yes');

    // The gift flow acknowledges an occurrence that has NOT been answered yes.
    const other = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    await other.service.acknowledge({
      occasionId: "natalie sons's birthday",
      source: 'gift-flow',
    });
    const auto = (await other.state.acknowledgements())
      .find((record) => record.occasionId === "natalie sons's birthday");
    expect(auto?.source).toBe('gift-flow');
    const before = other.pushes.length;
    await sweepHourly(other, '2026-08-10', 11);
    expect(other.pushes).toHaveLength(before);
  });
});

describe('an occasion about him that he only has to remember is never pushed', () => {
  test('his own birthday is never sent, through a whole hourly lead window', async () => {
    const h = harness({ now: Date.parse('2026-07-27T10:00:00Z') });
    // His birthday is 08-06; the window opens on 07-27. Eleven days of hourly
    // sweeps is 154 passes — the exact scenario that produced five pushes.
    await sweepHourly(h, '2026-07-27', 11);
    const aboutHim = h.pushes.filter((push) =>
      push.nudge.subjects.some((subject) => subject.occasionId === "mike's birthday"));
    expect(aboutHim).toHaveLength(0);
  });

  test('it is still there when he asks what is coming up', async () => {
    const h = harness({ now: Date.parse('2026-07-27T10:00:00Z') });
    await h.service.sweep();
    const pending = await h.service.pending();
    const titles = [
      ...(pending.nudge?.subjects ?? []),
      ...pending.acknowledged,
    ].map((entry) => entry.title);
    expect(titles).toContain("Mike's birthday");
  });

  test('his wife\'s gift-giving birthday is unaffected by his going quiet', async () => {
    const h = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    await h.service.sweep();
    expect(h.pushes.some((push) =>
      push.nudge.subjects.some((subject) => subject.occasionId === "natalie sons's birthday")))
      .toBe(true);
  });

  test('the subject is resolved from his declared names, not from a name literal', () => {
    const his = occasionLine("Mike's birthday · 08-06 · annual · remember-only");
    const hers = occasionLine("Natalie Sons's birthday · 08-20 · annual · gift-giving · for Natalie Sons");
    const names = ['Mike Davis', 'Mike'];

    expect(resolveOccasionSubject(his, names)).toBe('owner');
    expect(resolveOccasionSubject(hers, names)).toBe('other');

    // The same line on someone else's machine is about someone else. This is
    // what "not a name match" means: change the file, change the answer — and
    // the practical consequence is that it goes back to being pushed normally.
    expect(resolveOccasionSubject(his, ['Priya Raman'])).toBe('other');
    expect(pushableSubject({ ...his, subject: resolveOccasionSubject(his, ['Priya Raman']) }))
      .toBe(true);
    // With nothing declared, a possessive title still names SOMEONE, and the
    // one thing that must not happen is concluding it is him.
    expect(resolveOccasionSubject(his, [])).not.toBe('owner');
    expect(pushableSubject({ ...his, subject: resolveOccasionSubject(his, []) })).toBe(true);
  });

  test('an unattributed line is never treated as his', () => {
    const ours = occasionLine('Our anniversary · 09-12 · annual · gift-giving');
    const dad = occasionLine('Dad · 11-02 · annual · remember-only');
    expect(resolveOccasionSubject(ours, ['Mike Davis', 'Mike'])).toBe('unattributed');
    expect(resolveOccasionSubject(dad, ['Mike Davis', 'Mike'])).toBe('unattributed');
    expect(possessiveSubject('Our anniversary')).toBe('');
    expect(possessiveSubject("Mike's birthday")).toBe('Mike');
    expect(possessiveSubject("Natalie Sons's birthday")).toBe('Natalie Sons');
  });

  test('`for me` settles it on the line, whatever the title says', () => {
    const explicit = occasionLine('Renew the car tax · 02-01 · annual · remember-only · for me');
    expect(explicit.selfDeclared).toBe(true);
    expect(resolveOccasionSubject(explicit, [])).toBe('owner');
  });

  test('the silence is narrow: an occasion about him that wants an action still runs', () => {
    const remember = occasionLine('My birthday · 08-06 · annual · remember-only · for me');
    const action = occasionLine('Renew passport · 2026-11-02 · once · gift-giving · for me');
    // He knows when he was born. He does not know when his passport expires.
    expect(pushableSubject(remember)).toBe(false);
    expect(pushableSubject(action)).toBe(true);
  });
});

describe('a machine already in the bad state settles on load', () => {
  /** The owner's own item, exactly as his state file held it. */
  const LIVE_ITEM = {
    id: "nudge:mike's birthday@2026-08-06",
    kind: 'nudge',
    occasionId: "mike's birthday",
    occurrence: '2026-08-06',
    openedAt: 1,
    lastRaisedAt: 2,
    raiseCount: 5,
    dueOn: '2026-08-05',
    expiresAfter: '2026-08-06',
  };

  test('an over-raised item is kept open and marked as having spoken', async () => {
    const dir = tempDir();
    const statePath = join(dir, 'occasions-state.json');
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      acknowledgements: [],
      gifts: [],
      openItems: [LIVE_ITEM],
      interviews: [],
      mirrors: [],
      lastSweep: null,
    }), 'utf-8');

    const store = new OccasionStateStore(statePath);
    const items = await store.openItems();
    expect(items).toHaveLength(1);
    // Kept open. Not deleted, not resolved — nothing about it was resolved.
    expect(items[0]?.id).toBe("nudge:mike's birthday@2026-08-06");
    expect(items[0]?.servedBoundaries).toEqual(['lead', 'day-of']);
  });

  test('the reconciliation is receipted rather than silent', async () => {
    const dir = tempDir();
    const statePath = join(dir, 'occasions-state.json');
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      openItems: [LIVE_ITEM],
    }), 'utf-8');
    const store = new OccasionStateStore(statePath);
    expect((await store.disclose()).reconciledOpenItems).toBe(1);
  });

  test('his birthday goes silent the moment the fixed daemon boots', async () => {
    const dir = tempDir();
    const statePath = join(dir, 'occasions-state.json');
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      openItems: [LIVE_ITEM],
    }), 'utf-8');

    const h = harness({ now: Date.parse('2026-08-05T09:00:00Z'), statePath });
    // The day he complained, and the day after it. Every waking hour.
    await sweepHourly(h, '2026-08-05', 2);
    expect(h.pushes).toHaveLength(0);
    // And it is still on file, still open, still answerable.
    expect((await h.state.openItems()).some((entry) => entry.raiseCount === 5)).toBe(true);
  });

  test('a legacy item raised once keeps the day itself', () => {
    const once: OpenItem = { ...LIVE_ITEM, kind: 'nudge', raiseCount: 1, servedBoundaries: [] };
    expect(reconcileRaiseLedger(once)?.servedBoundaries).toEqual(['lead']);
    const twice: OpenItem = { ...once, raiseCount: 2 };
    expect(reconcileRaiseLedger(twice)?.servedBoundaries).toEqual(['lead', 'day-of']);
    // An item already carrying a ledger is left exactly alone.
    const current: OpenItem = { ...once, servedBoundaries: ['lead'] };
    expect(reconcileRaiseLedger(current)).toBeNull();
  });
});

describe('a nudge landed in the agent conversation says what it is', () => {
  const NUDGE: OccasionNudge = {
    id: 'n1',
    raisedAt: 0,
    subjects: [{
      occasionId: "mike's birthday",
      title: "Mike's birthday",
      person: '',
      kind: 'remember-only',
      proximity: 'imminent',
      subject: 'owner',
      acknowledged: false,
    }],
    message: "Mike's birthday is very close now.",
    answerable: false,
  };

  test('the agent gets a framed, self-contained notice rather than a bare line', () => {
    const { title, body } = nudgeDeliveryText('agent', NUDGE);
    expect(title).toBe(AGENT_NOTICE_HEADING);
    // The exact defect: this sentence, alone, in someone else's conversation.
    expect(body).not.toBe(NUDGE.message);
    expect(body.startsWith(`[${AGENT_NOTICE_HEADING}]`)).toBe(true);
    expect(body).toContain(NUDGE.message);
    expect(body).toContain('It is not');
    expect(body).toContain('do not weave it');
    expect(body).toContain('acknowledge_occasion');
  });

  test('a message channel still gets the plain line', () => {
    expect(nudgeDeliveryText('telegram', NUDGE).body).toBe(NUDGE.message);
    expect(nudgeDeliveryText('telegram:12345', NUDGE).body).toBe(NUDGE.message);
  });
});

describe('the doctrine the fix must not have broken', () => {
  test('no nudge carries a date, in any form', async () => {
    const h = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    await sweepHourly(h, '2026-08-10', 11);
    expect(h.pushes).not.toHaveLength(0);
    for (const push of h.pushes) {
      const text = `${push.nudge.message} ${nudgeDeliveryText(push.channel, push.nudge).body}`;
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(text).not.toMatch(/\b\d{1,2}\s+(days?|August|Aug)\b/i);
      expect(text).toContain("Natalie Sons's birthday");
    }
  });

  test('the channels are unchanged: Telegram and the agent, never the TUI', async () => {
    const h = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    h.setConfig('occasions.nudgeChannel', 'telegram,agent,tui');
    await h.service.sweep();
    const channels = new Set(h.pushes.map((push) => push.channel));
    expect(channels.has('telegram')).toBe(true);
    expect(channels.has('agent')).toBe(true);
    expect(channels.has('tui')).toBe(false);
  });

  test('the ten-day lead is unchanged', async () => {
    const h = harness({ now: Date.parse('2026-08-09T10:00:00Z') });
    // Eleven days out is outside the window; ten days is inside it.
    expect((await h.service.sweep()).nudge).toBeNull();
    h.setNow(Date.parse('2026-08-10T10:00:00Z'));
    expect((await h.service.sweep()).nudge?.subjects[0]?.title)
      .toBe("Natalie Sons's birthday");
  });

  test('a `later` he asked for still comes back, ceiling or not', async () => {
    const h = harness({ now: Date.parse('2026-08-10T10:00:00Z') });
    await h.service.sweep();
    await h.service.answer({ occasionId: "natalie sons's birthday", answer: 'later' });
    const returnOn = (await h.state.acknowledgements())[0]?.returnOn;
    expect(returnOn).toBe('2026-08-15');

    h.setNow(Date.parse('2026-08-14T10:00:00Z'));
    expect((await h.service.sweep()).nudge).toBeNull();
    h.setNow(Date.parse('2026-08-15T10:00:00Z'));
    expect((await h.service.sweep()).nudge?.subjects[0]?.title)
      .toBe("Natalie Sons's birthday");
  });
});
