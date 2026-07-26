/**
 * types.ts — the contract surface for LAN leader election.
 *
 * One goodvibes install commonly ends up running more than once: a laptop and a
 * desktop on the same network, a daemon plus a second daemon started by an
 * update that did not fully retire the first, two checkouts on one host. Every
 * one of those processes independently long-polls Telegram and subscribes to
 * ntfy, so one inbound message is consumed twice and answered twice.
 *
 * The fix is an election over the LAN: exactly one node is RESPONSIBLE for
 * inbound consumption at a time, and every other node stays warm but silent.
 * Outbound sends, sessions, the control plane and HTTP are untouched on every
 * node — leadership gates what a node LISTENS to, never what it can do.
 *
 * Everything here is transport- and clock-injectable so the state machine can
 * be exercised deterministically with no sockets and no real time.
 */

/** Where a node currently sits in the protocol. */
export type ClusterRole =
  /** Not participating (never started, or stopped). */
  | 'stopped'
  /** Broadcast a PROBE; waiting out the boot window for a master to answer. */
  | 'probing'
  /** A master exists elsewhere. Consumers are stopped. */
  | 'standby'
  /** No master heard within the timeout; running the jittered CLAIM window. */
  | 'electing'
  /** We preempted a sitting master and are waiting for its ordered RESIGN. */
  | 'awaiting-handoff'
  /** We are the single responsible node. Consumers are running. */
  | 'master'
  /** Stopping consumers so a RESIGN can be broadcast after they are closed. */
  | 'resigning';

/** The four datagrams the protocol uses. Nothing else is ever sent. */
export type ClusterMessageType = 'PROBE' | 'CLAIM' | 'HEARTBEAT' | 'RESIGN';

/** A protocol datagram, before signing. */
export interface ClusterMessage {
  readonly type: ClusterMessageType;
  /** Stable per install, persisted under the daemon state dir. */
  readonly nodeId: string;
  /** Build version, used as the first ranking tier. */
  readonly version: string;
  /** Monotonic process uptime in ms, used as the second ranking tier. */
  readonly uptimeMs: number;
  /** Per-node send counter; drops duplicate and reordered datagrams. */
  readonly seq: number;
}

/** A datagram as it appears on the wire — `sig` present only when signing. */
export interface SignedClusterMessage extends ClusterMessage {
  readonly sig?: string | undefined;
}

/** How this node is reaching the rest of the cluster. */
export interface ClusterTransportDescription {
  readonly mode: 'multicast' | 'multicast+unicast' | 'unicast' | 'in-memory';
  readonly group: string;
  readonly port: number;
  readonly peers: readonly string[];
  /** Local interface addresses the group was joined on; empty for non-UDP transports. */
  readonly interfaces?: readonly string[] | undefined;
}

/**
 * A duplex datagram channel. The real implementation is one UDP multicast
 * socket with loopback enabled; tests use an in-memory bus.
 */
export interface ClusterTransport {
  /** Begin delivering datagrams. Called once, before any send. */
  start(onMessage: (raw: string) => void): Promise<void>;
  /** Fan a datagram out to the group and to any static unicast peers. */
  send(raw: string): Promise<void>;
  /** Close the socket. Safe to call when never started. */
  stop(): Promise<void>;
  describe(): ClusterTransportDescription;
}

/**
 * Time, injected.
 *
 * `now()` is wall clock (what a replay cursor is expressed in) and
 * `monotonicNow()` is a monotonic source that does NOT advance across a host
 * suspend — the difference between the two is exactly how a woken node
 * discovers it was asleep.
 *
 * `setTimer` returns its own cancel function so no handle type has to be
 * threaded through the state machine.
 */
export interface ClusterClock {
  now(): number;
  monotonicNow(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

/** Why consumers are being started, and from when to replay. */
export interface ClusterConsumerStartContext {
  /**
   * Wall-clock ms of the last heartbeat heard from the previous master, or
   * null when no master was ever seen. A consumer whose provider has no
   * server-side backlog (ntfy) subscribes with `since=` this value so the gap
   * between the old master's last breath and this start is replayed rather
   * than lost.
   */
  readonly replayFromMs: number | null;
  readonly reason: string;
}

/**
 * One inbound consumer whose lifetime follows leadership.
 *
 * `stop()` MUST NOT resolve until the consumer has genuinely stopped
 * consuming: a Telegram long-poll closed with its offset committed, an ntfy
 * stream aborted. The ordered handoff depends on that promise being honest —
 * the successor starts only after this resolves.
 */
export interface ClusterConsumerGate {
  readonly id: string;
  start(context: ClusterConsumerStartContext): Promise<void>;
  stop(reason: string): Promise<void>;
}

/** Resolved `cluster.*` settings. */
export interface ClusterSettings {
  readonly enabled: boolean;
  readonly heartbeatSeconds: number;
  readonly masterTimeoutSeconds: number;
  readonly bootProbeSeconds: number;
  readonly port: number;
  readonly multicastGroup: string;
  readonly secret: string;
  readonly peers: readonly string[];
}

/** A peer this node has heard from. */
export interface ClusterPeerStatus {
  readonly nodeId: string;
  readonly version: string;
  readonly uptimeMs: number;
  /** Wall-clock ms when this node last received anything from the peer. */
  readonly lastSeenAt: number;
  readonly lastMessageType: ClusterMessageType;
}

/** The `cluster` section of /status. Inspection only; never user-facing. */
export interface ClusterStatus {
  readonly enabled: boolean;
  readonly role: ClusterRole;
  readonly nodeId: string;
  readonly version: string;
  readonly uptimeMs: number;
  readonly masterNodeId: string | null;
  readonly lastMasterHeartbeatAt: number | null;
  readonly consumersRunning: boolean;
  readonly signed: boolean;
  readonly peers: readonly ClusterPeerStatus[];
  readonly transport: ClusterTransportDescription;
}

/** Minimal logging surface, injected so tests stay silent. */
export interface ClusterLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
