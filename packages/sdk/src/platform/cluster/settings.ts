/**
 * settings.ts — turn a `cluster.*` config category into usable settings.
 *
 * Values are clamped rather than rejected. A daemon whose inbound messaging
 * refuses to start because someone typed `heartbeatSeconds: 0` is a worse
 * outcome than one that runs with a sane floor and says what it did.
 */
import type { ClusterSettings } from './types.js';

/**
 * Administratively-scoped multicast group (239.0.0.0/8, RFC 2365) — never
 * routed off the local network by a conforming router. The last two octets
 * are the ASCII codes for "GV", which keeps the address recognisable in a
 * packet capture without encoding anything about the install.
 */
export const DEFAULT_CLUSTER_MULTICAST_GROUP = '239.255.71.86';

/**
 * Chosen inside the IANA Dynamic/Private range (49152-65535), which IANA never
 * assigns, and ABOVE the Linux default ephemeral range (32768-60999) so a
 * transient outbound socket cannot take the port before the daemon binds it.
 */
export const DEFAULT_CLUSTER_PORT = 61860;

export const DEFAULT_CLUSTER_SETTINGS: ClusterSettings = {
  enabled: true,
  heartbeatSeconds: 30,
  masterTimeoutSeconds: 90,
  bootProbeSeconds: 3,
  port: DEFAULT_CLUSTER_PORT,
  multicastGroup: DEFAULT_CLUSTER_MULTICAST_GROUP,
  secret: '',
  peers: [],
};

function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberOf(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function stringOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/** Normalize a raw `cluster` config category into resolved settings. */
export function resolveClusterSettings(raw: unknown): ClusterSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_CLUSTER_SETTINGS;
  const source = raw as Record<string, unknown>;
  const heartbeatSeconds = numberOf(source['heartbeatSeconds'], 30, 1, 3_600);
  return {
    enabled: boolOf(source['enabled'], true),
    heartbeatSeconds,
    // A master timeout below two heartbeats would declare a healthy master
    // dead between its own beats.
    masterTimeoutSeconds: numberOf(
      source['masterTimeoutSeconds'],
      90,
      heartbeatSeconds * 2,
      86_400,
    ),
    bootProbeSeconds: numberOf(source['bootProbeSeconds'], 3, 1, 300),
    port: Math.trunc(numberOf(source['port'], DEFAULT_CLUSTER_PORT, 1, 65_535)),
    multicastGroup: stringOf(source['multicastGroup'], DEFAULT_CLUSTER_MULTICAST_GROUP),
    secret: typeof source['secret'] === 'string' ? source['secret'] : '',
    peers: Array.isArray(source['peers'])
      ? source['peers'].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [],
  };
}
