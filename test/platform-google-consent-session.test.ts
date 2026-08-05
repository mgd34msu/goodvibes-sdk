/**
 * Registering a client the owner pasted, and the consent that follows it.
 *
 * The gap these cover: the guided path ended by telling the owner to type
 * `/google client <id> <secret>`, because nothing in the platform could take
 * two pasted values and act on them. A string that hands over a chore is the
 * symptom; the missing capability was the cause. So the load-bearing tests
 * here are that the values register, that the consent link comes back in the
 * SAME answer rather than after a five-minute block, and that the secret never
 * appears in anything a person or a log could read.
 */

import { describe, expect, test } from 'bun:test';

import {
  beginGoogleConsent,
  clientIdTail,
  registerGoogleClient,
} from '../packages/sdk/src/platform/google/consent-session.ts';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS, OAUTH_SCOPES } from '../packages/sdk/src/platform/google/setup-plan.ts';
import type { GoogleConfigPort, GoogleSecretPort } from '../packages/sdk/src/platform/google/types.ts';
import type { LoopbackListener } from '../packages/sdk/src/platform/google/oauth-loopback.ts';

const CLIENT_ID = '918273645500-abcdefghijklmnop.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-thisIsTheSecretValue';

function configPort(values: Record<string, unknown> = {}): GoogleConfigPort & { readonly values: Record<string, unknown> } {
  const store = { ...values };
  return { values: store, get: (key) => store[key], set: (key, value) => { store[key] = value; } };
}

function secretPort(): GoogleSecretPort & { readonly values: Record<string, string> } {
  const store: Record<string, string> = {};
  return {
    values: store,
    get: async (key) => store[key] ?? null,
    set: async (key, value) => { store[key] = value; },
  };
}

/** A listener that hands back whatever the test says the person did. */
function fakeLoopback(outcome: { code?: string; error?: Error } = { code: 'auth-code-1' }) {
  let closes = 0;
  const factory = (): LoopbackListener => ({
    redirectUri: 'http://127.0.0.1:41234/',
    waitForCode: async () => {
      if (outcome.error) throw outcome.error;
      return { code: outcome.code ?? 'auth-code-1', state: 'state' };
    },
    close: () => { closes += 1; },
  });
  return { factory, closes: () => closes };
}

/** Google's token endpoint, answering from a fixture. */
function tokenFetch(payload: Record<string, unknown>, status = 200) {
  const calls: string[] = [];
  return {
    calls,
    port: {
      fetch: async (url: string, init: RequestInit): Promise<Response> => {
        calls.push(typeof init.body === 'string' ? init.body : '');
        void url;
        return new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  };
}

describe('registering a client the owner handed over', () => {
  test('the id goes to config and the secret to the encrypted store', async () => {
    const config = configPort();
    const secrets = secretPort();
    const result = await registerGoogleClient({ config, secrets }, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    expect(result.ok).toBe(true);
    expect(config.values[GOOGLE_CONFIG_KEYS.oauthClientId]).toBe(CLIENT_ID);
    expect(secrets.values[GOOGLE_SECRET_KEYS.oauthClientSecret]).toBe(CLIENT_SECRET);
  });

  test('the confirmation carries the id tail and never the secret', async () => {
    const result = await registerGoogleClient(
      { config: configPort(), secrets: secretPort() },
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Enough to recognise the right client, useless to anyone reading the
    // transcript afterwards.
    expect(result.clientIdTail).toBe(`...${CLIENT_ID.slice(-12)}`);
    expect(result.clientIdTail).not.toContain('918273645500');
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
  });

  test('a mistyped pair is refused here rather than at the consent screen', async () => {
    const secrets = secretPort();
    const result = await registerGoogleClient({ config: configPort(), secrets }, { clientId: '', clientSecret: '' });

    expect(result.ok).toBe(false);
    expect(Object.keys(secrets.values)).toEqual([]);
  });

  test('clientIdTail never returns more than it was given', () => {
    expect(clientIdTail('short')).toBe('short');
    expect(clientIdTail(CLIENT_ID).length).toBeLessThan(CLIENT_ID.length);
  });
});

describe('the consent link comes back in the same answer', () => {
  test('the URL is available synchronously, without waiting for the person', () => {
    const loopback = fakeLoopback();
    const session = beginGoogleConsent({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      config: configPort(),
      secrets: secretPort(),
      loopback: loopback.factory,
      fetchPort: tokenFetch({}).port,
      generateState: () => 'state',
    });

    // No await anywhere above. A turn that had to block for five minutes to
    // answer is a turn that looks broken.
    const url = new URL(session.consentUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    session.cancel();
  });

  test('it carries every scope, so one approval covers mail and calendar', () => {
    const loopback = fakeLoopback();
    const session = beginGoogleConsent({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      config: configPort(),
      secrets: secretPort(),
      loopback: loopback.factory,
      fetchPort: tokenFetch({}).port,
    });

    const requested = (new URL(session.consentUrl).searchParams.get('scope') ?? '').split(' ');
    for (const scope of OAUTH_SCOPES) expect(requested).toContain(scope);
    session.cancel();
  });

  test('it names the account to approve as, when something knows it', () => {
    const session = beginGoogleConsent({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      config: configPort(),
      secrets: secretPort(),
      loopback: fakeLoopback().factory,
      fetchPort: tokenFetch({}).port,
      loginHint: 'agent@example.com',
    });
    expect(new URL(session.consentUrl).searchParams.get('login_hint')).toBe('agent@example.com');
    session.cancel();
  });

  test('the consent URL never carries the client secret', () => {
    const session = beginGoogleConsent({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      config: configPort(),
      secrets: secretPort(),
      loopback: fakeLoopback().factory,
      fetchPort: tokenFetch({}).port,
    });
    expect(session.consentUrl).not.toContain(CLIENT_SECRET);
    session.cancel();
  });
});

describe('the consent finishes on its own', () => {
  test('approval stores the refresh token with nobody being told to run anything', async () => {
    const secrets = secretPort();
    const fetcher = tokenFetch({ access_token: 'at', refresh_token: 'rt-1', expires_in: 3600, scope: OAUTH_SCOPES.join(' '), token_type: 'Bearer' });
    const session = beginGoogleConsent({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      config: configPort(),
      secrets,
      loopback: fakeLoopback({ code: 'code-1' }).factory,
      fetchPort: fetcher.port,
    });

    const outcome = await session.completed;
    expect(outcome.ok).toBe(true);
    expect(secrets.values[GOOGLE_SECRET_KEYS.oauthRefreshToken]).toBe('rt-1');
  });

  test('a consent nobody completed resolves rather than rejecting', async () => {
    // An unawaited rejection would surface as a crash in whatever process the
    // session was started from, which is not what "the person got distracted"
    // should cost.
    const session = beginGoogleConsent({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      config: configPort(),
      secrets: secretPort(),
      loopback: fakeLoopback({ error: new Error('timed out') }).factory,
      fetchPort: tokenFetch({}).port,
    });

    const outcome = await session.completed;
    expect(outcome.ok).toBe(false);
    expect(outcome.problem ?? '').toContain('timed out');
  });

  test('a grant Google answers without a refresh token is reported, not stored as success', async () => {
    const secrets = secretPort();
    const session = beginGoogleConsent({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      config: configPort(),
      secrets,
      loopback: fakeLoopback().factory,
      fetchPort: tokenFetch({ access_token: 'at', expires_in: 3600, scope: '', token_type: 'Bearer' }).port,
    });

    const outcome = await session.completed;
    expect(outcome.ok).toBe(false);
    expect(Object.keys(secrets.values)).toEqual([]);
  });

  test('the port is released however the consent ended', async () => {
    const loopback = fakeLoopback({ error: new Error('nope') });
    const session = beginGoogleConsent({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      config: configPort(),
      secrets: secretPort(),
      loopback: loopback.factory,
      fetchPort: tokenFetch({}).port,
    });
    await session.completed;
    expect(loopback.closes()).toBe(1);

    // cancel() after completion must not double-close.
    session.cancel();
    expect(loopback.closes()).toBe(1);
  });

  test('no outcome string carries the secret or the token', async () => {
    const session = beginGoogleConsent({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      config: configPort(),
      secrets: secretPort(),
      loopback: fakeLoopback().factory,
      fetchPort: tokenFetch({ access_token: 'at', refresh_token: 'rt-secret', expires_in: 3600, scope: '', token_type: 'Bearer' }).port,
    });
    const outcome = await session.completed;
    const rendered = JSON.stringify(outcome);
    expect(rendered).not.toContain(CLIENT_SECRET);
    expect(rendered).not.toContain('rt-secret');
  });
});
