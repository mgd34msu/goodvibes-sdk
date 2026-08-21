/**
 * platform-google-unconfigured-machine.test.ts
 *
 * "Nothing is set up" is a normal state with a clear next step. It is not an
 * exception.
 *
 * `ConfigManager.resolvePath()` throws `Invalid config path` for a section that
 * does not exist, and every path this connector reads, `email.*`,
 * `calendar.google.*`, `google.*`, is app-layer rather than base schema. So on
 * a machine where nobody has run setup, the sections are simply absent and a
 * naive read throws on the FIRST key it touches. That turned a status command
 * into a crash, a capability probe into a crash, and a daemon route into a 500
 * where it should have said "not configured".
 *
 * The failure only appears on machines where the feature was never used, which
 * is exactly where nobody is looking, so it is pinned here rather than left to
 * a caller remembering to seed the sections first.
 */

import { describe, expect, test } from 'bun:test';
import { detectGoogleSetupState, describeGoogleSetupState } from '../packages/sdk/src/platform/google/setup-state.ts';
import { openGoogleConnection, describeGoogleConnection } from '../packages/sdk/src/platform/google/connection.ts';
import { safeConfigGet, safeConfigString } from '../packages/sdk/src/platform/google/config-access.ts';
import type { GoogleConfigPort, GoogleSecretPort } from '../packages/sdk/src/platform/google/types.ts';

/** A config manager on a machine where the mail and calendar sections do not exist. */
const throwingConfig: GoogleConfigPort = {
  get(key: string): unknown {
    throw new Error(`Invalid config path: ${key}`);
  },
  set(): void {
    throw new Error('not expected in this test');
  },
};

/** An empty secret store that answers rather than throwing. */
const emptySecrets: GoogleSecretPort = {
  get: async () => null,
  set: async () => undefined,
};

/** A secret store that is itself unreadable, the harsher case. */
const throwingSecrets: GoogleSecretPort = {
  get: async () => {
    throw new Error('secret store is locked');
  },
  set: async () => undefined,
};

const noFiles = { exists: (): boolean => false, readText: (): string | null => null };

const neverCalledFetch = {
  fetch: (): Promise<Response> => {
    throw new Error('no network call should be attempted with no credentials');
  },
};

describe('the read guard', () => {
  test('an unreachable config path reads as unset, not as a throw', () => {
    expect(safeConfigGet(throwingConfig, 'email.username')).toBeUndefined();
    expect(safeConfigString(throwingConfig, 'email.username')).toBeNull();
  });

  test('a present-but-blank value is also unset — a whitespace host is not a host', () => {
    const blank: GoogleConfigPort = { get: () => '   ', set: () => undefined };
    expect(safeConfigString(blank, 'email.imapHost')).toBeNull();
  });
});

describe('state detection on a machine where setup never ran', () => {
  test('reports nothing connected instead of raising Invalid config path', async () => {
    const state = await detectGoogleSetupState({ config: throwingConfig, secrets: emptySecrets });

    expect(state.hasAppPassword).toBe(false);
    expect(state.hasGmailConfig).toBe(false);
    expect(state.gmailEnabled).toBe(false);
    expect(state.gmailUsername).toBeNull();
    expect(state.hasCalendarAddress).toBe(false);
    expect(state.oauthClientId).toBeNull();
    expect(state.hasRefreshToken).toBe(false);
    expect(state.projectId).toBeNull();
    expect(state.publishingStatus).toBe('unknown');
  });

  test('an unreadable secret store is also reported, not thrown', async () => {
    const state = await detectGoogleSetupState({ config: throwingConfig, secrets: throwingSecrets });
    expect(state.hasAppPassword).toBe(false);
    expect(state.hasRefreshToken).toBe(false);
  });

  test('the description a person reads says what to do, and names no exception', async () => {
    const state = await detectGoogleSetupState({ config: throwingConfig, secrets: emptySecrets });
    const lines = describeGoogleSetupState(state);
    expect(lines.join('\n')).toContain('Gmail: not connected.');
    expect(lines.join('\n')).toContain('Calendar: not connected.');
    expect(lines.join('\n')).not.toContain('Invalid config path');
  });
});

describe('opening a connection on a machine where setup never ran', () => {
  const sources = {
    files: noFiles,
    homeDirectory: '/nonexistent-home-for-this-test',
    configGet: (key: string): unknown => {
      throw new Error(`Invalid config path: ${key}`);
    },
    secretGet: async (): Promise<string | null> => null,
  };

  test('returns null rather than throwing, so a caller can say "not connected"', async () => {
    await expect(openGoogleConnection(sources, { fetch: neverCalledFetch })).resolves.toBeNull();
  });

  test('the safe-to-display summary is a not-found summary, not an error', async () => {
    const summary = await describeGoogleConnection(sources, 0);
    expect(summary.found).toBe(false);
    expect(summary.origin).toBeNull();
    expect(summary.canSendMail).toBe(false);
    expect(summary.canReadCalendar).toBe(false);
    expect(summary.detail).not.toContain('Invalid config path');
  });
});
