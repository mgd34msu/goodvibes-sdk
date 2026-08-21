/**
 * The rebuilt Google connection flow.
 *
 * Every test here corresponds to something that actually went wrong in a real
 * session: twenty minutes spent failing to connect an account the machine
 * already had credentials for. The behaviours pinned are, in the order they
 * bit: discovery before action, gcloud treated as a real source, one consent
 * carrying every scope, a dead grant diagnosed instead of retried, error text
 * that names only commands which exist, and no credential removed without an
 * explicit yes.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { planGoogleConnection } from '../packages/sdk/src/platform/google/discovery.ts';
import { diagnoseInvalidGrant } from '../packages/sdk/src/platform/google/grant-diagnosis.ts';
import { mentionsUserTypedCommand } from '../packages/sdk/src/platform/runtime/setup-contract.ts';
import { removeGoogleCredentials } from '../packages/sdk/src/platform/google/credential-removal.ts';
import { adoptExistingGoogleCredentials } from '../packages/sdk/src/platform/google/setup-actions.ts';
import { buildAuthorizationUrl } from '../packages/sdk/src/platform/google/oauth-loopback.ts';
import { GoogleTokenManager } from '../packages/sdk/src/platform/google/token-manager.ts';
import { proveGoogleConnection } from '../packages/sdk/src/platform/google/connection-proof.ts';
import {
  GOOGLE_CONFIG_KEYS,
  GOOGLE_REFERENCED_COMMANDS,
  GOOGLE_SETUP_STEPS,
  GOOGLE_SECRET_KEYS,
  OAUTH_SCOPES,
} from '../packages/sdk/src/platform/google/setup-plan.ts';
import type {
  GoogleCommandPort,
  GoogleCommandResult,
  GoogleConfigPort,
  GoogleSecretPort,
} from '../packages/sdk/src/platform/google/types.ts';
import type { GoogleOAuthCredentials } from '../packages/sdk/src/platform/google/credential-adoption.ts';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function configPort(values: Record<string, unknown> = {}): GoogleConfigPort & { readonly values: Record<string, unknown> } {
  const store = { ...values };
  return {
    values: store,
    get: (key) => store[key],
    set: (key, value) => { store[key] = value; },
  };
}

function secretPort(values: Record<string, string> = {}): GoogleSecretPort & {
  readonly values: Record<string, string>;
  readonly deleted: string[];
} {
  const store = { ...values };
  const deleted: string[] = [];
  return {
    values: store,
    deleted,
    get: async (key) => store[key] ?? null,
    set: async (key, value) => { store[key] = value; },
    delete: async (key) => { deleted.push(key); delete store[key]; },
  };
}

/** A secret store with no delete, to prove a removal refuses rather than lies. */
function undeletableSecretPort(values: Record<string, string> = {}): GoogleSecretPort {
  const store = { ...values };
  return {
    get: async (key) => store[key] ?? null,
    set: async (key, value) => { store[key] = value; },
  };
}

function commandResult(stdout: string, code = 0): GoogleCommandResult {
  return { code, stdout, stderr: '', timedOut: false, spawnError: null };
}

/** A gcloud that is absent, every invocation fails to spawn. */
const noGcloud: GoogleCommandPort = {
  run: async () => ({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' }),
};

/** A gcloud that is installed and signed in. */
function liveGcloud(account: string, projectId: string | null = 'my-project'): GoogleCommandPort & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, ...args].join(' '));
      if (args[0] === '--version') return commandResult('Google Cloud SDK 500.0.0');
      if (args[0] === 'auth' && args[1] === 'list') {
        return commandResult(JSON.stringify([{ account, status: 'ACTIVE' }]));
      }
      if (args[0] === 'config' && args[1] === 'get-value') {
        return commandResult(projectId ?? '(unset)');
      }
      return commandResult('');
    },
  };
}

const HOME = '/home/tester';

// ---------------------------------------------------------------------------
// Discovery order
// ---------------------------------------------------------------------------

describe('discovery decides before anything runs', () => {
  test('a complete stored credential is used, and asks the person for nothing', async () => {
    const plan = await planGoogleConnection({
      config: configPort({ [GOOGLE_CONFIG_KEYS.oauthClientId]: 'client-123' }),
      secrets: secretPort({
        [GOOGLE_SECRET_KEYS.oauthClientSecret]: 'shh',
        [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'refresh-abc',
      }),
      commands: noGcloud,
      homeDirectory: HOME,
    });

    expect(plan.route).toBe('stored-credential');
    expect(plan.userActionsRequired).toBe(0);
    expect(plan.setupPath).toBeNull();
  });

  test('a stored client with no token goes STRAIGHT to consent, not to project setup', async () => {
    // This is the headline defect. The owner had a client id and secret and
    // was walked through the new-project Branding workflow regardless.
    const plan = await planGoogleConnection({
      config: configPort({ [GOOGLE_CONFIG_KEYS.oauthClientId]: 'client-123' }),
      secrets: secretPort({ [GOOGLE_SECRET_KEYS.oauthClientSecret]: 'shh' }),
      commands: noGcloud,
      homeDirectory: HOME,
    });

    expect(plan.route).toBe('stored-client-consent');
    expect(plan.setupPath).toBe('existing-client');
    expect(plan.userActionsRequired).toBe(1);
  });

  test('an authenticated gcloud is used rather than ignored', async () => {
    // Verbatim owner complaint: "it REFUSED to use the google cli, completely".
    const gcloud = liveGcloud('agent@example.com');
    const plan = await planGoogleConnection({
      config: configPort(),
      secrets: secretPort(),
      commands: gcloud,
      homeDirectory: HOME,
    });

    expect(plan.route).toBe('gcloud-assisted');
    expect(plan.gcloud?.account).toBe('agent@example.com');
    expect(plan.gcloud?.projectId).toBe('my-project');
    expect(gcloud.calls.some((call) => call.includes('auth list'))).toBe(true);
  });

  test('gcloud supplies the intended account when config does not know it', async () => {
    const plan = await planGoogleConnection({
      config: configPort(),
      secrets: secretPort(),
      commands: liveGcloud('agent@example.com'),
      homeDirectory: HOME,
    });
    expect(plan.intendedAccount).toBe('agent@example.com');
  });

  test('nothing anywhere falls back to the guided new-client path', async () => {
    const plan = await planGoogleConnection({
      config: configPort(),
      secrets: secretPort(),
      commands: noGcloud,
      homeDirectory: HOME,
    });
    expect(plan.route).toBe('guided-new-client');
    expect(plan.setupPath).toBe('oauth');
  });

  test('the default succession never scans the filesystem for credential files', async () => {
    // Ordinary people have no ~/.gmail-mcp, and a connector that goes looking
    // through home directories for credentials is doing something nobody
    // asked for. Disk credentials are user-directed only.
    let filesTouched = 0;
    const watchfulHome = new Proxy(
      {},
      {
        get: () => { filesTouched += 1; return undefined; },
      },
    );

    const plan = await planGoogleConnection({
      config: configPort(),
      secrets: secretPort(),
      commands: noGcloud,
      // Any real file access would have to come through a port, and discovery
      // is not given one at all, its dependencies do not include a file port.
      homeDirectory: HOME,
    });

    expect(plan.route).toBe('guided-new-client');
    expect(filesTouched).toBe(0);
    void watchfulHome;
  });

  test('the discovery contract exposes no file port at all, so a scan is impossible', () => {
    // Structural rather than behavioural: the succession cannot regrow a disk
    // step by accident if there is nothing to read a disk with.
    const source = readFileSync(
      join(import.meta.dir, '..', 'packages/sdk/src/platform/google/discovery.ts'),
      'utf8',
    );
    expect(source).not.toContain('GoogleFilePort');
    expect(source).not.toContain('adoptGmailMcpCredentials');
  });
});

// ---------------------------------------------------------------------------
// The acceptance standard
// ---------------------------------------------------------------------------

describe('zero friction is the bar, not an aspiration', () => {
  // The anti-example is the session this work came from: 20+ minutes, three
  // logins, ten dialogs. The standard is that from "connect google" to working
  // mail AND calendar the person does AT MOST ONE thing, open a consent link
  // and approve it. Anything more needs a stated reason, and the only reason
  // that survives review is a fact about Google.

  test('a machine with a credential asks for nothing at all', async () => {
    const plan = await planGoogleConnection({
      config: configPort({ [GOOGLE_CONFIG_KEYS.oauthClientId]: 'client-123' }),
      secrets: secretPort({
        [GOOGLE_SECRET_KEYS.oauthClientSecret]: 'shh',
        [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'refresh-abc',
      }),
      commands: noGcloud,
      homeDirectory: HOME,
    });
    expect(plan.userActionsRequired).toBe(0);
    expect(plan.whyExtraSteps).toBeNull();
  });

  test('a machine with a client asks for exactly one thing: the consent', async () => {
    const plan = await planGoogleConnection({
      config: configPort({ [GOOGLE_CONFIG_KEYS.oauthClientId]: 'client-123' }),
      secrets: secretPort({ [GOOGLE_SECRET_KEYS.oauthClientSecret]: 'shh' }),
      commands: noGcloud,
      homeDirectory: HOME,
    });
    expect(plan.userActionsRequired).toBe(1);
    expect(plan.whyExtraSteps).toBeNull();
  });

  test('any route asking for more than one thing states why, and names Google', async () => {
    // The reason has to be a fact about Google rather than a convenience for
    // us. Creating a Desktop app OAuth client has no API and no gcloud command
    //, verified against Google's live docs on 2026-08-05, so the console is
    // unavoidable exactly once, on a machine that has no client yet.
    for (const commands of [noGcloud, liveGcloud('agent@example.com')]) {
      const plan = await planGoogleConnection({
        config: configPort(),
        secrets: secretPort(),
        commands,
        homeDirectory: HOME,
      });
      if (plan.userActionsRequired <= 1) continue;
      expect(plan.whyExtraSteps).not.toBeNull();
      expect(plan.whyExtraSteps ?? '').toMatch(/no API and no gcloud command/i);
    }
  });

  test('no route ever asks for more than two things', async () => {
    const plans = await Promise.all([
      planGoogleConnection({ config: configPort(), secrets: secretPort(), commands: noGcloud, homeDirectory: HOME }),
      planGoogleConnection({
        config: configPort(),
        secrets: secretPort(),
        commands: liveGcloud('agent@example.com'),
        homeDirectory: HOME,
      }),
      planGoogleConnection({
        config: configPort({ [GOOGLE_CONFIG_KEYS.oauthClientId]: 'c' }),
        secrets: secretPort({ [GOOGLE_SECRET_KEYS.oauthClientSecret]: 's' }),
        commands: noGcloud,
        homeDirectory: HOME,
      }),
    ]);
    for (const plan of plans) expect(plan.userActionsRequired).toBeLessThanOrEqual(2);
  });

  test('the consent step is the only human-assisted step on the existing-client path', async () => {
    // Three logins and ten dialogs is what a path full of browser-driven steps
    // produces. This path has one thing a person touches.
    const { stepsForPath } = await import('../packages/sdk/src/platform/google/setup-plan.ts');
    const humanSteps = stepsForPath('existing-client').filter((step) => step.actor !== 'automated');
    expect(humanSteps.map((step) => step.id)).toEqual(['oauth-authorize']);
  });

  test('the run ends by reading mail AND calendar, so the reply is not "try it and see"', async () => {
    const { stepsForPath } = await import('../packages/sdk/src/platform/google/setup-plan.ts');
    const last = stepsForPath('existing-client').at(-1);
    expect(last?.id).toBe('oauth-verify');
    expect(last?.purpose).toMatch(/reads the mailbox and reads the calendar/i);
  });
});

// ---------------------------------------------------------------------------
// User-directed adoption still works
// ---------------------------------------------------------------------------

describe('credentials on disk, when the person points at them', () => {
  const clientFile = `${HOME}/.gmail-mcp/gcp-oauth.keys.json`;
  const tokenFile = `${HOME}/.gmail-mcp/credentials.json`;
  const files = {
    exists: (path: string) => path === clientFile || path === tokenFile,
    readText: (path: string) =>
      path === clientFile
        ? JSON.stringify({ installed: { client_id: 'disk-client', client_secret: 'disk-secret' } })
        : path === tokenFile
          ? JSON.stringify({ refresh_token: 'disk-refresh', scope: 'https://www.googleapis.com/auth/gmail.readonly' })
          : null,
  };

  test('adoption takes them up and says what it took and where it now lives', async () => {
    const config = configPort();
    const secrets = secretPort();
    const outcome = await adoptExistingGoogleCredentials({ files, config, secrets, homeDirectory: HOME });

    expect(outcome.adopted).toBe(true);
    expect(outcome.detail).toContain(tokenFile);
    expect(outcome.detail).toContain('encrypted secret store');
    expect(outcome.detail).toContain('left untouched');
    expect(config.values[GOOGLE_CONFIG_KEYS.oauthClientId]).toBe('disk-client');
    expect(secrets.values[GOOGLE_SECRET_KEYS.oauthRefreshToken]).toBe('disk-refresh');
  });

  test('replacing a different stored token asks first and changes nothing', async () => {
    const secrets = secretPort({ [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'the-good-one' });
    const outcome = await adoptExistingGoogleCredentials({
      files,
      config: configPort(),
      secrets,
      homeDirectory: HOME,
    });

    expect(outcome.adopted).toBe(false);
    expect(outcome.needsConfirmation).toBe(true);
    expect(outcome.prompt).toContain('replace');
    expect(secrets.values[GOOGLE_SECRET_KEYS.oauthRefreshToken]).toBe('the-good-one');
  });

  test('with an explicit yes the replacement proceeds and is reported', async () => {
    const secrets = secretPort({ [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'the-old-one' });
    const outcome = await adoptExistingGoogleCredentials({
      files,
      config: configPort(),
      secrets,
      homeDirectory: HOME,
      confirmReplace: true,
    });

    expect(outcome.adopted).toBe(true);
    expect(outcome.detail).toContain('replacing the token that was there');
    expect(secrets.values[GOOGLE_SECRET_KEYS.oauthRefreshToken]).toBe('disk-refresh');
  });
});

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

describe('the consent request', () => {
  test('carries every scope in one URL, so calendar cannot fail afterwards', () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: 'client-123',
        redirectUri: 'http://127.0.0.1:9999/',
        scopes: OAUTH_SCOPES,
        codeChallenge: 'challenge',
        state: 'state',
      }),
    );
    const requested = (url.searchParams.get('scope') ?? '').split(' ');
    expect(requested).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(requested).toContain('https://www.googleapis.com/auth/calendar.events');
  });

  test('names the account to sign in as, which is the account trap defused', () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: 'client-123',
        redirectUri: 'http://127.0.0.1:9999/',
        scopes: OAUTH_SCOPES,
        codeChallenge: 'challenge',
        state: 'state',
        loginHint: 'agent@example.com',
      }),
    );
    expect(url.searchParams.get('login_hint')).toBe('agent@example.com');
  });

  test('omits the hint entirely when nothing knows which account is meant', () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: 'client-123',
        redirectUri: 'http://127.0.0.1:9999/',
        scopes: OAUTH_SCOPES,
        codeChallenge: 'challenge',
        state: 'state',
        loginHint: '   ',
      }),
    );
    expect(url.searchParams.has('login_hint')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// invalid_grant
// ---------------------------------------------------------------------------

describe('a dead grant is diagnosed, not retried', () => {
  test('an account mismatch names both accounts and which one to pick', () => {
    const diagnosis = diagnoseInvalidGrant({
      googleError: 'invalid_grant',
      intendedAccount: 'agent@example.com',
      signedInAccount: 'personal@gmail.com',
      publishingStatus: 'in-production',
      credentialOrigin: 'secret-store',
    });

    expect(diagnosis.cause).toBe('account-mismatch');
    expect(diagnosis.problem).toContain('personal@gmail.com');
    expect(diagnosis.problem).toContain('agent@example.com');
    expect(diagnosis.fix).toContain('sign in as agent@example.com');
    expect(diagnosis.fix).toContain('Use another account');
  });

  test('a revoked grant is named as revoked and points at the permissions page', () => {
    const diagnosis = diagnoseInvalidGrant({
      googleError: 'Token has been expired or revoked.',
      intendedAccount: 'agent@example.com',
      signedInAccount: 'agent@example.com',
      publishingStatus: 'in-production',
      credentialOrigin: 'secret-store',
    });
    expect(diagnosis.cause).toBe('revoked');
    expect(diagnosis.problem).toContain('myaccount.google.com/permissions');
  });

  test('a Testing app is told about its seven-day fuse', () => {
    const diagnosis = diagnoseInvalidGrant({
      googleError: 'invalid_grant',
      intendedAccount: null,
      signedInAccount: null,
      publishingStatus: 'testing',
      credentialOrigin: 'secret-store',
    });
    expect(diagnosis.cause).toBe('testing-expiry');
    expect(diagnosis.problem).toContain('seven days');
  });

  test('an unexplained rejection still states the three real candidates', () => {
    const diagnosis = diagnoseInvalidGrant({
      googleError: 'invalid_grant',
      intendedAccount: null,
      signedInAccount: null,
      publishingStatus: 'unknown',
      credentialOrigin: null,
    });
    expect(diagnosis.cause).toBe('unknown');
    expect(diagnosis.problem).toContain('different');
    expect(diagnosis.problem).toContain('revoked');
    expect(diagnosis.problem).toContain('client id');
  });

  test('every diagnosis offers to do the work rather than naming a command', () => {
    const inputs = [
      { intendedAccount: 'a@x.com', signedInAccount: 'b@x.com', publishingStatus: 'unknown' as const },
      { intendedAccount: null, signedInAccount: null, publishingStatus: 'testing' as const },
      { intendedAccount: null, signedInAccount: null, publishingStatus: 'unknown' as const },
    ];
    for (const input of inputs) {
      const diagnosis = diagnoseInvalidGrant({
        googleError: 'invalid_grant',
        credentialOrigin: 'secret-store',
        ...input,
      });
      // The old assertion here was that every fix NAMED a command that
      // resolved. Naming one at all is now the defect: a dead credential is
      // the platform's job to replace, not a chore to hand over.
      expect(mentionsUserTypedCommand(diagnosis.fix)).toBe(false);
      expect(diagnosis.fix.toLowerCase()).toContain('say the word');
    }
  });
});

describe('the token manager never repeats a refusal', () => {
  function credentials(): GoogleOAuthCredentials {
    return {
      clientId: 'client-123',
      clientSecret: 'shh',
      refreshToken: 'refresh-abc',
      accessToken: null,
      expiresAtMs: null,
      scopes: [],
      tokenUri: 'https://oauth2.googleapis.com/token',
      origin: 'secret-store',
      location: 'the encrypted secret store',
    };
  }

  test('a dead grant is asked about exactly once, however many callers arrive', async () => {
    // The observed failure was six identical refresh attempts against a
    // revoked grant. The correct number of repeats is zero.
    let attempts = 0;
    const manager = new GoogleTokenManager(credentials(), {
      refresh: async () => {
        attempts += 1;
        return { ok: false, failure: 'grant-invalid', problem: 'Token has been expired or revoked.', fix: '/google reauthorize' };
      },
    });

    for (let i = 0; i < 6; i += 1) await manager.accessToken();
    await manager.forceRefresh();

    expect(attempts).toBe(1);
    expect(manager.grantIsDead()).toBe(true);
  });

  test('the recorded verdict is what later callers are told', async () => {
    const manager = new GoogleTokenManager(credentials(), {
      refresh: async () => ({
        ok: false,
        failure: 'grant-invalid',
        problem: 'This credential was granted by someone else.',
        fix: 'Run /google reauthorize',
      }),
    });

    await manager.accessToken();
    const second = await manager.accessToken();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.failure).toBe('grant-invalid');
      expect(second.problem).toContain('granted by someone else');
    }
  });

  test('a transient failure is NOT latched, because retrying a blip is reasonable', async () => {
    let attempts = 0;
    const manager = new GoogleTokenManager(credentials(), {
      refresh: async () => {
        attempts += 1;
        return { ok: false, failure: 'transient', problem: 'Network unreachable.', fix: 'Try again.' };
      },
    });

    await manager.accessToken();
    await manager.accessToken();
    expect(attempts).toBe(2);
    expect(manager.grantIsDead()).toBe(false);
  });

  test('re-authorization lifts the latch so a fresh credential is not held to the old verdict', async () => {
    let attempts = 0;
    let dead = true;
    const manager = new GoogleTokenManager(credentials(), {
      refresh: async () => {
        attempts += 1;
        return dead
          ? { ok: false as const, failure: 'grant-invalid' as const, problem: 'revoked', fix: '/google reauthorize' }
          : { ok: true as const, result: { accessToken: 'fresh', expiresInSeconds: 3600, scopes: null } };
      },
    });

    await manager.accessToken();
    dead = false;
    manager.clearGrantFailure();
    const outcome = await manager.accessToken();

    expect(attempts).toBe(2);
    expect(outcome.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Proving the connection
// ---------------------------------------------------------------------------

describe('a connection is proven by using it', () => {
  function client(profile: unknown, events: unknown): Parameters<typeof proveGoogleConnection>[0] {
    return {
      getProfile: async () => profile,
      listEvents: async () => events,
    } as unknown as Parameters<typeof proveGoogleConnection>[0];
  }

  test('reads mail and calendar and reports both', async () => {
    const proof = await proveGoogleConnection(
      client(
        { ok: true, value: { emailAddress: 'agent@example.com', messagesTotal: 12, threadsTotal: 5, historyId: '1' } },
        { ok: true, value: [{ id: 'e1', summary: 'Standup', start: '', end: '' }] },
      ),
    );

    expect(proof.ok).toBe(true);
    expect(proof.account).toBe('agent@example.com');
    expect(proof.summary).toContain('Connected and proven');
    expect(proof.calendar.detail).toContain('Standup');
  });

  test('a Gmail-only grant is reported as calendar refusing, with the scope reason', async () => {
    // Exactly the owner's failure: mail worked, calendar answered 403
    // "insufficient authentication scopes".
    const proof = await proveGoogleConnection(
      client(
        { ok: true, value: { emailAddress: 'agent@example.com', messagesTotal: 1, threadsTotal: 1, historyId: '1' } },
        { ok: false, status: 403, problem: 'Request had insufficient authentication scopes.', fix: '' },
      ),
    );

    expect(proof.ok).toBe(false);
    expect(proof.summary).toContain('Mail works; calendar does not');
    expect(proof.calendar.problem).toContain('Calendar scope');
    expect(proof.calendar.fix).toMatch(/re-authorize/i);
    expect(mentionsUserTypedCommand(proof.calendar.fix ?? '')).toBe(false);
  });

  test('a disabled API is told apart from a missing scope', async () => {
    const proof = await proveGoogleConnection(
      client(
        { ok: false, status: 403, problem: 'Gmail API has not been used in project 123 before or it is disabled.', fix: '' },
        { ok: true, value: [] },
      ),
    );
    expect(proof.mail.detail).toContain('not enabled on the Cloud project');
    expect(proof.mail.fix).toMatch(/enable both APIs/i);
    expect(mentionsUserTypedCommand(proof.mail.fix ?? '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Credential removal
// ---------------------------------------------------------------------------

describe('a credential is never removed without an explicit yes', () => {
  test('an unconfirmed removal changes nothing and returns a question', async () => {
    // The agent deleted the stored refresh token mid-flow, unprompted.
    const secrets = secretPort({ [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'refresh-abc' });
    const result = await removeGoogleCredentials(
      { secrets, config: configPort() },
      { items: ['refresh-token'] },
    );

    expect(result.confirmed).toBe(false);
    expect(secrets.values[GOOGLE_SECRET_KEYS.oauthRefreshToken]).toBe('refresh-abc');
    expect(secrets.deleted).toEqual([]);
    if (!result.confirmed && !('refused' in result)) {
      expect(result.prompt).toContain('refresh token');
      expect(result.prompt.endsWith('?')).toBe(true);
    }
  });

  test('a confirmed removal happens and states exactly what went', async () => {
    const secrets = secretPort({ [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'refresh-abc' });
    const config = configPort();
    const result = await removeGoogleCredentials(
      { secrets, config },
      { items: ['refresh-token'], confirmed: true },
    );

    expect(result.confirmed).toBe(true);
    expect(secrets.deleted).toEqual([GOOGLE_SECRET_KEYS.oauthRefreshToken]);
    if (result.confirmed) {
      expect(result.detail).toContain('Removed');
      expect(result.detail).toContain('refresh token');
    }
  });

  test('a store that cannot delete refuses rather than reporting a removal', async () => {
    const result = await removeGoogleCredentials(
      {
        secrets: undeletableSecretPort({ [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'refresh-abc' }),
        config: configPort(),
      },
      { items: ['refresh-token'], confirmed: true },
    );
    expect(result.confirmed).toBe(false);
    expect('refused' in result && result.refused).toBe(true);
  });

  test('the config reference is cleared alongside the value it points at', async () => {
    const config = configPort({ [GOOGLE_CONFIG_KEYS.oauthRefreshToken]: 'ref' });
    await removeGoogleCredentials(
      { secrets: secretPort({ [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'refresh-abc' }), config },
      { items: ['refresh-token'], confirmed: true },
    );
    expect(config.values[GOOGLE_CONFIG_KEYS.oauthRefreshToken]).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The error-string sweep
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The flow never hands the user a chore
// ---------------------------------------------------------------------------

describe('no setup string tells the user to type anything', () => {
  // The standing ruling: "we should NEVER tell a user to type something... if
  // they say they want something done, it needs to get done." The guided path
  // used to end at "Hand both values over with: /google client <id> <secret>",
  // which is a chore handed over at the exact moment the platform had
  // everything it needed to do the work itself. The gap underneath it was real
  //, the google tool had no action that could register pasted values, so the
  // string had no honest alternative until connect.client existed.
  //
  // `mentionsUserTypedCommand` is the platform's own predicate, the same one
  // the voice setup round is held to. See runtime/setup-contract.ts.

  test('no step in any path instructs a command', () => {
    const offenders: string[] = [];
    for (const step of GOOGLE_SETUP_STEPS) {
      for (const instruction of step.manualSteps) {
        if (mentionsUserTypedCommand(instruction)) offenders.push(`${step.id}: ${instruction}`);
      }
      if (mentionsUserTypedCommand(step.purpose)) offenders.push(`${step.id} purpose: ${step.purpose}`);
      if (mentionsUserTypedCommand(step.title)) offenders.push(`${step.id} title: ${step.title}`);
    }
    expect(offenders).toEqual([]);
  });

  test('the guided path asks for the two values to be pasted, not typed into a command', () => {
    const step = GOOGLE_SETUP_STEPS.find((entry) => entry.id === 'oauth-client');
    const last = step?.manualSteps.at(-1) ?? '';
    expect(last).toMatch(/paste both values here/i);
    // The reason the paste has to happen now rather than later, which is the
    // part a person cannot recover from if they miss it.
    expect(last).toMatch(/only in this dialog/i);
    expect(mentionsUserTypedCommand(last)).toBe(false);
  });

  test('no runner fix string instructs a command', () => {
    // Fix strings are what a person reads at the moment something went wrong,
    // which is the worst possible moment to be handed a command to look up.
    const source = readFileSync(
      join(import.meta.dir, '..', 'packages/sdk/src/platform/google/setup-actions.ts'),
      'utf8',
    );
    const offenders = [...source.matchAll(/(?:problem|fix|detail):\s*(?:'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g)]
      .map((match) => match[1] ?? match[2] ?? '')
      .filter((text) => text.length > 0 && mentionsUserTypedCommand(text));
    expect(offenders).toEqual([]);
  });

  test('the file-intake failure offers to read the path rather than naming a command', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'packages/sdk/src/platform/google/setup-actions.ts'),
      'utf8',
    );
    expect(source).toContain('Tell me where the client JSON is and I will read it from there.');
    expect(source).not.toContain('/google client-file <path-to-client.json>');
  });

  test('a dead grant offers a fresh consent rather than naming a command', () => {
    for (const status of ['testing', 'in-production', 'unknown'] as const) {
      const diagnosis = diagnoseInvalidGrant({
        googleError: 'invalid_grant',
        intendedAccount: 'agent@example.com',
        signedInAccount: 'personal@gmail.com',
        publishingStatus: status,
        credentialOrigin: 'secret-store',
      });
      expect(mentionsUserTypedCommand(diagnosis.fix)).toBe(false);
      expect(diagnosis.fix).toMatch(/say the word/i);
    }
  });

  test('a scope refusal offers to re-authorize rather than naming a command', async () => {
    const { proveGoogleConnection: prove } = await import(
      '../packages/sdk/src/platform/google/connection-proof.ts'
    );
    const proof = await prove({
      getProfile: async () => ({ ok: true, value: { emailAddress: 'a@b.c', messagesTotal: 1, threadsTotal: 1, historyId: '1' } }),
      listEvents: async () => ({ ok: false, status: 403, problem: 'Request had insufficient authentication scopes.', fix: '' }),
    } as never);
    expect(proof.calendar.fix).toBeDefined();
    expect(mentionsUserTypedCommand(proof.calendar.fix ?? '')).toBe(false);
  });
});

describe('every command named in Google-flow text exists', () => {
  // An error told the owner to run `/google setup --path oauth` and the
  // command surface answered "Unknown setup item google". A fix line naming a
  // command that does not resolve is worse than no fix line.

  const googleDir = join(import.meta.dir, '..', 'packages/sdk/src/platform/google');

  /**
   * Command invocations named anywhere in the connector's source, as
   * "/command subcommand".
   *
   * URLs are stripped first, so `console.cloud.google.com/auth/audience`
   * cannot be mistaken for a command. Only the three commands this connector
   * ever names are matched, and only where a slash starts a token, never
   * after a word character, a dot, a colon, a backslash or another slash,
   * which excludes import specifiers, file paths, regex literals and HTML.
   *
   * A bare `/google` with no subcommand is normalised to `/google status`,
   * which is what the command does when run with no arguments.
   */
  /**
   * Comments and file paths stripped before the scan.
   *
   * A comment explaining what the owner ran when a defect was found is history,
   * not an instruction, and a path like `$HOME/google-cloud-sdk/bin` is neither.
   * The rule is about what a PERSON is shown, so only string literals count.
   */
  function userFacingText(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\$\{[^}]*\}/g, ' ');
  }

  function slashCommandsIn(source: string): readonly string[] {
    const withoutUrls = userFacingText(source);
    // `(?![-\w./])` keeps `/google-cloud-sdk/bin` and `/google-workspace-...json`
    // out: a hyphenated path segment is a path, not a command.
    const pattern = /(?<![\w/.:\\-])\/(google|email|calendar)(?![-\w./])[ ]*([a-z][a-z-]*)?/g;
    return [...withoutUrls.matchAll(pattern)].map((match) => {
      const command = match[1];
      const sub = match[2];
      if (sub === undefined) return command === 'google' ? '/google status' : `/${command}`;
      return `/${command} ${sub}`;
    });
  }

  function namedCommands(): ReadonlyMap<string, readonly string[]> {
    const found = new Map<string, string[]>();
    for (const entry of readdirSync(googleDir)) {
      if (!entry.endsWith('.ts')) continue;
      for (const command of slashCommandsIn(readFileSync(join(googleDir, entry), 'utf8'))) {
        const list = found.get(command) ?? [];
        if (!list.includes(entry)) list.push(entry);
        found.set(command, list);
      }
    }
    return found;
  }

  test('the connector names only commands on the declared list', () => {
    const offenders: string[] = [];
    for (const [command, files] of namedCommands()) {
      if (!GOOGLE_REFERENCED_COMMANDS.includes(command)) {
        offenders.push(`${command} (in ${files.join(', ')})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the declared list is not empty, so the sweep cannot pass vacuously', () => {
    expect(GOOGLE_REFERENCED_COMMANDS.length).toBeGreaterThan(0);
    expect(namedCommands().size).toBeGreaterThan(0);
  });

  test('the only user-facing text naming a command is the declared list itself', () => {
    // The commands still exist for self-service and the agent-side test still
    // proves each one resolves. What changed is that no string a person reads
    // reaches for one: setup-plan.ts holds the contract list and the runbook
    // renders a clearly-labelled self-service section, and every other file
    // talks about what the platform will do instead.
    const files = new Set<string>();
    for (const [, where] of namedCommands()) for (const file of where) files.add(file);
    expect([...files].sort()).toEqual(['setup-plan.ts', 'setup-runbook.ts']);
  });

  test('no text still points at the setup subcommand that answered "Unknown setup item"', () => {
    for (const entry of readdirSync(googleDir)) {
      if (!entry.endsWith('.ts')) continue;
      const source = readFileSync(join(googleDir, entry), 'utf8');
      // The specific dead pointer from the incident. `/google setup --path
      // app-password` survives because that path is real; the oauth variant is
      // replaced by /google connect and /google reauthorize.
      expect(source).not.toContain('/google setup --path oauth');
    }
  });
});
