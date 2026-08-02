/**
 * SurfaceEvent — discriminated union covering configured client surfaces and their health.
 */

import { ROUTE_SURFACE_KINDS, type RouteSurfaceKind } from './routes.js';

/**
 * Transport surface kinds — the subset of surfaces that can bind an external
 * route (Slack, Discord, ntfy, …). Route-binding schemas validate against this
 * strict list; product surfaces (below) are intentionally excluded so they can
 * never accidentally become bindable routes.
 */
export const TRANSPORT_SURFACE_KINDS = ROUTE_SURFACE_KINDS;
export type TransportSurfaceKind = RouteSurfaceKind;

/**
 * Product surface kinds — first-party surfaces that participate in sessions as
 * identity participants but never bind an external route. `web` already exists
 * as a transport surface; `webui` is the distinct rich web client surface.
 */
export const PRODUCT_SURFACE_KINDS = ['agent', 'webui', 'companion', 'automation'] as const;
export type ProductSurfaceKind = (typeof PRODUCT_SURFACE_KINDS)[number];

/**
 * Canonical surface-kind vocabulary: transport surfaces ∪ product surfaces.
 * This is the single source of truth for the participant/message surface axis
 * (`SharedSessionParticipant.surfaceKind`). Unifies what used to be three
 * near-duplicate lists (ROUTE_SURFACE_KINDS, the old SURFACE_KINDS re-export,
 * and AutomationSurfaceKind).
 */
export const SURFACE_KINDS = [...ROUTE_SURFACE_KINDS, ...PRODUCT_SURFACE_KINDS] as const;

export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/**
 * The transport surfaces that are genuinely third-party messaging/notification
 * channels — a private chat app, a webhook, a bridge — as opposed to the two
 * first-party operator transports ('tui', 'web') or the internal
 * service-to-service surface ('service'). Filtered from `ROUTE_SURFACE_KINDS`
 * (never hand-duplicated) so a new channel adapter's surface kind is picked up
 * automatically.
 *
 * This is what session classification uses to tell "a channel adapter
 * originated this session" from "the operator's own TUI/web surface did" — see
 * `SharedSessionKind`'s 'channel' variant in control-plane/session-types.ts.
 */
const FIRST_PARTY_TRANSPORT_KINDS = new Set<RouteSurfaceKind>(['tui', 'web', 'service']);
export const CHANNEL_SURFACE_KINDS = ROUTE_SURFACE_KINDS.filter(
  (kind) => !FIRST_PARTY_TRANSPORT_KINDS.has(kind),
);
export type ChannelSurfaceKind = Exclude<RouteSurfaceKind, 'tui' | 'web' | 'service'>;

/** Whether a surface kind string is a third-party channel (see {@link CHANNEL_SURFACE_KINDS}). */
export function isChannelSurfaceKind(kind: string | undefined): kind is ChannelSurfaceKind {
  return kind !== undefined && (CHANNEL_SURFACE_KINDS as readonly string[]).includes(kind);
}

export type SurfaceEvent =
  | {
      type: 'SURFACE_ENABLED';
      surfaceKind: SurfaceKind;
      surfaceId: string;
      accountId: string;
    }
  | {
      type: 'SURFACE_DISABLED';
      surfaceKind: SurfaceKind;
      surfaceId: string;
      reason: string;
    }
  | {
      type: 'SURFACE_ACCOUNT_CONNECTED';
      surfaceKind: SurfaceKind;
      surfaceId: string;
      accountId: string;
      displayName: string;
    }
  | {
      type: 'SURFACE_ACCOUNT_DEGRADED';
      surfaceKind: SurfaceKind;
      surfaceId: string;
      accountId: string;
      error: string;
    }
  | {
      type: 'SURFACE_CAPABILITY_CHANGED';
      surfaceKind: SurfaceKind;
      surfaceId: string;
      capability: string;
      enabled: boolean;
    };

export type SurfaceEventType = SurfaceEvent['type'];
