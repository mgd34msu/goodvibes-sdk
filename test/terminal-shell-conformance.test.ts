/**
 * terminal-shell-conformance.test.ts — the package's own regression gate for
 * @pellux/goodvibes-terminal-shell.
 *
 * Reproduces the exact 501 defect class the package exists to prevent: a
 * gateway descriptor registered without an attached handler. The conformance
 * helper (assertEveryDescriptorHasHandler / findMethodsMissingHandlers) is the
 * same one shipped to consumers so they can run it against their own
 * composition; here we exercise it two ways:
 *   1. against a hand-built fake catalog (documents the consumer contract), and
 *   2. against the real SDK GatewayMethodCatalog, before and after
 *      attachWsOnlyGatewayVerbHandlers, proving the ws-only verb family goes
 *      from handler-less (501) to invokable.
 */
import { describe, expect, test } from 'bun:test';
import {
  attachWsOnlyGatewayVerbHandlers,
  assertEveryDescriptorHasHandler,
  findMethodsMissingHandlers,
  type GatewayCatalogConformanceView,
  type GatewayVerbGroupDeps,
} from '@pellux/goodvibes-terminal-shell';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';

/** A minimal in-memory catalog matching the structural conformance view. */
function fakeCatalog(entries: ReadonlyArray<{ id: string; handled: boolean }>): GatewayCatalogConformanceView {
  const handled = new Set(entries.filter((e) => e.handled).map((e) => e.id));
  return {
    list: () => entries.map((e) => ({ id: e.id })),
    hasHandler: (id: string) => handled.has(id),
  };
}

/** Enough of GatewayVerbGroupDeps for registration to run; handlers are never invoked here. */
function fakeVerbGroupDeps(): GatewayVerbGroupDeps {
  const deps = {
    processRegistry: { query: () => ({ nodes: [], generatedAt: 0 }) },
    workspaceCheckpointManager: {},
    sessionBroker: {},
    secretsManager: {
      get: async () => null,
      set: async () => {},
    },
    approvalBroker: { subscribe: () => () => {} },
    shellPaths: {
      resolveUserPath: (...segments: string[]) => `/nonexistent-conformance-test/${segments.join('/')}`,
    },
  };
  return deps as unknown as GatewayVerbGroupDeps;
}

describe('conformance helper — consumer contract', () => {
  test('passes when every descriptor has a handler', () => {
    const catalog = fakeCatalog([
      { id: 'a.one', handled: true },
      { id: 'a.two', handled: true },
    ]);
    expect(findMethodsMissingHandlers(catalog)).toEqual([]);
    expect(() => assertEveryDescriptorHasHandler(catalog)).not.toThrow();
  });

  test('reports and throws on a descriptor with no handler (the 501 class)', () => {
    const catalog = fakeCatalog([
      { id: 'a.one', handled: true },
      { id: 'a.two', handled: false },
      { id: 'a.three', handled: false },
    ]);
    expect(findMethodsMissingHandlers(catalog)).toEqual(['a.three', 'a.two']);
    expect(() => assertEveryDescriptorHasHandler(catalog)).toThrow(/no attached handler/);
    // The thrown message names the offending ids so CI failure is actionable.
    expect(() => assertEveryDescriptorHasHandler(catalog)).toThrow(/a\.two/);
  });

  test('onlyIds scopes the check; ignoreIds carves out known gaps', () => {
    const catalog = fakeCatalog([
      { id: 'a.one', handled: true },
      { id: 'host.only', handled: false },
    ]);
    expect(findMethodsMissingHandlers(catalog, { onlyIds: ['a.one'] })).toEqual([]);
    expect(findMethodsMissingHandlers(catalog, { ignoreIds: ['host.only'] })).toEqual([]);
    expect(() => assertEveryDescriptorHasHandler(catalog, { onlyIds: ['a.one'] })).not.toThrow();
  });
});

describe('attachWsOnlyGatewayVerbHandlers — real SDK catalog', () => {
  test('ws-only verb family goes from handler-less to invokable', () => {
    // A fresh catalog carries the ws-only DESCRIPTORS but no handlers: exactly
    // the state that answered 501 in production.
    const before = new GatewayMethodCatalog();
    const missingBefore = new Set(findMethodsMissingHandlers(before));
    expect(missingBefore.has('fleet.snapshot')).toBe(true);
    expect(missingBefore.has('fleet.archived.list')).toBe(true);
    expect(missingBefore.has('sessions.search')).toBe(true);

    // Attaching the ws-only handler groups binds handlers onto those descriptors.
    const after = new GatewayMethodCatalog();
    attachWsOnlyGatewayVerbHandlers(after, fakeVerbGroupDeps());
    const missingAfter = new Set(findMethodsMissingHandlers(after));

    // Every id that gained a handler is a strict subset of what was missing,
    // and it includes the representative ws-only verbs from the incident.
    const nowHandled = [...missingBefore].filter((id) => !missingAfter.has(id));
    expect(nowHandled).toContain('fleet.snapshot');
    expect(nowHandled).toContain('fleet.archived.list');
    expect(nowHandled).toContain('sessions.search');

    // None of the ws-only family remains handler-less after attach.
    const wsOnlyRepresentatives = ['fleet.snapshot', 'fleet.list', 'fleet.archived.list', 'sessions.search'];
    expect(findMethodsMissingHandlers(after, { onlyIds: wsOnlyRepresentatives })).toEqual([]);
    expect(() =>
      assertEveryDescriptorHasHandler(after, { onlyIds: wsOnlyRepresentatives }),
    ).not.toThrow();

    // And the same scoped assert FAILS before attach — the gate catches the defect.
    expect(() =>
      assertEveryDescriptorHasHandler(before, { onlyIds: wsOnlyRepresentatives }),
    ).toThrow(/no attached handler/);
  });
});
