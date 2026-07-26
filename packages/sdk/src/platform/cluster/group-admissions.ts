/**
 * group-admissions.ts — the JOIN and REJOIN exchange, both ends of it.
 *
 * Split out of the runtime because it is the part with the security property in
 * it: everything here either decides whether a machine may enter the group, or
 * hands the group's secrets to one that may. Keeping it in one file means the
 * whole of that decision fits on a screen or two and can be read as a unit.
 *
 * The runtime owns the socket and the key material; this service borrows both
 * through {@link AdmissionHost} and owns nothing persistent of its own except
 * the single in-flight request this node is waiting on.
 */
import { deriveJoinVerifier, generateNodeKeyMaterial, type NodeKeyMaterial } from './group-crypto.js';
import {
  checkIdentityClassMessage,
  checkJoinClassMessage,
  decideAdmission,
  describeRefusal,
  encodeIdentityClassMessage,
  encodeJoinClassMessage,
  GROUP_MESSAGE_TYPES,
  openGrant,
  parseJoinRequestBody,
  parseRejoinRequestBody,
  peekIdentityClassMessage,
  sealGrant,
  type AdmissionGrant,
  type AdmissionRefusal,
} from './group-membership.js';
import {
  admitMember,
  findTombstone,
  isCurrentMember,
  MAX_GROUP_MEMBERS,
  readmitMember,
  type GroupMember,
  type GroupStateDocument,
} from './group-state.js';
import type { GroupKeyMaterial } from './group-store.js';
import type { ClusterClock, ClusterLogger } from './types.js';

/** What the admission service borrows from the runtime. */
export interface AdmissionHost {
  readonly nodeId: string;
  readonly version: string;
  readonly nodeDisplayName: string;
  readonly clock: ClusterClock;
  readonly logger: ClusterLogger;
  material(): GroupKeyMaterial | null;
  state(): GroupStateDocument | null;
  commitState(state: GroupStateDocument, gossip: boolean): Promise<void>;
  send(raw: string): Promise<void>;
  nextSeq(): number;
}

export type AdmissionOutcome =
  | { readonly ok: true; readonly grant: AdmissionGrant; readonly node: NodeKeyMaterial }
  | { readonly ok: false; readonly reason: string };

interface PendingAdmission {
  readonly kind: 'join' | 'rejoin';
  readonly joinVerifier: string;
  readonly node: NodeKeyMaterial;
  readonly deadline: number;
  readonly settle: (result: AdmissionOutcome) => void;
}

export class GroupAdmissionService {
  private pending: PendingAdmission | null = null;

  constructor(private readonly host: AdmissionHost) {}

  /** Fail an in-flight request — on shutdown, or when its deadline passes. */
  expire(now: number, reason: string): void {
    if (this.pending && this.pending.deadline <= now) this.settle({ ok: false, reason });
  }

  abandon(reason: string): void {
    this.settle({ ok: false, reason });
  }

  /** Route a datagram the group layer could not authenticate with a group key. */
  async handle(raw: string, type: string): Promise<void> {
    switch (type) {
      case GROUP_MESSAGE_TYPES.join:
        await this.onJoinRequest(raw);
        return;
      case GROUP_MESSAGE_TYPES.joinAccept:
      case GROUP_MESSAGE_TYPES.joinRefuse:
        this.onJoinReply(raw, type);
        return;
      case GROUP_MESSAGE_TYPES.rejoin:
        await this.onRejoinRequest(raw);
        return;
      case GROUP_MESSAGE_TYPES.rejoinAccept:
        this.onRejoinReply(raw);
        return;
      default:
    }
  }

  // ── admitting others ──────────────────────────────────────────────────────

  private async onJoinRequest(raw: string): Promise<void> {
    const material = this.host.material();
    const state = this.host.state();
    if (!material || !state) return;
    const checked = checkJoinClassMessage(raw, material.joinVerifier);
    if (!checked || checked.envelope.groupId !== material.groupId) return;
    if (checked.envelope.nodeId === this.host.nodeId) return;
    const body = parseJoinRequestBody(checked.envelope.body);
    if (!body) return;

    const decision = decideAdmission(
      state,
      {
        nodeId: checked.envelope.nodeId,
        ts: checked.envelope.ts,
        now: this.host.clock.now(),
        provedCurrentJoinKey: checked.joinKeyProved,
        provedHistoricalKey: false,
      },
      MAX_GROUP_MEMBERS,
    );
    if (!decision.admit) {
      // `identity-did-not-match` on this path means the join-key signature did
      // not verify — say THAT, because a mistyped key is the likely cause and
      // the operator needs to be pointed at it rather than at a generic refusal.
      await this.refuse(
        checked.envelope.nodeId,
        decision.reason === 'identity-did-not-match' ? 'join-key-did-not-match' : decision.reason,
      );
      return;
    }
    // A machine that was previously REMOVED and is now presenting the current
    // join key is the operator putting it back on purpose. That clears the
    // tombstone; nothing else does.
    const admit = findTombstone(state, checked.envelope.nodeId) ? readmitMember : admitMember;
    const admitted = admit(state, {
      nodeId: checked.envelope.nodeId,
      displayName: body.displayName,
      identityKey: body.identityKey,
      agreementKey: body.agreementKey,
      now: this.host.clock.now(),
    });
    if (admitted.refused) {
      await this.refuse(
        checked.envelope.nodeId,
        admitted.refused === 'group-is-full' ? 'group-is-full' : 'removed-from-the-group',
      );
      return;
    }
    await this.host.commitState(admitted.state, true);
    await this.grant(checked.envelope.nodeId, body.agreementKey, 'join', admitted.state);
    this.host.logger.info('cluster: a machine joined the group', {
      nodeId: checked.envelope.nodeId,
      members: admitted.state.members.length,
    });
  }

  /**
   * A machine that was already a member is coming back.
   *
   * Its identity key comes from THE ROSTER, never from the datagram. That is
   * the whole difference between "prove you are node X" and "assert you are
   * node X", and rule 2 of `decideAdmission` depends on it entirely: a node id
   * that is not on the roster has no key to check against, so there is nothing
   * an unknown machine can present here that gets it in.
   */
  private async onRejoinRequest(raw: string): Promise<void> {
    const material = this.host.material();
    const state = this.host.state();
    if (!material || !state) return;
    const peeked = peekIdentityClassMessage(raw);
    if (!peeked || peeked.groupId !== material.groupId) return;
    if (peeked.type !== GROUP_MESSAGE_TYPES.rejoin || peeked.nodeId === this.host.nodeId) return;

    const member: GroupMember | undefined = state.members.find((entry) => entry.nodeId === peeked.nodeId);
    const proved = member
      ? (checkIdentityClassMessage(raw, member.identityKey)?.identityProved ?? false)
      : false;
    const decision = decideAdmission(
      state,
      {
        nodeId: peeked.nodeId,
        ts: peeked.ts,
        now: this.host.clock.now(),
        provedCurrentJoinKey: false,
        provedHistoricalKey: proved,
      },
      MAX_GROUP_MEMBERS,
    );
    if (!decision.admit || !member) {
      this.host.logger.debug('cluster: refused a machine asking to come back', {
        nodeId: peeked.nodeId,
        reason: decision.admit ? 'not-on-the-roster' : decision.reason,
      });
      return;
    }
    const body = parseRejoinRequestBody(peeked.body);
    // The agreement key may legitimately have changed (a rebuilt machine that
    // kept its identity key). The IDENTITY key never rotates and is never taken
    // from the datagram — accepting a new one there would let anybody rewrite
    // the credential they are about to be checked against.
    const agreementKey = body?.agreementKey ?? member.agreementKey;
    const refreshed = admitMember(state, {
      nodeId: member.nodeId,
      displayName: body?.displayName || member.displayName,
      identityKey: member.identityKey,
      agreementKey,
      now: this.host.clock.now(),
    });
    if (refreshed.refused) return;
    await this.host.commitState(refreshed.state, true);
    await this.grant(member.nodeId, agreementKey, 'rejoin', refreshed.state);
    this.host.logger.info('cluster: a machine already on the roster came back and was re-keyed to the current group key', {
      nodeId: member.nodeId,
    });
  }

  private async refuse(nodeId: string, reason: AdmissionRefusal): Promise<void> {
    const material = this.host.material();
    if (!material) return;
    await this.host.send(encodeJoinClassMessage(
      {
        type: GROUP_MESSAGE_TYPES.joinRefuse,
        nodeId: this.host.nodeId,
        nodeVersion: this.host.version,
        seq: this.host.nextSeq(),
        ts: this.host.clock.now(),
        body: { forNodeId: nodeId, reason, detail: describeRefusal(reason) },
      },
      material.groupId,
      material.joinVerifier,
    ));
  }

  /**
   * Hand the group over to a machine that has proved itself.
   *
   * Every secret in the grant is sealed to that one machine's agreement key, so
   * although the datagram goes to the whole network exactly one recipient can
   * read it.
   */
  private async grant(
    nodeId: string,
    agreementKey: string,
    path: 'join' | 'rejoin',
    state: GroupStateDocument,
  ): Promise<void> {
    const material = this.host.material();
    if (!material) return;
    const sealed = sealGrant(
      {
        joinKey: material.joinKey,
        joinSalt: material.joinSalt,
        joinVerifier: material.joinVerifier,
        keys: material.keys,
        currentGeneration: material.currentGeneration,
        state,
      },
      agreementKey,
      path,
    );
    const draft = {
      type: path === 'join' ? GROUP_MESSAGE_TYPES.joinAccept : GROUP_MESSAGE_TYPES.rejoinAccept,
      nodeId: this.host.nodeId,
      nodeVersion: this.host.version,
      seq: this.host.nextSeq(),
      ts: this.host.clock.now(),
      body: { forNodeId: nodeId, sealed },
    };
    await this.host.send(path === 'join'
      ? encodeJoinClassMessage(draft, material.groupId, material.joinVerifier)
      : encodeIdentityClassMessage(draft, material.groupId, material.node));
  }

  // ── getting in ────────────────────────────────────────────────────────────

  /** Broadcast a JOIN and wait for the group to answer. */
  async requestJoin(input: {
    readonly groupId: string;
    readonly joinKey: string;
    readonly joinSalt: string;
    readonly timeoutMs: number;
  }): Promise<AdmissionOutcome> {
    const node = this.host.material()?.node ?? generateNodeKeyMaterial();
    let joinVerifier: string;
    try {
      joinVerifier = await deriveJoinVerifier(input.joinKey, input.joinSalt);
    } catch {
      return { ok: false, reason: 'that group advertised a join salt this build cannot read' };
    }
    return this.await('join', joinVerifier, node, input.timeoutMs, () => this.host.send(encodeJoinClassMessage(
      {
        type: GROUP_MESSAGE_TYPES.join,
        nodeId: this.host.nodeId,
        nodeVersion: this.host.version,
        seq: this.host.nextSeq(),
        ts: this.host.clock.now(),
        body: {
          displayName: this.host.nodeDisplayName,
          identityKey: node.identity.publicKey,
          agreementKey: node.agreement.publicKey,
        },
      },
      input.groupId,
      joinVerifier,
    )));
  }

  /**
   * Broadcast a REJOIN — the zero-touch return.
   *
   * A machine that has been switched off long enough to have missed every group
   * key rotation, and a join-key change on top, sends this when it starts and
   * is back in the group without the operator doing anything. It proves only
   * that it is itself; the group decides whether that is enough, and it is
   * enough only because the node id is already on the roster.
   */
  async requestRejoin(timeoutMs: number): Promise<AdmissionOutcome> {
    const material = this.host.material();
    if (!material) return { ok: false, reason: 'this machine is not in a group' };
    return this.await('rejoin', material.joinVerifier, material.node, timeoutMs, () => this.host.send(
      encodeIdentityClassMessage(
        {
          type: GROUP_MESSAGE_TYPES.rejoin,
          nodeId: this.host.nodeId,
          nodeVersion: this.host.version,
          seq: this.host.nextSeq(),
          ts: this.host.clock.now(),
          body: {
            displayName: this.host.nodeDisplayName,
            identityKey: material.node.identity.publicKey,
            agreementKey: material.node.agreement.publicKey,
            heldGenerations: material.keys.map((entry) => entry.generation),
          },
        },
        material.groupId,
        material.node,
      ),
    ));
  }

  private onJoinReply(raw: string, type: string): void {
    const pending = this.pending;
    if (!pending || pending.kind !== 'join') return;
    const checked = checkJoinClassMessage(raw, pending.joinVerifier);
    if (!checked || !checked.joinKeyProved) return;
    if (checked.envelope.body['forNodeId'] !== this.host.nodeId) return;

    if (type === GROUP_MESSAGE_TYPES.joinRefuse) {
      const detail = checked.envelope.body['detail'];
      this.settle({ ok: false, reason: typeof detail === 'string' ? detail : 'the group refused the request' });
      return;
    }
    const grant = openGrant(pending.node, checked.envelope.body['sealed'], 'join');
    if (!grant) return;
    this.settle({ ok: true, grant, node: pending.node });
  }

  /**
   * The reply to a REJOIN.
   *
   * When the responder is on the roster THIS node still holds, its identity
   * signature is checked and a bad one is dropped. When it is not — a machine
   * admitted while this one was away — there is nothing local to check it
   * against, so the grant is accepted on the strength of the seal alone: it was
   * encrypted to this node's agreement key, and a wrong one simply produces a
   * group key nobody accepts, which this node notices and retries. That
   * residual is stated rather than hidden; closing it fully needs a group-level
   * signing key, which is a larger change than this warrants.
   */
  private onRejoinReply(raw: string): void {
    const pending = this.pending;
    if (!pending || pending.kind !== 'rejoin') return;
    const peeked = peekIdentityClassMessage(raw);
    if (!peeked || peeked.body['forNodeId'] !== this.host.nodeId) return;
    const state = this.host.state();
    const responder = state?.members.find((entry) => entry.nodeId === peeked.nodeId);
    if (responder && !checkIdentityClassMessage(raw, responder.identityKey)?.identityProved) return;
    if (state && !responder && isCurrentMember(state, peeked.nodeId)) return;
    const grant = openGrant(pending.node, peeked.body['sealed'], 'rejoin');
    if (!grant) return;
    this.settle({ ok: true, grant, node: pending.node });
  }

  private await(
    kind: 'join' | 'rejoin',
    joinVerifier: string,
    node: NodeKeyMaterial,
    timeoutMs: number,
    send: () => Promise<void>,
  ): Promise<AdmissionOutcome> {
    return new Promise((resolve) => {
      const pending: PendingAdmission = {
        kind,
        joinVerifier,
        node,
        deadline: this.host.clock.now() + timeoutMs,
        settle: resolve,
      };
      this.pending = pending;
      void send().catch((error: unknown) => {
        this.settle(
          { ok: false, reason: error instanceof Error ? error.message : 'the request could not be sent' },
          pending,
        );
      });
      // Identity-scoped so a timer left over from an earlier attempt cannot
      // settle a later one with a deadline that never applied to it.
      this.host.clock.setTimer(() => {
        this.settle({ ok: false, reason: 'no machine in that group answered in time' }, pending);
      }, timeoutMs);
    });
  }

  private settle(result: AdmissionOutcome, only?: PendingAdmission): void {
    const pending = this.pending;
    if (!pending || (only && pending !== only)) return;
    this.pending = null;
    pending.settle(result);
  }
}
