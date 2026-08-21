/**
 * config-replication.ts, the master's settings, on every machine that might
 * have to serve them.
 *
 * Leader election decides which machine reads an inbox. That is only half an
 * answer: a machine that wins a surface and does not hold the surface's
 * configuration, or its credential, cannot serve it, and the handover is
 * theatre. This closes that.
 *
 * ── shape ──────────────────────────────────────────────────────────────────
 *
 *   The MASTER is the source of truth. It issues revisions, and it is the only
 *   node that writes one.
 *
 *   A machine that joins pulls a SNAPSHOT. From then on it receives DELTAS.
 *
 *   An edit made on a machine that is not the master is FORWARDED to the master
 *   as a proposal, and comes back as a delta like any other change. A standby
 *   never issues a revision of its own, so there is exactly one writer and no
 *   merge to argue about in the normal case.
 *
 * Everything rides the group transport and the group keyring, the same signed,
 * group-scoped channel every other cluster datagram uses. There is no second
 * channel and no second trust boundary.
 *
 * ── secrets ────────────────────────────────────────────────────────────────
 *
 * A credential never travels in the clear and never travels as another node's
 * ciphertext. It is sealed to each recipient's agreement key for the journey,
 * and the receiver hands the plaintext to its OWN secret store, which encrypts
 * it under its OWN keyfile at rest. Nothing here logs a value, and nothing here
 * puts one in `/status`, a replicated secret is reported as a path and a
 * revision, never as a value.
 */
import { openSealedEnvelope, sealForMember, type NodeKeyMaterial } from './group-crypto.js';
import {
  isReplicatedConfigPath,
  isReplicatedSecretKey,
  listReplicatedConfigPaths,
  replicatedSecretKeyFor,
} from './config-replication-policy.js';
import {
  createConfigReplicaDocument,
  deleteReplicaEntry,
  findReplicaEntry,
  isReplicableValue,
  mergeConfigReplica,
  putReplicaEntry,
  readConfigReplicaDocument,
  sweepConfigReplica,
  type ConfigReplicaDocument,
} from './config-replica.js';
import type { GroupMember, GroupStateDocument } from './group-state.js';
import type { ClusterEnvelope } from './protocol-envelope.js';
import type { ClusterLogger } from './types.js';

/** Message types this layer speaks. All group-key signed, like everything else. */
export const CONFIG_MESSAGE_TYPES = {
  snapshot: 'CONFIG_SNAPSHOT',
  delta: 'CONFIG_DELTA',
  propose: 'CONFIG_PROPOSE',
  request: 'CONFIG_REQUEST',
} as const;

const SECRET_SEAL_CONTEXT = 'goodvibes-cluster-config-secret-v1';

/** The narrow slice of config this layer touches. */
export interface ReplicatedConfigStore {
  get(path: string): unknown;
  set(path: string, value: unknown): void;
  /**
   * Return a setting to its default. Optional: a store without it simply keeps
   * the local value after a group-wide delete, and the tombstone still stops
   * that value from being replicated back out.
   */
  reset?(path: string): void;
}

/** The narrow slice of the secret store this layer touches. */
export interface ReplicatedSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** What the replication service borrows from the group runtime. */
export interface ConfigReplicationHost {
  readonly nodeId: string;
  readonly logger: ClusterLogger;
  now(): number;
  /** True when this machine is the one that issues revisions. */
  isMaster(): boolean;
  groupState(): GroupStateDocument | null;
  nodeKeys(): NodeKeyMaterial | null;
  config(): ReplicatedConfigStore | null;
  secrets(): ReplicatedSecretStore | null;
  /** Send an already-built group message. */
  send(type: string, body: Record<string, unknown>): Promise<void>;
  /** Persist the replica document alongside the roster. */
  persist(document: ConfigReplicaDocument): void;
}

/** What `cluster status` reports about replication. Never a value. */
export interface ConfigReplicationStatus {
  readonly revision: number;
  readonly entries: number;
  readonly secrets: number;
  readonly tombstones: number;
  readonly lastAppliedFrom: string | null;
  readonly lastAppliedAt: number | null;
  readonly pendingProposals: number;
}

export class ConfigReplicationService {
  private document: ConfigReplicaDocument;
  private lastAppliedFrom: string | null = null;
  private lastAppliedAt: number | null = null;
  private pendingProposals = 0;

  constructor(private readonly host: ConfigReplicationHost, groupId: string) {
    this.document = createConfigReplicaDocument(groupId);
  }

  /** Adopt a document read back from disk, or from a group this node just joined. */
  adopt(document: ConfigReplicaDocument): void {
    this.document = document;
  }

  get replica(): ConfigReplicaDocument {
    return this.document;
  }

  status(): ConfigReplicationStatus {
    return {
      revision: this.document.revision,
      entries: this.document.entries.filter((entry) => !entry.secret).length,
      secrets: this.document.entries.filter((entry) => entry.secret).length,
      tombstones: this.document.tombstones.length,
      lastAppliedFrom: this.lastAppliedFrom,
      lastAppliedAt: this.lastAppliedAt,
      pendingProposals: this.pendingProposals,
    };
  }

  // ── reconciling this machine's own config into the replica ────────────────

  /**
   * Fold local changes into the replica, and broadcast them.
   *
   * Runs on the master only. It is a reconcile rather than a change hook
   * because the config manager has no change event: comparing the replica
   * against what is actually on disk catches an edit made through any path at
   * all, including one made while this process was not running.
   */
  async reconcileLocalConfig(): Promise<void> {
    if (!this.host.isMaster()) return;
    const config = this.host.config();
    if (!config) return;

    let document = this.document;
    const changed: string[] = [];
    const deleted = new Set(document.tombstones.map((entry) => entry.path));
    for (const path of listReplicatedConfigPaths()) {
      // A path the group DELETED is never picked back up by a reconcile. A
      // local value can outlive the deletion, a store with no reset, or a
      // value written back by something else, and folding it in again would
      // undo the operator's deletion on the next housekeeping tick, which is
      // exactly what this loop did before the rule existed. Re-adding is an
      // explicit act: `announceLocalChange` clears the tombstone.
      if (deleted.has(path)) continue;
      const value = config.get(path);
      if (!isReplicableValue(value)) continue;
      const entry = findReplicaEntry(document, path);
      if (entry && JSON.stringify(entry.value) === JSON.stringify(value)) continue;
      document = putReplicaEntry(document, {
        path,
        value,
        origin: this.host.nodeId,
        at: this.host.now(),
      });
      changed.push(path);
    }
    if (changed.length === 0) return;
    this.document = document;
    this.host.persist(document);
    await this.broadcastDelta(changed);
  }

  /**
   * Record an operator edit made on this machine, wherever it lands.
   *
   * On the master this writes the path EXPLICITLY rather than going through the
   * reconcile, because the reconcile deliberately skips anything the group has
   * deleted. Setting a deleted path again is the operator undoing the deletion,
   * and this is the only path that can.
   */
  async announceLocalChange(path: string): Promise<void> {
    if (!isReplicatedConfigPath(path)) return;
    const config = this.host.config();
    if (this.host.isMaster()) {
      const current = config?.get(path);
      if (!isReplicableValue(current)) return;
      this.document = putReplicaEntry(this.document, {
        path,
        value: current,
        origin: this.host.nodeId,
        at: this.host.now(),
      });
      this.host.persist(this.document);
      await this.broadcastDelta([path]);
      return;
    }
    const value = config?.get(path);
    if (!isReplicableValue(value)) return;
    // Not the master, so this is a proposal rather than a change. The master
    // issues the revision and broadcasts it back; that is what keeps a single
    // writer in the normal case.
    this.pendingProposals += 1;
    await this.host.send(CONFIG_MESSAGE_TYPES.propose, { path, value, secret: false });
  }

  /** Replicate a secret the operator set on this machine. */
  async announceLocalSecret(configPath: string): Promise<void> {
    if (!isReplicatedConfigPath(configPath)) return;
    const secrets = this.host.secrets();
    if (!secrets) return;
    const secretKey = replicatedSecretKeyFor(configPath);
    const value = await secrets.get(secretKey);
    if (value === null) return;
    if (!this.host.isMaster()) {
      this.pendingProposals += 1;
      await this.sendSealed(CONFIG_MESSAGE_TYPES.propose, configPath, value);
      return;
    }
    await this.publishSecret(configPath, value);
  }

  /** Delete a setting across the group. */
  async announceLocalDelete(path: string, secret = false): Promise<void> {
    if (!isReplicatedConfigPath(path) || !this.host.isMaster()) return;
    this.document = deleteReplicaEntry(this.document, {
      path,
      origin: this.host.nodeId,
      at: this.host.now(),
      secret,
    });
    // Clear it here too, where the store can. A deletion the operator made on
    // the group should not leave this machine still running the old value.
    this.host.config()?.reset?.(path);
    if (secret) await this.host.secrets()?.delete(replicatedSecretKeyFor(path));
    this.host.persist(this.document);
    await this.host.send(CONFIG_MESSAGE_TYPES.delta, {
      deletes: [{ path, revision: this.document.revision, origin: this.host.nodeId, at: this.host.now(), secret }],
    });
  }

  // ── sending ───────────────────────────────────────────────────────────────

  private async broadcastDelta(paths: readonly string[]): Promise<void> {
    const entries = this.document.entries.filter((entry) => paths.includes(entry.path) && !entry.secret);
    if (entries.length === 0) return;
    await this.host.send(CONFIG_MESSAGE_TYPES.delta, { entries });
  }

  /**
   * Record a secret in the replica and send it, sealed per member.
   *
   * The document holds only the fact that the path has a secret at a revision.
   * The value itself never lands in the document, so it is never written to the
   * replica file and never appears in a snapshot that is not individually
   * sealed.
   */
  private async publishSecret(configPath: string, value: string): Promise<void> {
    this.document = putReplicaEntry(this.document, {
      path: configPath,
      value: { secretRevision: this.document.revision + 1 },
      origin: this.host.nodeId,
      at: this.host.now(),
      secret: true,
    });
    this.host.persist(this.document);
    await this.sendSealed(CONFIG_MESSAGE_TYPES.delta, configPath, value);
  }

  /** Seal `value` to every current member and send it. */
  private async sendSealed(type: string, configPath: string, value: string): Promise<void> {
    const members = this.host.groupState()?.members ?? [];
    const sealed: Record<string, unknown> = {};
    for (const member of members) {
      if (member.nodeId === this.host.nodeId) continue;
      sealed[member.nodeId] = sealForMember(member.agreementKey, value, SECRET_SEAL_CONTEXT);
    }
    if (Object.keys(sealed).length === 0) return;
    await this.host.send(type, {
      secretPath: configPath,
      revision: this.document.revision,
      sealed,
    });
  }

  /** Ask the group for everything. Sent by a machine that has just joined. */
  async requestSnapshot(): Promise<void> {
    await this.host.send(CONFIG_MESSAGE_TYPES.request, {});
  }

  // ── receiving ─────────────────────────────────────────────────────────────

  /** Route a config-replication datagram that already verified under the group key. */
  async handle(envelope: ClusterEnvelope): Promise<void> {
    switch (envelope.type) {
      case CONFIG_MESSAGE_TYPES.request:
        await this.onRequest(envelope);
        return;
      case CONFIG_MESSAGE_TYPES.snapshot:
        await this.onSnapshot(envelope);
        return;
      case CONFIG_MESSAGE_TYPES.delta:
        await this.onDelta(envelope);
        return;
      case CONFIG_MESSAGE_TYPES.propose:
        await this.onPropose(envelope);
        return;
      default:
    }
  }

  private async onRequest(envelope: ClusterEnvelope): Promise<void> {
    if (!this.host.isMaster() || envelope.nodeId === this.host.nodeId) return;
    await this.host.send(CONFIG_MESSAGE_TYPES.snapshot, { document: this.document });
    // Secrets are not in the document, so each one is sent sealed to the asker.
    const secrets = this.host.secrets();
    const member = this.host.groupState()?.members.find((entry) => entry.nodeId === envelope.nodeId);
    if (!secrets || !member) return;
    for (const entry of this.document.entries.filter((candidate) => candidate.secret)) {
      const value = await secrets.get(replicatedSecretKeyFor(entry.path));
      if (value === null) continue;
      await this.host.send(CONFIG_MESSAGE_TYPES.delta, {
        secretPath: entry.path,
        revision: entry.revision,
        sealed: { [member.nodeId]: sealForMember(member.agreementKey, value, SECRET_SEAL_CONTEXT) },
      });
    }
  }

  private async onSnapshot(envelope: ClusterEnvelope): Promise<void> {
    if (envelope.nodeId === this.host.nodeId) return;
    const incoming = readConfigReplicaDocument(envelope.body['document'], isReplicatedConfigPath);
    if (!incoming) {
      this.host.logger.debug('cluster: a config snapshot did not parse and was ignored', {
        from: envelope.nodeId,
      });
      return;
    }
    const merged = mergeConfigReplica(this.document, incoming);
    await this.applyDocument(merged, envelope.nodeId);
  }

  private async onDelta(envelope: ClusterEnvelope): Promise<void> {
    if (envelope.nodeId === this.host.nodeId) return;
    if (typeof envelope.body['secretPath'] === 'string') {
      await this.applySealedSecret(envelope);
      return;
    }
    const incoming = readConfigReplicaDocument(
      {
        version: 1,
        groupId: this.document.groupId,
        revision: this.document.revision,
        entries: envelope.body['entries'] ?? [],
        tombstones: envelope.body['deletes'] ?? [],
      },
      isReplicatedConfigPath,
    );
    if (!incoming) return;
    await this.applyDocument(mergeConfigReplica(this.document, incoming), envelope.nodeId);
  }

  /**
   * A proposal from a machine that is not the master.
   *
   * Only the master acts on one, and it re-derives the value from its own
   * policy check before issuing a revision, a peer does not get to name a path
   * this machine would not have replicated itself.
   */
  private async onPropose(envelope: ClusterEnvelope): Promise<void> {
    if (!this.host.isMaster() || envelope.nodeId === this.host.nodeId) return;
    if (typeof envelope.body['secretPath'] === 'string') {
      const opened = this.openSealed(envelope);
      const path = envelope.body['secretPath'];
      if (opened === null || !isReplicatedConfigPath(path)) return;
      const secrets = this.host.secrets();
      if (!secrets) return;
      await secrets.set(replicatedSecretKeyFor(path), opened);
      this.logApplied(path, envelope.nodeId, true);
      await this.publishSecret(path, opened);
      return;
    }
    const path = envelope.body['path'];
    const value = envelope.body['value'];
    if (typeof path !== 'string' || !isReplicatedConfigPath(path) || !isReplicableValue(value)) return;
    const config = this.host.config();
    if (!config) return;
    config.set(path, value);
    this.logApplied(path, envelope.nodeId, false);
    await this.reconcileLocalConfig();
  }

  private openSealed(envelope: ClusterEnvelope): string | null {
    const keys = this.host.nodeKeys();
    const sealed = envelope.body['sealed'];
    if (!keys || typeof sealed !== 'object' || sealed === null) return null;
    const forThisNode = (sealed as Record<string, unknown>)[this.host.nodeId];
    if (!forThisNode) return null;
    return openSealedEnvelope(
      keys.agreement,
      forThisNode as Parameters<typeof openSealedEnvelope>[1],
      SECRET_SEAL_CONTEXT,
    );
  }

  /**
   * Take a credential handed over by the group.
   *
   * The plaintext goes straight into this machine's OWN secret store, which
   * encrypts it under this machine's OWN keyfile. Another node's ciphertext is
   * never written verbatim, it could not be read back here anyway, and storing
   * it would quietly make the group's secrets undecryptable after a keyfile
   * rotation on one machine.
   */
  private async applySealedSecret(envelope: ClusterEnvelope): Promise<void> {
    const path = envelope.body['secretPath'];
    if (typeof path !== 'string' || !isReplicatedConfigPath(path)) return;
    const secrets = this.host.secrets();
    const opened = this.openSealed(envelope);
    if (!secrets || opened === null) return;
    const secretKey = replicatedSecretKeyFor(path);
    if (!isReplicatedSecretKey(secretKey)) return;
    await secrets.set(secretKey, opened);
    const revision = envelope.body['revision'];
    this.document = putReplicaEntry(this.document, {
      path,
      value: { secretRevision: typeof revision === 'number' ? revision : this.document.revision + 1 },
      origin: envelope.nodeId,
      at: this.host.now(),
      secret: true,
    });
    this.host.persist(this.document);
    this.logApplied(path, envelope.nodeId, true);
  }

  /** Apply a merged document to this machine's config, then persist it. */
  private async applyDocument(merged: ConfigReplicaDocument, from: string): Promise<void> {
    const config = this.host.config();
    if (!config) return;
    const before = this.document;
    this.document = merged;
    this.host.persist(merged);

    for (const entry of merged.entries) {
      if (entry.secret) continue;
      const existing = findReplicaEntry(before, entry.path);
      if (existing && existing.revision === entry.revision) continue;
      if (JSON.stringify(config.get(entry.path)) === JSON.stringify(entry.value)) continue;
      try {
        config.set(entry.path, entry.value);
        this.logApplied(entry.path, entry.origin, false);
      } catch (error) {
        // A value this build's validator refuses is dropped, loudly, rather
        // than throwing away the rest of the snapshot with it.
        this.host.logger.warn('cluster: a replicated setting was refused by this build and was not applied', {
          path: entry.path,
          origin: entry.origin,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const tombstone of merged.tombstones) {
      if (!before.tombstones.some((entry) => entry.path === tombstone.path
        && entry.revision === tombstone.revision)) {
        this.host.logger.info('cluster: a setting was deleted by another machine in the group', {
          path: tombstone.path,
          origin: tombstone.origin,
        });
      }
      if (tombstone.secret) await this.host.secrets()?.delete(replicatedSecretKeyFor(tombstone.path));
      else config.reset?.(tombstone.path);
    }
    this.lastAppliedFrom = from;
    this.lastAppliedAt = this.host.now();
    this.pendingProposals = 0;
  }

  /**
   * Every peer-sourced change is logged with the node it came from.
   *
   * A value is never logged, whether or not it is a secret: a replicated
   * surface token and a replicated surface id are equally nobody's business in
   * a log file, and the path plus the origin is what an operator actually needs
   * to answer "why did this machine change".
   */
  private logApplied(path: string, origin: string, secret: boolean): void {
    this.host.logger.info('cluster: applied a setting from another machine in the group', {
      path,
      origin,
      kind: secret ? 'credential' : 'setting',
    });
  }

  /** Bound the document. Called from the group runtime's housekeeping pass. */
  sweep(now: number): void {
    const swept = sweepConfigReplica(this.document, now);
    if (swept.droppedTombstones === 0) return;
    this.document = swept.document;
    this.host.persist(swept.document);
    this.host.logger.debug('cluster: expired old replicated-setting deletions', {
      dropped: swept.droppedTombstones,
    });
  }

  /**
   * True while this machine still has nothing and is not the one issuing
   * revisions, the condition under which it should keep asking.
   *
   * Asking again is how a snapshot that was missed because the master was busy,
   * or was sent while this machine was still starting, is recovered. It costs
   * one small datagram per housekeeping pass and stops the moment anything
   * arrives.
   */
  get needsSnapshot(): boolean {
    return !this.host.isMaster() && this.document.revision === 0;
  }

  /**
   * Anti-entropy: another member says it is at `revision`.
   *
   * A machine that was partitioned when a change went out never receives that
   * delta, and nothing else would ever tell it. Every roster gossip carries the
   * sender's revision, so a machine that is behind notices on the next one and
   * asks for a snapshot, which carries the DELETIONS as well as the values,
   * and is therefore what stops a healed partition from running settings the
   * operator removed while it was away.
   */
  async notePeerRevision(revision: number): Promise<void> {
    if (!Number.isFinite(revision) || revision <= this.document.revision) return;
    if (this.host.isMaster()) return;
    await this.requestSnapshot();
  }
}
