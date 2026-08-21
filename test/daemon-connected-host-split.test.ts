/**
 * daemon-connected-host-split.test.ts
 *
 * `daemon.enabled` used to answer two questions at once:
 *   1. does this surface ADOPT a session daemon of its own?
 *   2. may it DIAL a daemon it is already connected to?
 *
 * Answering "no" to the first silently answered "no" to the second. On a
 * machine configured that way with a LIVE connected host, the session-inputs
 * poll, the conversation-rewind host registration, the approvals update stream
 * and the hosted-conversation handoff all refused, while the session spine,
 * the memory spine and the operator tools dialed the same host without trouble,
 * because none of them read the flag.
 *
 * These tests pin the split: the two questions are two settings, the dial
 * setting does NOT inherit the adopt setting's value, and an existing settings
 * file gets the second answer written down where its owner can see it.
 */
import { describe, expect, test } from 'bun:test';
import { resolveConnectedHostDialEnabled, resolveDaemonEnabled } from '@pellux/goodvibes-sdk/platform/config';
import { migrateDaemonConnectedHostSplit } from '../packages/sdk/src/platform/config/migrations.ts';

/** A config reader over a flat key→value map, like ConfigManager.get. */
function readerFor(values: Record<string, unknown>): {
  get(key: 'daemon.enabled' | 'daemon.connectedHost.enabled'): boolean | string | number | undefined;
} {
  return {
    get: (key) => values[key] as boolean | string | number | undefined,
  };
}

describe('daemon adopt-vs-dial setting split', () => {
  test('dialing is on by default when nothing is configured', () => {
    expect(resolveConnectedHostDialEnabled(readerFor({}))).toBe(true);
  });

  test("the owner's configuration — daemon.enabled false, connected host live — still dials", () => {
    // The exact shape that produced the defect: adoption declined, nothing said
    // about dialing. Both resolvers must now answer their OWN question.
    const config = readerFor({ 'daemon.enabled': false });
    expect(resolveDaemonEnabled(config)).toBe(false);
    expect(resolveConnectedHostDialEnabled(config)).toBe(true);
  });

  test('the dial setting does not inherit daemon.enabled, at either value', () => {
    expect(resolveConnectedHostDialEnabled(readerFor({ 'daemon.enabled': false }))).toBe(true);
    expect(resolveConnectedHostDialEnabled(readerFor({ 'daemon.enabled': true }))).toBe(true);
  });

  test('an explicit refusal to dial is honored, and does not turn adoption off', () => {
    const config = readerFor({ 'daemon.connectedHost.enabled': false });
    expect(resolveConnectedHostDialEnabled(config)).toBe(false);
    expect(resolveDaemonEnabled(config)).toBe(true);
  });

  test('a non-boolean stored value falls back to on rather than to off', () => {
    // A corrupted or hand-edited value must not silently disable half the
    // product; the honest fallback is the documented default.
    expect(resolveConnectedHostDialEnabled(readerFor({ 'daemon.connectedHost.enabled': 'yes' }))).toBe(true);
    expect(resolveConnectedHostDialEnabled(readerFor({ 'daemon.connectedHost.enabled': undefined }))).toBe(true);
  });
});

describe('daemon connected-host split migration', () => {
  test("writes the dial answer into a file that declined adoption, leaving daemon.enabled alone", () => {
    const result = migrateDaemonConnectedHostSplit({ daemon: { enabled: false, timezone: 'UTC' } });
    expect(result.migrated).toBe(true);
    const daemon = result.config.daemon as { enabled: boolean; timezone: string; connectedHost: { enabled: boolean } };
    expect(daemon.connectedHost.enabled).toBe(true);
    // The user's own statement is preserved: this is a split, not a removal.
    expect(daemon.enabled).toBe(false);
    expect(daemon.timezone).toBe('UTC');
  });

  test('is idempotent — a second load changes nothing', () => {
    const once = migrateDaemonConnectedHostSplit({ daemon: { enabled: false } });
    const twice = migrateDaemonConnectedHostSplit(once.config);
    expect(twice.migrated).toBe(false);
    expect(twice.config).toEqual(once.config);
  });

  test('never overrides a stated refusal to dial', () => {
    const parsed = { daemon: { enabled: false, connectedHost: { enabled: false } } };
    const result = migrateDaemonConnectedHostSplit(parsed);
    expect(result.migrated).toBe(false);
    expect((result.config.daemon as { connectedHost: { enabled: boolean } }).connectedHost.enabled).toBe(false);
  });

  test('leaves alone a file that never declined adoption', () => {
    // These files were never affected by the conflation, so nothing is added.
    expect(migrateDaemonConnectedHostSplit({ daemon: { enabled: true } }).migrated).toBe(false);
    expect(migrateDaemonConnectedHostSplit({ daemon: { timezone: 'UTC' } }).migrated).toBe(false);
    expect(migrateDaemonConnectedHostSplit({}).migrated).toBe(false);
  });

  test('does not mutate the object it was handed', () => {
    const parsed = { daemon: { enabled: false } };
    migrateDaemonConnectedHostSplit(parsed);
    expect(parsed).toEqual({ daemon: { enabled: false } });
  });

  test('preserves other keys already under daemon.connectedHost', () => {
    const result = migrateDaemonConnectedHostSplit({
      daemon: { enabled: false, connectedHost: { label: 'workshop' } },
    });
    expect(result.migrated).toBe(true);
    expect(result.config.daemon).toEqual({
      enabled: false,
      connectedHost: { label: 'workshop', enabled: true },
    });
  });

  test('ignores a daemon section that is not an object', () => {
    expect(migrateDaemonConnectedHostSplit({ daemon: 'off' }).migrated).toBe(false);
    expect(migrateDaemonConnectedHostSplit({ daemon: null }).migrated).toBe(false);
    expect(migrateDaemonConnectedHostSplit({ daemon: [] }).migrated).toBe(false);
  });
});
