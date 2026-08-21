/**
 * The Gmail metadata-only delivery path, what
 * `surfaces.email.inbound.onInsufficientCapability: 'notice-only'` actually
 * does.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 *
 * The schema promised that `notice-only` "keeps announcing that mail arrived
 * using envelope fields alone (sender, subject, delivery evidence), stating
 * plainly in every notice that bodies are unavailable, and it can never satisfy
 * a verification expectation while degraded." Nothing could produce that. The
 * `capability-degraded` notice outcome and its `missingCapability` field
 * existed, were rendered, and were tested, with **zero producers**. The key
 * itself was read by nothing, so `notice-only` and `refuse-and-notify` were the
 * same behaviour.
 *
 * ── The security half, which is the part with no shortcut ────────────────
 *
 * `VerificationExpectationBook.matchCandidate` gates a match on the DELIVERY
 * EVIDENCE ADDRESS and nothing else, `CandidateEmail.body` is passed in and is
 * never consulted in the decision. Delivery evidence is a `Delivered-To`
 * HEADER, so it is present on a metadata-only message. A metadata-only message
 * would therefore match an open expectation for its alias and consume it, on
 * evidence nobody read: the verification link lives in the body that was never
 * fetched.
 *
 * `must never satisfy a verification expectation` is asserted here DIRECTLY,
 * against the real `VerificationExpectationBook`, with a real open expectation
 * whose recipient address is the message's real delivery evidence, rather than
 * inferred from the delta path happening not to produce a match.
 *
 * No network anywhere: Google's HTTP layer is an injected fake port.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GoogleApiClient,
  type GoogleApiFetchPort,
} from '../packages/sdk/src/platform/google/api-client.ts';
import { GoogleTokenManager } from '../packages/sdk/src/platform/google/token-manager.ts';
import type { GoogleOAuthCredentials } from '../packages/sdk/src/platform/google/credential-adoption.ts';
import { collectHistoryDelta } from '../packages/sdk/src/platform/google/history-delta.ts';
import type { HistoryDeltaDeps } from '../packages/sdk/src/platform/google/history-delta.ts';
import { createInboundMailIntake } from '../packages/sdk/src/platform/email/inbound/intake.ts';
import { InboundMailStore } from '../packages/sdk/src/platform/email/inbound/record-store.ts';
import { VerificationExpectationBook } from '../packages/sdk/src/platform/google/verification-expectations.ts';
import {
  INBOUND_CAPABILITY_POLICY_DEFAULT,
  NOTICE_ONLY_CAPABLE_REASONS,
  resolveInboundCapabilityPolicy,
} from '../packages/sdk/src/platform/email/inbound/capability-policy.ts';
import { stateForReason } from '../packages/sdk/src/platform/email/inbound/capability.ts';
import { createInboundMailSourceFactory } from '../packages/sdk/src/platform/email/inbound/source-factory.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import type { InboundCapabilityReason } from '../packages/sdk/src/platform/email/inbound/ports.ts';
import type { GmailInboundMessage } from '../packages/sdk/src/platform/email/inbound/ports.ts';
import type { StructuredNotice } from '../packages/sdk/src/platform/email/inbound-notice.ts';

const METADATA_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-gmail-metadata-'));
  tmpRoots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// 1. The metadata fetch path in api-client.ts
// ---------------------------------------------------------------------------

function tokenManagerWithScopes(scopes: readonly string[]): GoogleTokenManager {
  const credentials: GoogleOAuthCredentials = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    accessToken: 'valid-access-token',
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    scopes,
    tokenUri: 'https://oauth2.googleapis.com/token',
    origin: 'secret-store',
    location: 'test',
  };
  return new GoogleTokenManager(credentials, {
    refresh: async () => {
      throw new Error('refresh must never be called: the cached access token is valid throughout');
    },
  });
}

function recordingPort(body: unknown, status = 200): {
  readonly port: GoogleApiFetchPort;
  readonly urls: string[];
} {
  const urls: string[] = [];
  return {
    urls,
    port: {
      fetch: async (url: string): Promise<Response> => {
        urls.push(url);
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  };
}

/**
 * What Google returns for `format=METADATA`.
 *
 * `payload.body` is deliberately ABSENT, which is the real shape, under
 * `format=METADATA` the payload carries headers and no body data, and
 * `snippet` is deliberately PRESENT, because a snippet is body-derived text and
 * the mapping must drop it rather than trust the provider not to send one.
 */
function metadataResponse(): unknown {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Click here to verify your account: https://evil.example/steal',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'noreply@service.test' },
        { name: 'To', value: 'owner@example.test' },
        { name: 'Subject', value: 'Verify your email' },
        { name: 'Date', value: 'Mon, 27 Jul 2026 12:00:00 +0000' },
        { name: 'Delivered-To', value: 'owner+signup-a1b2@example.test' },
      ],
    },
  };
}

describe('readMessageMetadata: the format=metadata call a gmail.metadata token may make', () => {
  test('it requests format=metadata and names only the headers it reads', async () => {
    const { port, urls } = recordingPort(metadataResponse());
    const client = new GoogleApiClient(tokenManagerWithScopes([METADATA_SCOPE]), port);

    const result = await client.readMessageMetadata('msg-1');
    expect(result.ok).toBe(true);

    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/gmail/v1/users/me/messages/msg-1');
    // Verified against Google's live reference on 2026-07-28: `format` (enum)
    // and `metadataHeaders[]`, whose description is "When given and format is
    // METADATA, only include headers specified."
    expect(url.searchParams.get('format')).toBe('metadata');
    expect(url.searchParams.getAll('metadataHeaders').sort()).toEqual(
      ['Date', 'Delivered-To', 'From', 'Subject', 'To', 'X-Original-To'],
    );
    // Not the body-bearing call. `format=full` here would return a body under a
    // body-capable token and silently reintroduce everything this path removes.
    expect(url.searchParams.get('format')).not.toBe('full');
  });

  test('it returns headers and delivery evidence, and carries NO body property at all', async () => {
    const { port } = recordingPort(metadataResponse());
    const client = new GoogleApiClient(tokenManagerWithScopes([METADATA_SCOPE]), port);

    const result = await client.readMessageMetadata('msg-1');
    if (!result.ok) throw new Error(`expected ok, got ${result.problem}`);

    expect(result.value.from).toBe('noreply@service.test');
    expect(result.value.subject).toBe('Verify your email');
    expect(result.value.to).toBe('owner@example.test');
    // Receiver-written, so this is the correlation evidence and it survives.
    expect(result.value.deliveredTo).toEqual(['owner+signup-a1b2@example.test']);
    expect(result.value.unread).toBe(true);

    // The property is absent, not empty. `'body' in value` is the assertion
    // that matters: an empty string would be a body-shaped field holding
    // something that is not the body, which is the confusion the separate type
    // exists to remove.
    expect('body' in result.value).toBe(false);
  });

  test('the snippet is dropped even when Google sends one, because a snippet is body text', async () => {
    // Google should not return a snippet to a gmail.metadata token. "Should
    // not" is the provider's promise; this path's guarantee is its own, so the
    // mapping blanks it unconditionally. The fixture deliberately contains a
    // verification link inside the snippet, exactly the material that must
    // never reach a caller that believes no body was read.
    const { port } = recordingPort(metadataResponse());
    const client = new GoogleApiClient(tokenManagerWithScopes([METADATA_SCOPE]), port);

    const result = await client.readMessageMetadata('msg-1');
    if (!result.ok) throw new Error('expected ok');

    expect(result.value.snippet).toBe('');
    expect(JSON.stringify(result.value)).not.toContain('evil.example');
  });
});

// ---------------------------------------------------------------------------
// 2. collectHistoryDelta stops refusing, but only when asked
// ---------------------------------------------------------------------------

/** A history page naming one added message, plus the new high-water mark. */
function historyDeps(input: {
  readonly scopes: readonly string[];
  readonly historyId: string;
  readonly ids: readonly string[];
  readonly onBodyFetch?: (id: string) => void;
  readonly onMetadataFetch?: (id: string) => void;
}): HistoryDeltaDeps {
  return {
    scopes: () => input.scopes,
    fetchHistoryPage: async () => ({
      ok: true,
      value: {
        historyId: input.historyId,
        history: input.ids.map((id) => ({ messagesAdded: [{ message: { id } }] })),
      },
    }),
    getMessage: async (id) => {
      input.onBodyFetch?.(id);
      return {
        ok: true,
        value: {
          id,
          threadId: `thread-${id}`,
          from: 'noreply@service.test',
          to: 'owner@example.test',
          subject: 'Verify your email',
          date: 'Mon, 27 Jul 2026 12:00:00 +0000',
          snippet: 'a snippet',
          unread: true,
          provenance: 'untrusted-external',
          body: 'Click https://service.test/verify?token=abc',
          deliveredTo: ['owner+signup-a1b2@example.test'],
        },
      };
    },
    readMessageMetadata: async (id) => {
      input.onMetadataFetch?.(id);
      return {
        ok: true,
        value: {
          id,
          threadId: `thread-${id}`,
          from: 'noreply@service.test',
          to: 'owner@example.test',
          subject: 'Verify your email',
          date: 'Mon, 27 Jul 2026 12:00:00 +0000',
          snippet: '',
          unread: true,
          provenance: 'untrusted-external',
          deliveredTo: ['owner+signup-a1b2@example.test'],
        },
      };
    },
  };
}

describe('collectHistoryDelta on a metadata-only grant', () => {
  /**
   * THE DEFAULT IS UNCHANGED, and this test is here because of that rather
   * than in spite of it.
   *
   * `surfaces.email.inbound.onInsufficientCapability` ships as
   * `refuse-and-notify`. If omitting the new option had started returning `ok`,
   * this module would have changed what that unset key means from underneath
   * every existing caller, so the option defaults to `'refuse'` and this pins
   * it.
   */
  test('with the option omitted it still refuses, exactly as before', async () => {
    let bodyFetches = 0;
    let metadataFetches = 0;
    const deps = historyDeps({
      scopes: [METADATA_SCOPE],
      historyId: '101',
      ids: ['msg-1'],
      onBodyFetch: () => { bodyFetches += 1; },
      onMetadataFetch: () => { metadataFetches += 1; },
    });

    const result = await collectHistoryDelta(deps, { startHistoryId: '100' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect('unavailable' in result && result.unavailable).toBe('metadata-scope-only');
    // Refused before any call of either kind.
    expect(bodyFetches).toBe(0);
    expect(metadataFetches).toBe(0);
  });

  test("with 'refuse' passed explicitly it refuses too — the same answer, said out loud", async () => {
    const deps = historyDeps({ scopes: [METADATA_SCOPE], historyId: '101', ids: ['msg-1'] });
    const result = await collectHistoryDelta(deps, {
      startHistoryId: '100',
      onMetadataOnlyGrant: 'refuse',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect('unavailable' in result && result.unavailable).toBe('metadata-scope-only');
  });

  test("with 'fetch-metadata' it takes the metadata path and returns envelope-only messages", async () => {
    let bodyFetches = 0;
    const metadataIds: string[] = [];
    const deps = historyDeps({
      scopes: [METADATA_SCOPE],
      historyId: '101',
      ids: ['msg-1', 'msg-2'],
      onBodyFetch: () => { bodyFetches += 1; },
      onMetadataFetch: (id) => { metadataIds.push(id); },
    });

    const result = await collectHistoryDelta(deps, {
      startHistoryId: '100',
      onMetadataOnlyGrant: 'fetch-metadata',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.bodies).toBe('withheld-metadata-only');
    expect(result.value.historyId).toBe('101');
    expect(result.value.unreadable).toEqual([]);
    expect(result.value.messages).toHaveLength(2);

    // It used the metadata call for every message and the body call for none.
    // Both halves matter: a path that fetched metadata AND bodies would be
    // strictly worse than refusing.
    expect(metadataIds).toEqual(['msg-1', 'msg-2']);
    expect(bodyFetches).toBe(0);

    for (const message of result.value.messages) {
      expect(message.from).toBe('noreply@service.test');
      expect(message.subject).toBe('Verify your email');
      expect(message.deliveredTo).toEqual(['owner+signup-a1b2@example.test']);
      expect('body' in message).toBe(false);
    }
  });

  test('a body-capable grant is untouched by the option and still returns bodies', async () => {
    let metadataFetches = 0;
    const deps = historyDeps({
      scopes: [READONLY_SCOPE],
      historyId: '102',
      ids: ['msg-1'],
      onMetadataFetch: () => { metadataFetches += 1; },
    });

    // Passing the metadata policy must NOT downgrade a grant that can do
    // better. The option answers "what if bodies are unavailable", not "fetch
    // less".
    const result = await collectHistoryDelta(deps, {
      startHistoryId: '100',
      onMetadataOnlyGrant: 'fetch-metadata',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.bodies).toBe('available');
    expect(metadataFetches).toBe(0);
    if (result.value.bodies !== 'available') throw new Error('narrowing failed');
    expect(result.value.messages[0]?.body).toContain('service.test/verify');
  });

  /**
   * A `historyId` is a decimal uint64 STRING. `Number('18446744073709551615')`
   * is `18446744073709552000`, a position that looks valid and names a
   * different record, so the metadata path must carry it as text, exactly as
   * the body path does.
   */
  test('a uint64 historyId above 2^53 survives the metadata path verbatim', async () => {
    const HUGE = '18446744073709551615';
    expect(String(Number(HUGE))).not.toBe(HUGE); // the truncation this guards

    const deps = historyDeps({ scopes: [METADATA_SCOPE], historyId: HUGE, ids: ['msg-1'] });
    const result = await collectHistoryDelta(deps, {
      startHistoryId: '100',
      onMetadataOnlyGrant: 'fetch-metadata',
    });

    if (!result.ok) throw new Error('unreachable');
    expect(result.value.historyId).toBe(HUGE);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. The intake: the degraded notice, and the expectation that must NOT
//        be satisfied.
// ---------------------------------------------------------------------------

const ALIAS = 'owner+signup-a1b2@example.test';

function gmailMessage(
  overrides: Partial<GmailInboundMessage> = {},
): GmailInboundMessage {
  return {
    source: 'gmail',
    account: 'primary',
    mailbox: 'INBOX',
    from: 'noreply@service.test',
    subject: 'Verify your email',
    claimedDate: 'Mon, 27 Jul 2026 12:00:00 +0000',
    messageId: '<abc@service.test>',
    // Receiver-written delivery evidence, and the ONLY field
    // `matchCandidate` gates on. Present on a metadata-only message because it
    // is a header, which is precisely why item 4 needs asserting.
    deliveredTo: [ALIAS],
    unverifiedToHeaderClaim: 'owner@example.test',
    resourceId: '18f0a2b3c4d5e6f7',
    historyId: '9876543210',
    body: '',
    bodyAvailability: 'metadata-only',
    via: 'poll',
    ...overrides,
  };
}

interface IntakeRig {
  readonly intake: (message: GmailInboundMessage) => Promise<void>;
  readonly records: InboundMailStore;
  readonly sent: StructuredNotice[];
  readonly book: VerificationExpectationBook;
}

function intakeRig(): IntakeRig {
  const root = tmpRoot();
  const records = new InboundMailStore(join(root, 'records.json'));
  const sent: StructuredNotice[] = [];
  const book = new VerificationExpectationBook({
    // `false`: email is input-only. The book refuses to open an expectation at
    // all if email has been granted command authority, so `true` here would
    // make every test below fail on the wrong assertion.
    surfaceHasCommandAuthority: () => false,
  });

  const intake = createInboundMailIntake({
    // The REAL book, match-only, not a stub that returns a canned verdict. A
    // stub here would assert the intake's own arithmetic and prove nothing
    // about whether an expectation can actually be satisfied.
    expectations: {
      matchCandidate: async (email, now, options) => book.matchCandidate(email, now, options),
      consumeMatch: async (match) => {
        if (match.kind === 'matched') book.closeExpectation(match.expectation.id);
      },
    },
    records,
    notices: {
      resolveBinding: () => ({ kind: 'bound', binding: { surfaceKind: 'telegram' } }),
      send: async (notice) => {
        sent.push(notice);
        return { delivered: true };
      },
    },
    noticeMode: () => 'all',
    now: () => new Date('2026-07-27T12:00:05.000Z'),
  });

  return { intake: intake as IntakeRig['intake'], records, sent, book };
}

describe('a metadata-only message is announced as LIMITED VIEW', () => {
  test('the notice title and the outcome line both say bodies were not read', async () => {
    const rig = intakeRig();
    await rig.intake(gmailMessage());

    expect(rig.sent).toHaveLength(1);
    const notice = rig.sent[0]!;

    // The renderer arm that existed with no producer until now.
    expect(notice.title.map((span) => span.text).join('')).toBe('New mail, LIMITED VIEW');

    const outcome = notice.fields.find((field) => field.label === 'Outcome');
    expect(outcome).toBeDefined();
    const text = outcome!.value.map((span) => span.text).join('');
    expect(text).toContain('LIMITED VIEW');
    expect(text).toContain('read message bodies under the granted scope');
    expect(text).toContain('Read from envelope fields only');

    // The envelope fields the schema promises are all present and populated.
    const field = (label: string): string =>
      notice.fields.find((entry) => entry.label === label)!.value
        .map((span) => span.text).join('');
    expect(field('From')).toBe('noreply@service.test');
    expect(field('Subject')).toBe('Verify your email');
    expect(field('Delivered to')).toBe(ALIAS);
  });

  test('a full-body Gmail message on the same rig is NOT marked degraded', async () => {
    // The control. Without it, a producer that marked everything degraded would
    // pass the test above.
    const rig = intakeRig();
    await rig.intake(gmailMessage({
      bodyAvailability: 'full',
      body: 'Click https://service.test/verify?token=abc',
    }));

    const notice = rig.sent[0]!;
    expect(notice.title.map((span) => span.text).join('')).toBe('New mail');
    const outcome = notice.fields.find((field) => field.label === 'Outcome')!;
    expect(outcome.value.map((span) => span.text).join('')).not.toContain('LIMITED VIEW');
  });
});

describe('a metadata-only message can NEVER satisfy a verification expectation', () => {
  /**
   * The one that matters.
   *
   * The expectation is real, open, unexpired, and registered for exactly the
   * address this message's delivery evidence names, so every gate
   * `matchCandidate` applies is satisfied. The only thing standing between it
   * and a `matched` verdict is that the body was never read.
   */
  test('an open expectation for its own delivery address is neither matched nor spent', async () => {
    const rig = intakeRig();
    const opened = rig.book.openExpectation({
      purpose: 'Create a service.test account for the owner',
      serviceDomain: 'service.test',
      recipientAddress: ALIAS,
      now: new Date('2026-07-27T12:00:00.000Z'),
    });
    expect(rig.book.list(new Date('2026-07-27T12:00:05.000Z'))).toHaveLength(1);

    await rig.intake(gmailMessage());

    // Not matched: the notice says degraded, not "Matched an open expectation".
    const outcome = rig.sent[0]!.fields.find((field) => field.label === 'Outcome')!;
    const text = outcome.value.map((span) => span.text).join('');
    expect(text).not.toContain('Matched an open expectation');
    expect(text).toContain('LIMITED VIEW');

    // Not spent: still open, still the same expectation, and still available to
    // the real message when a body-capable grant reads it.
    const stillOpen = rig.book.list(new Date('2026-07-27T12:00:05.000Z'));
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]?.id).toBe(opened.id);

    // And the durable record does not claim a match either.
    const stored = (await rig.records.list())[0]!;
    expect(stored.outcome).not.toBe('matched-expectation');
    expect(stored.outcome).toBe('no-expectation');
  });

  /**
   * The control that makes the test above mean something.
   *
   * The SAME expectation, the SAME delivery address, the SAME rig, and a
   * body-capable read. This one MUST match and MUST be consumed. Without it,
   * an intake that had simply stopped matching anything at all would pass the
   * assertion above.
   */
  test('the identical message read WITH its body does match and does spend the grant', async () => {
    const rig = intakeRig();
    rig.book.openExpectation({
      purpose: 'Create a service.test account for the owner',
      serviceDomain: 'service.test',
      recipientAddress: ALIAS,
      now: new Date('2026-07-27T12:00:00.000Z'),
    });

    await rig.intake(gmailMessage({
      bodyAvailability: 'full',
      body: 'Click https://service.test/verify?token=abc',
    }));

    const outcome = rig.sent[0]!.fields.find((field) => field.label === 'Outcome')!;
    expect(outcome.value.map((span) => span.text).join(''))
      .toContain('Matched an open expectation');
    expect(rig.book.list(new Date('2026-07-27T12:00:05.000Z'))).toHaveLength(0);

    const stored = (await rig.records.list())[0]!;
    expect(stored.outcome).toBe('matched-expectation');
  });

  /**
   * A Gmail message with no usable `bodyAvailability` is REFUSED, not guessed.
   *
   * `bunx tsc -b` does not typecheck `test/`, so a rig that omits the field
   * compiles and the value reads `undefined`. Falling through a `!==
   * 'metadata-only'` comparison would treat it as a full body, the unsafe
   * direction, and the one that would let a body-less message satisfy an
   * expectation. Throwing releases the sink's claim and the message is retried.
   */
  test('an absent bodyAvailability throws rather than being read as a full body', async () => {
    const rig = intakeRig();
    rig.book.openExpectation({
      purpose: 'Create a service.test account for the owner',
      serviceDomain: 'service.test',
      recipientAddress: ALIAS,
      now: new Date('2026-07-27T12:00:00.000Z'),
    });

    const { bodyAvailability: _dropped, ...withoutTheField } = gmailMessage();
    await expect(rig.intake(withoutTheField as GmailInboundMessage))
      .rejects.toThrow(/bodyAvailability/);

    // Nothing announced and nothing spent, it left the world as it found it.
    expect(rig.sent).toEqual([]);
    expect(rig.book.list(new Date('2026-07-27T12:00:05.000Z'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. notice-only degrades on every reason it cannot serve, and says so.
// ---------------------------------------------------------------------------

/**
 * Every member of `InboundCapabilityReason`, listed here rather than derived.
 *
 * A derived list would come from the same place the production set does, so a
 * reason silently added to both would be "covered" without anyone deciding
 * whether `notice-only` can serve it. The count assertion below is what makes
 * this list fail when the union grows.
 */
const ALL_REASONS: readonly InboundCapabilityReason[] = [
  'idle-push',
  'polling-configured',
  'polling-no-idle',
  'polling-idle-refused',
  'polling-capability-unknown',
  'reconnecting',
  'server-unavailable',
  'credentials-missing',
  'credentials-rejected',
  'mailbox-unreadable',
  'uidvalidity-missing',
  'mailbox-position-unknown',
  'fetch-refused',
  'gmail-metadata-only',
  'gmail-metadata-notice-only',
  'fetch-unreadable',
  'local-store-unwritable',
  'watcher-stopped-unexpectedly',
];

describe('resolveInboundCapabilityPolicy', () => {
  test('the shipped default is refuse-and-notify, matching the config schema', () => {
    expect(INBOUND_CAPABILITY_POLICY_DEFAULT).toBe('refuse-and-notify');
  });

  test('notice-only is honoured on the two Gmail metadata reasons and nowhere else', () => {
    // Stated as a set comparison rather than as one `has` call per reason, so
    // a reason quietly joining the capable set fails here.
    expect([...NOTICE_ONLY_CAPABLE_REASONS].sort())
      .toEqual(['gmail-metadata-notice-only', 'gmail-metadata-only']);
  });

  test('every insufficient reason other than the Gmail ones degrades notice-only, and says so', () => {
    const insufficient = ALL_REASONS.filter((reason) => stateForReason(reason) === 'insufficient');
    // There are several; a filter that produced one or none would make the loop
    // below vacuous.
    expect(insufficient.length).toBeGreaterThan(5);

    for (const reason of insufficient) {
      const resolved = resolveInboundCapabilityPolicy('notice-only', reason);
      if (reason === 'gmail-metadata-only') {
        expect(resolved.effective).toBe('notice-only');
        expect(resolved.degraded).toBe(false);
        continue;
      }
      expect(resolved.effective).toBe('refuse-and-notify');
      expect(resolved.degraded).toBe(true);
      // Not silent: the sentence names the setting, names this reason, and
      // says which condition the setting DOES apply to.
      expect(resolved.statusSentence)
        .toContain('surfaces.email.inbound.onInsufficientCapability');
      expect(resolved.statusSentence).toContain(reason);
      expect(resolved.statusSentence).toContain('gmail.metadata');
    }
  });

  test('refuse-and-notify never degrades, and still states which policy is in force', () => {
    for (const reason of ALL_REASONS) {
      const resolved = resolveInboundCapabilityPolicy('refuse-and-notify', reason);
      expect(resolved.effective).toBe('refuse-and-notify');
      expect(resolved.degraded).toBe(false);
      expect(resolved.statusSentence.length).toBeGreaterThan(0);
    }
  });

  test('the status sentence is never empty, on any policy and any reason', () => {
    // The property the call sites rely on: appended unconditionally, so there
    // is no branch deciding whether the owner is told.
    for (const configured of ['refuse-and-notify', 'notice-only'] as const) {
      for (const reason of ALL_REASONS) {
        expect(resolveInboundCapabilityPolicy(configured, reason).statusSentence.length)
          .toBeGreaterThan(20);
      }
    }
  });

  /**
   * The owner's setting actually reaches the source that acts on it.
   *
   * This test exists because its absence was found by mutation and not by
   * reading: replacing `capabilityPolicy: readCapabilityPolicy(deps.getConfig)`
   * in `source-factory.ts` with the hardcoded default left the entire suite
   * green. Every other check was either about the schema row, about the key's
   * text appearing inside a `getConfig(...)` call somewhere in the tree, or
   * about `GmailMailSource` honouring a policy it was HANDED, and none of
   * those is the claim that the value travels from the owner's config to the
   * constructor argument.
   *
   * That is precisely the failure this key had for its whole life: a schema
   * row, a validated enum, a description the owner reads, and no path from the
   * setting to any behaviour. A text-shaped gate cannot tell "read" from "read
   * and then ignored", so this drives the real factory and reads what the
   * builder was actually given.
   */
  test('the configured policy travels from ConfigManager to the Gmail source builder', async () => {
    const built: Array<{ readonly capabilityPolicy: unknown }> = [];

    const factoryFor = async (configured: string | undefined) => {
      const root = tmpRoot();
      const config = new ConfigManager({ configDir: join(root, 'config') });
      if (configured !== undefined) {
        config.set('surfaces.email.inbound.onInsufficientCapability' as never, configured as never);
      }
      const factory = createInboundMailSourceFactory({
        getConfig: ((key: string) => config.get(key as never)) as never,
        secrets: { get: async () => undefined } as never,
        transport: { connectImapTls: async () => { throw new Error('no IMAP in this test'); } } as never,
        cursors: {} as never,
        settings: { capabilityRecheckMs: 60 * 60_000 } as never,
        gmail: async (input) => {
          built.push({ capabilityPolicy: input.capabilityPolicy });
          return null;
        },
      });
      await factory.create({
        kind: 'gmail',
        account: 'primary',
        mailbox: 'INBOX',
        sink: {} as never,
        observer: {} as never,
      });
    };

    // Explicitly set to the non-default value: this is the assertion the
    // hardcoded-default mutation fails.
    await factoryFor('notice-only');
    expect(built.at(-1)?.capabilityPolicy).toBe('notice-only');

    // Explicitly set to the default.
    await factoryFor('refuse-and-notify');
    expect(built.at(-1)?.capabilityPolicy).toBe('refuse-and-notify');

    // And UNSET means the shipped default, asserted rather than changed.
    await factoryFor(undefined);
    expect(built.at(-1)?.capabilityPolicy).toBe('refuse-and-notify');
    expect(built.at(-1)?.capabilityPolicy).toBe(INBOUND_CAPABILITY_POLICY_DEFAULT);

    expect(built).toHaveLength(3);
  });

  test('the reason list here still covers the whole union', () => {
    // `stateForReason` is total over the union, so an unlisted reason would be
    // untested rather than failing. This pins the count: adding a member to
    // `InboundCapabilityReason` reddens here and forces a ruling on whether
    // `notice-only` can serve it.
    expect(new Set(ALL_REASONS).size).toBe(18);
    for (const reason of ALL_REASONS) {
      expect(['healthy', 'degraded', 'insufficient']).toContain(stateForReason(reason));
    }
  });
});
