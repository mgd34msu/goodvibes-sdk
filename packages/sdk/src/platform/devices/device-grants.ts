/**
 * device-grants.ts — durable "always allow" grants for paired-device capabilities.
 *
 * The owner's ruling (2026-07-25): "'always allow' is OFFERED on every
 * capability — including front camera, screen capture, precise location, and
 * clipboard — as a durable per-capability, per-node grant, visible and
 * revocable in the grants surface." This store is that durable record.
 *
 * A grant is a positive authority and nothing else: if no live, unexpired,
 * unrevoked grant is found, the capability is confirmed with the person. There
 * is no cached "yes" anywhere else in the system, so revocation takes effect on
 * the very next request — the store is re-read from disk on every lookup rather
 * than served from a process-local cache that a second process could not
 * invalidate.
 *
 * Persisted state, so the housekeeping rule applies in full:
 *  1. Reap on recovery — grants for a node that no longer exists, and
 *     session-scoped grants whose session is gone, are removed at load time.
 *  2. Bound everything — per-node count cap AND an age TTL; the audit ledger
 *     has its own cap and TTL.
 *  3. Validate by content — every record is re-validated against its parsed
 *     shape and the live capability catalog; a torn or half-written record is
 *     dropped, never honoured.
 *  4. Reap periodically — `sweep()` is safe to call on a timer, not only at boot.
 *  5. Disclose what was reaped — every sweep returns an itemised report, and
 *     the removals are appended to the audit ledger the grants surface renders.
 *
 * Sweeps are idempotent and safe to run from more than one process: each one
 * re-reads the file, recomputes removals from scratch, and writes atomically.
 */
import { randomUUID } from 'node:crypto';
import { PersistentStore } from '../state/persistent-store.js';
import { isDeviceCapabilityId, type DeviceCapabilityId, type DeviceNodeKind } from './device-capability-contract.js';

/** Scope of an approval a person gave. */
export type DeviceGrantScope = 'always' | 'session';

/** A durable per-capability, per-node approval. */
export interface DeviceCapabilityGrant {
  readonly id: string;
  readonly nodeId: string;
  readonly nodeKind: DeviceNodeKind;
  readonly capabilityId: DeviceCapabilityId;
  readonly scope: DeviceGrantScope;
  /** Present only for session-scoped grants; reaped when the session is gone. */
  readonly sessionId?: string | undefined;
  readonly grantedAt: number;
  /** Age TTL. Every grant has one — nothing is granted forever. */
  readonly expiresAt: number;
  readonly lastUsedAt?: number | undefined;
  readonly useCount: number;
  /** Who approved it (operator id / surface actor). */
  readonly grantedBy: string;
}

/** Why a grant left the store. */
export type DeviceGrantRemovalReason =
  | 'revoked'
  | 'expired'
  | 'node-gone'
  | 'session-gone'
  | 'malformed'
  | 'per-node-cap'
  | 'total-cap';

/** One removal, itemised for disclosure. */
export interface DeviceGrantRemoval {
  readonly grantId: string;
  readonly nodeId: string;
  readonly capabilityId: string;
  readonly scope: string;
  readonly reason: DeviceGrantRemovalReason;
  readonly removedAt: number;
  readonly note?: string | undefined;
}

/** Bounded ledger entry so a surface can show what happened and why. */
export interface DeviceGrantAuditRecord {
  readonly id: string;
  readonly action: 'granted' | 'used' | 'removed';
  readonly grantId: string;
  readonly nodeId: string;
  readonly capabilityId: string;
  readonly at: number;
  readonly actor: string;
  readonly reason?: string | undefined;
}

interface DeviceGrantSnapshot extends Record<string, unknown> {
  readonly version: 1;
  readonly grants: readonly DeviceCapabilityGrant[];
  readonly audit: readonly DeviceGrantAuditRecord[];
}

/** Result of one housekeeping pass over the grant store. */
export interface DeviceGrantSweepReport {
  readonly sweptAt: number;
  readonly removed: readonly DeviceGrantRemoval[];
  readonly retained: number;
  readonly auditTrimmed: number;
}

export interface DeviceGrantPolicy {
  /** Age TTL applied when a grant is recorded. */
  readonly grantTtlMs: number;
  /** Count cap per node; oldest grants past the cap are reaped. */
  readonly maxGrantsPerNode: number;
  /** Absolute count cap across all nodes. */
  readonly maxGrantsTotal: number;
  /** Age TTL for the audit ledger. */
  readonly auditRetentionMs: number;
  /** Count cap for the audit ledger. */
  readonly maxAuditRecords: number;
}

export const DEFAULT_DEVICE_GRANT_POLICY: DeviceGrantPolicy = {
  grantTtlMs: 90 * 24 * 60 * 60 * 1000,
  maxGrantsPerNode: 64,
  maxGrantsTotal: 512,
  auditRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxAuditRecords: 500,
};

/**
 * Liveness probes the sweep uses to decide whether a grant's owner still
 * exists. Both default to "still there" so a caller that cannot answer never
 * causes silent data loss.
 */
export interface DeviceGrantOwnership {
  readonly isKnownNode?: ((nodeId: string) => boolean) | undefined;
  readonly isActiveSession?: ((sessionId: string) => boolean) | undefined;
}

export interface DeviceGrantStoreOptions {
  readonly policy?: Partial<DeviceGrantPolicy> | undefined;
  readonly now?: (() => number) | undefined;
  readonly ownership?: DeviceGrantOwnership | undefined;
}

const EMPTY_SNAPSHOT: DeviceGrantSnapshot = { version: 1, grants: [], audit: [] };

/**
 * Validate a grant by its parsed content, not by its presence in the file. A
 * crash mid-write, a truncated array, or a capability that no longer exists all
 * produce a record that must be dropped rather than honoured.
 */
function validateGrant(value: unknown): DeviceCapabilityGrant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const nodeId = typeof record.nodeId === 'string' ? record.nodeId.trim() : '';
  const nodeKind = typeof record.nodeKind === 'string' ? record.nodeKind.trim() : '';
  const capabilityId = record.capabilityId;
  const scope = record.scope;
  const grantedAt = record.grantedAt;
  const expiresAt = record.expiresAt;
  const useCount = record.useCount;
  const grantedBy = typeof record.grantedBy === 'string' ? record.grantedBy.trim() : '';
  if (!id || !nodeId || !nodeKind || !grantedBy) return null;
  if (!isDeviceCapabilityId(capabilityId)) return null;
  if (scope !== 'always' && scope !== 'session') return null;
  if (typeof grantedAt !== 'number' || !Number.isFinite(grantedAt)) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  if (typeof useCount !== 'number' || !Number.isInteger(useCount) || useCount < 0) return null;
  const sessionId = typeof record.sessionId === 'string' && record.sessionId.trim() ? record.sessionId.trim() : undefined;
  if (scope === 'session' && !sessionId) return null;
  const lastUsedAt = typeof record.lastUsedAt === 'number' && Number.isFinite(record.lastUsedAt) ? record.lastUsedAt : undefined;
  return {
    id,
    nodeId,
    nodeKind,
    capabilityId,
    scope,
    ...(sessionId ? { sessionId } : {}),
    grantedAt,
    expiresAt,
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
    useCount,
    grantedBy,
  };
}

function validateAudit(value: unknown): DeviceGrantAuditRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const action = record.action;
  if (action !== 'granted' && action !== 'used' && action !== 'removed') return null;
  const id = typeof record.id === 'string' ? record.id : '';
  const at = record.at;
  if (!id || typeof at !== 'number' || !Number.isFinite(at)) return null;
  return {
    id,
    action,
    grantId: typeof record.grantId === 'string' ? record.grantId : '',
    nodeId: typeof record.nodeId === 'string' ? record.nodeId : '',
    capabilityId: typeof record.capabilityId === 'string' ? record.capabilityId : '',
    at,
    actor: typeof record.actor === 'string' ? record.actor : 'unknown',
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
  };
}

/**
 * Durable grant store. Every read re-loads from disk so a revocation written by
 * another process (the webui grants surface, say) is honoured immediately.
 */
export class DeviceGrantStore {
  private readonly store: PersistentStore<DeviceGrantSnapshot>;
  private readonly policy: DeviceGrantPolicy;
  private readonly now: () => number;
  private readonly ownership: DeviceGrantOwnership;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(storeOrPath: PersistentStore<DeviceGrantSnapshot> | string, options: DeviceGrantStoreOptions = {}) {
    this.store = typeof storeOrPath === 'string'
      ? new PersistentStore<DeviceGrantSnapshot>(storeOrPath)
      : storeOrPath;
    this.policy = { ...DEFAULT_DEVICE_GRANT_POLICY, ...(options.policy ?? {}) };
    this.now = options.now ?? (() => Date.now());
    this.ownership = options.ownership ?? {};
  }

  /** Effective policy after option merge — surfaced so callers can render it. */
  getPolicy(): DeviceGrantPolicy {
    return this.policy;
  }

  private async readWithDrops(): Promise<{ snapshot: DeviceGrantSnapshot; malformed: number }> {
    const raw = await this.store.load();
    if (!raw || typeof raw !== 'object') return { snapshot: EMPTY_SNAPSHOT, malformed: 0 };
    const rawGrants = Array.isArray(raw.grants) ? raw.grants : [];
    const grants = rawGrants
      .map(validateGrant)
      .filter((entry): entry is DeviceCapabilityGrant => entry !== null);
    const audit = Array.isArray(raw.audit)
      ? raw.audit.map(validateAudit).filter((entry): entry is DeviceGrantAuditRecord => entry !== null)
      : [];
    return { snapshot: { version: 1, grants, audit }, malformed: rawGrants.length - grants.length };
  }

  private async read(): Promise<DeviceGrantSnapshot> {
    return (await this.readWithDrops()).snapshot;
  }

  /** Serialise writes within this process; across processes the write is atomic. */
  private async mutate<T>(
    fn: (snapshot: DeviceGrantSnapshot, malformed: number) => Promise<{ next: DeviceGrantSnapshot; result: T }>,
  ): Promise<T> {
    const run = this.writeChain.then(async () => {
      const { snapshot, malformed } = await this.readWithDrops();
      const { next, result } = await fn(snapshot, malformed);
      await this.store.persist(next);
      return result;
    });
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Every grant currently on disk, after dropping malformed and expired ones.
   * Expired records are filtered here as well as reaped by `sweep()`, so an
   * expired grant can never be honoured even between sweeps.
   */
  async list(): Promise<readonly DeviceCapabilityGrant[]> {
    const snapshot = await this.read();
    const now = this.now();
    return snapshot.grants.filter((grant) => grant.expiresAt > now);
  }

  /** The audit ledger, newest last. */
  async listAudit(limit = 100): Promise<readonly DeviceGrantAuditRecord[]> {
    const snapshot = await this.read();
    return snapshot.audit.slice(-Math.max(1, limit));
  }

  /**
   * Find a live grant authorising this capability on this node, or null.
   *
   * Returns null for anything revoked (the record is gone), expired, or scoped
   * to a session that is no longer active — a revoked or expired grant is never
   * silently honoured.
   */
  async find(input: {
    readonly nodeId: string;
    readonly capabilityId: DeviceCapabilityId;
    readonly sessionId?: string | undefined;
  }): Promise<DeviceCapabilityGrant | null> {
    const now = this.now();
    const grants = await this.list();
    const matches = grants.filter((grant) => grant.nodeId === input.nodeId && grant.capabilityId === input.capabilityId);
    for (const grant of matches) {
      if (grant.expiresAt <= now) continue;
      if (grant.scope === 'session') {
        if (!input.sessionId || grant.sessionId !== input.sessionId) continue;
        if (this.ownership.isActiveSession && !this.ownership.isActiveSession(grant.sessionId)) continue;
      }
      return grant;
    }
    return null;
  }

  /** Record an approval. Re-granting an existing pair refreshes it rather than duplicating. */
  async record(input: {
    readonly nodeId: string;
    readonly nodeKind: DeviceNodeKind;
    readonly capabilityId: DeviceCapabilityId;
    readonly scope: DeviceGrantScope;
    readonly sessionId?: string | undefined;
    readonly grantedBy: string;
    readonly ttlMs?: number | undefined;
  }): Promise<DeviceCapabilityGrant> {
    const now = this.now();
    const ttl = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : this.policy.grantTtlMs;
    return this.mutate(async (snapshot) => {
      const kept = snapshot.grants.filter((grant) => !(
        grant.nodeId === input.nodeId
        && grant.capabilityId === input.capabilityId
        && grant.scope === input.scope
        && grant.sessionId === input.sessionId
      ));
      const grant: DeviceCapabilityGrant = {
        id: randomUUID(),
        nodeId: input.nodeId,
        nodeKind: input.nodeKind,
        capabilityId: input.capabilityId,
        scope: input.scope,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        grantedAt: now,
        expiresAt: now + ttl,
        useCount: 0,
        grantedBy: input.grantedBy,
      };
      const audit: DeviceGrantAuditRecord = {
        id: randomUUID(),
        action: 'granted',
        grantId: grant.id,
        nodeId: grant.nodeId,
        capabilityId: grant.capabilityId,
        at: now,
        actor: input.grantedBy,
        reason: `always-allow (${input.scope})`,
      };
      return {
        next: { version: 1, grants: [...kept, grant], audit: [...snapshot.audit, audit] },
        result: grant,
      };
    });
  }

  /** Note a use of a grant (drives "last used" in the grants surface). */
  async markUsed(grantId: string): Promise<void> {
    const now = this.now();
    await this.mutate(async (snapshot) => {
      const existing = snapshot.grants.find((grant) => grant.id === grantId);
      if (!existing) return { next: snapshot, result: undefined };
      const used: DeviceCapabilityGrant = { ...existing, lastUsedAt: now, useCount: existing.useCount + 1 };
      const grants = snapshot.grants.map((grant) => (grant.id === grantId ? used : grant));
      const audit: DeviceGrantAuditRecord = {
        id: randomUUID(),
        action: 'used',
        grantId: used.id,
        nodeId: used.nodeId,
        capabilityId: used.capabilityId,
        at: now,
        actor: used.grantedBy,
      };
      return { next: { version: 1, grants, audit: [...snapshot.audit, audit] }, result: undefined };
    });
  }

  /**
   * Revoke grants. The matching records are DELETED, not flagged — there is no
   * "revoked but present" state a later read could mistake for authority.
   * Returns the itemised removals for disclosure.
   */
  async revoke(input: {
    readonly grantId?: string | undefined;
    readonly nodeId?: string | undefined;
    readonly capabilityId?: DeviceCapabilityId | undefined;
    readonly actor: string;
    readonly note?: string | undefined;
  }): Promise<readonly DeviceGrantRemoval[]> {
    const now = this.now();
    return this.mutate(async (snapshot) => {
      const removals: DeviceGrantRemoval[] = [];
      const kept: DeviceCapabilityGrant[] = [];
      for (const grant of snapshot.grants) {
        const matches =
          (input.grantId ? grant.id === input.grantId : true)
          && (input.nodeId ? grant.nodeId === input.nodeId : true)
          && (input.capabilityId ? grant.capabilityId === input.capabilityId : true)
          && Boolean(input.grantId ?? input.nodeId ?? input.capabilityId);
        if (!matches) {
          kept.push(grant);
          continue;
        }
        removals.push({
          grantId: grant.id,
          nodeId: grant.nodeId,
          capabilityId: grant.capabilityId,
          scope: grant.scope,
          reason: 'revoked',
          removedAt: now,
          ...(input.note ? { note: input.note } : {}),
        });
      }
      const audit = [
        ...snapshot.audit,
        ...removals.map((removal): DeviceGrantAuditRecord => ({
          id: randomUUID(),
          action: 'removed',
          grantId: removal.grantId,
          nodeId: removal.nodeId,
          capabilityId: removal.capabilityId,
          at: now,
          actor: input.actor,
          reason: 'revoked',
        })),
      ];
      return { next: { version: 1, grants: kept, audit }, result: removals };
    });
  }

  /**
   * One housekeeping pass. Safe at recovery, safe on a timer, safe concurrently
   * — it recomputes every removal from the file it just read and writes the
   * result atomically, so running it twice removes nothing extra.
   */
  async sweep(): Promise<DeviceGrantSweepReport> {
    const now = this.now();
    return this.mutate(async (snapshot, malformedCount) => {
      const removals: DeviceGrantRemoval[] = [];
      if (malformedCount > 0) {
        removals.push({
          grantId: '(unreadable)',
          nodeId: '(unknown)',
          capabilityId: '(unknown)',
          scope: '(unknown)',
          reason: 'malformed',
          removedAt: now,
          note: `${malformedCount} grant record(s) failed content validation and were dropped`,
        });
      }

      const surviving: DeviceCapabilityGrant[] = [];
      for (const grant of snapshot.grants) {
        if (grant.expiresAt <= now) {
          removals.push({ grantId: grant.id, nodeId: grant.nodeId, capabilityId: grant.capabilityId, scope: grant.scope, reason: 'expired', removedAt: now });
          continue;
        }
        if (this.ownership.isKnownNode && !this.ownership.isKnownNode(grant.nodeId)) {
          removals.push({ grantId: grant.id, nodeId: grant.nodeId, capabilityId: grant.capabilityId, scope: grant.scope, reason: 'node-gone', removedAt: now });
          continue;
        }
        if (grant.scope === 'session' && grant.sessionId && this.ownership.isActiveSession && !this.ownership.isActiveSession(grant.sessionId)) {
          removals.push({ grantId: grant.id, nodeId: grant.nodeId, capabilityId: grant.capabilityId, scope: grant.scope, reason: 'session-gone', removedAt: now });
          continue;
        }
        surviving.push(grant);
      }

      const byNode = new Map<string, DeviceCapabilityGrant[]>();
      for (const grant of surviving) {
        const bucket = byNode.get(grant.nodeId);
        if (bucket) bucket.push(grant);
        else byNode.set(grant.nodeId, [grant]);
      }
      const capped: DeviceCapabilityGrant[] = [];
      for (const [, bucket] of byNode) {
        bucket.sort((a, b) => a.grantedAt - b.grantedAt);
        const overflow = bucket.length - this.policy.maxGrantsPerNode;
        for (let index = 0; index < bucket.length; index += 1) {
          const grant = bucket[index];
          if (!grant) continue;
          if (index < overflow) {
            removals.push({ grantId: grant.id, nodeId: grant.nodeId, capabilityId: grant.capabilityId, scope: grant.scope, reason: 'per-node-cap', removedAt: now });
            continue;
          }
          capped.push(grant);
        }
      }
      capped.sort((a, b) => a.grantedAt - b.grantedAt);
      const totalOverflow = capped.length - this.policy.maxGrantsTotal;
      const finalGrants: DeviceCapabilityGrant[] = [];
      for (let index = 0; index < capped.length; index += 1) {
        const grant = capped[index];
        if (!grant) continue;
        if (index < totalOverflow) {
          removals.push({ grantId: grant.id, nodeId: grant.nodeId, capabilityId: grant.capabilityId, scope: grant.scope, reason: 'total-cap', removedAt: now });
          continue;
        }
        finalGrants.push(grant);
      }

      const auditCutoff = now - this.policy.auditRetentionMs;
      const auditWithRemovals = [
        ...snapshot.audit,
        ...removals
          .filter((removal) => removal.grantId !== '(unreadable)')
          .map((removal): DeviceGrantAuditRecord => ({
            id: randomUUID(),
            action: 'removed',
            grantId: removal.grantId,
            nodeId: removal.nodeId,
            capabilityId: removal.capabilityId,
            at: now,
            actor: 'housekeeping',
            reason: removal.reason,
          })),
      ];
      const auditAged = auditWithRemovals.filter((entry) => entry.at >= auditCutoff);
      const auditFinal = auditAged.slice(-this.policy.maxAuditRecords);
      const auditTrimmed = auditWithRemovals.length - auditFinal.length;

      return {
        next: { version: 1, grants: finalGrants, audit: auditFinal },
        result: {
          sweptAt: now,
          removed: removals,
          retained: finalGrants.length,
          auditTrimmed: Math.max(0, auditTrimmed),
        } satisfies DeviceGrantSweepReport,
      };
    });
  }
}
