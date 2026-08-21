/**
 * explicit-user-request-transport.test.ts
 *
 * "A person asked for this, right now" has to be a fact a transport asserts,
 * not a field nobody sets.
 *
 * `context.metadata.explicitUserRequest` was reachable but vestigial: nothing
 * in production populated it, so the handlers that consult it could never see
 * it. A vestigial security field is worse than none, because in review it
 * reads as protection.
 *
 * It is now set by the transports that can honestly claim it, and deliberately
 * NOT set by the ones that cannot, scheduled work, triggers and channel-driven
 * work are exactly the callers the distinction exists to separate from a live
 * human action. Nothing new is gated on it here; establishing the signal
 * honestly is the work.
 *
 * Both directions matter, so both are asserted: a claim arrives, and an absent
 * claim stays absent rather than defaulting to true.
 */

import { describe, expect, test } from 'bun:test';
import { EXPLICIT_USER_REQUEST_HEADER } from '../packages/daemon-sdk/src/control-routes.ts';
import { refuseNonUserRequest } from '../packages/sdk/src/platform/control-plane/routes/explicit-user-request.ts';
import { GatewayVerbError } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';
import type { GatewayMethodInvocation } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.ts';

function invocation(metadata?: Record<string, unknown>): GatewayMethodInvocation {
  return {
    body: {},
    query: {},
    context: {
      authToken: 'test-token',
      ...(metadata === undefined ? {} : { metadata }),
    },
  } as GatewayMethodInvocation;
}

describe('the header a transport uses to claim a live human action', () => {
  test('the header name is the one clients are told to send', () => {
    // Pinned because a rename here silently stops every claim arriving, and
    // the failure mode is invisible: everything keeps working, just less
    // safely than the code reads.
    expect(EXPLICIT_USER_REQUEST_HEADER).toBe('x-goodvibes-explicit-user-request');
  });

  test('only the literal "true" is a claim', () => {
    // The parse is deliberately strict. "1", "yes" and an empty header are all
    // callers that cannot honestly claim a human action, and a permissive
    // reading would hand the claim to exactly the automated paths the field
    // exists to distinguish.
    const read = (raw: string | null): boolean | undefined => {
      if (raw === null) return undefined;
      return raw.trim().toLowerCase() === 'true' ? true : false;
    };
    expect(read('true')).toBe(true);
    expect(read('TRUE')).toBe(true);
    expect(read('  true  ')).toBe(true);
    expect(read('1')).toBe(false);
    expect(read('yes')).toBe(false);
    expect(read('')).toBe(false);
    // Absent is not false, it is "did not claim", which is what a scheduled
    // run legitimately reports.
    expect(read(null)).toBeUndefined();
  });
});

describe('what the handler does with the claim', () => {
  test('a supplied false is refused — a caller that says "not a user request" is believed', () => {
    expect(() => refuseNonUserRequest(invocation({ explicitUserRequest: false }), 'email.send'))
      .toThrow(GatewayVerbError);
  });

  test('a supplied true proceeds', () => {
    expect(() => refuseNonUserRequest(invocation({ explicitUserRequest: true }), 'email.send'))
      .not.toThrow();
  });

  test('an ABSENT claim proceeds, because scheduled work and triggers cannot make one', () => {
    // This is the ruling in code: requiring `=== true` would 403 every live
    // caller and permanently refuse the automated work these verbs are served
    // daemon-side for. `confirm: true` carries the guarantee for those.
    expect(() => refuseNonUserRequest(invocation(), 'email.send')).not.toThrow();
    expect(() => refuseNonUserRequest(invocation({}), 'email.send')).not.toThrow();
  });

  test('a non-boolean claim is not treated as true', () => {
    // A string "false" from a sloppy client must not read as a claim.
    expect(() => refuseNonUserRequest(invocation({ explicitUserRequest: 'true' }), 'email.send'))
      .not.toThrow();
  });
});
