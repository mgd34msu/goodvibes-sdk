/**
 * Backoff, capability verdicts and state transitions — the parts of the
 * inbound watcher that are decisions rather than protocol.
 *
 * Pure functions and small objects with injected time and chance, so every
 * assertion here is exact rather than statistical, and a five-minute ceiling
 * is asserted without waiting five minutes.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { IMAP_MAX_FETCH_UIDS } from '../packages/sdk/src/platform/email/imap-client.ts';
import { composeOpenFailure } from '../packages/sdk/src/platform/email/imap-open.ts';
import {
  BackoffSchedule,
  CapabilityStateTracker,
  DEFAULT_BACKOFF_POLICY,
  IDLE_REISSUE_ADVISORY_BOUND_MS,
  backoffWindowMs,
  capabilityVerdict,
  classifyOpenFailure,
  classifyReadFailure,
  fullJitterDelayMs,
  isIdleWakeLine,
  resolveIdleSupport,
  runIdleRound,
  resolveWatcherSettings,
  searchAboveCursor,
  verdictForOpenConnection,
  type MailboxReader,
  type MailboxWire,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import {
  FakeClock,
  RecordingObserver,
  fixedRandom,
  scriptedRandom,
} from './_helpers/inbound-watcher-harness.ts';

const INBOUND_DIR = join(
  import.meta.dir,
  '..',
  'packages/sdk/src/platform/email/inbound',
);

describe('backoff', () => {
  test('windows double from one second and stop at the ceiling', () => {
    const policy = DEFAULT_BACKOFF_POLICY;
    expect(backoffWindowMs(policy, 0)).toBe(1_000);
    expect(backoffWindowMs(policy, 1)).toBe(2_000);
    expect(backoffWindowMs(policy, 2)).toBe(4_000);
    expect(backoffWindowMs(policy, 8)).toBe(256_000);
    expect(backoffWindowMs(policy, 9)).toBe(300_000);
    // An absurd attempt count must reach the ceiling, not Infinity.
    expect(backoffWindowMs(policy, 5_000)).toBe(300_000);
  });

  test('every delay is inside its window, and the ceiling bounds all of them', () => {
    const random = scriptedRandom([0, 0.25, 0.5, 0.75, 0.999999]);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const delay = fullJitterDelayMs(DEFAULT_BACKOFF_POLICY, attempt, random);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(backoffWindowMs(DEFAULT_BACKOFF_POLICY, attempt));
      expect(delay).toBeLessThanOrEqual(300_000);
    }
  });

  test('jitter spreads the whole window, not a fraction of it', () => {
    // Full jitter, not "half the window plus a wobble": a draw near zero must
    // produce a delay near zero, which is what actually de-synchronises a
    // cohort of mailboxes reconnecting after one provider outage.
    expect(fullJitterDelayMs(DEFAULT_BACKOFF_POLICY, 5, fixedRandom(0))).toBe(0);
    expect(fullJitterDelayMs(DEFAULT_BACKOFF_POLICY, 5, fixedRandom(1))).toBe(32_000);
    expect(fullJitterDelayMs(DEFAULT_BACKOFF_POLICY, 5, fixedRandom(0.5))).toBe(16_000);

    const spread = new Set<number>();
    const random = scriptedRandom([0.01, 0.37, 0.62, 0.88, 0.13]);
    for (let index = 0; index < 5; index += 1) {
      spread.add(fullJitterDelayMs(DEFAULT_BACKOFF_POLICY, 6, random));
    }
    expect(spread.size).toBe(5);
  });

  test('a source that misbehaves cannot produce a delay outside the window', () => {
    expect(fullJitterDelayMs(DEFAULT_BACKOFF_POLICY, 3, () => -5)).toBe(0);
    expect(fullJitterDelayMs(DEFAULT_BACKOFF_POLICY, 3, () => 12)).toBe(8_000);
    expect(fullJitterDelayMs(DEFAULT_BACKOFF_POLICY, 3, () => Number.NaN)).toBe(8_000);
  });

  test('a schedule escalates, resets, and honours a per-draw ceiling', () => {
    const schedule = new BackoffSchedule(DEFAULT_BACKOFF_POLICY, fixedRandom(1));
    expect(schedule.next()).toBe(1_000);
    expect(schedule.next()).toBe(2_000);
    expect(schedule.next()).toBe(4_000);
    expect(schedule.attempts).toBe(3);
    // The connection-limit ceiling widens one draw without losing the count.
    expect(schedule.next(900_000)).toBe(8_000);
    expect(schedule.attempts).toBe(4);
    schedule.reset();
    expect(schedule.attempts).toBe(0);
    expect(schedule.next()).toBe(1_000);
  });
});

describe('capability verdicts', () => {
  /**
   * Built the way the client builds them, rather than by hand.
   *
   * `composeOpenFailure` is what actually classifies a refusal now, and it is
   * the thing whose answer this file must not second-guess. Constructing an
   * `ImapOpenError` directly would let the test assert a reason the real path
   * would never produce.
   */
  function refusedAtLogin(serverMessage: string): Error {
    return composeOpenFailure({
      refusedReason: 'authentication-rejected',
      refusedSummary: 'The mail server rejected the credentials.',
      error: new Error(`IMAP command failed: A0002 ${serverMessage}`),
      mailbox: 'INBOX',
    });
  }

  test('a refused credential is insufficient and terminal, with an owner message', () => {
    const result = classifyOpenFailure(
      refusedAtLogin('NO [AUTHENTICATIONFAILED] Invalid credentials'),
    );
    expect(result.terminal).toBe(true);
    expect(result.verdict.state).toBe('insufficient');
    expect(result.verdict.reason).toBe('credentials-rejected');
    // The owner-facing sentence comes off the routable notice, so there is one
    // text per failure wherever it surfaces rather than two that can disagree.
    expect(result.notice?.reason).toBe('authentication-rejected');
    expect(result.verdict.fix).toBe(result.notice?.ownerMessage);
    expect(result.verdict.fix.length).toBeGreaterThan(0);
  });

  test('a connection limit refused AT LOGIN is not read as a bad credential', () => {
    // The whole reason this round exists. Gmail answers a
    // simultaneous-connection refusal at the login step, and calling that a
    // rejected credential stops the watcher permanently on something that
    // clears in seconds — a mailbox that looks quiet while mail piles up.
    const result = classifyOpenFailure(
      refusedAtLogin('NO [LIMIT] Too many simultaneous connections'),
    );
    expect(result.terminal).toBe(false);
    expect(result.verdict.state).toBe('degraded');
    expect(result.verdict.reason).toBe('server-unavailable');
    expect(result.verdict.detail).toContain('Too many simultaneous connections');
  });

  test('an ambiguous refusal keeps trying rather than stopping', () => {
    // The asymmetry is not close: a wrong "terminal" stops mail until a person
    // notices, a wrong "transient" costs a retry.
    const result = classifyOpenFailure(refusedAtLogin('NO Request failed'));
    expect(result.terminal).toBe(false);
    expect(result.verdict.state).toBe('degraded');
  });

  test('an unopenable mailbox is insufficient; a socket failure is a reconnect', () => {
    const mailbox = classifyOpenFailure(composeOpenFailure({
      refusedReason: 'mailbox-unavailable',
      refusedSummary: 'The mailbox could not be opened.',
      error: new Error('IMAP command failed: A0003 NO Mailbox does not exist'),
      mailbox: 'INBOX',
    }));
    expect(mailbox.terminal).toBe(true);
    expect(mailbox.verdict.reason).toBe('mailbox-unreadable');

    const socket = classifyOpenFailure(composeOpenFailure({
      refusedReason: 'connection-failed',
      refusedSummary: 'The mail server did not answer.',
      error: new Error('ECONNRESET'),
      mailbox: 'INBOX',
    }));
    expect(socket.terminal).toBe(false);
    expect(socket.verdict.reason).toBe('reconnecting');

    const plain = classifyOpenFailure(new Error('connect ECONNREFUSED 127.0.0.1:993'));
    expect(plain.terminal).toBe(false);
    expect(plain.verdict.reason).toBe('reconnecting');
    expect(plain.notice).toBeNull();
  });

  test('a missing credential is its own reason, not a rejected one', () => {
    // Structural: anything carrying the shared notice routes by one path, so a
    // credential that was never stored does not arrive telling the owner to
    // replace a password he never set.
    const missing = {
      message: 'No mail password is stored.',
      notice: {
        reason: 'credential-unavailable',
        terminal: true,
        mailbox: 'INBOX',
        ownerMessage: 'Store a mail password at daemon scope.',
        serverMessage: '',
      },
    };
    const result = classifyOpenFailure(missing);
    expect(result.terminal).toBe(true);
    expect(result.verdict.reason).toBe('credentials-missing');
    expect(result.verdict.state).toBe('insufficient');
    expect(result.verdict.fix).toBe('Store a mail password at daemon scope.');
  });

  test('a refused FETCH is insufficient; a refused SEARCH and a [LIMIT] are not', () => {
    const refused = classifyReadFailure(
      new Error('IMAP command failed: A0007 NO Server error fetching message data'),
    );
    expect(refused.terminal).toBe(true);
    expect(refused.verdict.reason).toBe('fetch-refused');

    // A server that says it is busy is taken at its word, whichever command
    // it said it to.
    const busy = classifyReadFailure(
      new Error('IMAP command failed: A0006 NO Server busy, try again'),
      'search',
    );
    expect(busy.terminal).toBe(false);
    expect(busy.verdict.reason).toBe('server-unavailable');

    // When the refusal says nothing about itself, the phase decides — and the
    // two phases are different claims about the mailbox.
    const ambiguousSearch = classifyReadFailure(
      new Error('IMAP command failed: A0006 NO Request failed'),
      'search',
    );
    expect(ambiguousSearch.terminal).toBe(false);
    expect(ambiguousSearch.verdict.reason).toBe('reconnecting');

    const ambiguousFetch = classifyReadFailure(
      new Error('IMAP command failed: A0007 NO Request failed'),
      'fetch',
    );
    expect(ambiguousFetch.terminal).toBe(true);
    expect(ambiguousFetch.verdict.reason).toBe('fetch-refused');

    // Mid-session, the same response code means the same thing it means at
    // login — one classifier, asked from both places.
    const limited = classifyReadFailure(
      new Error('IMAP command failed: A0007 NO [LIMIT] Too many simultaneous connections'),
    );
    expect(limited.terminal).toBe(false);
    expect(limited.verdict.reason).toBe('server-unavailable');

    const dropped = classifyReadFailure(new Error('IMAP connection closed unexpectedly'));
    expect(dropped.terminal).toBe(false);
    expect(dropped.verdict.reason).toBe('reconnecting');
  });
});

describe('resolving whether the server can push', () => {
  function readerWith(atoms: readonly string[] | 'throws'): MailboxReader {
    return {
      capabilities: async () => {
        if (atoms === 'throws') throw new Error('IMAP read timeout');
        return atoms;
      },
      fetchEnvelopes: async () => [],
      fetchEnvelopeBatch: async () => ({ envelopes: [], unreadable: [] }),
    };
  }

  test('an advertised answer is taken at face value, either way', async () => {
    expect(await resolveIdleSupport(readerWith(['IMAP4REV1', 'IDLE'])))
      .toEqual({ supported: true, reason: 'advertised' });
    expect(await resolveIdleSupport(readerWith(['IMAP4REV1', 'UIDPLUS'])))
      .toEqual({ supported: false, reason: 'not-advertised' });
  });

  test('a server that says nothing is asked, and its silence is named', async () => {
    // The tri-state's whole point: an empty capability set means the server
    // said NOTHING, which is not "no". It is resolved by asking, and when even
    // asking gets no answer the reason says so — so the surfaced status can
    // explain why it is polling rather than let the owner assume his provider
    // cannot do better.
    expect(await resolveIdleSupport(readerWith([])))
      .toEqual({ supported: false, reason: 'server-would-not-say' });
  });

  test('the verdict distinguishes chosen polling from fallen-back polling', () => {
    expect(verdictForOpenConnection({
      mode: 'poll',
      idle: { supported: true, reason: 'advertised' },
    })).toMatchObject({ state: 'healthy', reason: 'polling-configured' });

    expect(verdictForOpenConnection({
      mode: 'auto',
      idle: { supported: true, reason: 'advertised' },
    })).toMatchObject({ state: 'healthy', reason: 'idle-push' });

    expect(verdictForOpenConnection({
      mode: 'auto',
      idle: { supported: false, reason: 'not-advertised' },
    })).toMatchObject({ state: 'degraded', reason: 'polling-no-idle' });

    expect(verdictForOpenConnection({
      mode: 'auto',
      idle: { supported: false, reason: 'server-would-not-say' },
    })).toMatchObject({ state: 'degraded', reason: 'polling-capability-unknown' });
  });

  test('the batch size cannot be configured above what one FETCH accepts', () => {
    // `fetchEnvelopes` REFUSES an over-long batch rather than trimming it, so
    // a batch size above the ceiling would not fetch fewer messages — it would
    // fetch none, on every pass, and the delta would never drain.
    expect(resolveWatcherSettings({
      account: 'a', mailbox: 'INBOX', deltaBatchSize: 5_000,
    }).deltaBatchSize).toBe(IMAP_MAX_FETCH_UIDS);
    expect(resolveWatcherSettings({
      account: 'a', mailbox: 'INBOX',
    }).deltaBatchSize).toBe(50);
  });
});

describe('state transitions', () => {
  test('the same condition observed twice is announced once', () => {
    const observer = new RecordingObserver();
    const tracker = new CapabilityStateTracker({
      account: 'primary', mailbox: 'INBOX', clock: new FakeClock(), observer,
    });

    expect(tracker.record(capabilityVerdict('credentials-rejected', 'refused at 10:00'))).toBe(true);
    expect(tracker.record(capabilityVerdict('credentials-rejected', 'refused at 11:00'))).toBe(false);
    expect(tracker.record(capabilityVerdict('credentials-rejected', 'refused at 12:00'))).toBe(false);
    expect(observer.transitions.length).toBe(1);
    expect(tracker.transitionCount).toBe(1);
    // The wording still updates, so status shows what the server LAST said.
    expect(tracker.current?.detail).toBe('refused at 12:00');

    expect(tracker.record(capabilityVerdict('idle-push', 'connected'))).toBe(true);
    expect(observer.states).toEqual(['insufficient:credentials-rejected', 'healthy:idle-push']);
  });

  test('an observer that throws does not take the watcher with it', () => {
    const tracker = new CapabilityStateTracker({
      account: 'primary',
      mailbox: 'INBOX',
      clock: new FakeClock(),
      observer: { stateChanged: () => { throw new Error('the notice route is down'); } },
    });
    expect(() => tracker.record(capabilityVerdict('idle-push', ''))).not.toThrow();
    expect(tracker.current?.reason).toBe('idle-push');
  });
});

describe('protocol details', () => {
  test('only lines worth waking for are wake lines', () => {
    expect(isIdleWakeLine('* 12 EXISTS')).toBe(true);
    expect(isIdleWakeLine('* 1 RECENT')).toBe(true);
    expect(isIdleWakeLine('* 0 RECENT')).toBe(false);
    expect(isIdleWakeLine('* 4 EXPUNGE')).toBe(true);
    expect(isIdleWakeLine('* VANISHED 101:103')).toBe(true);
    expect(isIdleWakeLine('* BYE Server shutting down')).toBe(true);
    expect(isIdleWakeLine('* OK Still here')).toBe(false);
    expect(isIdleWakeLine('* 3 FETCH (FLAGS (\\Seen))')).toBe(false);
  });

  test('IDLE is issued without retaining its own untagged lines', async () => {
    // An IDLE is outstanding for twenty-seven minutes. Every untagged line
    // that arrives in that window would otherwise be retained in the command's
    // own buffer for a reader that never comes — the IDLE completion is read
    // for its status, never for its lines — so a busy mailbox grows that
    // buffer for the whole round. The subscription is where those lines are
    // actually used, and it is unaffected.
    const sent: { text: string; options: unknown }[] = [];
    const wire: MailboxWire = {
      onUntagged: () => () => undefined,
      sendCommand: async (text, options) => {
        sent.push({ text, options });
        return 'A0009';
      },
      sendRawLine: async () => undefined,
      awaitContinuation: async () => undefined,
      awaitTag: async () => [],
      waitForUntagged: async () => '',
    };
    const abort = new AbortController();
    abort.abort();
    await runIdleRound({
      wire,
      clock: new FakeClock(),
      settings: resolveWatcherSettings({ account: 'a', mailbox: 'INBOX' }),
      signal: abort.signal,
      roundIndex: 0,
    });
    expect(sent).toEqual([{ text: 'IDLE', options: { retainUntagged: false } }]);
  });

  test('an inverted `n:*` range cannot redeliver the newest message', async () => {
    // RFC 3501 ranges are unordered pairs, so `UID SEARCH UID 105:*` on a
    // mailbox whose highest UID is 104 is the range 104:105 and matches 104 —
    // which the cursor says is already done. Trusting the server's answer here
    // redelivers the newest message on every single pass.
    const wire = stubWire(['* SEARCH 104', 'A0005 OK SEARCH completed']);
    const above = await searchAboveCursor(wire, 104, {
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(above).toEqual([]);
  });

  test('the search asks from exactly one above the cursor, in ascending order', async () => {
    const sent: string[] = [];
    const wire = stubWire(
      ['* SEARCH 107 105 106', 'A0005 OK SEARCH completed'],
      (text) => sent.push(text),
    );
    const above = await searchAboveCursor(wire, 104, {
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(sent).toEqual(['UID SEARCH UID 105:*']);
    expect(above).toEqual([105, 106, 107]);
  });

  test('the re-issue interval is capped strictly below RFC 2177’s advisory', () => {
    const settings = resolveWatcherSettings({
      account: 'primary',
      mailbox: 'INBOX',
      idleReissueMs: 45 * 60_000,
    });
    expect(settings.idleReissueMs).toBeLessThan(IDLE_REISSUE_ADVISORY_BOUND_MS);
    expect(resolveWatcherSettings({ account: 'a', mailbox: 'INBOX' }).idleReissueMs)
      .toBe(27 * 60_000);
  });
});

describe('the inbound path has no way to start work', () => {
  test('no file under platform/email/inbound references a spawn capability', () => {
    const banned = [
      'trySpawnAgent',
      'sessionBroker',
      'AgentManager',
      'queueSurfaceReplyFromBinding',
      'publishConversationFollowup',
      'SurfaceAdapterContext',
    ];
    const offences: string[] = [];
    for (const entry of readdirSync(INBOUND_DIR)) {
      if (!entry.endsWith('.ts')) continue;
      // Comments are stripped first: these files EXPLAIN that they are not
      // given a spawn capability, and naming the thing you do not have is not
      // having it. The assertion is about code.
      const source = stripComments(readFileSync(join(INBOUND_DIR, entry), 'utf8'));
      for (const name of banned) {
        if (source.includes(name)) offences.push(`${entry}: ${name}`);
      }
    }
    expect(offences).toEqual([]);
  });
});

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function stubWire(lines: readonly string[], onSend?: (text: string) => void): MailboxWire {
  return {
    onUntagged: () => () => undefined,
    sendCommand: async (text: string) => {
      onSend?.(text);
      return 'A0005';
    },
    sendRawLine: async () => undefined,
    awaitContinuation: async () => undefined,
    awaitTag: async () => [...lines],
    waitForUntagged: async () => '',
  };
}
