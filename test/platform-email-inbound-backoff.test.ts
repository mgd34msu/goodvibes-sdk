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
import { ImapOpenError } from '../packages/sdk/src/platform/email/imap-client.ts';
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
  isConnectionLimitRefusal,
  isIdleWakeLine,
  resolveIdleSupport,
  resolveWatcherSettings,
  searchAboveCursor,
  verdictForOpenConnection,
  type MailboxOpenReport,
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

  test('a connection-limit refusal is recognised in each provider’s own words', () => {
    expect(isConnectionLimitRefusal('NO [LIMIT] Too many simultaneous connections')).toBe(true);
    expect(isConnectionLimitRefusal(
      'NO Maximum number of connections from user+IP exceeded',
    )).toBe(true);
    expect(isConnectionLimitRefusal('NO [INUSE] Mailbox is locked')).toBe(true);
    expect(isConnectionLimitRefusal('NO [AUTHENTICATIONFAILED] Invalid credentials')).toBe(false);
  });
});

describe('capability verdicts', () => {
  function openFailure(
    reason: 'authentication-rejected' | 'mailbox-unavailable' | 'connection-failed',
    serverMessage: string,
  ): ImapOpenError {
    return new ImapOpenError({
      reason,
      summary: 'The mail server refused.',
      serverMessage,
      mailbox: 'INBOX',
    });
  }

  test('a refused credential is insufficient and terminal, with a fix', () => {
    const result = classifyOpenFailure(openFailure(
      'authentication-rejected',
      'IMAP command failed: A0002 NO [AUTHENTICATIONFAILED] Invalid credentials',
    ));
    expect(result.terminal).toBe(true);
    expect(result.verdict.state).toBe('insufficient');
    expect(result.verdict.reason).toBe('credentials-rejected');
    expect(result.verdict.fix.length).toBeGreaterThan(0);
  });

  test('a connection limit refused AT LOGIN is not read as a bad credential', () => {
    // The trap: a simultaneous-connection refusal arrives at LOGIN, and the
    // open path classifies anything refused at LOGIN as a rejected credential
    // — which is terminal. Believing that would stop the watcher permanently
    // on a condition that clears by itself in seconds.
    const result = classifyOpenFailure(openFailure(
      'authentication-rejected',
      'IMAP command failed: A0002 NO [LIMIT] Too many simultaneous connections',
    ));
    expect(result.terminal).toBe(false);
    expect(result.verdict.state).toBe('degraded');
    expect(result.verdict.reason).toBe('connection-limit');
    expect(result.verdict.detail).toContain('Too many simultaneous connections');
  });

  test('an unopenable mailbox is insufficient; a socket failure is a reconnect', () => {
    const mailbox = classifyOpenFailure(openFailure(
      'mailbox-unavailable',
      'IMAP command failed: A0003 NO Mailbox does not exist',
    ));
    expect(mailbox.terminal).toBe(true);
    expect(mailbox.verdict.reason).toBe('mailbox-unreadable');

    const socket = classifyOpenFailure(openFailure('connection-failed', 'ECONNRESET'));
    expect(socket.terminal).toBe(false);
    expect(socket.verdict.state).toBe('degraded');
    expect(socket.verdict.reason).toBe('reconnecting');

    const plain = classifyOpenFailure(new Error('connect ECONNREFUSED 127.0.0.1:993'));
    expect(plain.terminal).toBe(false);
    expect(plain.verdict.reason).toBe('reconnecting');
  });

  test('a refused FETCH is insufficient; a dropped socket is not', () => {
    const refused = classifyReadFailure(
      new Error('IMAP command failed: A0007 NO Server error fetching message data'),
    );
    expect(refused.terminal).toBe(true);
    expect(refused.verdict.reason).toBe('fetch-refused');
    expect(refused.verdict.state).toBe('insufficient');

    const dropped = classifyReadFailure(new Error('IMAP connection closed unexpectedly'));
    expect(dropped.terminal).toBe(false);
    expect(dropped.verdict.state).toBe('degraded');
    expect(dropped.verdict.reason).toBe('reconnecting');
  });
});

describe('resolving whether the server can push', () => {
  function reportWith(supportsIdle: boolean | null): MailboxOpenReport {
    return {
      advertisedCapabilities: supportsIdle === null ? [] : ['IMAP4REV1'],
      supportsIdle,
      mailbox: {
        name: 'INBOX', exists: 3, uidValidity: 42, uidNext: 104, readOnly: true,
      },
    };
  }
  function readerWith(atoms: readonly string[] | 'throws'): MailboxReader {
    return {
      capabilities: async () => {
        if (atoms === 'throws') throw new Error('IMAP read timeout');
        return atoms;
      },
      fetchEnvelopes: async () => [],
    };
  }

  test('an advertised answer is taken at face value, either way', async () => {
    expect(await resolveIdleSupport(reportWith(true), readerWith([])))
      .toEqual({ supported: true, resolvedBy: 'advertised' });
    expect(await resolveIdleSupport(reportWith(false), readerWith(['IDLE'])))
      .toEqual({ supported: false, resolvedBy: 'advertised' });
  });

  test('null means the server said NOTHING, so it is asked — not assumed to be no', async () => {
    const answered = await resolveIdleSupport(
      reportWith(null),
      readerWith(['IMAP4REV1', 'IDLE', 'UIDPLUS']),
    );
    expect(answered).toEqual({ supported: true, resolvedBy: 'capability-probe' });

    const denied = await resolveIdleSupport(
      reportWith(null),
      readerWith(['IMAP4REV1', 'UIDPLUS']),
    );
    expect(denied).toEqual({ supported: false, resolvedBy: 'capability-probe' });
  });

  test('a server that will not answer leaves the question unknown, not false', async () => {
    expect(await resolveIdleSupport(reportWith(null), readerWith('throws')))
      .toEqual({ supported: false, resolvedBy: 'unknown' });
    expect(await resolveIdleSupport(reportWith(null), readerWith([])))
      .toEqual({ supported: false, resolvedBy: 'unknown' });
  });

  test('the verdict distinguishes chosen polling from fallen-back polling', () => {
    expect(verdictForOpenConnection({
      mode: 'poll',
      idle: { supported: true, resolvedBy: 'advertised' },
    })).toMatchObject({ state: 'healthy', reason: 'polling-configured' });

    expect(verdictForOpenConnection({
      mode: 'auto',
      idle: { supported: true, resolvedBy: 'capability-probe' },
    })).toMatchObject({ state: 'healthy', reason: 'idle-push' });

    expect(verdictForOpenConnection({
      mode: 'auto',
      idle: { supported: false, resolvedBy: 'advertised' },
    })).toMatchObject({ state: 'degraded', reason: 'polling-no-idle' });

    expect(verdictForOpenConnection({
      mode: 'auto',
      idle: { supported: false, resolvedBy: 'unknown' },
    })).toMatchObject({ state: 'degraded', reason: 'polling-capability-unknown' });
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
