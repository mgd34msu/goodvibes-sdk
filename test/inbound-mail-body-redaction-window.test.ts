/**
 * The body excerpt's card redaction, at the truncation boundary.
 *
 * `record()` redacts before it truncates, which is right — truncating first
 * leaves a card number straddling the cap as a readable prefix. What was wrong
 * is the SIZE of what it redacted: a window of `cap + one maximum span`, on the
 * reasoning that a span starting just inside the cap is then always seen whole.
 *
 * That holds for one span. It fails for several, because redaction SHORTENS.
 * `[redacted:pan]` is fourteen characters against a nineteen-digit grouped
 * PAN's thirty-seven, so each replacement pulls everything after it leftwards —
 * and a span sitting beyond the window, seen only in part and therefore not
 * matched, slides back inside the final `slice(0, cap)` and is stored verbatim.
 *
 * Not reachable through inbound mail today: `intake.ts` passes `body: ''`. It
 * is the designated path for the body-fetch round, and the comment asserting
 * the window was safe is what would have stopped anyone re-deriving it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboundMailStore } from '../packages/sdk/src/platform/email/inbound/record-store.ts';
import { detectCardShapes } from '../packages/sdk/src/platform/security/card-shapes.ts';

let dir: string;
let store: InboundMailStore;

/** Small enough that the boundary is reachable, large enough to be realistic. */
const CAP = 200;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-body-redaction-'));
  store = new InboundMailStore(join(dir, 'records.json'), {
    policy: { maxBodyExcerptChars: CAP },
    now: () => Date.parse('2026-07-28T12:00:00.000Z'),
  });
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Longest run of digits, ignoring the separators a card may carry. */
function longestDigitRun(text: string): number {
  return (text.match(/\d(?:[ -]?\d)*/g) ?? [])
    .map((run) => run.replace(/\D/g, '').length)
    .reduce((a, b) => Math.max(a, b), 0);
}

async function excerptFor(body: string): Promise<string> {
  const record = await store.record({
    source: 'imap',
    uidValidity: 42,
    uid: 7,
    account: 'primary',
    mailbox: 'INBOX',
    senderDisplay: 'sender@example.test',
    subject: 'a subject',
    deliveredToAddress: 'owner@example.com',
    deliveryEvidenceSource: 'delivered-to-header',
    links: [],
    outcome: 'no-expectation',
    noticeStatus: 'suppressed',
    body,
    receivedAt: '2026-07-28T12:00:00.000Z',
  });
  return record.bodyExcerpt;
}

/** A grouped PAN: the longest written form, and the one that shrinks most. */
const GROUPED = '5555 5555 5555 4444';
/** A bare PAN, the shortest written form. */
const BARE = '5555555555554444';

describe('no card shape survives into a stored body excerpt', () => {
  test('the straddling-span case the window was built for still holds', () => {
    // The original reason for redacting before truncating. Kept so the fix
    // cannot regress into truncate-then-redact.
    const body = `${'x'.repeat(CAP - 8)}${BARE} trailing`;
    return excerptFor(body).then((excerpt) => {
      expect(detectCardShapes(excerpt)).toEqual([]);
      expect(excerpt).not.toContain('5555555555554444');
    });
  });

  test('a span cut by the old scan window leaves no digits behind', async () => {
    // The measured construction. Searched 1830 combinations of span form,
    // preceding-redaction count and padding: under the windowed scan the worst
    // surviving run was SIX digits, at nine grouped spans and fifty characters
    // of padding. Not the fifteen the report described — the redactor also
    // catches short digit runs as security codes, so a truncated PAN is mostly
    // eaten on the way out — but six digits of a card is still six digits that
    // did not need to be on disk, and scanning the whole body leaves none.
    const shrinkers = `${GROUPED} `.repeat(9);
    const body = `${shrinkers}${'y'.repeat(50)}${GROUPED}${'z'.repeat(80)}`;
    const excerpt = await excerptFor(body);

    expect(longestDigitRun(excerpt)).toBe(0);
    expect(detectCardShapes(excerpt)).toEqual([]);
  });

  test('no digits survive across the whole construction space', async () => {
    // The property rather than the one worst case: whatever the arrangement,
    // a stored excerpt carries no card digits at all.
    for (const span of [GROUPED, BARE]) {
      for (const shrinkers of [0, 3, 9, 12]) {
        for (const pad of [0, 25, 50]) {
          const body = `${`${span} `.repeat(shrinkers)}${'y'.repeat(pad)}${span}${'z'.repeat(80)}`;
          expect({ span, shrinkers, pad, run: longestDigitRun(await excerptFor(body)) })
            .toEqual({ span, shrinkers, pad, run: 0 });
        }
      }
    }
  });

  test('a body with no card shapes is truncated and otherwise untouched', async () => {
    const body = 'z'.repeat(CAP * 2);
    const excerpt = await excerptFor(body);
    expect(excerpt).toBe('z'.repeat(CAP));
  });

  test('the excerpt never exceeds the configured cap', async () => {
    for (const body of ['', 'short', `${GROUPED} `.repeat(30), 'q'.repeat(CAP * 3)]) {
      expect((await excerptFor(body)).length).toBeLessThanOrEqual(CAP);
    }
  });
});
