/**
 * D2 regression test: buildOperatorContract must use the catalog parameter.
 *
 * Root cause: buildOperatorContract contained `void catalog;` — it accepted
 * the catalog but immediately discarded it, always returning the static
 * pre-baked artifact regardless of what was registered. This meant
 * plugin-registered methods/events were never reflected in the contract,
 * and TUI tests had to loosen assertions from exact catalog counts to generic
 * non-empty checks.
 */
import { describe, expect, test } from 'bun:test';
import { buildOperatorContract } from '../packages/sdk/src/platform/control-plane/operator-contract.js';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.js';

// ---------------------------------------------------------------------------
// Helper: create a catalog with known counts
// ---------------------------------------------------------------------------

function makeMinimalCatalog(options: { methods: number; events: number }): GatewayMethodCatalog {
  // includeBuiltins: false — clean slate so we control the exact counts
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });

  for (let i = 0; i < options.methods; i++) {
    catalog.register({
      id: `test.method.${i}`,
      title: `Test Method ${i}`,
      description: `Synthetic method for testing`,
      category: 'test',
      source: 'plugin',
      access: 'authenticated',
      transport: ['http'],
      scopes: ['read'],
      pluginId: 'test-plugin',
    });
  }

  for (let i = 0; i < options.events; i++) {
    catalog.registerEvent({
      id: `test.event.${i}`,
      title: `Test Event ${i}`,
      description: `Synthetic event for testing`,
      category: 'test',
      source: 'plugin',
      transport: ['sse'],
      scopes: ['read:events'],
      pluginId: 'test-plugin',
    });
  }

  return catalog;
}

// ---------------------------------------------------------------------------
// Core invariant: contract.operator.methods/events reflect catalog
// ---------------------------------------------------------------------------

describe('buildOperatorContract uses catalog parameter', () => {
  test('contract.operator.methods has exactly N methods when catalog has N methods', () => {
    const N = 3;
    const catalog = makeMinimalCatalog({ methods: N, events: 0 });
    const contract = buildOperatorContract(catalog);
    expect(contract.operator.methods).toHaveLength(N);
  });

  test('contract.operator.events has exactly M events when catalog has M events', () => {
    const M = 5;
    const catalog = makeMinimalCatalog({ methods: 0, events: M });
    const contract = buildOperatorContract(catalog);
    expect(contract.operator.events).toHaveLength(M);
  });

  test('contract.operator.methods and events reflect independent counts simultaneously', () => {
    const N = 4;
    const M = 7;
    const catalog = makeMinimalCatalog({ methods: N, events: M });
    const contract = buildOperatorContract(catalog);
    expect(contract.operator.methods).toHaveLength(N);
    expect(contract.operator.events).toHaveLength(M);
  });

  test('different catalogs produce different method counts (non-static behavior)', () => {
    const catalogA = makeMinimalCatalog({ methods: 2, events: 0 });
    const catalogB = makeMinimalCatalog({ methods: 6, events: 0 });
    const contractA = buildOperatorContract(catalogA);
    const contractB = buildOperatorContract(catalogB);
    expect(contractA.operator.methods).toHaveLength(2);
    expect(contractB.operator.methods).toHaveLength(6);
    // The counts must differ — if both returned the static contract, they'd be equal
    expect(contractA.operator.methods.length).not.toBe(contractB.operator.methods.length);
  });

  test('empty catalog produces empty methods and events arrays', () => {
    const catalog = makeMinimalCatalog({ methods: 0, events: 0 });
    const contract = buildOperatorContract(catalog);
    expect(contract.operator.methods).toHaveLength(0);
    expect(contract.operator.events).toHaveLength(0);
  });

  test('schemaCoverage.methods matches catalog method count', () => {
    const N = 5;
    const catalog = makeMinimalCatalog({ methods: N, events: 0 });
    const contract = buildOperatorContract(catalog);
    expect(contract.operator.schemaCoverage.methods).toBe(N);
  });

  test('eventCoverage.events matches catalog event count', () => {
    const M = 3;
    const catalog = makeMinimalCatalog({ methods: 0, events: M });
    const contract = buildOperatorContract(catalog);
    expect(contract.operator.eventCoverage.events).toBe(M);
  });
});

// ---------------------------------------------------------------------------
// Static fields are preserved (product, auth, transports, peer)
// ---------------------------------------------------------------------------

describe('buildOperatorContract preserves static contract fields', () => {
  test('product.id is preserved from static contract', () => {
    const catalog = makeMinimalCatalog({ methods: 1, events: 1 });
    const contract = buildOperatorContract(catalog);
    expect(contract.product.id).toBe('goodvibes');
  });

  test('auth modes are preserved from static contract', () => {
    const catalog = makeMinimalCatalog({ methods: 0, events: 0 });
    const contract = buildOperatorContract(catalog);
    expect(contract.auth.modes).toEqual(['shared-bearer', 'session-login']);
  });

  test('version is set to current SDK VERSION string', () => {
    const catalog = makeMinimalCatalog({ methods: 0, events: 0 });
    const contract = buildOperatorContract(catalog);
    // Version must be a semver-like string set dynamically, not the old static value
    expect(typeof contract.product.version).toBe('string');
    expect(contract.product.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
