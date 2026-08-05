/**
 * Gateway and control-plane contracts shared by the daemon host and clients.
 */

import type { ArtifactAttachment } from '../artifacts/index.js';

export type ControlPlaneStreamingMode = 'sse' | 'websocket' | 'both';
export type ControlPlaneClientSurface =
  | 'tui'
  | 'web'
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'webhook'
  | 'homeassistant'
  | 'telegram'
  | 'google-chat'
  | 'signal'
  | 'whatsapp'
  | 'telephony'
  | 'imessage'
  | 'msteams'
  | 'bluebubbles'
  | 'mattermost'
  | 'matrix'
  | 'service';

/**
 * The kinds a control-plane STREAM is opened as.
 *
 * Identical to {@link ControlPlaneClientSurface} but for the last member: a
 * stream opened by the daemon itself declares `daemon`, which the gateway maps
 * onto the `service` surface when it records the client. The union is named
 * here because gateway.ts spelled all nineteen members out twice — once for the
 * stream options and once for the live-client record — and two copies of one
 * list is how a kind ends up accepted on one path and rejected on the other.
 */
export type ControlPlaneStreamClientKind =
  | Exclude<ControlPlaneClientSurface, 'service'>
  | 'daemon';

export interface ControlPlaneServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  baseUrl?: string | undefined;
  streamingMode: ControlPlaneStreamingMode;
  sessionTtlMs: number;
}

export interface ControlPlaneClientDescriptor {
  id: string;
  surface: ControlPlaneClientSurface;
  label: string;
  connectedAt: number;
  lastSeenAt: number;
  userId?: string | undefined;
}

export interface ControlPlaneEventSubscription {
  id: string;
  clientId: string;
  domains: string[];
  createdAt: number;
}

export interface ControlPlaneSurfaceMessage {
  id: string;
  surface: ControlPlaneClientSurface;
  createdAt: number;
  title: string;
  body: string;
  level?: 'info' | 'success' | 'warn' | 'error' | undefined;
  routeId?: string | undefined;
  surfaceId?: string | undefined;
  clientId?: string | undefined;
  attachments?: readonly ArtifactAttachment[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}
