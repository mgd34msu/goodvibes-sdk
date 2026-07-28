/**
 * The live verb and the load path must agree at every boundary.
 *
 * The failure this file exists to rule out is not a refusal — a refusal is
 * loud. It is an expectation that `openExpectation` ACCEPTS and
 * `validatePersistedExpectation` then REFUSES: the workstream opens it, the
 * signup proceeds, the daemon restarts, and the grant is gone. Nothing errors,
 * nothing logs, and the verification mail that arrives afterwards matches
 * nothing. The store re-validates every entry it writes, so the drop happens
 * silently at the mirror write — `replaceAll` filters and returns void.
 *
 * §9.2 states the property in one direction: *a file on disk must not be able
 * to mint an expectation the live API would have refused.* This file asserts
 * the inverse, which is just as load-bearing and was never written down: **the
 * live API must not be able to mint an expectation the file would refuse.**
 *
 * Proved rather than asserted. The round trip is driven with generated input
 * across every boundary either side enforces — window clamping, the id bound,
 * domain registrability, address and purpose ceilings — and the whole restart
 * is exercised end to end: open, mirror, sweep, hydrate.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fc from 'fast-check';
import {
  MAX_EXPECTATION_ID_CHARS,
  MAX_PURPOSE_CHARS,
  MAX_RECIPIENT_ADDRESS_CHARS,
  MAX_OPEN_EXPECTATIONS,
  MAX_VERIFICATION_WINDOW_MS,
  MIN_VERIFICATION_WINDOW_MS,
  VerificationExpectationBook,
  validatePersistedExpectation,
} from '../packages/sdk/src/platform/google/verification-expectations.ts';
import { PersistedExpectationStore } from '../packages/sdk/src/platform/email/inbound/expectation-store.ts';

const T0 = new Date('2026-07-27T12:00:00.000Z');

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-expectation-roundtrip-'));
  storePath = join(dir, 'inbound-mail-expectations.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Generators — aimed at the boundaries, not at the middle
// ---------------------------------------------------------------------------

/** Registrable domains: a label below a public suffix. */
const serviceDomain = fc.tuple(
  fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
  fc.constantFrom('com', 'org', 'net', 'co.uk', 'io'),
).map(([label, tld]) => `${label}.${tld}`);

const recipientAddress = fc.tuple(
  fc.stringMatching(/^[a-z][a-z0-9._+-]{0,24}$/),
  serviceDomain,
).map(([local, domain]) => `${local}@${domain}`);

const purpose = fc.oneof(
  fc.stringMatching(/^[ -~]{1,40}$/).filter((value) => value.trim().length > 0),
  // Exactly at the ceiling, and one under.
  fc.constant('p'.repeat(MAX_PURPOSE_CHARS)),
  fc.constant('p'.repeat(MAX_PURPOSE_CHARS - 1)),
);

/**
 * Windows the live verb CLAMPS rather than refuses.
 *
 * `clampWindow` floors and clamps into [MIN, MAX]; the load path refuses
 * anything outside that range. So every value here — including the absurd ones
 * — must come out the other side inside the range, or the two disagree.
 */
const windowMs = fc.oneof(
  fc.integer({ min: -1_000_000, max: 10_000_000 }),
  fc.constantFrom(
    MIN_VERIFICATION_WINDOW_MS,
    MIN_VERIFICATION_WINDOW_MS - 1,
    MAX_VERIFICATION_WINDOW_MS,
    MAX_VERIFICATION_WINDOW_MS + 1,
    0, -1, 1, 999.9, 1000.5, Number.MAX_SAFE_INTEGER,
  ),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.constant(undefined),
);

/**
 * Ids ACROSS the bound, not inside it.
 *
 * Generating only values the live verb accepts would make the agreement
 * property unable to fail: loosening `openExpectation` would produce no input
 * that reaches the disagreement. The generator has to straddle every boundary
 * for the property to mean anything — see the note above `openInput`.
 */
const suppliedId = fc.oneof(
  fc.constant(undefined),
  fc.stringMatching(/^[A-Za-z0-9._:-]{1,40}$/),
  fc.constant('a'.repeat(MAX_EXPECTATION_ID_CHARS)),
  fc.constant(`  ${'b'.repeat(MAX_EXPECTATION_ID_CHARS)}  `),
  // Over the bound, and shapes the bound refuses.
  fc.constant('x'.repeat(MAX_EXPECTATION_ID_CHARS + 1)),
  fc.constant('x'.repeat(100_000)),
  fc.constant('has space'),
  fc.constant('line\nbreak'),
  fc.constant('"quoted"'),
  fc.constant('   '),
);

/**
 * Inputs that STRADDLE every boundary either side enforces.
 *
 * The property below is deliberately conditional: if `openExpectation` throws,
 * the input was refused loudly and the two paths agree by construction. What
 * must never happen is `openExpectation` RETURNING a record that
 * `validatePersistedExpectation` then rejects — that is the silent-vanish
 * case, and it is only reachable if the generator can produce input that one
 * side accepts and the other does not.
 */
const openInput = fc.record({
  serviceDomain: fc.oneof(
    serviceDomain,
    fc.constantFrom('com', 'co.uk', '', 'not a host', '.', 'localhost'),
  ),
  recipientAddress: fc.oneof(
    recipientAddress,
    fc.constantFrom('no-at-sign', '', '@', `${'a'.repeat(400)}@example.com`),
  ),
  purpose: fc.oneof(
    purpose,
    fc.constantFrom('', '   ', 'p'.repeat(MAX_PURPOSE_CHARS + 1)),
  ),
  windowMs,
  id: suppliedId,
  kind: fc.constantFrom('signup' as const, 'login' as const),
});

/**
 * Open, or report that it was refused.
 *
 * A refusal is agreement: the live verb said no, loudly, and nothing was
 * minted that could later vanish.
 */
function openOrRefuse(
  book: VerificationExpectationBook,
  input: Parameters<VerificationExpectationBook['openExpectation']>[0],
): ReturnType<VerificationExpectationBook['openExpectation']> | null {
  try {
    return book.openExpectation(input);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe('anything the live verb mints, the load path accepts', () => {
  test('open -> validate round-trips for every accepted input', () => {
    fc.assert(
      fc.property(openInput, (input) => {
        const book = new VerificationExpectationBook();
        const opened = openOrRefuse(book, { ...input, now: T0 });
        if (opened === null) return;

        // The same instant the record was minted at. A record cannot be
        // "already stale" the moment it is written.
        const validated = validatePersistedExpectation(opened, T0);
        expect(validated).not.toBeNull();
        // And byte-for-byte the same grant — the load path may not silently
        // rewrite a window, an id, or an expiry.
        expect(validated).toEqual(opened);
      }),
      { numRuns: 400 },
    );
  });

  test('the minted window always lands inside the range the load path enforces', () => {
    fc.assert(
      fc.property(openInput, (input) => {
        const opened = openOrRefuse(new VerificationExpectationBook(), { ...input, now: T0 });
        if (opened === null) return;
        const span = Date.parse(opened.expiresAt) - Date.parse(opened.openedAt);
        expect(span).toBeGreaterThanOrEqual(MIN_VERIFICATION_WINDOW_MS);
        expect(span).toBeLessThanOrEqual(MAX_VERIFICATION_WINDOW_MS);
      }),
      { numRuns: 400 },
    );
  });

  test('a minted id always satisfies the bound the load path applies', () => {
    fc.assert(
      fc.property(openInput, (input) => {
        const opened = openOrRefuse(new VerificationExpectationBook(), { ...input, now: T0 });
        if (opened === null) return;
        expect(opened.id.length).toBeGreaterThan(0);
        expect(opened.id.length).toBeLessThanOrEqual(MAX_EXPECTATION_ID_CHARS);
        expect(opened.id).toMatch(/^[A-Za-z0-9._:-]+$/);
      }),
      { numRuns: 400 },
    );
  });

  test('a minted recipient always satisfies the ceiling the load path applies', () => {
    fc.assert(
      fc.property(openInput, (input) => {
        const opened = openOrRefuse(new VerificationExpectationBook(), { ...input, now: T0 });
        if (opened === null) return;
        expect(opened.recipientAddress.length).toBeLessThanOrEqual(MAX_RECIPIENT_ADDRESS_CHARS);
        expect(opened.recipientAddress).toContain('@');
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// The whole restart, not just the validator
// ---------------------------------------------------------------------------

describe('an expectation survives the restart it was persisted for', () => {
  test('open -> mirror -> sweep -> hydrate keeps the grant intact', async () => {
    await fc.assert(
      fc.asyncProperty(openInput, async (input) => {
        rmSync(storePath, { force: true });
        const book = new VerificationExpectationBook();
        const opened = openOrRefuse(book, { ...input, now: T0 });
        if (opened === null) return;

        // The mirror write. `replaceAll` returns void and silently drops
        // anything it re-validates as invalid, so a disagreement here is
        // invisible at the call site — which is exactly why it is asserted.
        const store = new PersistedExpectationStore(storePath, { now: () => T0 });
        await store.replaceAll(book.list(T0));
        expect(await store.list()).toHaveLength(1);

        // The restart: a fresh store over the same file, swept, then hydrated
        // back into a fresh book.
        const reopened = new PersistedExpectationStore(storePath, { now: () => T0 });
        const report = await reopened.sweep('recovery');
        expect(report.retained).toBe(1);
        expect(report.removed).toHaveLength(0);

        const restored = new VerificationExpectationBook();
        const hydrated = restored.hydrateExpectation(opened, T0);
        expect(hydrated).not.toBeNull();
        // The window is the ORIGINAL one. A restart must not extend a grant.
        expect(hydrated?.expiresAt).toBe(opened.expiresAt);
        expect(hydrated?.openedAt).toBe(opened.openedAt);
        expect(hydrated?.id).toBe(opened.id);
      }),
      { numRuns: 60 },
    );
  });

  test('a full book at the open ceiling mirrors without losing any of it', async () => {
    // Both sides bound the open set at MAX_OPEN_EXPECTATIONS. If the store's
    // ceiling were the lower of the two, the overflow would be dropped by
    // `sweep` as 'over-cap' and the owner would never be told.
    const book = new VerificationExpectationBook();
    for (let index = 0; index < MAX_OPEN_EXPECTATIONS; index += 1) {
      book.openExpectation({
        serviceDomain: 'github.com',
        recipientAddress: `owner+gv-${String(index)}@example.com`,
        purpose: `signup ${String(index)}`,
        now: T0,
      });
    }
    expect(book.list(T0)).toHaveLength(MAX_OPEN_EXPECTATIONS);

    const store = new PersistedExpectationStore(storePath, { now: () => T0 });
    await store.replaceAll(book.list(T0));
    const report = await store.sweep('recovery');

    expect(report.retained).toBe(MAX_OPEN_EXPECTATIONS);
    expect(report.removed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The stated direction, still held
// ---------------------------------------------------------------------------

describe('the file still cannot mint what the live verb would refuse', () => {
  test('every field the live verb bounds is bounded on the load path too', () => {
    const base = new VerificationExpectationBook().openExpectation({
      serviceDomain: 'github.com',
      recipientAddress: 'owner+gv-github-com@example.com',
      purpose: 'account signup',
      now: T0,
    });

    // Each of these is a mutation the live verb would have refused outright.
    const refused: readonly Record<string, unknown>[] = [
      { ...base, id: 'x'.repeat(MAX_EXPECTATION_ID_CHARS + 1) },
      { ...base, id: 'has space' },
      { ...base, purpose: 'p'.repeat(MAX_PURPOSE_CHARS + 1) },
      { ...base, purpose: '   ' },
      { ...base, serviceDomain: 'com' },
      { ...base, recipientAddress: 'no-at-sign' },
      { ...base, authority: 'command' },
      { ...base, kind: 'password-reset' },
      {
        ...base,
        expiresAt: new Date(Date.parse(base.openedAt) + MAX_VERIFICATION_WINDOW_MS + 1).toISOString(),
      },
      {
        ...base,
        openedAt: new Date(T0.getTime() + 60_000).toISOString(),
        expiresAt: new Date(T0.getTime() + 60_000 + MIN_VERIFICATION_WINDOW_MS).toISOString(),
      },
    ];

    for (const record of refused) {
      expect(validatePersistedExpectation(record, T0)).toBeNull();
    }
  });
});
