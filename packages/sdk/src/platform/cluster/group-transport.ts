/**
 * group-transport.ts, one socket, two tenants.
 *
 * The group layer owns the datagram socket. Leader election is a TENANT on it:
 * every election datagram is wrapped in the group envelope, signed with the
 * current group key, and unwrapped on the far side before the election state
 * machine ever sees it. The election is not aware of any of this, which is
 * exactly the point, it means group membership, rotation and revocation are
 * enforced in ONE place, at the edge, and no state machine downstream has to
 * remember to check.
 *
 * Two consequences worth stating plainly:
 *
 *   - a datagram from a node that is not in this group never reaches the
 *     election. Two groups sharing one multicast address are mutually
 *     invisible, and it costs one string compare to keep them that way;
 *
 *   - a node whose group key was rotated out, because it was REMOVED, stops
 *     being heard on the same tick, without the election needing a concept of
 *     revocation at all.
 */
import { digestSurfaceId } from './group-crypto.js';
import { isOutOfBandMessageType } from './group-membership.js';
import {
  decodeEnvelope,
  encodeEnvelope,
  peekEnvelope,
  type ClusterEnvelope,
  type ClusterKeyring,
  type EnvelopeRejection,
} from './protocol-envelope.js';
import type { ClusterLogger, ClusterTransport, ClusterTransportDescription } from './types.js';

/** Envelope types the group layer handles itself rather than passing down. */
const GROUP_OWNED_TYPES: ReadonlySet<string> = new Set([
  'BEACON', 'ROSTER', 'REKEY',
  // Config replication rides the same signed channel. Anything not listed here
  // is handed to the election, so a type added to the group layer and forgotten
  // here arrives at the wrong state machine and is silently ignored.
  'CONFIG_SNAPSHOT', 'CONFIG_DELTA', 'CONFIG_PROPOSE', 'CONFIG_REQUEST',
]);

/**
 * Fields lifted out of an election message onto the envelope, and put back on
 * arrival.
 *
 * These are exactly the fields the envelope has its own home for, and they mean
 * the same thing in both places. `v` and `sig` are deliberately NOT lifted:
 * `v` is the ELECTION protocol's version, which is a different number from the
 * envelope's own version, and `sig` is the election's optional signature under
 * `cluster.secret`, which is independent of the group key. Both ride in `body`,
 * where the envelope signature still covers them.
 */
const LIFTED_FIELDS = ['type', 'surfaceId', 'nodeId', 'nodeVersion', 'seq', 'ts'] as const;

/** Running totals, surfaced in `cluster status` so drops are visible rather than inferred. */
export interface GroupWireCounters {
  sent: number;
  received: number;
  droppedOtherGroup: number;
  droppedBadSignature: number;
  droppedMalformed: number;
  droppedOldGeneration: number;
  /** Outbound election datagrams not sent because this machine is in no group. */
  droppedNoGroup: number;
}

export interface GroupWireRouterOptions {
  readonly inner: ClusterTransport;
  readonly keyring: ClusterKeyring;
  readonly logger: ClusterLogger;
  readonly now: () => number;
  /** BEACON / ROSTER that verified against the group key. */
  readonly onGroupMessage: (envelope: ClusterEnvelope) => void;
  /** JOIN / REJOIN and their replies, authenticated by the membership layer, not here. */
  readonly onOutOfBandMessage: (raw: string, type: string) => void;
  /** A beacon from a DIFFERENT group. Advertisement only; never acted on. */
  readonly onForeignBeacon: (groupId: string, body: Record<string, unknown>, version: string) => void;
}

/**
 * Routes every inbound datagram to exactly one destination, and wraps every
 * outbound election datagram.
 */
export class GroupWireRouter {
  readonly counters: GroupWireCounters = {
    sent: 0,
    received: 0,
    droppedOtherGroup: 0,
    droppedBadSignature: 0,
    droppedMalformed: 0,
    droppedOldGeneration: 0,
    droppedNoGroup: 0,
  };

  private started = false;
  private announcedNoGroup = false;
  private electionListener: ((raw: string) => void) | null = null;
  private seq = 0;

  constructor(private readonly options: GroupWireRouterOptions) {}

  /** Start the underlying socket. Idempotent, both tenants may call it. */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.options.inner.start((raw) => this.receive(raw));
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.electionListener = null;
    await this.options.inner.stop();
  }

  describe(): ClusterTransportDescription {
    return this.options.inner.describe();
  }

  /** Next per-node sequence number. Shared by both tenants so it never repeats. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Send a datagram the group layer built itself (already a full envelope). */
  async sendRaw(raw: string): Promise<void> {
    this.counters.sent += 1;
    await this.options.inner.send(raw);
  }

  /**
   * The transport handed to `ClusterCoordinator`.
   *
   * Deliberately a plain object rather than a subclass: the coordinator only
   * ever calls these four methods, and keeping the seam this narrow is what
   * lets the election stay entirely unaware of the group layer.
   */
  electionTransport(nodeVersion: string): ClusterTransport {
    return {
      start: async (onMessage) => {
        this.electionListener = onMessage;
        await this.ensureStarted();
      },
      send: async (raw) => {
        const wrapped = this.wrapElectionMessage(raw, nodeVersion);
        if (!wrapped) return;
        await this.sendRaw(wrapped);
      },
      // The socket belongs to the group runtime, whose own lifecycle closes it.
      // A coordinator shutting down must not take the beacon down with it.
      stop: async () => {
        this.electionListener = null;
      },
      describe: () => this.describe(),
    };
  }

  // ── outbound ──────────────────────────────────────────────────────────────

  /**
   * Lift an election message into the group envelope.
   *
   * The merged wire format is ONE object carrying the group's fields and the
   * surface's together:
   *
   *   { v, groupId, keyGen, surfaceId, type, nodeId, nodeVersion, seq, ts, body, sig }
   *
   * so a datagram is answerable for which group it belongs to, which key
   * generation signed it, AND which surface it is about, all under one
   * signature. Whatever the election put on the message beyond those fields
   * rides in `body` untouched, so the message that comes out the far side is
   * the one that went in.
   */
  private wrapElectionMessage(raw: string, nodeVersion: string): string | null {
    // No group, nothing to sign with. This is the explicitly-handled state, not
    // a failure: the machine coordinates with nobody, consumes locally exactly
    // as it did before clustering existed, and `cluster status` says so and
    // names the two commands that fix it.
    //
    // Said ONCE. The election heartbeats every few seconds, so warning per
    // datagram would bury the machine's logs in a message whose answer never
    // changes, which is what the first live run of this code actually did.
    if (this.options.keyring.acceptedGenerations().length === 0) {
      this.counters.droppedNoGroup += 1;
      if (!this.announcedNoGroup) {
        this.announcedNoGroup = true;
        this.options.logger.info(
          'cluster: this machine is not in a group, so it is coordinating with nobody and reading its own inbox',
          { action: 'create a group with `cluster create`, or join one with `cluster join`' },
        );
      }
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.options.logger.warn('cluster: an election datagram was not JSON and was not sent');
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const message = parsed as Record<string, unknown>;
    const type = message['type'];
    const nodeId = message['nodeId'];
    if (typeof type !== 'string' || typeof nodeId !== 'string') return null;

    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(message)) {
      if (!(LIFTED_FIELDS as readonly string[]).includes(key)) body[key] = value;
    }
    // The election already derives its surface ids as domain-separated digests
    // (surface-id.ts), so this is a guard against an un-hashed id reaching the
    // wire, not a second hash: digestSurfaceId returns such a value unchanged.
    // It has to, because this exact string is what the far side routes on and
    // what the election's own inner signature covers.
    const surfaceId = typeof message['surfaceId'] === 'string'
      ? digestSurfaceId(message['surfaceId'], this.options.keyring.groupId)
      : null;

    try {
      return encodeEnvelope(
        {
          type,
          nodeId,
          nodeVersion: typeof message['nodeVersion'] === 'string' ? message['nodeVersion'] : nodeVersion,
          seq: typeof message['seq'] === 'number' ? message['seq'] : this.nextSeq(),
          // The election stamps its own send time, and the holder-timeout logic
          // on the far side reads it. Re-stamping here would replace the
          // sender's clock with the wrapper's.
          ts: typeof message['ts'] === 'number' ? message['ts'] : this.options.now(),
          surfaceId,
          body,
        },
        this.options.keyring,
      );
    } catch (error) {
      this.options.logger.warn('cluster: an election datagram could not be signed and was not sent', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Rebuild the election's own message from a verified envelope.
   *
   * Every lifted field goes back under the name the election gave it, and the
   * body is restored around them. The reconstruction has to be exact: when
   * `cluster.secret` is also set, the election re-checks its own signature over
   * `[v, type, surfaceId, nodeId, nodeVersion, seq, ts]`, and a field that came
   * back under a different name or a different value would fail every datagram.
   */
  private unwrapElectionMessage(envelope: ClusterEnvelope): string {
    return JSON.stringify({
      ...envelope.body,
      type: envelope.type,
      surfaceId: envelope.surfaceId,
      nodeId: envelope.nodeId,
      nodeVersion: envelope.nodeVersion,
      seq: envelope.seq,
      ts: envelope.ts,
    });
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  private receive(raw: string): void {
    this.counters.received += 1;

    // Join and rejoin traffic is authenticated by the membership layer against
    // the join verifier or a roster public key, this node may not even hold a
    // key the sender could have used. Hand it over unopened.
    const peeked = peekEnvelope(raw);
    if (peeked && isOutOfBandMessageType(peeked.type)) {
      this.options.onOutOfBandMessage(raw, peeked.type);
      return;
    }

    const decoded = decodeEnvelope(raw, this.options.keyring);
    if (!decoded.envelope) {
      this.countRejection(decoded.rejected);
      if (
        decoded.rejected === 'other-group'
        && peeked?.type === 'BEACON'
        && decoded.claimedGroupId !== null
      ) {
        this.options.onForeignBeacon(decoded.claimedGroupId, peeked.body, readVersion(raw));
      }
      return;
    }

    if (GROUP_OWNED_TYPES.has(decoded.envelope.type)) {
      this.options.onGroupMessage(decoded.envelope);
      return;
    }
    this.electionListener?.(this.unwrapElectionMessage(decoded.envelope));
  }

  private countRejection(rejection: EnvelopeRejection | null): void {
    switch (rejection) {
      case 'other-group':
        this.counters.droppedOtherGroup += 1;
        return;
      case 'signature-did-not-verify':
        this.counters.droppedBadSignature += 1;
        return;
      case 'generation-not-accepted':
      case 'generation-not-held':
        this.counters.droppedOldGeneration += 1;
        return;
      default:
        this.counters.droppedMalformed += 1;
    }
  }
}

/** Pull the advertised build version off a beacon this node cannot verify. */
function readVersion(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return 'unknown';
    const version = (parsed as Record<string, unknown>)['nodeVersion'];
    return typeof version === 'string' && version.length <= 64 ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
