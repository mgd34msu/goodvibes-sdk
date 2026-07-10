/**
 * marketplace-index.ts
 *
 * A static, self-hostable JSON index of capability bundles. The governance is
 * STRUCTURAL, not policy: an index entry that lacks a SHA-256 pin or a
 * capability summary cannot be represented — `PinnedMarketplaceIndexEntry`
 * makes `source.sha256` and `capabilities` required, and `parseMarketplaceIndex`
 * rejects any entry missing them. A registry built from this type therefore
 * cannot list an unpinned or capability-opaque bundle; there is no field to omit
 * that would let one through.
 *
 * This is the governed-registry position: a public index without mandatory
 * pinning + declared capabilities is on the do-not-build list, so the format
 * simply cannot express one.
 */

import type { PinnedBundleSource } from './bundle-pin.js';
import type { BundleCapabilitySummary } from './bundle-manifest.js';
import { summarizeBundleCapabilities, type CapabilityBundleManifest } from './bundle-manifest.js';

/** One bundle listed in a marketplace index. Pin + capabilities are required. */
export interface PinnedMarketplaceIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: CapabilityBundleManifest['kind'];
  readonly summary: string;
  /** The pinned source — `source.sha256` is required by the type. */
  readonly source: PinnedBundleSource;
  /** The bundle's declared capability summary — required, never omitted. */
  readonly capabilities: BundleCapabilitySummary;
  readonly author?: string | undefined;
}

/** The marketplace index document. `version` is fixed at 1. */
export interface PinnedMarketplaceIndex {
  readonly version: 1;
  readonly bundles: readonly PinnedMarketplaceIndexEntry[];
}

/** Result of validating an untrusted value as a marketplace index. */
export type MarketplaceIndexValidation =
  | { readonly ok: true; readonly index: PinnedMarketplaceIndex }
  | { readonly ok: false; readonly errors: readonly string[] };

const HEX64 = /^[0-9a-f]{64}$/;
const KINDS = ['plugin', 'skill', 'hook-pack', 'policy-pack'] as const;

function validateSource(raw: unknown, path: string, errors: string[]): raw is PinnedBundleSource {
  if (raw === null || typeof raw !== 'object') {
    errors.push(`${path}.source: required object`);
    return false;
  }
  const rec = raw as Record<string, unknown>;
  if (rec.kind !== 'file' && rec.kind !== 'url' && rec.kind !== 'git') {
    errors.push(`${path}.source.kind: must be 'file' | 'url' | 'git'`);
  }
  if (typeof rec.location !== 'string' || rec.location.length === 0) {
    errors.push(`${path}.source.location: required non-empty string`);
  }
  if (typeof rec.sha256 !== 'string' || !HEX64.test(rec.sha256.toLowerCase())) {
    errors.push(`${path}.source.sha256: required 64-char hex SHA-256 pin (unpinned entries are not representable)`);
  }
  if (rec.kind === 'git' && (typeof rec.ref !== 'string' || rec.ref.length === 0)) {
    errors.push(`${path}.source.ref: required for a git source`);
  }
  return errors.length === 0;
}

function validateCapabilities(raw: unknown, path: string, errors: string[]): void {
  if (raw === null || typeof raw !== 'object') {
    errors.push(`${path}.capabilities: required capability summary (capability-opaque entries are not representable)`);
    return;
  }
  const rec = raw as Record<string, unknown>;
  if (!Array.isArray(rec.runtime)) errors.push(`${path}.capabilities.runtime: required array`);
  for (const key of ['toolCount', 'hookCount', 'configDomainCount', 'channelCount'] as const) {
    if (typeof rec[key] !== 'number') errors.push(`${path}.capabilities.${key}: required number`);
  }
  if (typeof rec.highRisk !== 'boolean') errors.push(`${path}.capabilities.highRisk: required boolean`);
}

/**
 * Validate an untrusted value as a marketplace index. Every entry must carry a
 * pinned source and a capability summary; the first missing pin or summary makes
 * the whole document invalid (a partially-governed index is not accepted).
 */
export function parseMarketplaceIndex(value: unknown): MarketplaceIndexValidation {
  const errors: string[] = [];
  if (value === null || typeof value !== 'object') {
    return { ok: false, errors: ['index: must be an object'] };
  }
  const rec = value as Record<string, unknown>;
  if (rec.version !== 1) errors.push('version: must be the literal 1');
  if (!Array.isArray(rec.bundles)) {
    errors.push('bundles: required array');
    return { ok: false, errors };
  }
  rec.bundles.forEach((entry, i) => {
    const path = `bundles[${i}]`;
    if (entry === null || typeof entry !== 'object') {
      errors.push(`${path}: must be an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    for (const field of ['id', 'name', 'version', 'summary'] as const) {
      if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
        errors.push(`${path}.${field}: required non-empty string`);
      }
    }
    if (!(KINDS as ReadonlyArray<unknown>).includes(e.kind)) {
      errors.push(`${path}.kind: must be one of ${KINDS.join(' | ')}`);
    }
    validateSource(e.source, path, errors);
    validateCapabilities(e.capabilities, path, errors);
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, index: value as PinnedMarketplaceIndex };
}

/**
 * Build a governed index entry from a validated bundle manifest and a pinned
 * source. Because the capability summary is derived from the manifest, an entry
 * is always capability-complete by construction.
 */
export function buildMarketplaceIndexEntry(
  manifest: CapabilityBundleManifest,
  source: PinnedBundleSource,
): PinnedMarketplaceIndexEntry {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    summary: manifest.description,
    source,
    capabilities: summarizeBundleCapabilities(manifest),
    ...(manifest.author !== undefined ? { author: manifest.author } : {}),
  };
}

/** Serialize a marketplace index to canonical pretty JSON with a trailing newline. */
export function serializeMarketplaceIndex(index: PinnedMarketplaceIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}
