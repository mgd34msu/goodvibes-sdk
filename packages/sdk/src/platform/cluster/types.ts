/**
 * types.ts — the contract surface for LAN leader election.
 *
 * One goodvibes install commonly ends up running more than once: a laptop and a
 * desktop on the same network, a daemon plus a second daemon started by an
 * update that did not fully retire the first, two checkouts on one host. Every
 * one of those processes independently long-polls Telegram and subscribes to
 * ntfy, so one inbound message is consumed twice and answered twice.
 *
 * The fix is an election over the LAN — one election PER INBOUND SURFACE.
 *
 * Per surface, not per node, because a node is rarely the same shape as its
 * neighbour. A laptop configured for Telegram and ntfy and a desktop
 * configured for ntfy alone cannot share a single whole-node election: whoever
 * won it would own Telegram too, and if that was the desktop — which has no bot
 * token — Telegram would simply stop being read by anybody. Each surface
 * therefore runs its own election among the nodes that can ACTUALLY serve it,
 * and failover is granular: losing the node that holds ntfy moves ntfy, and
 * touches nothing else.
 *
 * Outbound sends, sessions, the control plane and HTTP are untouched on every
 * node — leadership gates what a node LISTENS to, never what it can do.
 *
 * Everything here is transport- and clock-injectable so the state machine can
 * be exercised deterministically with no sockets and no real time.
 */
import type { ClusterSurfaceKey } from './surface-id.js';

/** Where a node currently sits in the protocol FOR ONE SURFACE. */
export type ClusterRole =
  /** Not participating (never started, or stopped). */
  | 'stopped'
  /** Broadcast a PROBE; waiting out the boot window for a holder to answer. */
  | 'probing'
  /** Another node holds this surface. This node's consumer is stopped. */
  | 'standby'
  /** No holder heard within the timeout; running the jittered CLAIM window. */
  | 'electing'
  /** We preempted a sitting holder and are waiting for its ordered RESIGN. */
  | 'awaiting-handoff'
  /** We are the single node responsible for this surface. Consumer running. */
  | 'master'
  /** Stopping the consumer so a RESIGN can be broadcast after it has closed. */
  | 'resigning';

/** The four datagrams the protocol uses. Nothing else is ever sent. */
export type ClusterMessageType = 'PROBE' | 'CLAIM' | 'HEARTBEAT' | 'RESIGN';

/** The only protocol version this build speaks. */
export const CLUSTER_PROTOCOL_VERSION = 1;

/**
 * A protocol datagram, before signing.
 *
 * `surfaceId` is a DIGEST — see surface-id.ts for why a topic name never
 * travels — and is null on a group-level datagram that is not about any one
 * surface. This module sends no group-level datagrams of its own; the field is
 * null-capable so datagrams from the group's other traffic decode and are
 * routed past the per-surface machinery rather than mistaken for it.
 */
export interface ClusterMessage {
  /** Protocol version. Always CLUSTER_PROTOCOL_VERSION on send. */
  readonly v: number;
  readonly type: ClusterMessageType;
  /** Surface digest, or null for a group-level datagram. */
  readonly surfaceId: string | null;
  /** Stable per install, persisted under the daemon state dir. */
  readonly nodeId: string;
  /** Build version, the first ranking tier. */
  readonly nodeVersion: string;
  /** Per-node send counter; drops duplicate and reordered datagrams. */
  readonly seq: number;
  /** Sender's wall clock at send. Distinguishes a restart from a replay. */
  readonly ts: number;
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

/** Why a surface's consumer is being started, and from when to replay. */
export interface ClusterConsumerStartContext {
  /**
   * Wall-clock ms of the last heartbeat heard from the previous holder of THIS
   * surface, or null when the handoff was ordered (or no holder was ever
   * seen). A consumer whose provider has no server-side backlog (ntfy)
   * subscribes with `since=` this value so the gap between the old holder's
   * last breath and this start is replayed rather than lost.
   */
  readonly replayFromMs: number | null;
  readonly reason: string;
}

/**
 * One inbound consumer whose lifetime follows leadership OF ITS OWN SURFACE.
 *
 * `stop()` MUST NOT resolve until the consumer has genuinely stopped
 * consuming: a Telegram long-poll closed with its offset committed, an ntfy
 * stream aborted. The ordered handoff depends on that promise being honest —
 * the successor starts only after this resolves.
 */
export interface ClusterConsumerGate {
  readonly id: string;
  /**
   * Which surface this gate consumes. One gate, one surface: a gate that
   * covered several would have to start and stop them together, which is the
   * whole-node coupling this design removes.
   */
  readonly surface: ClusterSurfaceKey;
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
  /** Wall-clock ms when this node last received anything from the peer. */
  readonly lastSeenAt: number;
  readonly lastMessageType: ClusterMessageType;
  /** Surface digests this peer is currently believed to hold. */
  readonly holds: readonly string[];
}

/** One surface's standing on this node. Inspection only; never user-facing. */
export interface ClusterSurfaceStatus {
  /** The digest, exactly as it appears on the wire. */
  readonly surfaceId: string;
  /**
   * A short local label (`ntfy:1a2b3c4d`). Derived from the digest, not the
   * topic name, so a pasted `/status` still discloses nothing.
   */
  readonly label: string;
  readonly kind: string;
  readonly role: ClusterRole;
  /** Node believed responsible, this one included. */
  readonly holderNodeId: string | null;
  /** True when this node's consumer for the surface is running. */
  readonly consuming: boolean;
  readonly lastHolderHeartbeatAt: number | null;
}

/**
 * One surface this node currently consumes, and why.
 *
 * Lives here rather than in the group layer because the per-surface election
 * is what establishes the fact; the group layer only reports it. `surfaceId` is
 * always a digest — a raw topic or chat id must never reach here.
 */
export interface ClusterSurfaceHolding {
  readonly surfaceId: string;
  readonly reason: string;
}

/** The `cluster` section of /status. Inspection only; never user-facing. */
export interface ClusterStatus {
  readonly enabled: boolean;
  /**
   * The node's aggregate standing: `master` when it holds at least one
   * surface, `standby` when it participates but holds none, `stopped` when it
   * is not participating at all.
   */
  readonly role: ClusterRole;
  readonly nodeId: string;
  readonly version: string;
  readonly uptimeMs: number;
  /** True when any surface's consumer is running on this node. */
  readonly consumersRunning: boolean;
  /** How many surfaces this node currently holds. */
  readonly heldSurfaceCount: number;
  readonly signed: boolean;
  readonly surfaces: readonly ClusterSurfaceStatus[];
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
