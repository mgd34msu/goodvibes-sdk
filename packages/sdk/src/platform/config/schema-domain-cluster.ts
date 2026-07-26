/**
 * schema-domain-cluster.ts — the `cluster.*` config domain.
 *
 * These settings describe how the local network's goodvibes nodes agree on
 * which ONE of them consumes inbound channel messages. They never affect
 * outbound sends, sessions, the control plane, or HTTP — those run on every
 * node regardless of who holds the role.
 *
 * `cluster.peers` is an array, so like `conversationGate.gatedSurfaces` it is
 * not a scalar ConfigKey; it is read through `getCategory('cluster')` and
 * carried in DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS so ownership walks see it.
 */
import { intRange, port, type ConfigSettingDefinition } from './schema-shared.js';

/** LAN leader election (`cluster.*`). */
export interface ClusterConfig {
  enabled: boolean;
  heartbeatSeconds: number;
  masterTimeoutSeconds: number;
  bootProbeSeconds: number;
  port: number;
  multicastGroup: string;
  secret: string;
  /**
   * Static list of other nodes, as `host` or `host:port`, for networks that
   * drop multicast (many corporate wireless networks, some VPN interfaces).
   * Additive rather than exclusive: coordination messages go to the multicast
   * group AND to every host listed here, so a mixed network where only some
   * links carry multicast still converges. Empty — the default — means
   * multicast only, and this setting does nothing.
   */
  peers: string[];
}

declare module './schema-types.js' {
  interface GoodVibesConfig {
    cluster: ClusterConfig;
  }
}

export const clusterConfigDefaults: { cluster: ClusterConfig } = {
  cluster: {
    // OFF by default, deliberately. See the setting's description: switching
    // it on is the operator asserting that every goodvibes node on this network
    // is theirs, and that assertion is the whole trust boundary.
    enabled: false,
    heartbeatSeconds: 30,
    masterTimeoutSeconds: 90,
    bootProbeSeconds: 3,
    // Administratively-scoped multicast (RFC 2365, 239.0.0.0/8): a conforming
    // router never forwards it off the local network.
    multicastGroup: '239.255.71.86',
    // IANA Dynamic/Private range, above the Linux ephemeral range so an
    // outbound socket cannot claim it first.
    port: 61860,
    secret: '',
    peers: [],
  },
};

export const clusterConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'cluster.enabled',
    type: 'boolean',
    default: false,
    description:
      'Let this machine share inbound channel work with your OTHER goodvibes machines on this network, so exactly one of them reads each inbox (Telegram polling, ntfy subscriptions, inbox pollers) instead of all of them answering the same message. For a homelab where you run goodvibes on several machines that are all yours and configured with the same surfaces: switch it on everywhere and they sort it out between themselves, including taking over within about a second when one is shut down or crashes. Off by default because switching it on asserts that every goodvibes node on this network belongs to you — on a shared network (an office, a shared house) a stranger\'s node would join the same coordination and one of you would stop receiving messages with nothing to indicate why. Outbound sends, sessions and the control plane are unaffected either way.',
  },
  {
    key: 'cluster.heartbeatSeconds',
    type: 'number',
    default: 30,
    description:
      'How often the responsible node tells the others it is still alive, in seconds. Lower means a faster crash takeover and slightly more network chatter.',
    ...intRange(1, 3_600),
  },
  {
    key: 'cluster.masterTimeoutSeconds',
    type: 'number',
    default: 90,
    description:
      'How long a standby node waits without a heartbeat before it decides the responsible node has crashed and holds an election, in seconds. This is the CRASH path only: a node shut down normally hands over immediately, so ordinary restarts never wait this out. Must be at least two heartbeats.',
    ...intRange(2, 86_400),
  },
  {
    key: 'cluster.bootProbeSeconds',
    type: 'number',
    default: 3,
    description:
      'How long a starting node listens for an existing responsible node before claiming the role itself, in seconds.',
    ...intRange(1, 300),
  },
  {
    key: 'cluster.port',
    type: 'number',
    default: 61860,
    description:
      'UDP port used for node-to-node coordination on the local network. Every node that should coordinate must share this port. Change it only to avoid a collision with something else on your network.',
    ...port(),
  },
  {
    key: 'cluster.multicastGroup',
    type: 'string',
    default: '239.255.71.86',
    description:
      'IPv4 multicast group the nodes coordinate over. The default sits in the administratively-scoped range (239.0.0.0/8), which routers do not forward off the local network. Every node that should coordinate must share this value.',
  },
  {
    key: 'cluster.secret',
    type: 'string',
    default: '',
    description:
      'Optional shared phrase. When set, coordination messages are signed with it and any message that does not verify is ignored, so only nodes that know the phrase can take the responsible role. Leave empty on a network you trust. Every node that should coordinate must use the same value.',
  },
];
