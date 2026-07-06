/**
 * w4-a3-capability-route-reconcile.test.ts
 *
 * Capability-advertisement honesty: proves the SDK's
 * advertisement-vs-route reconcile (method-catalog-route-reconcile.ts)
 * against the REAL dispatch chain — dispatchDaemonApiRoutes from
 * @pellux/goodvibes-daemon-sdk, the same function DaemonHttpRouter delegates
 * to for every method-catalog family it doesn't special-case ahead of it —
 * with inert marker-returning handler stubs (no real service ever runs).
 *
 * Covers the brief's three SDK tests:
 *   1. the exact dogfood repro: email.inbox.list's route is unresolvable,
 *      and it is marked unavailable (invokable: false) rather than
 *      advertised live.
 *   2. the build/boot regression gate: no descriptor in the live catalog
 *      is advertised-but-undispatchable without also being marked
 *      unavailable. KNOWN_PRE_EXISTING_ROUTE_DEBT started as a grandfather
 *      list for calendar.* and channels.inbox/routing/drafts.* (distinct,
 *      out-of-ownership findings this reconcile surfaced incidentally) and
 *      has since been retired to empty: every one of those methods is now
 *      marked `invokable: false` at the source (method-catalog-calendar.ts,
 *      method-catalog-channels.ts), so the exact-set comparison below holds
 *      with no exceptions. A new, unmarked advertise-without-route method
 *      changes the observed violation set and fails this test.
 *   3. a genuinely-served method (control.auth.current) still reconciles
 *      as 'live' — the reconcile must not cry wolf on real routes.
 */

import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import {
  createDaemonSdkRouteProbe,
  findUnreconciledAdvertisements,
  reconcileCatalogRoutes,
  reconcileHttpDescriptor,
} from '../packages/sdk/src/platform/control-plane/method-catalog-route-reconcile.ts';

/**
 * Pre-existing advertise-without-route debt discovered incidentally while
 * building this route-reconcile gate (an audit finding): these methods had the identical defect
 * class as email.* (an http path with no router.ts dispatch chain serving
 * it, confirmed by grepping the full path across packages/sdk/src and
 * packages/daemon-sdk/src), but lived in other work items' files —
 * method-catalog-calendar.ts (calendar.*) and method-catalog-channels.ts
 * (channels.drafts.* / channels.inbox.list / channels.routing.*) — not
 * method-catalog-email.ts, which was this audit finding's exclusive ownership at the
 * time. Grandfathered explicitly (by id, not by category) so the gate
 * shipped green without hiding the debt or masking a future regression in
 * some OTHER method in those same files that wasn't already on this list.
 *
 * Retired to empty: every method above is now re-verified against the real
 * dispatch chain (still no route anywhere — channel-routes.ts defines no
 * inbox/routing/drafts handler, and there is no calendar-routes.ts at all)
 * and marked `invokable: false` at the source, so the gate now guards them
 * for real instead of grandfathering them. Re-add an entry only if a new,
 * genuinely pre-existing, out-of-ownership case shows up — shrink this
 * list, don't grow it.
 */
const KNOWN_PRE_EXISTING_ROUTE_DEBT: readonly string[] = [];

function liveCatalogDescriptors() {
  return new GatewayMethodCatalog().list();
}

describe('W4-A3 capability-advertisement honesty: route reconcile', () => {
  test('email.inbox.list reproduces the dogfood finding: no route, and it is marked unavailable', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors();
    const emailInboxList = descriptors.find((d) => d.id === 'email.inbox.list');
    expect(emailInboxList).toBeDefined();
    expect(emailInboxList!.http).toEqual({ method: 'GET', path: '/api/email/inbox' });

    const result = await reconcileHttpDescriptor(emailInboxList!, probe);
    expect(result.status).toBe('unavailable');

    // The ad itself must already say "don't call this" — not just the probe.
    expect(emailInboxList!.invokable).toBe(false);
  });

  test('all four email.* methods are unresolvable and all four are marked unavailable', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors().filter((d) => d.category === 'email');
    expect(descriptors).toHaveLength(4);

    for (const descriptor of descriptors) {
      const result = await reconcileHttpDescriptor(descriptor, probe);
      expect(result.status).toBe('unavailable');
      expect(descriptor.invokable).toBe(false);
    }
  });

  test('build/boot gate: no advertise-without-route method is unmarked, beyond known pre-existing debt', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors();
    const results = await reconcileCatalogRoutes(descriptors, probe);

    const violations = findUnreconciledAdvertisements(descriptors, results).sort();
    const expected = [...KNOWN_PRE_EXISTING_ROUTE_DEBT].sort();

    // Exact-set comparison (not "is empty" / not "is a subset"): a NEW
    // regression — some other method later advertising a dead route without
    // invokable:false — changes this set and fails the test loudly, which is
    // the whole point of the gate. Shrinking the set (fixing calendar.*) is
    // expected to require updating KNOWN_PRE_EXISTING_ROUTE_DEBT above.
    expect(violations).toEqual(expected);
  });

  test('a genuinely-served method still reconciles as live (no false-unavailable)', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors();
    const controlAuthCurrent = descriptors.find((d) => d.id === 'control.auth.current');
    expect(controlAuthCurrent).toBeDefined();
    expect(controlAuthCurrent!.http).toEqual({ method: 'GET', path: '/api/control-plane/auth' });

    const result = await reconcileHttpDescriptor(controlAuthCurrent!, probe);
    expect(result.status).toBe('live');
  });

  test('a method with no http binding is left unchecked, not flagged', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors();
    // fleet.snapshot is handler-registered with no http binding at
    // catalog-construction time (registered later, at RuntimeServices
    // construction) — reconcile must not treat "no binding yet" as a
    // violation.
    const noHttpDescriptor = descriptors.find((d) => !d.http);
    expect(noHttpDescriptor).toBeDefined();
    const result = await reconcileHttpDescriptor(noHttpDescriptor!, probe);
    expect(result.status).toBe('unchecked');
  });

  test('a path served by a specialized sub-router is left unchecked, not falsely marked unavailable', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors();
    const mcpDescriptor = descriptors.find((d) => d.http?.path.startsWith('/api/mcp'));
    expect(mcpDescriptor).toBeDefined();
    const result = await reconcileHttpDescriptor(mcpDescriptor!, probe);
    expect(result.status).toBe('unchecked');
  });
});
