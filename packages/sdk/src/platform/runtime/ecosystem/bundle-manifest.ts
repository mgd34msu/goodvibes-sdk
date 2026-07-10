/**
 * bundle-manifest.ts
 *
 * The capability-bundle manifest format. A bundle is a distributable unit
 * (plugin/skill/hook-pack/policy-pack) that declares EXACTLY which capabilities
 * it needs, up front, so the runtime can grant it ONLY what it declared —
 * deny-by-default at the surface level, not just the security-capability level.
 *
 * This layers on the existing plugin capability model (`PluginCapability`,
 * `resolveCapabilityManifest`, `filterCapabilitiesByTrust`) in
 * `../plugins/`. The security capabilities (`filesystem.*`, `network.*`,
 * `shell.exec`, `register.*`) are reused verbatim; the bundle adds four
 * *surface* declarations the plugin model did not capture:
 *
 *   - `tools`        — gateway/agent tool ids the bundle registers
 *   - `hooks`        — runtime hook/event names the bundle subscribes to
 *   - `configDomains`— config domains the bundle reads
 *   - `channels`     — channel surfaces the bundle touches
 *
 * The enforcement contract (`createBundleCapabilityGuard`) is the load-bearing
 * piece: a bundle that tries to register a tool, subscribe a hook, read a config
 * domain, touch a channel, or exercise a security capability it did NOT declare
 * is refused. The declaration IS the grant; nothing outside it is reachable.
 */

import type { PluginCapability } from '../plugins/types.js';
import { ALL_CAPABILITIES } from '../plugins/types.js';

/** The four capability surfaces a bundle declares beyond security capabilities. */
export type BundleSurfaceKind = 'tool' | 'hook' | 'config-domain' | 'channel';

/**
 * The capability declaration block of a bundle manifest. Every field is a
 * closed list: the runtime grants the bundle these and nothing else.
 */
export interface BundleCapabilityDeclaration {
  /** Deny-by-default security capabilities (reused from the plugin model). */
  readonly runtime: readonly PluginCapability[];
  /** Gateway/agent tool ids this bundle registers. */
  readonly tools: readonly string[];
  /** Runtime hook / event names this bundle subscribes to. */
  readonly hooks: readonly string[];
  /** Config domains this bundle reads. */
  readonly configDomains: readonly string[];
  /** Channel surfaces this bundle touches. */
  readonly channels: readonly string[];
}

/**
 * A capability-bundle manifest. `schemaVersion` is fixed at 1 so a future
 * format change is a representable, checkable bump rather than a silent drift.
 */
export interface CapabilityBundleManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly kind: 'plugin' | 'skill' | 'hook-pack' | 'policy-pack';
  readonly capabilities: BundleCapabilityDeclaration;
  readonly author?: string | undefined;
  /** Minimum runtime version (semver). Advisory; the installer enforces fit. */
  readonly minRuntimeVersion?: string | undefined;
}

/** A concise, index-embeddable summary of what a bundle can do. */
export interface BundleCapabilitySummary {
  readonly runtime: readonly PluginCapability[];
  readonly toolCount: number;
  readonly hookCount: number;
  readonly configDomainCount: number;
  readonly channelCount: number;
  /** True when the bundle declares any high-risk security capability. */
  readonly highRisk: boolean;
}

const HIGH_RISK: ReadonlyArray<PluginCapability> = ['filesystem.write', 'network.outbound', 'shell.exec'];

const EMPTY_DECLARATION: BundleCapabilityDeclaration = {
  runtime: [],
  tools: [],
  hooks: [],
  configDomains: [],
  channels: [],
};

/** Result of validating an untrusted value as a capability-bundle manifest. */
export type BundleManifestValidation =
  | { readonly ok: true; readonly manifest: CapabilityBundleManifest }
  | { readonly ok: false; readonly errors: readonly string[] };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateDeclaration(raw: unknown, errors: string[]): BundleCapabilityDeclaration {
  if (raw === undefined || raw === null) {
    errors.push('capabilities: missing declaration block');
    return EMPTY_DECLARATION;
  }
  if (typeof raw !== 'object') {
    errors.push('capabilities: must be an object');
    return EMPTY_DECLARATION;
  }
  const rec = raw as Record<string, unknown>;
  const runtimeRaw = rec.runtime ?? [];
  const runtime: PluginCapability[] = [];
  if (!isStringArray(runtimeRaw)) {
    errors.push('capabilities.runtime: must be an array of capability strings');
  } else {
    for (const cap of runtimeRaw) {
      if ((ALL_CAPABILITIES as ReadonlyArray<string>).includes(cap)) {
        runtime.push(cap as PluginCapability);
      } else {
        errors.push(`capabilities.runtime: unknown capability '${cap}'`);
      }
    }
  }
  const list = (key: 'tools' | 'hooks' | 'configDomains' | 'channels'): readonly string[] => {
    const v = rec[key] ?? [];
    if (!isStringArray(v)) {
      errors.push(`capabilities.${key}: must be an array of strings`);
      return [];
    }
    return v;
  };
  return {
    runtime,
    tools: list('tools'),
    hooks: list('hooks'),
    configDomains: list('configDomains'),
    channels: list('channels'),
  };
}

/**
 * Validate an untrusted value as a capability-bundle manifest. Returns the typed
 * manifest on success or the full list of reasons it was rejected. Unknown
 * security capabilities are a hard error (not silently dropped) so a bundle
 * cannot smuggle a typo past review.
 */
export function validateCapabilityBundleManifest(value: unknown): BundleManifestValidation {
  const errors: string[] = [];
  if (value === null || typeof value !== 'object') {
    return { ok: false, errors: ['manifest: must be an object'] };
  }
  const rec = value as Record<string, unknown>;
  if (rec.schemaVersion !== 1) errors.push('schemaVersion: must be the literal 1');
  for (const field of ['id', 'name', 'version', 'description'] as const) {
    if (typeof rec[field] !== 'string' || (rec[field] as string).length === 0) {
      errors.push(`${field}: required non-empty string`);
    }
  }
  const kind = rec.kind;
  if (kind !== 'plugin' && kind !== 'skill' && kind !== 'hook-pack' && kind !== 'policy-pack') {
    errors.push("kind: must be one of 'plugin' | 'skill' | 'hook-pack' | 'policy-pack'");
  }
  if (rec.author !== undefined && typeof rec.author !== 'string') errors.push('author: must be a string');
  if (rec.minRuntimeVersion !== undefined && typeof rec.minRuntimeVersion !== 'string') {
    errors.push('minRuntimeVersion: must be a string');
  }
  const capabilities = validateDeclaration(rec.capabilities, errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      id: rec.id as string,
      name: rec.name as string,
      version: rec.version as string,
      description: rec.description as string,
      kind: kind as CapabilityBundleManifest['kind'],
      capabilities,
      ...(typeof rec.author === 'string' ? { author: rec.author } : {}),
      ...(typeof rec.minRuntimeVersion === 'string' ? { minRuntimeVersion: rec.minRuntimeVersion } : {}),
    },
  };
}

/** Summarize a bundle's declared capabilities for a marketplace index entry. */
export function summarizeBundleCapabilities(manifest: CapabilityBundleManifest): BundleCapabilitySummary {
  const { capabilities: c } = manifest;
  return {
    runtime: [...c.runtime],
    toolCount: c.tools.length,
    hookCount: c.hooks.length,
    configDomainCount: c.configDomains.length,
    channelCount: c.channels.length,
    highRisk: c.runtime.some((cap) => HIGH_RISK.includes(cap)),
  };
}

/**
 * A guard that answers "may this bundle do X?" for each capability surface.
 * Deny-by-default: anything not present in the declaration returns false.
 */
export interface BundleCapabilityGuard {
  readonly manifest: CapabilityBundleManifest;
  mayUseCapability(capability: PluginCapability): boolean;
  mayRegisterTool(toolId: string): boolean;
  maySubscribeHook(hookName: string): boolean;
  mayReadConfigDomain(domain: string): boolean;
  mayTouchChannel(surface: string): boolean;
}

/** Build a deny-by-default guard from a validated bundle manifest. */
export function createBundleCapabilityGuard(manifest: CapabilityBundleManifest): BundleCapabilityGuard {
  const runtime = new Set(manifest.capabilities.runtime);
  const tools = new Set(manifest.capabilities.tools);
  const hooks = new Set(manifest.capabilities.hooks);
  const configDomains = new Set(manifest.capabilities.configDomains);
  const channels = new Set(manifest.capabilities.channels);
  return {
    manifest,
    mayUseCapability: (capability) => runtime.has(capability),
    mayRegisterTool: (toolId) => tools.has(toolId),
    maySubscribeHook: (hookName) => hooks.has(hookName),
    mayReadConfigDomain: (domain) => configDomains.has(domain),
    mayTouchChannel: (surface) => channels.has(surface),
  };
}

/** Raised when a bundle exercises a capability it did not declare. */
export class BundleCapabilityViolation extends Error {
  constructor(
    readonly bundleId: string,
    readonly surface: BundleSurfaceKind | 'runtime',
    readonly capabilityName: string,
  ) {
    super(
      `Bundle '${bundleId}' attempted to use ${surface} '${capabilityName}' which it did not declare — ` +
        'a bundle receives only its declared capabilities.',
    );
    this.name = 'BundleCapabilityViolation';
  }
}

/**
 * Enforce a bundle action against its guard, throwing `BundleCapabilityViolation`
 * when the action was not declared. The single choke-point runtime registration
 * paths call before honoring a bundle's request.
 */
export function enforceBundleCapability(
  guard: BundleCapabilityGuard,
  surface: BundleSurfaceKind | 'runtime',
  name: string,
): void {
  const allowed =
    surface === 'runtime'
      ? guard.mayUseCapability(name as PluginCapability)
      : surface === 'tool'
        ? guard.mayRegisterTool(name)
        : surface === 'hook'
          ? guard.maySubscribeHook(name)
          : surface === 'config-domain'
            ? guard.mayReadConfigDomain(name)
            : guard.mayTouchChannel(name);
  if (!allowed) {
    throw new BundleCapabilityViolation(guard.manifest.id, surface, name);
  }
}

/** A blank capability-bundle manifest for `plugin-bundle init` scaffolding. */
export function scaffoldCapabilityBundleManifest(
  id: string,
  kind: CapabilityBundleManifest['kind'] = 'plugin',
): CapabilityBundleManifest {
  return {
    schemaVersion: 1,
    id,
    name: id,
    version: '0.1.0',
    description: `The ${id} ${kind}.`,
    kind,
    capabilities: { runtime: [], tools: [], hooks: [], configDomains: [], channels: [] },
  };
}
