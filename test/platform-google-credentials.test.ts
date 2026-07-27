/**
 * Credential adoption, token refresh, and the boot-time check.
 *
 * The defect these guard against: working Gmail credentials sat in
 * `~/.gmail-mcp/` while the agent reported that email was not configured,
 * because nothing looked there. Adoption must find them, must never write to
 * them, and must never leak their values into anything displayable.
 */

import { describe, expect, test } from 'bun:test';
import {
  adoptGmailMcpCredentials,
  gmailMcpLayout,
  summarizeCredentials,
  type GoogleFilePort,
  type GoogleOAuthCredentials,
} from '../packages/sdk/src/platform/google/credential-adoption.ts';
import {
  checkGoogleCredentialsAtBoot,
  GoogleTokenManager,
  type GoogleRefreshOutcome,
} from '../packages/sdk/src/platform/google/token-manager.ts';

const SECRET_CLIENT_SECRET = 'GOCSPX-super-secret-value';
const SECRET_REFRESH_TOKEN = '1//0refresh-token-value';
const SECRET_ACCESS_TOKEN = 'ya29.access-token-value';

function filePortFrom(files: Readonly<Record<string, string>>): GoogleFilePort {
  return {
    exists: (path: string): boolean => Object.hasOwn(files, path),
    readText: (path: string): string | null => files[path] ?? null,
  };
}

const HOME = '/home/tester';

function gmailMcpFiles(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  const layout = gmailMcpLayout(HOME);
  return {
    [layout.clientFile]: JSON.stringify({
      installed: {
        client_id: 'client-id-value.apps.googleusercontent.com',
        project_id: 'a-project',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        client_secret: SECRET_CLIENT_SECRET,
        redirect_uris: ['http://localhost'],
      },
    }),
    [layout.tokenFiles[0] ?? '']: JSON.stringify({
      access_token: SECRET_ACCESS_TOKEN,
      refresh_token: SECRET_REFRESH_TOKEN,
      scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events',
      token_type: 'Bearer',
      expires_in: 3599,
    }),
    ...overrides,
  };
}

describe('adopting credentials from an existing gmail-mcp install', () => {
  test('it finds a complete credential set and records where it came from', () => {
    const adopted = adoptGmailMcpCredentials(filePortFrom(gmailMcpFiles()), HOME);
    expect(adopted).not.toBeNull();
    expect(adopted?.origin).toBe('gmail-mcp');
    expect(adopted?.refreshToken).toBe(SECRET_REFRESH_TOKEN);
    expect(adopted?.scopes).toContain('https://www.googleapis.com/auth/calendar.events');
  });

  test('it returns nothing when no gmail-mcp install is present', () => {
    expect(adoptGmailMcpCredentials(filePortFrom({}), HOME)).toBeNull();
  });

  test('it returns nothing when the client file exists but no token file does', () => {
    const layout = gmailMcpLayout(HOME);
    const files = gmailMcpFiles();
    delete files[layout.tokenFiles[0] ?? ''];
    expect(adoptGmailMcpCredentials(filePortFrom(files), HOME)).toBeNull();
  });

  test('it falls through to the second token file layout when the first is absent', () => {
    const layout = gmailMcpLayout(HOME);
    const files = gmailMcpFiles();
    delete files[layout.tokenFiles[0] ?? ''];
    files[layout.tokenFiles[1] ?? ''] = JSON.stringify({
      access_token: SECRET_ACCESS_TOKEN,
      refresh_token: SECRET_REFRESH_TOKEN,
      scope: 'https://www.googleapis.com/auth/gmail.send',
      expiry_date: 4102444800000,
    });
    const adopted = adoptGmailMcpCredentials(filePortFrom(files), HOME);
    expect(adopted?.refreshToken).toBe(SECRET_REFRESH_TOKEN);
    expect(adopted?.expiresAtMs).toBe(4102444800000);
  });

  test('a token file with no refresh token is not adoptable, because it cannot be renewed', () => {
    const layout = gmailMcpLayout(HOME);
    const files = gmailMcpFiles({
      [layout.tokenFiles[0] ?? '']: JSON.stringify({ access_token: SECRET_ACCESS_TOKEN }),
    });
    expect(adoptGmailMcpCredentials(filePortFrom(files), HOME)).toBeNull();
  });

  test('malformed JSON is treated as absent rather than throwing', () => {
    const layout = gmailMcpLayout(HOME);
    expect(
      adoptGmailMcpCredentials(filePortFrom({ [layout.clientFile]: '{ not json' }), HOME),
    ).toBeNull();
  });

  test('adoption never writes — the file port it is given exposes no write method', () => {
    // Enforced by construction: GoogleFilePort has only exists() and
    // readText(). The credentials belong to a tool that is still using them,
    // so rewriting or rotating them would break it.
    const port = filePortFrom(gmailMcpFiles());
    expect(Object.keys(port).sort()).toEqual(['exists', 'readText']);
  });
});

describe('summarising credentials for display', () => {
  test('the summary contains no secret value of any kind', () => {
    const adopted = adoptGmailMcpCredentials(filePortFrom(gmailMcpFiles()), HOME);
    expect(adopted).not.toBeNull();
    const serialized = JSON.stringify(summarizeCredentials(adopted, Date.now()));
    expect(serialized).not.toContain(SECRET_CLIENT_SECRET);
    expect(serialized).not.toContain(SECRET_REFRESH_TOKEN);
    expect(serialized).not.toContain(SECRET_ACCESS_TOKEN);
  });

  test('it reports which capabilities the granted scopes actually permit', () => {
    const adopted = adoptGmailMcpCredentials(filePortFrom(gmailMcpFiles()), HOME);
    const summary = summarizeCredentials(adopted, Date.now());
    expect(summary.canSendMail).toBe(true);
    expect(summary.canWriteCalendar).toBe(true);
    expect(summary.canReadMail).toBe(false);
  });

  test('it names where an adopted credential came from, so its origin is never a mystery', () => {
    const adopted = adoptGmailMcpCredentials(filePortFrom(gmailMcpFiles()), HOME);
    expect(summarizeCredentials(adopted, Date.now()).detail).toContain('gmail-mcp');
  });

  test('with no credentials it says so and names the command that fixes it', () => {
    const summary = summarizeCredentials(null, Date.now());
    expect(summary.found).toBe(false);
    expect(summary.detail).toContain('/google setup');
  });
});

function credentials(overrides: Partial<GoogleOAuthCredentials> = {}): GoogleOAuthCredentials {
  return {
    clientId: 'client-id',
    clientSecret: SECRET_CLIENT_SECRET,
    refreshToken: SECRET_REFRESH_TOKEN,
    accessToken: SECRET_ACCESS_TOKEN,
    expiresAtMs: null,
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    tokenUri: 'https://oauth2.googleapis.com/token',
    origin: 'secret-store',
    location: 'goodvibes.google.oauth.refreshToken',
    ...overrides,
  };
}

describe('keeping an access token usable', () => {
  test('a cached token that is still valid is reused without a refresh', async () => {
    let refreshes = 0;
    const manager = new GoogleTokenManager(
      credentials({ expiresAtMs: 10_000_000 }),
      {
        refresh: async (): Promise<GoogleRefreshOutcome> => {
          refreshes += 1;
          return { ok: true, result: { accessToken: 'new', expiresInSeconds: 3600, scopes: null } };
        },
        now: () => 1_000_000,
      },
    );

    const outcome = await manager.accessToken();
    expect(outcome.ok).toBe(true);
    expect(refreshes).toBe(0);
  });

  test('an unknown expiry causes a refresh rather than a gamble on a possibly-dead token', async () => {
    let refreshes = 0;
    const manager = new GoogleTokenManager(credentials({ expiresAtMs: null }), {
      refresh: async (): Promise<GoogleRefreshOutcome> => {
        refreshes += 1;
        return { ok: true, result: { accessToken: 'fresh', expiresInSeconds: 3600, scopes: null } };
      },
    });

    await manager.accessToken();
    expect(refreshes).toBe(1);
  });

  test('concurrent callers share a single refresh instead of each starting one', async () => {
    let refreshes = 0;
    const manager = new GoogleTokenManager(credentials({ expiresAtMs: null }), {
      refresh: async (): Promise<GoogleRefreshOutcome> => {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true, result: { accessToken: 'fresh', expiresInSeconds: 3600, scopes: null } };
      },
    });

    await Promise.all([manager.accessToken(), manager.accessToken(), manager.accessToken()]);
    expect(refreshes).toBe(1);
  });

  test('an adopted credential is never written back, because another tool owns the file', async () => {
    let persisted = 0;
    const manager = new GoogleTokenManager(
      credentials({ origin: 'gmail-mcp', expiresAtMs: null }),
      {
        refresh: async (): Promise<GoogleRefreshOutcome> => ({
          ok: true,
          result: { accessToken: 'fresh', expiresInSeconds: 3600, scopes: null },
        }),
        persist: async (): Promise<void> => {
          persisted += 1;
        },
      },
    );

    await manager.accessToken();
    expect(persisted).toBe(0);
  });

  test('a credential the agent owns is persisted after refresh so restarts reuse it', async () => {
    let persisted = 0;
    const manager = new GoogleTokenManager(credentials({ origin: 'secret-store', expiresAtMs: null }), {
      refresh: async (): Promise<GoogleRefreshOutcome> => ({
        ok: true,
        result: { accessToken: 'fresh', expiresInSeconds: 3600, scopes: null },
      }),
      persist: async (): Promise<void> => {
        persisted += 1;
      },
    });

    await manager.accessToken();
    expect(persisted).toBe(1);
  });

  test('a revoked grant is reported as needing re-authorization, not as a network blip', async () => {
    const manager = new GoogleTokenManager(credentials({ expiresAtMs: null }), {
      refresh: async (): Promise<GoogleRefreshOutcome> => ({
        ok: false,
        failure: 'grant-invalid',
        problem: 'the refresh token was revoked',
        fix: 'Re-authorize with: /google setup',
      }),
    });

    const outcome = await manager.accessToken();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.failure).toBe('grant-invalid');
  });
});

describe('the boot-time credential check', () => {
  test('it proves the credential works by refreshing, which reads and sends nothing', async () => {
    let refreshCalls = 0;
    const manager = new GoogleTokenManager(credentials(), {
      refresh: async (): Promise<GoogleRefreshOutcome> => {
        refreshCalls += 1;
        return { ok: true, result: { accessToken: 'fresh', expiresInSeconds: 3600, scopes: null } };
      },
    });

    const result = await checkGoogleCredentialsAtBoot(manager);
    expect(result.usable).toBe(true);
    expect(refreshCalls).toBe(1);
  });

  test('with no credentials at all it reports plainly rather than guessing', async () => {
    const result = await checkGoogleCredentialsAtBoot(null);
    expect(result.usable).toBe(false);
    expect(result.needsReauthorization).toBe(false);
    expect(result.detail).toContain('/google setup');
  });

  test('a revoked credential is flagged as needing re-authorization at boot', async () => {
    const manager = new GoogleTokenManager(credentials(), {
      refresh: async (): Promise<GoogleRefreshOutcome> => ({
        ok: false,
        failure: 'grant-invalid',
        problem: 'the grant was revoked',
        fix: 'Re-authorize.',
      }),
    });

    const result = await checkGoogleCredentialsAtBoot(manager);
    expect(result.usable).toBe(false);
    expect(result.needsReauthorization).toBe(true);
  });

  test('a network problem is not mistaken for a revoked credential', async () => {
    const manager = new GoogleTokenManager(credentials(), {
      refresh: async (): Promise<GoogleRefreshOutcome> => ({
        ok: false,
        failure: 'transient',
        problem: 'connection refused',
        fix: 'Check connectivity.',
      }),
    });

    const result = await checkGoogleCredentialsAtBoot(manager);
    expect(result.usable).toBe(false);
    expect(result.needsReauthorization).toBe(false);
  });

  test('the boot check never puts a token value in its displayable detail', async () => {
    const manager = new GoogleTokenManager(credentials(), {
      refresh: async (): Promise<GoogleRefreshOutcome> => ({
        ok: true,
        result: { accessToken: SECRET_ACCESS_TOKEN, expiresInSeconds: 3600, scopes: null },
      }),
    });

    const result = await checkGoogleCredentialsAtBoot(manager);
    expect(JSON.stringify(result)).not.toContain(SECRET_ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(SECRET_REFRESH_TOKEN);
  });
});
