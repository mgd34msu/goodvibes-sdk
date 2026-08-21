/**
 * udp-transport.ts, one UDP multicast socket, with loopback deliberately ON.
 *
 * Loopback matters more than it looks. Two goodvibes processes on the SAME
 * host are the most common way an install ends up double-subscribed (a daemon
 * left over from an update, a second checkout, a service plus a hand-started
 * copy). With `setMulticastLoopback(true)` those processes coordinate through
 * the identical mechanism as two machines on the LAN, one protocol, one code
 * path, one set of tests, and same-host duplication is fixed as a side effect
 * rather than as a special case.
 *
 * `reuseAddr` is what allows several processes on one host to bind the same
 * port at all; without it the second process would fail to bind and quietly
 * never participate.
 *
 * A static peer list is the escape hatch for networks that drop multicast
 * (many corporate wireless networks, and some VPN interfaces). It is additive:
 * datagrams go to the group AND to each configured peer, so a mixed network
 * where only some links carry multicast still converges.
 *
 * Nothing here talks to anything but the LAN. There is no outbound call to
 * Telegram, ntfy, or any other external service in this file or in anything it
 * imports, and there must never be one.
 */
import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import type { ClusterLogger, ClusterTransport, ClusterTransportDescription } from './types.js';

/**
 * Every local IPv4 address the group should be joined on, loopback FIRST.
 *
 * Loopback is not an optimization, it is the same-host case working at all.
 * Measured on a Linux host with one ethernet interface: a datagram sent on the
 * LAN interface with IP_MULTICAST_LOOP set was not delivered to ANY local
 * socket, not even the sender's own, while the identical exchange over
 * 127.0.0.1 delivered to every process that had joined there. Two goodvibes
 * processes on one machine is the most common way an install ends up
 * double-consuming, so relying on the kernel's default interface choice would
 * have left the primary case silently broken.
 *
 * Joining several interfaces means a peer reachable over more than one path
 * can receive the same datagram twice. That is expected and handled: the
 * election drops a datagram whose sequence number it has already seen.
 */
export function resolveMulticastInterfaces(): string[] {
  const addresses = ['127.0.0.1'];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4') continue;
      if (entry.internal) continue;
      if (!addresses.includes(entry.address)) addresses.push(entry.address);
    }
  }
  return addresses;
}

export interface UdpClusterTransportOptions {
  readonly port: number;
  readonly multicastGroup: string;
  /** `host:port` or bare `host` entries; a bare host uses `port`. */
  readonly peers: readonly string[];
  readonly logger: ClusterLogger;
}

interface ResolvedPeer {
  readonly host: string;
  readonly port: number;
}

export class UdpClusterTransport implements ClusterTransport {
  private socket: Socket | null = null;
  /** Interface addresses the group was successfully joined on. */
  private joined: string[] = [];
  /**
   * Serializes sends. IP_MULTICAST_IF is a property of the SOCKET, not of an
   * individual datagram, so two concurrent sends could otherwise swap the
   * outgoing interface out from under each other.
   */
  private sendChain: Promise<void> = Promise.resolve();
  private readonly peers: readonly ResolvedPeer[];

  constructor(private readonly options: UdpClusterTransportOptions) {
    this.peers = parsePeers(options.peers, options.port);
  }

  describe(): ClusterTransportDescription {
    const mode = this.peers.length === 0
      ? 'multicast'
      : this.joined.length > 0 ? 'multicast+unicast' : 'unicast';
    return {
      mode,
      group: this.options.multicastGroup,
      port: this.options.port,
      peers: this.peers.map((peer) => `${peer.host}:${peer.port}`),
      interfaces: [...this.joined],
    };
  }

  async start(onMessage: (raw: string) => void): Promise<void> {
    if (this.socket) return;
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (payload) => {
      onMessage(payload.toString('utf8'));
    });
    socket.on('error', (error) => {
      // A transient network error must not take the daemon down with it; the
      // election simply stops hearing peers, and the watchdog covers that.
      this.options.logger.warn('cluster: multicast socket error', { error: error.message });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      socket.once('error', onError);
      socket.bind({ port: this.options.port, exclusive: false }, () => {
        socket.removeListener('error', onError);
        resolve();
      });
    });

    // Loopback ON so processes on THIS host coordinate through the identical
    // mechanism as processes on other hosts, one protocol, one code path.
    socket.setMulticastLoopback(true);
    // TTL 1 keeps traffic on the local link, which is the whole scope of this
    // protocol. It must never be routed off the LAN.
    socket.setMulticastTTL(1);

    this.joined = [];
    const failures: string[] = [];
    for (const address of resolveMulticastInterfaces()) {
      try {
        socket.addMembership(this.options.multicastGroup, address);
        this.joined.push(address);
      } catch (error) {
        failures.push(`${address}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (this.joined.length === 0) {
      // Multicast is unavailable here. With static peers this is survivable;
      // without them the node runs alone, which is the same behavior as before
      // the election existed, never a reason to stop receiving messages.
      this.options.logger.warn('cluster: could not join the multicast group on any interface', {
        group: this.options.multicastGroup,
        failures,
        action: this.peers.length > 0
          ? 'falling back to the configured cluster.peers list'
          : 'set cluster.peers to a static list of hosts to coordinate without multicast',
      });
    } else {
      this.options.logger.debug('cluster: joined the coordination group', {
        group: this.options.multicastGroup,
        port: this.options.port,
        interfaces: this.joined,
        ...(failures.length > 0 ? { skipped: failures } : {}),
      });
    }
    socket.unref();
  }

  /**
   * Fan a datagram out: once per joined interface to the group, plus once to
   * each static unicast peer.
   *
   * Sends are chained rather than run in parallel because switching the
   * outgoing multicast interface mutates socket state, see `sendChain`.
   */
  async send(raw: string): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    const payload = Buffer.from(raw, 'utf8');
    const group = { host: this.options.multicastGroup, port: this.options.port };
    const joined = [...this.joined];
    const peers = [...this.peers];
    const work = this.sendChain.then(async () => {
      for (const address of joined) {
        try {
          socket.setMulticastInterface(address);
        } catch {
          // The interface went away between join and send (a VPN dropping, a
          // cable pulled). Skip it; the others still carry the datagram.
          continue;
        }
        await this.sendTo(socket, payload, group);
      }
      for (const peer of peers) await this.sendTo(socket, payload, peer);
    });
    this.sendChain = work.catch(() => { /* reported per-datagram in sendTo */ });
    await work;
  }

  private sendTo(socket: Socket, payload: Buffer, target: ResolvedPeer): Promise<void> {
    return new Promise<void>((resolve) => {
      socket.send(payload, target.port, target.host, (error) => {
        if (error) {
          this.options.logger.debug('cluster: datagram send failed', {
            target: `${target.host}:${target.port}`,
            error: error.message,
          });
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    for (const address of this.joined) {
      try {
        socket.dropMembership(this.options.multicastGroup, address);
      } catch {
        // Already gone (interface down, socket closing), nothing to undo.
      }
    }
    this.joined = [];
    await new Promise<void>((resolve) => {
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

/** Parse `cluster.peers`, skipping entries that are not usable addresses. */
export function parsePeers(entries: readonly string[], defaultPort: number): ResolvedPeer[] {
  const parsed: ResolvedPeer[] = [];
  for (const entry of entries) {
    const trimmed = String(entry ?? '').trim();
    if (!trimmed) continue;
    const separator = trimmed.lastIndexOf(':');
    if (separator === -1) {
      parsed.push({ host: trimmed, port: defaultPort });
      continue;
    }
    const host = trimmed.slice(0, separator);
    const port = Number.parseInt(trimmed.slice(separator + 1), 10);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) continue;
    parsed.push({ host, port });
  }
  return parsed;
}
