/**
 * channel-profiles/intake.ts
 *
 * The bridge channel intake calls when it turns an inbound message into a
 * session: it resolves WHO the sender is (a named principal, via the principal
 * registry) and WHICH profile the originating channel binds (model/permission
 * defaults, via the channel-profile registry), and packages both into the two
 * things the origination path needs — session metadata (attribution) and spawn
 * overrides (model/provider) plus the permission posture.
 *
 * These are pure functions over the two registries so intake adopts them with a
 * single call before submitMessage/trySpawnAgent, without the SharedSessionBroker
 * needing to know about principals or channel profiles.
 */
import type { PrincipalRegistry, PrincipalResolution } from '../principals/index.js';
import type { ChannelProfileRegistry } from './registry.js';
import type { ChannelPermissionMode, ChannelProfileDefaults } from './types.js';

/** Stable session-metadata keys the attribution stamps. */
export const ATTRIBUTED_PRINCIPAL_ID_KEY = 'attributedPrincipalId';
export const ATTRIBUTED_PRINCIPAL_NAME_KEY = 'attributedPrincipalName';
export const ATTRIBUTED_PRINCIPAL_KNOWN_KEY = 'attributedPrincipalKnown';

export interface InboundSender {
  /** The surface the message arrived on (e.g. 'slack') — used as the identity channel. */
  readonly surfaceKind: string;
  /** The sender's channel-specific id (a Slack user id, an address, a number). */
  readonly userId?: string | undefined;
  /** The channel/account within the surface, to scope the profile binding. */
  readonly channelId?: string | undefined;
}

/**
 * Resolve the sending principal for an inbound message and produce the session
 * metadata that attributes the originated session to it. An absent userId or an
 * unmapped identity attributes to the honest unknown principal (known:false) —
 * never a guess.
 */
export async function attributeInboundSession(
  principals: Pick<PrincipalRegistry, 'resolveByIdentity'>,
  sender: InboundSender,
): Promise<{ readonly metadata: Record<string, unknown>; readonly resolution: PrincipalResolution | null }> {
  const value = sender.userId?.trim();
  if (!value) {
    return {
      metadata: { [ATTRIBUTED_PRINCIPAL_KNOWN_KEY]: false },
      resolution: null,
    };
  }
  const resolution = await principals.resolveByIdentity({ channel: sender.surfaceKind, value });
  return {
    metadata: {
      [ATTRIBUTED_PRINCIPAL_ID_KEY]: resolution.principal.id,
      [ATTRIBUTED_PRINCIPAL_NAME_KEY]: resolution.principal.name,
      [ATTRIBUTED_PRINCIPAL_KNOWN_KEY]: resolution.known,
    },
    resolution,
  };
}

/** Resolve the profile the originating channel binds, or null when none applies. */
export async function resolveOriginationProfile(
  channelProfiles: Pick<ChannelProfileRegistry, 'resolve'>,
  sender: Pick<InboundSender, 'surfaceKind' | 'channelId'>,
): Promise<ChannelProfileDefaults | null> {
  return channelProfiles.resolve(sender.surfaceKind, sender.channelId);
}

/**
 * Merge a channel profile's model/provider into a spawn input WITHOUT overriding
 * values the caller already set explicitly — a channel default fills a gap, it
 * never overrules an intent the intake path expressed. Returns a new object.
 */
export function applyChannelProfileToSpawn<T extends { model?: string; provider?: string }>(
  spawnInput: T,
  defaults: ChannelProfileDefaults | null | undefined,
): T {
  if (!defaults) return spawnInput;
  return {
    ...spawnInput,
    ...(spawnInput.model === undefined && defaults.model !== undefined ? { model: defaults.model } : {}),
    ...(spawnInput.provider === undefined && defaults.provider !== undefined ? { provider: defaults.provider } : {}),
  };
}

/** The complete enrichment for one inbound message: attribution + profile + posture. */
export interface InboundIntakeEnrichment {
  readonly sessionMetadata: Record<string, unknown>;
  readonly spawnOverrides: { readonly model?: string; readonly provider?: string };
  readonly permissionMode?: ChannelPermissionMode | undefined;
  readonly principal: PrincipalResolution | null;
}

/**
 * One call intake makes to enrich an origination: resolves the sending principal
 * and the channel's bound profile, returning the session metadata to stamp, the
 * spawn model/provider overrides to apply, and the permission posture to set.
 */
export async function buildInboundIntakeEnrichment(
  deps: {
    readonly principals: Pick<PrincipalRegistry, 'resolveByIdentity'>;
    readonly channelProfiles: Pick<ChannelProfileRegistry, 'resolve'>;
  },
  sender: InboundSender,
): Promise<InboundIntakeEnrichment> {
  const [attribution, profile] = await Promise.all([
    attributeInboundSession(deps.principals, sender),
    resolveOriginationProfile(deps.channelProfiles, sender),
  ]);
  return {
    sessionMetadata: attribution.metadata,
    spawnOverrides: {
      ...(profile?.model !== undefined ? { model: profile.model } : {}),
      ...(profile?.provider !== undefined ? { provider: profile.provider } : {}),
    },
    ...(profile?.permissionMode !== undefined ? { permissionMode: profile.permissionMode } : {}),
    principal: attribution.resolution,
  };
}
