/**
 * ecosystem-capability-bundle.test.ts
 *
 * Covers the capability-bundle format, SHA-256-pinned distribution, quarantine-
 * on-install, and the governed marketplace index (deliverable 1 of the
 * open-platform round).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateCapabilityBundleManifest,
  createBundleCapabilityGuard,
  enforceBundleCapability,
  BundleCapabilityViolation,
  summarizeBundleCapabilities,
  scaffoldCapabilityBundleManifest,
  type CapabilityBundleManifest,
} from '../packages/sdk/src/platform/runtime/ecosystem/bundle-manifest.js';
import { planBundleActivation } from '../packages/sdk/src/platform/runtime/ecosystem/bundle-install.js';
import {
  computeSha256,
  verifyBundleBytes,
  fetchAndVerifyBundle,
  BundlePinRefusal,
  type PinnedBundleSource,
} from '../packages/sdk/src/platform/runtime/ecosystem/bundle-pin.js';
import {
  parseMarketplaceIndex,
  buildMarketplaceIndexEntry,
  serializeMarketplaceIndex,
} from '../packages/sdk/src/platform/runtime/ecosystem/marketplace-index.js';

function validManifest(overrides: Partial<CapabilityBundleManifest> = {}): CapabilityBundleManifest {
  return {
    schemaVersion: 1,
    id: 'sample-bundle',
    name: 'Sample Bundle',
    version: '1.2.3',
    description: 'A sample bundle.',
    kind: 'plugin',
    capabilities: {
      runtime: ['register.tool', 'filesystem.read'],
      tools: ['sample.echo'],
      hooks: ['session:start'],
      configDomains: ['sample'],
      channels: ['tui'],
    },
    ...overrides,
  };
}

describe('capability-bundle manifest', () => {
  test('accepts a well-formed manifest', () => {
    const result = validateCapabilityBundleManifest(validManifest());
    expect(result.ok).toBe(true);
  });

  test('rejects an unknown runtime capability rather than dropping it', () => {
    const result = validateCapabilityBundleManifest(
      validManifest({ capabilities: { runtime: ['not.a.capability'] as never, tools: [], hooks: [], configDomains: [], channels: [] } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes('unknown capability'))).toBe(true);
  });

  test('rejects missing required fields and a bad kind', () => {
    const bad = validateCapabilityBundleManifest({ schemaVersion: 1, kind: 'nope' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.some((e) => e.startsWith('id:'))).toBe(true);
      expect(bad.errors.some((e) => e.startsWith('kind:'))).toBe(true);
    }
  });

  test('scaffold produces a valid manifest', () => {
    const scaffold = scaffoldCapabilityBundleManifest('fresh', 'skill');
    expect(validateCapabilityBundleManifest(scaffold).ok).toBe(true);
  });
});

describe('capability guard — deny by default', () => {
  const guard = createBundleCapabilityGuard(validManifest());

  test('allows declared surfaces', () => {
    expect(guard.mayRegisterTool('sample.echo')).toBe(true);
    expect(guard.maySubscribeHook('session:start')).toBe(true);
    expect(guard.mayReadConfigDomain('sample')).toBe(true);
    expect(guard.mayTouchChannel('tui')).toBe(true);
    expect(guard.mayUseCapability('register.tool')).toBe(true);
  });

  test('denies anything not declared', () => {
    expect(guard.mayRegisterTool('other.tool')).toBe(false);
    expect(guard.maySubscribeHook('turn:end')).toBe(false);
    expect(guard.mayTouchChannel('slack')).toBe(false);
    expect(guard.mayUseCapability('shell.exec')).toBe(false);
  });

  test('enforceBundleCapability throws on an undeclared action', () => {
    expect(() => enforceBundleCapability(guard, 'tool', 'sample.echo')).not.toThrow();
    expect(() => enforceBundleCapability(guard, 'channel', 'slack')).toThrow(BundleCapabilityViolation);
  });
});

describe('quarantine on install (planBundleActivation)', () => {
  const overreaching = validManifest({
    capabilities: { runtime: ['register.tool', 'shell.exec', 'network.outbound'], tools: [], hooks: [], configDomains: [], channels: [] },
  });

  test('untrusted tier withholds high-risk capabilities and quarantines', () => {
    const plan = planBundleActivation(overreaching, { trustTier: 'untrusted' });
    expect(plan.quarantine.required).toBe(true);
    expect(plan.quarantine.revokedCapabilities).toContain('shell.exec');
    expect(plan.quarantine.revokedCapabilities).toContain('network.outbound');
    // the granted guard cannot exercise the withheld capability even though declared
    expect(plan.guard.mayUseCapability('shell.exec')).toBe(false);
    expect(plan.guard.mayUseCapability('register.tool')).toBe(true);
  });

  test('trusted tier grants high-risk and does not quarantine', () => {
    const plan = planBundleActivation(overreaching, { trustTier: 'trusted' });
    expect(plan.quarantine.required).toBe(false);
    expect(plan.guard.mayUseCapability('shell.exec')).toBe(true);
  });
});

describe('SHA-256 pinned distribution', () => {
  const bytes = new TextEncoder().encode('bundle payload v1');
  const digest = computeSha256(bytes);

  test('verifyBundleBytes matches, mismatches, and rejects a missing pin', () => {
    expect(verifyBundleBytes(bytes, digest).ok).toBe(true);
    const mismatch = verifyBundleBytes(bytes, 'a'.repeat(64));
    expect(mismatch.ok).toBe(false);
    const missing = verifyBundleBytes(bytes, '');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('missing');
  });

  test('file source: happy path returns verified bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-pin-'));
    const path = join(dir, 'payload.bin');
    writeFileSync(path, bytes);
    const source: PinnedBundleSource = { kind: 'file', location: path, sha256: digest };
    const result = await fetchAndVerifyBundle(source);
    expect(result.sha256).toBe(digest);
  });

  test('mismatched pin is a hard refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-pin-'));
    const path = join(dir, 'payload.bin');
    writeFileSync(path, bytes);
    const source: PinnedBundleSource = { kind: 'file', location: path, sha256: 'b'.repeat(64) };
    await expect(fetchAndVerifyBundle(source)).rejects.toBeInstanceOf(BundlePinRefusal);
  });

  test('url source verifies via an injected fetch', async () => {
    const source: PinnedBundleSource = { kind: 'url', location: 'https://example.test/b.tar', sha256: digest };
    const fetchImpl = (async () => new Response(bytes)) as unknown as typeof fetch;
    const result = await fetchAndVerifyBundle(source, { fetchImpl });
    expect(result.sha256).toBe(digest);
  });

  test('git source verifies via an injected archive resolver', async () => {
    const source: PinnedBundleSource = { kind: 'git', location: 'git@host:repo.git', ref: 'v1.0.0', sha256: digest };
    const result = await fetchAndVerifyBundle(source, { gitArchive: () => bytes });
    expect(result.sha256).toBe(digest);
  });
});

describe('governed marketplace index', () => {
  const source: PinnedBundleSource = { kind: 'url', location: 'https://example.test/b.tar', sha256: 'c'.repeat(64) };
  const entry = buildMarketplaceIndexEntry(validManifest(), source);

  test('a built entry round-trips through parse', () => {
    const doc = serializeMarketplaceIndex({ version: 1, bundles: [entry] });
    const parsed = parseMarketplaceIndex(JSON.parse(doc));
    expect(parsed.ok).toBe(true);
  });

  test('an entry without a pin is rejected (unpinned not representable)', () => {
    const { source: _src, ...rest } = entry;
    const result = parseMarketplaceIndex({ version: 1, bundles: [{ ...rest, source: { kind: 'url', location: 'x' } }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes('sha256'))).toBe(true);
  });

  test('an entry without a capability summary is rejected', () => {
    const { capabilities: _caps, ...rest } = entry;
    const result = parseMarketplaceIndex({ version: 1, bundles: [rest] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes('capabilities'))).toBe(true);
  });

  test('summary flags high-risk declarations', () => {
    const s = summarizeBundleCapabilities(
      validManifest({ capabilities: { runtime: ['shell.exec'], tools: [], hooks: [], configDomains: [], channels: [] } }),
    );
    expect(s.highRisk).toBe(true);
  });
});
