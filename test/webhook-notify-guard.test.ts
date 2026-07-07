/**
 *
 * WebhookNotifier test-isolation guard.
 *
 * WebhookNotifier posts real HTTP requests to configured webhook URLs (Slack/
 * Discord/ntfy/etc). Under an automated test run this must never actually
 * reach the network — same class of leak as desktop notifications, guarded
 * through the same shared isNotifySuppressed() check. Verifies:
 * - Suppressed by default under NODE_ENV=test (no real fetch attempted).
 * - Suppressed when GOODVIBES_SUPPRESS_NOTIFY is set, regardless of NODE_ENV.
 * - The `{ force: true }` constructor option opts a specific instance back in
 *   (for tests that exercise the real delivery layer itself — see
 *   ssrf-filter.test.ts, which relies on suppression NOT masking SSRF blocks).
 * - Normal runtime (NODE_ENV unset/production, no override) is unaffected.
 */

import { describe, expect, test, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import { WebhookNotifier } from '../packages/sdk/src/platform/integrations/webhooks.ts';
import * as fetchWithTimeout from '../packages/sdk/src/platform/utils/fetch-with-timeout.ts';

// A hostname that passes the SSRF trust-tier filter (public, non-private) so
// suppression — not the SSRF filter — is what's under test here.
const PUBLIC_URL = 'https://example.com/webhook';

describe('WebhookNotifier delivery suppression', () => {
  let origNodeEnv: string | undefined;
  let origOverride: string | undefined;
  let fetchSpy: Mock<typeof fetchWithTimeout.instrumentedFetch>;

  beforeEach(() => {
    origNodeEnv = process.env['NODE_ENV'];
    origOverride = process.env['GOODVIBES_SUPPRESS_NOTIFY'];
    delete process.env['GOODVIBES_SUPPRESS_NOTIFY'];
    fetchSpy = spyOn(fetchWithTimeout, 'instrumentedFetch').mockImplementation(
      async () => new Response('ok', { status: 200 }),
    ) as Mock<typeof fetchWithTimeout.instrumentedFetch>;
  });

  afterEach(() => {
    process.env['NODE_ENV'] = origNodeEnv;
    if (origOverride === undefined) {
      delete process.env['GOODVIBES_SUPPRESS_NOTIFY'];
    } else {
      process.env['GOODVIBES_SUPPRESS_NOTIFY'] = origOverride;
    }
    fetchSpy.mockRestore();
  });

  test('default test run: delivery is suppressed, no real fetch attempted', async () => {
    process.env['NODE_ENV'] = 'test';
    const notifier = new WebhookNotifier([PUBLIC_URL]);
    const result = await notifier.send('session cost $30.00 exceeded budget $1.00 · session test-ses');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results[0]?.error).toMatch(/suppressed under test/);
  });

  test('GOODVIBES_SUPPRESS_NOTIFY override suppresses even outside NODE_ENV=test', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['GOODVIBES_SUPPRESS_NOTIFY'] = '1';
    const notifier = new WebhookNotifier([PUBLIC_URL]);
    const result = await notifier.send('WRFC chain chain-abcdef cancelled');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.delivered).toBe(0);
  });

  test('force:true opts a specific instance back in under NODE_ENV=test', async () => {
    process.env['NODE_ENV'] = 'test';
    const notifier = new WebhookNotifier([PUBLIC_URL], { force: true });
    const result = await notifier.send('agent agent-12 failed: boom');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(1);
  });

  test('normal runtime (NODE_ENV unset) fires the real delivery path', async () => {
    delete process.env['NODE_ENV'];
    const notifier = new WebhookNotifier([PUBLIC_URL]);
    const result = await notifier.send('turn completed in 65s · session test-ses');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(1);
  });
});
