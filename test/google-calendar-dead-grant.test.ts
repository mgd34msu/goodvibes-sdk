/**
 * A dead Google refresh grant surfaces as CALENDAR_AUTH_FAILED.
 *
 * The failure this pins: Google answers a token refresh with `invalid_grant`
 * when the refresh token is expired or revoked. The token manager records the
 * verdict as `grant-invalid`, and the calendar gateway must report it under
 * `CALENDAR_AUTH_FAILED` with a 401, the same status the CalDAV service uses
 * for an auth refusal, so the webui shows its calm re-authorize note. It used
 * to collapse into `CALENDAR_REQUEST_FAILED` with a 400 because the structured
 * verdict was dropped between the token manager and the gateway's code mapper.
 */

import { describe, expect, test } from 'bun:test';

import { createGoogleCalendarGatewayService } from '../packages/sdk/src/platform/google/gateway-calendar-service.ts';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '../packages/sdk/src/platform/google/setup-plan.ts';
import { isGatewayVerbError } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';
import type { GoogleConnectionSources } from '../packages/sdk/src/platform/google/connection.ts';

const TOKEN_ENDPOINT = 'oauth2.googleapis.com/token';

/** Sources holding a complete store-owned credential set. */
function storeSources(): GoogleConnectionSources {
  return {
    files: { exists: () => false, readText: () => null },
    homeDirectory: '/home/tester',
    configGet: (key: string) => (key === GOOGLE_CONFIG_KEYS.oauthClientId ? 'client-123' : undefined),
    secretGet: async (key: string) => {
      if (key === GOOGLE_SECRET_KEYS.oauthClientSecret) return 'client-secret';
      if (key === GOOGLE_SECRET_KEYS.oauthRefreshToken) return 'refresh-dead';
      return null;
    },
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('google calendar gateway, expired or revoked refresh token', () => {
  test('an invalid_grant refresh maps to CALENDAR_AUTH_FAILED with a 401', async () => {
    const fetchPort = {
      fetch: async (url: string): Promise<Response> => {
        if (url.includes(TOKEN_ENDPOINT)) {
          return jsonResponse(
            { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
            400,
          );
        }
        throw new Error(`unexpected request past a dead grant: ${url}`);
      },
    };
    const service = createGoogleCalendarGatewayService({ sources: storeSources(), fetch: fetchPort });

    const error = await captureError(() => service.listEvents({}));

    expect(isGatewayVerbError(error)).toBe(true);
    if (!isGatewayVerbError(error)) return;
    expect(error.code).toBe('CALENDAR_AUTH_FAILED');
    expect(error.status).toBe(401);
  });

  test('an ordinary 400 from the calendar API stays CALENDAR_REQUEST_FAILED', async () => {
    const fetchPort = {
      fetch: async (url: string): Promise<Response> => {
        if (url.includes(TOKEN_ENDPOINT)) {
          return jsonResponse({ access_token: 'live-token', expires_in: 3600, scope: '', token_type: 'Bearer' }, 200);
        }
        return jsonResponse({ error: { message: 'Invalid timeMin value.' } }, 400);
      },
    };
    const service = createGoogleCalendarGatewayService({ sources: storeSources(), fetch: fetchPort });

    const error = await captureError(() => service.listEvents({ from: 'not-a-date' }));

    expect(isGatewayVerbError(error)).toBe(true);
    if (!isGatewayVerbError(error)) return;
    expect(error.code).toBe('CALENDAR_REQUEST_FAILED');
    expect(error.status).toBe(400);
  });
});
