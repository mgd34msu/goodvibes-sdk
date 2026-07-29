/**
 * occasions-state-store.test.ts
 *
 * The machine-owned store, held to the whole persisted-state treatment: bounded,
 * validated by content, reaped on schedule, swept, and disclosing what it holds.
 *
 * The through-line: a malformed record costs him that record and nothing else,
 * an answer dies with its date so next year asks fresh, and state whose occasion
 * is gone does not survive the occasion.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_ACKNOWLEDGEMENTS,
  OccasionStateStore,
  validateOccasionState,
} from '../packages/sdk/src/platform/occasions/state-store.ts';
import type {
  GiftRecord,
  Interview,
  OccasionAcknowledgement,
  OpenItem,
} from '../packages/sdk/src/platform/occasions/types.ts';

const dirs: string[] = [];
function statePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-occasions-state-'));
  dirs.push(dir);
  return join(dir, 'occasions-state.json');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ack(overrides: Partial<OccasionAcknowledgement> = {}): OccasionAcknowledgement {
  return {
    id: "sarah's birthday@2026-03-14",
    occasionId: "sarah's birthday",
    occurrence: '2026-03-14',
    answer: 'no',
    answeredAt: 1,
    expiresAfter: '2026-03-14',
    ...overrides,
  };
}

function gift(overrides: Partial<GiftRecord> = {}): GiftRecord {
  return {
    occasionId: "sarah's birthday",
    occurrence: '2026-03-14',
    recordedAt: 1,
    landedOn: 'a pottery class',
    ...overrides,
  };
}

function item(overrides: Partial<OpenItem> = {}): OpenItem {
  return {
    id: "nudge:sarah's birthday@2026-03-14",
    kind: 'nudge',
    occasionId: "sarah's birthday",
    occurrence: '2026-03-14',
    openedAt: 1,
    lastRaisedAt: 1,
    raiseCount: 1,
    dueOn: '2026-03-09',
    expiresAfter: '2026-03-14',
    ...overrides,
  };
}

function interview(overrides: Partial<Interview> = {}): Interview {
  return {
    id: "interview:sarah's birthday@2026-03-14",
    occasionId: "sarah's birthday",
    occurrence: '2026-03-14',
    startedAt: 1,
    steps: [{ id: 'direction', prompt: 'What has Sarah been into?', opensFrom: '' }],
    answers: [],
    ...overrides,
  };
}

const DECLARED = new Set(["sarah's birthday"]);

describe('content validation', () => {
  test('a malformed record is dropped and counted, and the rest survives', () => {
    const { snapshot, dropped } = validateOccasionState({
      version: 1,
      acknowledgements: [ack(), { occasionId: 'x' }, 'nonsense', null],
      gifts: [gift(), { occasionId: 'x', occurrence: 'not-a-date', landedOn: 'y', recordedAt: 1 }],
      openItems: [item(), { id: 'y', kind: 'invented', occasionId: 'x', dueOn: '2026-01-01', openedAt: 1, lastRaisedAt: 1, raiseCount: 1 }],
      interviews: [interview(), { id: 'z', occasionId: 'x', occurrence: '2026-03-14', startedAt: 1, steps: [] }],
      mirrors: [],
      lastSweep: null,
    });
    expect(snapshot.acknowledgements).toHaveLength(1);
    expect(snapshot.gifts).toHaveLength(1);
    expect(snapshot.openItems).toHaveLength(1);
    expect(snapshot.interviews).toHaveLength(1);
    // Three bad answers, one bad gift, one bad open item, one bad interview.
    expect(dropped).toBe(6);
  });

  test('an answer outside yes/no/later is not a valid record', () => {
    const { snapshot } = validateOccasionState({
      acknowledgements: [ack({ answer: 'maybe' as OccasionAcknowledgement['answer'] })],
    });
    expect(snapshot.acknowledgements).toHaveLength(0);
  });

  test('a non-object file yields an empty store rather than throwing', () => {
    expect(validateOccasionState('not a store').snapshot.acknowledgements).toHaveLength(0);
    expect(validateOccasionState(null).snapshot.gifts).toHaveLength(0);
  });
});

describe('the store', () => {
  test('an answer replaces an earlier answer for the same occurrence', async () => {
    const store = new OccasionStateStore(statePath());
    await store.recordAnswer(ack({ answer: 'later' }));
    await store.recordAnswer(ack({ answer: 'no' }));
    const all = await store.acknowledgements();
    expect(all).toHaveLength(1);
    expect(all[0]!.answer).toBe('no');
  });

  test('answers are bounded', async () => {
    const store = new OccasionStateStore(statePath());
    for (let index = 0; index < MAX_ACKNOWLEDGEMENTS + 5; index += 1) {
      await store.recordAnswer(ack({
        id: `a${index}`,
        occasionId: `occasion-${index}`,
        occurrence: '2026-03-14',
      }));
    }
    expect((await store.acknowledgements()).length).toBe(MAX_ACKNOWLEDGEMENTS);
  });

  test('an unreadable file is discarded, disclosed, and does not wedge the store', async () => {
    const path = statePath();
    writeFileSync(path, '{ this is not json', 'utf-8');
    const store = new OccasionStateStore(path);
    const disclosure = await store.disclose();
    expect(disclosure.corruption).not.toBeNull();
    expect(disclosure.acknowledgements).toBe(0);
    // Still writable afterwards — the disclosure verb and the next write both
    // work, which is the whole reason this uses loadOrDiscard.
    await store.recordAnswer(ack());
    expect((await store.acknowledgements())).toHaveLength(1);
  });

  test('it discloses counts, never contents', async () => {
    const store = new OccasionStateStore(statePath());
    await store.recordAnswer(ack());
    await store.recordGift(gift());
    await store.putOpenItem(item());
    await store.putInterview(interview());
    await store.recordMirror({
      occasionId: "sarah's birthday",
      occurrence: '2026-03-14',
      externalId: 'evt-1',
      mirroredAt: 1,
    });
    const disclosure = await store.disclose();
    expect(disclosure).toMatchObject({
      acknowledgements: 1,
      giftRecords: 1,
      openItems: 1,
      interviews: 1,
      mirrors: 1,
    });
    expect(JSON.stringify(disclosure)).not.toContain('pottery');
  });
});

describe('housekeeping', () => {
  test('an answer expires with its occurrence, so next year asks fresh', async () => {
    const store = new OccasionStateStore(statePath());
    await store.recordAnswer(ack());
    const before = await store.sweep({
      today: '2026-03-14',
      now: 2,
      declaredOccasionIds: DECLARED,
      giftHistoryYears: 10,
    });
    expect(before.expiredAcknowledgements).toBe(0);
    expect(await store.answerFor("sarah's birthday", '2026-03-14')).toBeDefined();

    const after = await store.sweep({
      today: '2026-03-15',
      now: 3,
      declaredOccasionIds: DECLARED,
      giftHistoryYears: 10,
    });
    expect(after.expiredAcknowledgements).toBe(1);
    expect(await store.answerFor("sarah's birthday", '2026-03-14')).toBeUndefined();
  });

  test('a one-off answer has no expiry — handled is permanent', async () => {
    const store = new OccasionStateStore(statePath());
    await store.recordAnswer({ ...ack(), expiresAfter: undefined });
    const report = await store.sweep({
      today: '2027-01-01',
      now: 3,
      declaredOccasionIds: DECLARED,
      giftHistoryYears: 10,
    });
    expect(report.expiredAcknowledgements).toBe(0);
    expect(await store.answerFor("sarah's birthday", '2026-03-14')).toBeDefined();
  });

  test('gift history survives the answer that produced it', async () => {
    const store = new OccasionStateStore(statePath());
    await store.recordAnswer(ack({ answer: 'yes' }));
    await store.recordGift(gift());
    await store.sweep({
      today: '2027-03-15',
      now: 3,
      declaredOccasionIds: DECLARED,
      giftHistoryYears: 10,
    });
    expect(await store.answerFor("sarah's birthday", '2026-03-14')).toBeUndefined();
    expect(await store.giftHistory("sarah's birthday")).toHaveLength(1);
  });

  test('gift history ages out at the configured retention', async () => {
    const store = new OccasionStateStore(statePath());
    await store.recordGift(gift({ occurrence: '2016-03-14' }));
    const report = await store.sweep({
      today: '2026-07-29',
      now: 3,
      declaredOccasionIds: DECLARED,
      giftHistoryYears: 1,
    });
    expect(report.agedGiftRecords).toBe(1);
    expect(await store.giftHistory("sarah's birthday")).toHaveLength(0);
  });

  test('state for an occasion he deleted by hand is reaped as orphaned', async () => {
    const store = new OccasionStateStore(statePath());
    await store.recordAnswer(ack());
    await store.recordGift(gift());
    await store.putOpenItem(item());
    await store.putInterview(interview());
    const report = await store.sweep({
      today: '2026-03-06',
      now: 3,
      declaredOccasionIds: new Set<string>(),
      giftHistoryYears: 10,
    });
    expect(report.orphanedRecords).toBe(3);
    expect(report.droppedInterviews).toBe(1);
    const disclosure = await store.disclose();
    expect(disclosure).toMatchObject({ acknowledgements: 0, giftRecords: 0, openItems: 0, interviews: 0 });
  });

  test('an open item stops being raised once its occurrence has passed', async () => {
    const store = new OccasionStateStore(statePath());
    await store.putOpenItem(item());
    const report = await store.sweep({
      today: '2026-03-15',
      now: 3,
      declaredOccasionIds: DECLARED,
      giftHistoryYears: 10,
    });
    expect(report.expiredOpenItems).toBe(1);
    expect(await store.openItems()).toHaveLength(0);
  });

  test('a conflict item carries no occurrence and is NOT expired by a passing date', async () => {
    const store = new OccasionStateStore(statePath());
    await store.putOpenItem(item({
      id: "conflict:sarah's birthday",
      kind: 'conflict',
      occurrence: '',
      expiresAfter: undefined,
    }));
    const report = await store.sweep({
      today: '2030-01-01',
      now: 3,
      declaredOccasionIds: DECLARED,
      giftHistoryYears: 10,
    });
    expect(report.expiredOpenItems).toBe(0);
    expect(await store.openItems()).toHaveLength(1);
  });

  test('a mirror record for a passed occurrence is stale and goes', async () => {
    const store = new OccasionStateStore(statePath());
    await store.recordMirror({
      occasionId: "sarah's birthday",
      occurrence: '2026-03-14',
      externalId: 'evt-1',
      mirroredAt: 1,
    });
    const report = await store.sweep({
      today: '2026-03-15',
      now: 3,
      declaredOccasionIds: DECLARED,
      giftHistoryYears: 10,
    });
    expect(report.staleMirrors).toBe(1);
  });

  test('the mirror is idempotent for one occurrence', async () => {
    const store = new OccasionStateStore(statePath());
    await store.recordMirror({ occasionId: 'a', occurrence: '2026-03-14', externalId: 'evt-1', mirroredAt: 1 });
    await store.recordMirror({ occasionId: 'a', occurrence: '2026-03-14', externalId: 'evt-2', mirroredAt: 2 });
    expect((await store.disclose()).mirrors).toBe(1);
    expect((await store.mirrorFor('a', '2026-03-14'))?.externalId).toBe('evt-2');
  });

  test('removing an occasion drops every record against it, in one call', async () => {
    const store = new OccasionStateStore(statePath());
    await store.recordAnswer(ack());
    await store.recordGift(gift());
    await store.putOpenItem(item());
    await store.putInterview(interview());
    await store.recordMirror({
      occasionId: "sarah's birthday",
      occurrence: '2026-03-14',
      externalId: 'evt-1',
      mirroredAt: 1,
    });
    await store.recordAnswer(ack({ id: 'other', occasionId: 'someone else' }));

    expect(await store.dropOccasion("sarah's birthday")).toBe(5);
    const disclosure = await store.disclose();
    expect(disclosure).toMatchObject({ giftRecords: 0, openItems: 0, interviews: 0, mirrors: 0 });
    // The unrelated occasion is untouched.
    expect(disclosure.acknowledgements).toBe(1);
  });

  test('the last sweep is recorded on disk, so the disclosure survives a restart', async () => {
    const path = statePath();
    const store = new OccasionStateStore(path);
    await store.recordAnswer(ack());
    await store.sweep({
      today: '2026-03-15',
      now: 99,
      declaredOccasionIds: DECLARED,
      giftHistoryYears: 10,
    });
    await store.drain();
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as { lastSweep: { sweptAt: number } };
    expect(onDisk.lastSweep.sweptAt).toBe(99);

    const reopened = new OccasionStateStore(path);
    expect((await reopened.disclose()).lastSweep?.expiredAcknowledgements).toBe(1);
  });
});
