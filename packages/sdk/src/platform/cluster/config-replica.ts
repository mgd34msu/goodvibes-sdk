/**
 * config-replica.ts, the replicated settings document, and how two copies of
 * it are reconciled.
 *
 * ── ORDERING IS NOT A CLOCK ────────────────────────────────────────────────
 *
 * Nothing here compares timestamps to decide what wins. Two homelab machines
 * routinely disagree about the time by minutes, neither is obliged to run NTP,
 * and a last-write-wins rule keyed on wall clock would let the machine with the
 * fastest clock win every conflict permanently, including winning against a
 * deletion made afterwards on a correct clock.
 *
 * Ordering is a REVISION: a counter the master increments. Higher revision
 * wins. At an equal revision, which only a partition with two masters can
 * produce, a deletion beats a write, and two writes are settled by origin node
 * id so both sides of a heal land on the same answer without negotiating.
 *
 * `at` is recorded because an operator reading `cluster status` wants to know
 * when something changed. It is never consulted to decide what wins, and it
 * must not start being.
 */

/** One replicated setting. */
export interface ConfigReplicaEntry {
  readonly path: string;
  /** JSON value for a config path; for a secret, the ciphertext is never here. */
  readonly value: unknown;
  readonly revision: number;
  /** The node that originated the change, logged, and the equal-revision tiebreak. */
  readonly origin: string;
  /** Wall clock, for display only. Never used for ordering. */
  readonly at: number;
  /** True when the value lives in the secret store rather than in config. */
  readonly secret: boolean;
}

/**
 * A deletion.
 *
 * The same discipline the roster uses for a removed machine, and for the same
 * reason: absence is indistinguishable from "not learned yet", so a deletion has
 * to be a positive fact that survives a merge. Without this, a machine that was
 * partitioned when the operator deleted a surface would helpfully put it back.
 */
export interface ConfigReplicaTombstone {
  readonly path: string;
  readonly revision: number;
  readonly origin: string;
  readonly at: number;
  readonly secret: boolean;
}

export interface ConfigReplicaDocument {
  readonly version: 1;
  readonly groupId: string;
  /** Highest revision this copy has issued or seen. */
  readonly revision: number;
  readonly entries: readonly ConfigReplicaEntry[];
  readonly tombstones: readonly ConfigReplicaTombstone[];
}

/**
 * Bounds. Persisted, replicated state that can only grow is a slow leak, and
 * one that arrives over the network is a leak someone else can drive.
 */
export const MAX_REPLICATED_ENTRIES = 512;
export const MAX_REPLICATED_TOMBSTONES = 256;
export const CONFIG_TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
/** A single replicated value, serialized. Comfortably past any real setting. */
export const MAX_REPLICATED_VALUE_BYTES = 16 * 1024;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True when a value is small enough and plain enough to replicate. */
export function isReplicableValue(value: unknown): boolean {
  if (value === undefined) return false;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    return false;
  }
  return serialized.length > 0 && serialized.length <= MAX_REPLICATED_VALUE_BYTES;
}

function readEntry(value: unknown): ConfigReplicaEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['path'] !== 'string' || candidate['path'].length === 0) return null;
  if (!isFiniteNumber(candidate['revision']) || candidate['revision'] < 0) return null;
  if (typeof candidate['origin'] !== 'string') return null;
  if (!isReplicableValue(candidate['value'])) return null;
  return {
    path: candidate['path'],
    value: candidate['value'],
    revision: Math.trunc(candidate['revision']),
    origin: candidate['origin'],
    at: isFiniteNumber(candidate['at']) ? Math.trunc(candidate['at']) : 0,
    secret: candidate['secret'] === true,
  };
}

function readTombstone(value: unknown): ConfigReplicaTombstone | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['path'] !== 'string' || candidate['path'].length === 0) return null;
  if (!isFiniteNumber(candidate['revision']) || candidate['revision'] < 0) return null;
  if (typeof candidate['origin'] !== 'string') return null;
  return {
    path: candidate['path'],
    revision: Math.trunc(candidate['revision']),
    origin: candidate['origin'],
    at: isFiniteNumber(candidate['at']) ? Math.trunc(candidate['at']) : 0,
    secret: candidate['secret'] === true,
  };
}

/** An empty document for a group that has replicated nothing yet. */
export function createConfigReplicaDocument(groupId: string): ConfigReplicaDocument {
  return { version: 1, groupId, revision: 0, entries: [], tombstones: [] };
}

/**
 * Parse an untrusted document, off the wire, or off disk after a crash.
 *
 * `keep` is the replication policy. Filtering on the RECEIVE side as well as
 * the send side is the point: a peer running a different build, or a modified
 * one, does not get to decide what this machine will apply to its own config.
 */
export function readConfigReplicaDocument(
  value: unknown,
  keep: (path: string) => boolean,
): ConfigReplicaDocument | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate['version'] !== 1) return null;
  if (typeof candidate['groupId'] !== 'string' || candidate['groupId'].length === 0) return null;
  const entries = (Array.isArray(candidate['entries']) ? candidate['entries'] : [])
    .map(readEntry)
    .filter((entry): entry is ConfigReplicaEntry => entry !== null && keep(entry.path));
  const tombstones = (Array.isArray(candidate['tombstones']) ? candidate['tombstones'] : [])
    .map(readTombstone)
    .filter((entry): entry is ConfigReplicaTombstone => entry !== null && keep(entry.path));
  return normalize({
    version: 1,
    groupId: candidate['groupId'],
    revision: isFiniteNumber(candidate['revision']) ? Math.max(0, Math.trunc(candidate['revision'])) : 0,
    entries,
    tombstones,
  });
}

/**
 * Deduplicate and order so two copies holding the same facts serialize
 * identically, and apply the tombstone rule.
 */
function normalize(document: ConfigReplicaDocument): ConfigReplicaDocument {
  const entries = new Map<string, ConfigReplicaEntry>();
  for (const entry of document.entries) {
    const existing = entries.get(entry.path);
    if (!existing || beats(entry, existing)) entries.set(entry.path, entry);
  }
  const tombstones = new Map<string, ConfigReplicaTombstone>();
  for (const tombstone of document.tombstones) {
    const existing = tombstones.get(tombstone.path);
    if (!existing || tombstone.revision > existing.revision) tombstones.set(tombstone.path, tombstone);
  }
  // A deletion at or above an entry's revision removes it. Equal resolves to
  // DELETED, see the header: only a two-master partition produces a tie, and
  // resolving toward the deletion is the only direction that cannot resurrect
  // something the operator removed.
  for (const [path, tombstone] of tombstones) {
    const entry = entries.get(path);
    if (entry && tombstone.revision >= entry.revision) entries.delete(path);
  }
  const bounded = [...entries.values()].sort(byPath).slice(0, MAX_REPLICATED_ENTRIES);
  return {
    ...document,
    revision: Math.max(
      document.revision,
      ...bounded.map((entry) => entry.revision),
      ...[...tombstones.values()].map((entry) => entry.revision),
      0,
    ),
    entries: bounded,
    tombstones: [...tombstones.values()].sort(byPath),
  };
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Higher revision wins; an equal revision is settled by origin, never by clock. */
function beats(candidate: ConfigReplicaEntry, incumbent: ConfigReplicaEntry): boolean {
  if (candidate.revision !== incumbent.revision) return candidate.revision > incumbent.revision;
  return candidate.origin < incumbent.origin;
}

/** Reconcile two copies. Commutative: the merge order does not change the result. */
export function mergeConfigReplica(
  local: ConfigReplicaDocument,
  remote: ConfigReplicaDocument,
): ConfigReplicaDocument {
  if (local.groupId !== remote.groupId) return local;
  return normalize({
    version: 1,
    groupId: local.groupId,
    revision: Math.max(local.revision, remote.revision),
    entries: [...local.entries, ...remote.entries],
    tombstones: [...local.tombstones, ...remote.tombstones],
  });
}

/** Write (or overwrite) a setting at the next revision. */
export function putReplicaEntry(
  document: ConfigReplicaDocument,
  input: { path: string; value: unknown; origin: string; at: number; secret?: boolean },
): ConfigReplicaDocument {
  const revision = document.revision + 1;
  return normalize({
    ...document,
    revision,
    entries: [
      ...document.entries.filter((entry) => entry.path !== input.path),
      {
        path: input.path,
        value: input.value,
        revision,
        origin: input.origin,
        at: Math.trunc(input.at),
        secret: input.secret === true,
      },
    ],
    // A re-write clears any earlier deletion of the same path, at a revision
    // above it, so the write is what survives the next merge.
    tombstones: document.tombstones.filter((entry) => entry.path !== input.path),
  });
}

/** Delete a setting at the next revision. */
export function deleteReplicaEntry(
  document: ConfigReplicaDocument,
  input: { path: string; origin: string; at: number; secret?: boolean },
): ConfigReplicaDocument {
  const revision = document.revision + 1;
  return normalize({
    ...document,
    revision,
    entries: document.entries.filter((entry) => entry.path !== input.path),
    tombstones: [
      ...document.tombstones.filter((entry) => entry.path !== input.path),
      {
        path: input.path,
        revision,
        origin: input.origin,
        at: Math.trunc(input.at),
        secret: input.secret === true,
      },
    ],
  });
}

export interface ConfigReplicaSweepResult {
  readonly document: ConfigReplicaDocument;
  readonly droppedTombstones: number;
}

/**
 * Bound the document.
 *
 * Deletions expire after {@link CONFIG_TOMBSTONE_MAX_AGE_MS} and are capped,
 * oldest first. Expiring one is safe for the same reason it is safe in the
 * roster: the deletion has already been applied everywhere that is still
 * talking, and the tombstone's only job is to outlive a partition, 90 days is
 * far longer than any partition that ends in a heal rather than a rebuild.
 */
export function sweepConfigReplica(
  document: ConfigReplicaDocument,
  now: number,
): ConfigReplicaSweepResult {
  const cutoff = now - CONFIG_TOMBSTONE_MAX_AGE_MS;
  const fresh = document.tombstones.filter((entry) => entry.at >= cutoff);
  const kept = fresh.length <= MAX_REPLICATED_TOMBSTONES
    ? fresh
    : [...fresh].sort((a, b) => b.at - a.at).slice(0, MAX_REPLICATED_TOMBSTONES);
  if (kept.length === document.tombstones.length) return { document, droppedTombstones: 0 };
  return {
    document: normalize({ ...document, tombstones: kept }),
    droppedTombstones: document.tombstones.length - kept.length,
  };
}

/** The entry for a path, or null. */
export function findReplicaEntry(
  document: ConfigReplicaDocument,
  path: string,
): ConfigReplicaEntry | null {
  return document.entries.find((entry) => entry.path === path) ?? null;
}
