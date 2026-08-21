/**
 * memory-transport.ts, an in-process stand-in for the multicast socket.
 *
 * Exported rather than kept in a test file because both consumer repositories
 * need it: a composition that wires the election has to be able to prove its
 * own wiring without opening a socket or waiting real seconds.
 *
 * It models the two properties of the real transport that the state machine
 * actually depends on: every attached node receives every datagram INCLUDING
 * its own (loopback is on), and delivery is synchronous relative to the
 * injected clock. `partition` reproduces a split network so a heal can be
 * tested; datagrams sent across a partition boundary are dropped, exactly as a
 * severed link would drop them.
 */
import type { ClusterTransport, ClusterTransportDescription } from './types.js';

interface Attachment {
  readonly transport: MemoryClusterTransport;
  onMessage: ((raw: string) => void) | null;
}

/** A shared segment. Every transport built from one bus can hear the others. */
export class MemoryClusterBus {
  private readonly attachments: Attachment[] = [];
  /** Segment id per transport; different ids cannot hear each other. */
  private readonly segments = new Map<MemoryClusterTransport, string>();
  /** Every datagram sent, for tests that assert on protocol ordering. */
  readonly sent: { readonly from: string; readonly raw: string }[] = [];

  createTransport(label: string): MemoryClusterTransport {
    const transport = new MemoryClusterTransport(this, label);
    this.attachments.push({ transport, onMessage: null });
    this.segments.set(transport, 'default');
    return transport;
  }

  /** Move a transport onto a named network segment. */
  partition(transport: MemoryClusterTransport, segment: string): void {
    this.segments.set(transport, segment);
  }

  /** Put every transport back on one segment. */
  heal(): void {
    for (const key of this.segments.keys()) this.segments.set(key, 'default');
  }

  attach(transport: MemoryClusterTransport, onMessage: (raw: string) => void): void {
    const attachment = this.attachments.find((entry) => entry.transport === transport);
    if (attachment) attachment.onMessage = onMessage;
  }

  detach(transport: MemoryClusterTransport): void {
    const attachment = this.attachments.find((entry) => entry.transport === transport);
    if (attachment) attachment.onMessage = null;
  }

  broadcast(from: MemoryClusterTransport, raw: string): void {
    this.sent.push({ from: from.label, raw });
    const segment = this.segments.get(from);
    for (const attachment of [...this.attachments]) {
      if (this.segments.get(attachment.transport) !== segment) continue;
      attachment.onMessage?.(raw);
    }
  }
}

export class MemoryClusterTransport implements ClusterTransport {
  private running = false;

  constructor(private readonly bus: MemoryClusterBus, readonly label: string) {}

  async start(onMessage: (raw: string) => void): Promise<void> {
    this.running = true;
    this.bus.attach(this, onMessage);
  }

  async send(raw: string): Promise<void> {
    if (!this.running) return;
    this.bus.broadcast(this, raw);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.bus.detach(this);
  }

  describe(): ClusterTransportDescription {
    return { mode: 'in-memory', group: 'memory', port: 0, peers: [] };
  }
}
