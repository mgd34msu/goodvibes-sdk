/**
 * A presence probe must not be able to destroy the outcome it is probing for.
 *
 * `facade-inbound-mail.ts` gives `GmailMailSource` a boolean predicate so the
 * poll loop can run fast while a signup is mid-flight and slow when nothing is
 * waiting. That predicate was `expectations.list().length > 0`, and `list()`
 * reached `VerificationExpectationBook.list`, which called `sweepExpired(now)`
 * and threw the return value away.
 *
 * The return value is the whole record that an expectation ended.
 * `InboundExpectationRegistry.sweep()` is the reporting path — the same
 * `sweepExpired`, but mapped through `describeExpiry`, written through to disk
 * and handed to `onExpired`. Both called the same reaper; only one of them told
 * anybody.
 *
 * The frequencies decided it. The predicate is asked before every poll wait —
 * five seconds apart at the shipped `gmailPollSecondsExpecting`, for as long as
 * an expectation is open — while `startSweeping` arms the reporting sweep every
 * thirty seconds at the shipped fifteen-minute window. The fast probe reached
 * the expired row first essentially always, deleted it, and the sweep arrived to
 * an empty book and reported nothing. A verification that never came expired in
 * silence: precisely the §2.3 outcome `onExpired` and `startSweeping` exist to
 * make impossible.
 *
 * So the tests below assert the REPORT, not the absence of the row. An
 * assertion that the expectation is gone passes on the defect — the defect is
 * that it is gone in a way nobody hears about.
 *
 * The book-level case is the general one. Reads filter; only `sweepExpired`
 * reaps, and its callers either report what came back or need the removal for
 * their own accounting. That is what stops the next caller stepping on this.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InboundExpectationRegistry,
  type ExpectationExpiryReport,
} from '../packages/sdk/src/platform/email/inbound/expectation-registry.ts';
import { PersistedExpectationStore } from '../packages/sdk/src/platform/email/inbound/expectation-store.ts';
import { VerificationExpectationBook } from '../packages/sdk/src/platform/google/verification-expectations.ts';

const T0 = Date.parse('2026-07-28T09:00:00.000Z');
const WINDOW_MS = 15 * 60_000;
const RECIPIENT = 'signup-a1@alias.test';

const dirs: string[] = [];
const registries: InboundExpectationRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.stopSweeping();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  readonly registry: InboundExpectationRegistry;
  readonly reports: ExpectationExpiryReport[];
  advance(ms: number): void;
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'gv-expectation-probe-'));
  dirs.push(dir);
  const reports: ExpectationExpiryReport[] = [];
  let nowMs = T0;
  const registry = new InboundExpectationRegistry({
    store: new PersistedExpectationStore(join(dir, 'expectations.json')),
    now: () => new Date(nowMs),
    onExpired: (report) => { reports.push(report); },
  });
  registries.push(registry);
  return { registry, reports, advance: (ms) => { nowMs += ms; } };
}

async function openOne(registry: InboundExpectationRegistry): Promise<void> {
  await registry.open({
    serviceDomain: 'example.com',
    recipientAddress: RECIPIENT,
    purpose: 'confirm the account for example.com',
    windowMs: WINDOW_MS,
  });
}

describe('the Gmail poll predicate is a read, and the expiry still gets reported', () => {
  test('hasOpen() answers false without consuming the report the sweep owes', async () => {
    const { registry, reports, advance } = rig();
    await openOne(registry);
    expect(registry.hasOpen()).toBe(true);

    advance(WINDOW_MS + 60_000);

    // Six probes is the Gmail loop's half-minute: `gmailPollSecondsExpecting`
    // is five seconds, and the reporting sweep at the shipped window is thirty.
    // On the defect every one of these deleted the row and dropped its report.
    for (let tick = 0; tick < 6; tick += 1) expect(registry.hasOpen()).toBe(false);

    const swept = await registry.sweep();
    expect(swept).toHaveLength(1);
    expect(swept[0]?.reason).toBe('window-elapsed');
    expect(swept[0]?.recipientAddress).toBe(RECIPIENT);

    // The assertion that matters. `swept` alone would still pass if `sweep()`
    // returned reports it never emitted; the owner is reached through
    // `onExpired`, so `onExpired` is what has to have fired.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.reason).toBe('window-elapsed');
    expect(reports[0]?.recipientAddress).toBe(RECIPIENT);
  });

  test('the disclosure list is a read too, so the status verb cannot silence an expiry', async () => {
    const { registry, reports, advance } = rig();
    await openOne(registry);
    advance(WINDOW_MS + 60_000);

    // `email.expectation.list` and `email.inbound.status` both reach this, and
    // either of them being asked at the wrong moment used to be enough.
    expect(registry.list()).toHaveLength(0);
    expect(registry.list()).toHaveLength(0);

    expect(await registry.sweep()).toHaveLength(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.reason).toBe('window-elapsed');
  });

  test('a probe before the window closes is unaffected: it is still open and nothing is reported', async () => {
    const { registry, reports, advance } = rig();
    await openOne(registry);
    advance(WINDOW_MS - 1_000);

    expect(registry.hasOpen()).toBe(true);
    expect(registry.list()).toHaveLength(1);
    expect(await registry.sweep()).toHaveLength(0);
    expect(reports).toHaveLength(0);
  });
});

describe('reading the expectation book never reaps it', () => {
  test('list, hasOpen and get all filter, and sweepExpired still has the record to return', () => {
    const book = new VerificationExpectationBook();
    const opened = book.openExpectation({
      serviceDomain: 'example.com',
      recipientAddress: RECIPIENT,
      purpose: 'confirm the account for example.com',
      now: new Date(T0),
      windowMs: WINDOW_MS,
    });

    const after = new Date(T0 + WINDOW_MS + 60_000);
    // Every read agrees the expectation is no longer open …
    expect(book.list(after)).toHaveLength(0);
    expect(book.hasOpen(after)).toBe(false);
    expect(book.get(opened.id, after)).toBeNull();

    // … and not one of them threw the record away. This is the property the
    // whole fix rests on: the reaper is the only thing that reaps, so the
    // reaper's caller is always the one that reports.
    const reaped = book.sweepExpired(after);
    expect(reaped).toHaveLength(1);
    expect(reaped[0]?.id).toBe(opened.id);

    // And it is genuinely gone once the reaper has run.
    expect(book.sweepExpired(after)).toHaveLength(0);
  });

  test('a live expectation is returned by every read and left alone by the reaper', () => {
    const book = new VerificationExpectationBook();
    const opened = book.openExpectation({
      serviceDomain: 'example.com',
      recipientAddress: RECIPIENT,
      purpose: 'confirm',
      now: new Date(T0),
      windowMs: WINDOW_MS,
    });

    const during = new Date(T0 + 60_000);
    expect(book.list(during)).toHaveLength(1);
    expect(book.hasOpen(during)).toBe(true);
    expect(book.get(opened.id, during)?.id).toBe(opened.id);
    expect(book.sweepExpired(during)).toHaveLength(0);
    expect(book.list(during)).toHaveLength(1);
  });
});
