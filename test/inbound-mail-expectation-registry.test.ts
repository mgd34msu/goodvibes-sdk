/**
 * The seam that makes signup -> verification -> completion actually run.
 *
 * Before this, `openExpectation` had no production call site and
 * `VerificationExpectationBook` was never constructed outside tests, so the
 * whole chain was inert: a signup began, nothing recorded that it had, the
 * mail arrived, the matcher correctly found no expectation, and the message
 * was correctly treated as unexpected and did nothing. Every piece worked and
 * the middle was missing.
 *
 * These cover the middle: registration is an explicit verb, matching is scoped
 * to what was declared, nothing arriving in mail can create or widen an
 * expectation, an expiry is reported rather than lapsing quietly, and a
 * restart restores the original window rather than a fresh one.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExpectationMailboxUnreadableError,
  InboundExpectationRegistry,
  type ExpectationExpiryReport,
} from '../packages/sdk/src/platform/email/inbound/expectation-registry.ts';
import { PersistedExpectationStore } from '../packages/sdk/src/platform/email/inbound/expectation-store.ts';
import { capabilityVerdict } from '../packages/sdk/src/platform/email/inbound/capability.ts';
import type { InboundCapabilityVerdict } from '../packages/sdk/src/platform/email/inbound/ports.ts';
import {
  MAX_VERIFICATION_WINDOW_MS,
  VerificationExpectationBook,
  type CandidateEmail,
} from '../packages/sdk/src/platform/google/verification-expectations.ts';
import { deliveredRecipientFromAliasMailbox } from '../packages/sdk/src/platform/google/delivery-evidence.ts';

const NOW_MS = Date.parse('2026-07-28T09:00:00.000Z');
const NOW = new Date(NOW_MS);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-expectation-registry-'));
  dirs.push(dir);
  return join(dir, 'expectations.json');
}

/** A clock the test moves by hand; nothing here waits fifteen real minutes. */
function clockFrom(startMs: number): { now: () => Date; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance: (ms: number) => { current += ms; },
  };
}

function build(options: {
  readonly storePath?: string;
  readonly startMs?: number;
  readonly onExpired?: (report: ExpectationExpiryReport) => void;
  readonly capability?: () => InboundCapabilityVerdict | null;
} = {}) {
  const storePath = options.storePath ?? newStorePath();
  const clock = clockFrom(options.startMs ?? NOW_MS);
  const store = new PersistedExpectationStore(storePath, { now: clock.now });
  const registry = new InboundExpectationRegistry({
    store,
    now: clock.now,
    ...(options.onExpired === undefined ? {} : { onExpired: options.onExpired }),
    ...(options.capability === undefined ? {} : { capability: options.capability }),
  });
  return { registry, clock, storePath };
}

/** A message as the watcher would hand it over, delivered to a real mailbox. */
function arrival(input: {
  readonly deliveredTo: string | null;
  readonly from: string;
  readonly messageId?: string;
}): CandidateEmail {
  return {
    messageId: input.messageId ?? 'msg-1',
    from: input.from,
    deliveredTo: input.deliveredTo === null
      ? null
      : deliveredRecipientFromAliasMailbox(input.deliveredTo),
    toHeaderClaim: 'whatever the sender wrote',
    subject: 'Confirm your address',
    body: 'Click the link to confirm.',
  };
}

describe('a workstream registers an expectation before it submits the form', () => {
  test('a matching arrival satisfies it', async () => {
    const { registry } = build();
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm the account for example.com',
    });

    const match = await registry.matcher.matchCandidate(
      arrival({ deliveredTo: 'signup-a1@alias.test', from: 'no-reply@example.com' }),
      NOW,
    );
    expect(match.kind).toBe('matched');
  });

  test('a message for a DIFFERENT service domain does not satisfy it', async () => {
    // Scoped to what was declared. Convenience is not a reason to widen.
    const { registry } = build();
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm the account for example.com',
    });

    const match = await registry.matcher.matchCandidate(
      arrival({ deliveredTo: 'signup-a1@alias.test', from: 'no-reply@evil.test' }),
      NOW,
    );
    // The delivery address is what gates the match, so this still matches the
    // expectation, but the sender is recorded as unrelated, which is what
    // stops a link from the wrong host being followed downstream.
    if (match.kind !== 'matched') throw new Error(`expected a match, got ${match.kind}`);
    expect(match.senderCorroboration).toBe('sender-domain-unrelated');
  });

  test('a message delivered to a DIFFERENT address does not satisfy it', async () => {
    const { registry } = build();
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm the account for example.com',
    });

    const match = await registry.matcher.matchCandidate(
      arrival({ deliveredTo: 'someone-else@alias.test', from: 'no-reply@example.com' }),
      NOW,
    );
    expect(match.kind).toBe('recipient-mismatch');
  });

  test('a message carrying no delivery evidence is refused, not correlated on its To: header', async () => {
    const { registry } = build();
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm the account for example.com',
    });

    const match = await registry.matcher.matchCandidate(
      arrival({ deliveredTo: null, from: 'no-reply@example.com' }),
      NOW,
    );
    expect(match.kind).toBe('no-delivery-evidence');
  });
});

describe('nothing arriving in mail can create, widen or extend an expectation', () => {
  test('the matcher handed to inbound code carries no way to insert', async () => {
    const { registry } = build();
    const matcher = registry.matcher;
    // Runtime own-property assertion, so a later widening is caught even if it
    // type-checks: the inbound path must never hold a way to open one.
    const reachable = new Set<string>();
    for (const key of Object.keys(matcher)) reachable.add(key);
    let proto: object | null = Object.getPrototypeOf(matcher) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) reachable.add(key);
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    // The two verbs the inbound path is entitled to, and nothing else.
    expect(reachable.has('matchCandidate')).toBe(true);
    expect(reachable.has('consumeMatch')).toBe(true);

    // The registry now hands over a purpose-built object rather than the book
    // itself, the seam the consuming match is written through from, so the
    // insert verbs are unreachable AT RUNTIME, not merely unnameable in the
    // type. That is strictly stronger than what this test could assert while
    // the concrete object was the book, and it is asserted here so a later
    // refactor that goes back to passing the book straight through reddens
    // instead of quietly restoring the reach.
    expect(reachable.has('openExpectation')).toBe(false);
    expect(reachable.has('hydrateExpectation')).toBe(false);
    expect(reachable.has('closeExpectation')).toBe(false);
    expect(reachable.has('sweepExpired')).toBe(false);

    // The EXACT own-key set, not a subset. `reachable.has(x) === false` above
    // names the four verbs somebody thought of; this names every key there is,
    // so a fifth one added later has to be added here too rather than slipping
    // through because nobody predicted its name.
    expect(Object.keys(matcher).sort()).toEqual(['consumeMatch', 'matchCandidate']);

    // And it is a plain object, not an instance of anything. This is the
    // assertion that survives a rename: handing back the book itself would
    // pass every `has(...)` check above if its methods were ever renamed, and
    // fails here, because the book is a class instance and this is not.
    expect(Object.getPrototypeOf(matcher)).toBe(Object.prototype);
    expect(matcher).not.toBeInstanceOf(VerificationExpectationBook);

    // The narrowed type is a type-level fact and is asserted at the type level
    //, `test/types/inbound-expectation-matcher-narrowing.ts` fails `tsc` if
    // `openExpectation` ever becomes nameable through `ExpectationMatcher`.
    // Nothing here can assert it: a runtime check cannot observe a type.
  });

  test('a second open for one address replaces rather than stacking', async () => {
    const { registry } = build();
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'first',
    });
    await registry.open({
      serviceDomain: 'other.test',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'second',
    });
    const open = registry.list();
    expect(open.length).toBe(1);
    expect(open[0]?.serviceDomain).toBe('other.test');
  });
});

describe('the window is a ceiling a caller cannot raise by asking', () => {
  test('a window above the hard maximum is clamped, not honoured', async () => {
    const start = Date.parse('2026-07-28T09:00:00.000Z');
    const { registry } = build({ startMs: start });
    const expectation = await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
      windowMs: 30 * 24 * 60 * 60 * 1000, // a month
    });
    const granted = Date.parse(expectation.expiresAt) - start;
    expect(granted).toBe(MAX_VERIFICATION_WINDOW_MS);
    expect(granted).toBeLessThan(30 * 24 * 60 * 60 * 1000);
  });
});

describe('an expectation that runs out is reported, not lapsed quietly', () => {
  test('sweep names the reason and hands over the record', async () => {
    const reports: ExpectationExpiryReport[] = [];
    const { registry, clock } = build({ onExpired: (report) => reports.push(report) });
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm the account for example.com',
      windowMs: 15 * 60_000,
    });

    clock.advance(16 * 60_000);
    const swept = await registry.sweep();

    expect(swept.length).toBe(1);
    expect(swept[0]?.reason).toBe('window-elapsed');
    expect(swept[0]?.recipientAddress).toBe('signup-a1@alias.test');
    expect(swept[0]?.detail).toContain('signup-a1@alias.test');
    expect(reports.length).toBe(1);
    expect(registry.list().length).toBe(0);
  });

  test('an arrival after the window is expired rather than matched', async () => {
    const { registry, clock } = build();
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
      windowMs: 15 * 60_000,
    });
    clock.advance(16 * 60_000);

    // Asked at the LATER time, the window is closed by then.
    const match = await registry.matcher.matchCandidate(
      arrival({ deliveredTo: 'signup-a1@alias.test', from: 'no-reply@example.com' }),
      clock.now(),
    );
    expect(match.kind).toBe('expired');
  });
});

describe('cancel closes an expectation the workstream abandoned', () => {
  test('a later matching arrival does not satisfy a cancelled expectation', async () => {
    const { registry } = build();
    const opened = await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
    });

    const closed = await registry.cancel(opened.id);
    expect(closed?.id).toBe(opened.id);
    expect(registry.list().length).toBe(0);

    const match = await registry.matcher.matchCandidate(
      arrival({ deliveredTo: 'signup-a1@alias.test', from: 'no-reply@example.com' }),
      NOW,
    );
    expect(match.kind).toBe('no-expectation');
  });

  test('cancelling an unknown id is an answer, not a failure', async () => {
    const { registry } = build();
    expect(await registry.cancel('not-a-real-id')).toBeNull();
  });
});

describe('a restart restores the original window, never a fresh one', () => {
  test('an expectation survives with the expiry it was opened with', async () => {
    const storePath = newStorePath();
    const start = Date.parse('2026-07-28T09:00:00.000Z');

    const first = build({ storePath, startMs: start });
    const opened = await first.registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
      windowMs: 15 * 60_000,
    });

    // The daemon restarts ten minutes in, it checks for updates hourly and
    // restarts itself at idle, which is what made persistence necessary.
    const second = build({ storePath, startMs: start + 10 * 60_000 });
    const hydrated = await second.registry.hydrate();
    expect(hydrated.restored).toBe(1);

    const live = second.registry.list();
    expect(live.length).toBe(1);
    expect(live[0]?.expiresAt).toBe(opened.expiresAt);
    // Five minutes left, not a fresh fifteen. A restart cannot extend a grant.
    expect(live[0]?.remainingMs).toBe(5 * 60_000);
  });

  test('an expectation that expired during the restart is not revived', async () => {
    const storePath = newStorePath();
    const start = Date.parse('2026-07-28T09:00:00.000Z');

    const first = build({ storePath, startMs: start });
    await first.registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
      windowMs: 15 * 60_000,
    });

    const second = build({ storePath, startMs: start + 20 * 60_000 });
    const hydrated = await second.registry.hydrate();
    expect(hydrated.restored).toBe(0);
    expect(second.registry.list().length).toBe(0);
  });
});

describe('the book is constructed with the real authority probe', () => {
  test('opening is refused outright if email ever gained command authority', async () => {
    // §2.2: the book's own defensive check has never run in production because
    // the book has never been constructed in production. This is that check,
    // live, with a probe that answers the way a future mistake would.
    const store = new PersistedExpectationStore(newStorePath());
    const registry = new InboundExpectationRegistry({
      store,
      authority: { surfaceHasCommandAuthority: () => true },
    });

    await expect(registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
    })).rejects.toThrow('command authority');
  });

  test('the default probe is the real predicate, so email is input-only and opening works', async () => {
    const { registry } = build();
    const opened = await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
    });
    expect(opened.authority).toBe('evidence-only');
  });

  test('the default probe is the SHIPPED predicate, not a stub that always says no', async () => {
    // The distinguishing question. Every stub anyone would write for this
    // answers `false` for email, and so does the real predicate, so asking
    // about email proves nothing. `owner-direct` is the one surface that DOES
    // hold command authority, and only the genuine function says so.
    const { registry } = build();
    expect(registry.authority.surfaceHasCommandAuthority('email')).toBe(false);
    expect(registry.authority.surfaceHasCommandAuthority('owner-direct')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §12 gates #31, #32, #33, an expectation is a promise to WATCH a mailbox
// ---------------------------------------------------------------------------

const UNREADABLE: InboundCapabilityVerdict = capabilityVerdict(
  'mailbox-unreadable',
  'The sign-in worked and the mailbox did not open.',
);
const RECONNECTING: InboundCapabilityVerdict = capabilityVerdict(
  'reconnecting',
  'The connection dropped; retrying on a backoff.',
);
const HEALTHY_VERDICT: InboundCapabilityVerdict = capabilityVerdict(
  'idle-push',
  'Holding an IDLE connection.',
);

describe('an expectation is refused against a mailbox that cannot be read (gate #31)', () => {
  test('opening is refused AT OPEN TIME, not left to expire fifteen minutes later', async () => {
    const { registry } = build({ capability: () => UNREADABLE });

    await expect(registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm the account for example.com',
    })).rejects.toBeInstanceOf(ExpectationMailboxUnreadableError);

    // Nothing was recorded, so nothing sits waiting to run out. A refusal that
    // still opened the expectation would be the fifteen-minute silence with an
    // error message in front of it.
    expect(registry.list()).toHaveLength(0);
  });

  test('the refusal names the condition and the step that fixes it', async () => {
    const { registry } = build({ capability: () => UNREADABLE });
    let raised: unknown;
    try {
      await registry.open({
        serviceDomain: 'example.com',
        recipientAddress: 'signup-a1@alias.test',
        purpose: 'confirm',
      });
    } catch (error) {
      raised = error;
    }
    if (!(raised instanceof ExpectationMailboxUnreadableError)) {
      throw new Error(`expected a mailbox-unreadable refusal, got ${String(raised)}`);
    }
    expect(raised.capability.reason).toBe('mailbox-unreadable');
    expect(raised.message).toContain('mailbox-unreadable');
    // The remedial step travels with the refusal, the caller is the signup
    // workstream, and "it did not work" without "here is what to change" is
    // what sends it to retry the same call.
    expect(raised.message).toContain('surfaces.email.imap.mailbox');
  });

  test('a DEGRADED mailbox still opens — a reconnect is not a refusal', async () => {
    const { registry } = build({ capability: () => RECONNECTING });
    const opened = await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
    });
    expect(registry.list().map((entry) => entry.id)).toEqual([opened.id]);
  });

  test('an unprobed mailbox still opens — no answer yet is not an answer of no', async () => {
    const { registry } = build({ capability: () => null });
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
    });
    expect(registry.list()).toHaveLength(1);
  });
});

describe('capability lost mid-window fails open expectations by name (gate #32)', () => {
  test('an insufficient verdict closes them with capability-lost, not window-elapsed', async () => {
    const reports: ExpectationExpiryReport[] = [];
    const { registry } = build({ onExpired: (report) => reports.push(report) });
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm the account for example.com',
      windowMs: 15 * 60_000,
    });

    const failed = await registry.capabilityChanged(UNREADABLE);

    expect(failed).toHaveLength(1);
    // The reason is the whole point: `window-elapsed` tells the owner "nothing
    // came", and the truth here is "we could no longer look".
    expect(failed[0]?.reason).toBe('capability-lost');
    expect(failed[0]?.capabilityReason).toBe('mailbox-unreadable');
    expect(failed[0]?.detail).toContain('stopped being readable');
    expect(failed[0]?.detail).not.toContain('No verification mail');
    expect(reports.map((report) => report.reason)).toEqual(['capability-lost']);
    expect(registry.list()).toHaveLength(0);
  });

  test('the failure is written through, so a restart does not resurrect it', async () => {
    const storePath = newStorePath();
    const first = build({ storePath });
    await first.registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
      windowMs: 15 * 60_000,
    });
    await first.registry.capabilityChanged(UNREADABLE);

    const second = build({ storePath });
    expect((await second.registry.hydrate()).restored).toBe(0);
    expect(second.registry.list()).toHaveLength(0);
  });

  test('a second insufficient verdict with nothing open reports nothing', async () => {
    const reports: ExpectationExpiryReport[] = [];
    const { registry } = build({ onExpired: (report) => reports.push(report) });
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
    });
    await registry.capabilityChanged(UNREADABLE);
    const again = await registry.capabilityChanged(UNREADABLE);
    expect(again).toHaveLength(0);
    expect(reports).toHaveLength(1);
  });
});

describe('a watcher in reconnect backoff does NOT fail expectations (gate #33)', () => {
  test('a reconnecting verdict leaves every open expectation open', async () => {
    const reports: ExpectationExpiryReport[] = [];
    const { registry } = build({ onExpired: (report) => reports.push(report) });
    const opened = await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
      windowMs: 15 * 60_000,
    });

    // "Not yet", not "cannot". The reconnect fetches everything above the
    // cursor, so mail that arrives during the backoff is still delivered and
    // still satisfies this expectation. Failing it here would close a live
    // grant seconds before the message it was waiting for landed.
    const failed = await registry.capabilityChanged(RECONNECTING);

    expect(failed).toHaveLength(0);
    expect(reports).toHaveLength(0);
    expect(registry.list().map((entry) => entry.id)).toEqual([opened.id]);
  });

  test('and it still matches afterwards — the grant was untouched, not merely uncounted', async () => {
    const { registry } = build();
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
      windowMs: 15 * 60_000,
    });
    await registry.capabilityChanged(RECONNECTING);

    const match = await registry.matcher.matchCandidate(
      arrival({ deliveredTo: 'signup-a1@alias.test', from: 'no-reply@example.com' }),
      NOW,
    );
    expect(match.kind).toBe('matched');
  });

  test('every degraded reason is a wait, not a failure', async () => {
    // Table-driven over the reasons that map to `degraded`, so a future reason
    // added to the degraded tier cannot start failing expectations by being
    // forgotten here.
    for (const reason of [
      'reconnecting',
      'server-unavailable',
      'polling-no-idle',
      'polling-idle-refused',
      'polling-capability-unknown',
    ] as const) {
      const { registry } = build();
      await registry.open({
        serviceDomain: 'example.com',
        recipientAddress: 'signup-a1@alias.test',
        purpose: 'confirm',
      });
      const failed = await registry.capabilityChanged(capabilityVerdict(reason, 'detail'));
      expect(failed, `${reason} must not fail expectations`).toHaveLength(0);
      expect(registry.list(), `${reason} must leave the expectation open`).toHaveLength(1);
    }
  });

  test('a healthy verdict fails nothing either', async () => {
    const { registry } = build();
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
    });
    expect(await registry.capabilityChanged(HEALTHY_VERDICT)).toHaveLength(0);
    expect(registry.list()).toHaveLength(1);
  });
});
