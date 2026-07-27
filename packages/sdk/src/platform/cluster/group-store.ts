/**
 * group-store.ts — where the group's secrets and its roster actually live.
 *
 * Two stores, deliberately different, because they hold different things:
 *
 *   KEY MATERIAL — the join key, the group keys, this node's private keys —
 *   goes in the ENCRYPTED secrets store and nowhere else. Not in config, not in
 *   a log line, not in /status, not in a datagram. The only way any of it
 *   reaches a human is `cluster key`, which prints the join key and nothing
 *   else, on request.
 *
 *   THE ROSTER is public to the group by construction: it holds node ids,
 *   labels and PUBLIC keys, and every member gossips it to every other member.
 *   It goes in a plain file under the cluster state directory, where an
 *   operator can read it if they want to.
 *
 * Both are bounded, content-validated on load, and swept — a store that only
 * ever grows is a slow leak, and one that trusts whatever it finds on disk
 * turns a half-written file into a crash loop.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  generateGroupKey,
  generateGroupSigningKeyPair,
  generateNodeKeyMaterial,
  isValidPublicKey,
  type NodeKeyMaterial,
  type NodeKeyPairMaterial,
} from './group-crypto.js';
import {
  createGroupStateDocument,
  DEFAULT_GROUP_DISPLAY_NAME,
  readGroupStateDocument,
  sweepGroupState,
  type GroupStateDocument,
} from './group-state.js';
import { daemonSecretKeyFor } from '../config/daemon-secret-keys.js';
import type { ClusterKeyring } from './protocol-envelope.js';
import type { ClusterLogger } from './types.js';

/** The roster file, relative to the cluster state directory. */
export const GROUP_STATE_FILENAME = 'group-state.json';
/** The replicated settings file, alongside the roster. Public to the group, like it. */
export const GROUP_REPLICA_FILENAME = 'group-config.json';
/**
 * The single secrets-store key holding every piece of group key material.
 *
 * DERIVED from the daemon-owned config path rather than written out, because
 * the name is what decides where the value lives. `defaultScopeForKey` files a
 * secret in the daemon tier exactly when its name is one the daemon's
 * derivation produces; a hand-written `'cluster.groupMaterial'` matches
 * nothing it produces, so the group's key material was landing at PROJECT
 * scope — in whichever directory the daemon happened to start in, outside the
 * tier holding every other cluster secret.
 *
 * Deriving it means the name the daemon recognises and the name actually
 * written are the same by construction, and cannot drift apart again.
 */
export const GROUP_MATERIAL_SECRET_KEY = daemonSecretKeyFor('cluster.groupMaterial');

/**
 * Bounds on key history.
 *
 * 16 generations at the default 24-hour rotation is a fortnight of history, and
 * 30 days caps it for a node that rotates faster. Neither bound costs anything
 * a returning machine needs: a member that has been off for a year rejoins by
 * proving its long-lived IDENTITY key, which never rotates and never expires —
 * old group keys are a convenience path, not the mechanism. See
 * group-membership.ts.
 */
export const MAX_KEY_GENERATIONS = 16;
export const MAX_KEY_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

/** One generation of the group key. */
export interface GroupKeyRecord {
  readonly generation: number;
  readonly key: string;
  readonly createdAt: number;
  /**
   * The node that minted this generation.
   *
   * Only one member mints a given rotation, but a network that partitions
   * mid-rotation can produce two candidates for the same generation. When that
   * happens every node picks the one from the lexicographically SMALLER node
   * id — a rule with no dependence on arrival order or clock, so both sides of
   * a healed partition land on the same key without negotiating.
   */
  readonly mintedBy: string;
}

/**
 * Which of two candidate keys for the same generation wins.
 *
 * Exported because it is the whole of the partition-rotation tiebreak and is
 * tested directly.
 */
export function preferredKeyRecord(a: GroupKeyRecord, b: GroupKeyRecord): GroupKeyRecord {
  if (a.generation !== b.generation) return a.generation > b.generation ? a : b;
  return a.mintedBy <= b.mintedBy ? a : b;
}

/** Everything secret about this node's membership of one group. */
export interface GroupKeyMaterial {
  readonly version: 1;
  readonly groupId: string;
  /**
   * The root secret, on the node that CREATED the group. Null on a node that
   * joined: the root's only job is to have produced the group id, which is
   * already stored, so there is no reason to spread it.
   */
  readonly groupRoot: string | null;
  readonly joinKey: string;
  readonly joinSalt: string;
  readonly joinVerifier: string;
  readonly keys: readonly GroupKeyRecord[];
  readonly currentGeneration: number;
  /**
   * Wall-clock ms until which the PREVIOUS generation is still accepted.
   *
   * Set on a scheduled rotation, so members that have not yet cut over keep
   * being heard. Set to 0 on a rotation caused by a REMOVAL, so the machine
   * that was just ejected stops being heard immediately — which is the entire
   * point of rotating on removal.
   */
  readonly previousAcceptedUntil: number;
  readonly node: NodeKeyMaterial;
  /**
   * The GROUP's signing key pair, and which generation of it this is.
   *
   * Every member holds the private half, so any member can answer a returning
   * machine as the group rather than as itself. It rotates only on REMOVAL —
   * not on a scheduled rotation — because its whole job is to be verifiable by
   * a machine holding a public key from months ago, and rotating it daily would
   * make that impossible for no gain.
   */
  readonly groupSigning: GroupSigningMaterial;
}

/** The group's signing key pair at one generation. */
export interface GroupSigningMaterial {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly generation: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate one key record. Exported so the wire path reuses exactly this check. */
export function readKeyRecord(value: unknown): GroupKeyRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isFiniteNumber(candidate['generation']) || candidate['generation'] < 0) return null;
  if (typeof candidate['key'] !== 'string' || candidate['key'].length === 0) return null;
  if (!isFiniteNumber(candidate['createdAt'])) return null;
  return {
    generation: Math.trunc(candidate['generation']),
    key: candidate['key'],
    createdAt: Math.trunc(candidate['createdAt']),
    mintedBy: typeof candidate['mintedBy'] === 'string' ? candidate['mintedBy'] : '',
  };
}

/** Validate a stored group signing key pair. */
export function readGroupSigningMaterial(value: unknown): GroupSigningMaterial | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isValidPublicKey(candidate['publicKey'])) return null;
  if (typeof candidate['privateKey'] !== 'string' || candidate['privateKey'].length === 0) return null;
  if (!isFiniteNumber(candidate['generation']) || candidate['generation'] < 0) return null;
  return {
    publicKey: candidate['publicKey'],
    privateKey: candidate['privateKey'],
    generation: Math.trunc(candidate['generation']),
  };
}

function readNodeKeyMaterial(value: unknown): NodeKeyMaterial | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const identity = candidate['identity'] as Record<string, unknown> | undefined;
  const agreement = candidate['agreement'] as Record<string, unknown> | undefined;
  if (!identity || !agreement) return null;
  if (!isValidPublicKey(identity['publicKey']) || typeof identity['privateKey'] !== 'string') return null;
  if (!isValidPublicKey(agreement['publicKey']) || typeof agreement['privateKey'] !== 'string') return null;
  return {
    identity: { publicKey: identity['publicKey'], privateKey: identity['privateKey'] },
    agreement: { publicKey: agreement['publicKey'], privateKey: agreement['privateKey'] },
  };
}

/**
 * Parse stored key material.
 *
 * Returns null rather than a partly-filled object on anything unexpected. A
 * half-valid key blob is not something to work around: the node has no usable
 * membership, and saying so plainly (`cluster status` reports it, and the fix
 * is to join again) beats limping along signing with a key nobody accepts.
 */
export function readGroupKeyMaterial(value: unknown): GroupKeyMaterial | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate['version'] !== 1) return null;
  if (typeof candidate['groupId'] !== 'string' || candidate['groupId'].length === 0) return null;
  if (typeof candidate['joinKey'] !== 'string' || candidate['joinKey'].length === 0) return null;
  if (typeof candidate['joinSalt'] !== 'string' || typeof candidate['joinVerifier'] !== 'string') return null;
  const node = readNodeKeyMaterial(candidate['node']);
  if (!node) return null;
  const groupSigning = readGroupSigningMaterial(candidate['groupSigning']);
  if (!groupSigning) return null;
  const keys = (Array.isArray(candidate['keys']) ? candidate['keys'] : [])
    .map(readKeyRecord)
    .filter((entry): entry is GroupKeyRecord => entry !== null)
    .sort((a, b) => b.generation - a.generation);
  if (keys.length === 0) return null;
  const currentGeneration = isFiniteNumber(candidate['currentGeneration'])
    ? Math.trunc(candidate['currentGeneration'])
    : (keys[0]?.generation ?? 0);
  if (!keys.some((entry) => entry.generation === currentGeneration)) return null;
  return {
    version: 1,
    groupId: candidate['groupId'],
    groupRoot: typeof candidate['groupRoot'] === 'string' ? candidate['groupRoot'] : null,
    joinKey: candidate['joinKey'],
    joinSalt: candidate['joinSalt'],
    joinVerifier: candidate['joinVerifier'],
    keys,
    currentGeneration,
    previousAcceptedUntil: isFiniteNumber(candidate['previousAcceptedUntil'])
      ? Math.trunc(candidate['previousAcceptedUntil'])
      : 0,
    node,
    groupSigning,
  };
}

export interface KeyHistorySweepResult {
  readonly keys: readonly GroupKeyRecord[];
  readonly dropped: number;
}

/**
 * Bound the key history.
 *
 * The current generation and the one before it are ALWAYS kept regardless of
 * age — dropping either would break the acceptance window and cause exactly the
 * spurious elections the window exists to prevent.
 */
export function sweepKeyHistory(
  keys: readonly GroupKeyRecord[],
  currentGeneration: number,
  now: number,
): KeyHistorySweepResult {
  const pinned = new Set([currentGeneration, currentGeneration - 1]);
  const cutoff = now - MAX_KEY_AGE_MS;
  const sorted = [...keys].sort((a, b) => b.generation - a.generation);
  const kept: GroupKeyRecord[] = [];
  for (const record of sorted) {
    if (pinned.has(record.generation)) {
      kept.push(record);
      continue;
    }
    if (kept.length >= MAX_KEY_GENERATIONS) continue;
    if (record.createdAt < cutoff) continue;
    kept.push(record);
  }
  return { keys: kept, dropped: keys.length - kept.length };
}

/**
 * The keyring the envelope codec signs and verifies with.
 *
 * Reads through to whatever material the store currently holds, so a rotation
 * that replaces the material is picked up by the very next datagram without
 * anything having to be re-wired.
 */
export class GroupKeyring implements ClusterKeyring {
  constructor(
    private readonly readMaterial: () => GroupKeyMaterial,
    private readonly now: () => number,
  ) {}

  get groupId(): string {
    return this.readMaterial().groupId;
  }

  get currentGeneration(): number {
    return this.readMaterial().currentGeneration;
  }

  keyForGeneration(generation: number): string | null {
    return this.readMaterial().keys.find((entry) => entry.generation === generation)?.key ?? null;
  }

  /**
   * The current generation, plus the previous one while the cutover window is
   * open. A removal closes the window immediately by setting
   * `previousAcceptedUntil` to 0, so the ejected machine's key stops verifying
   * on the same tick the tombstone is written.
   */
  acceptedGenerations(): readonly number[] {
    const material = this.readMaterial();
    const current = material.currentGeneration;
    if (material.previousAcceptedUntil > this.now() && current > 0) return [current, current - 1];
    return [current];
  }

  /** Every generation still held, for checking an old-key proof from a returning node. */
  heldGenerations(): readonly number[] {
    return this.readMaterial().keys.map((entry) => entry.generation);
  }
}

// ── persistence ─────────────────────────────────────────────────────────────

/**
 * The slice of the encrypted secrets store this module needs.
 *
 * Narrow on purpose: `SecretsManager` satisfies it structurally, and a test can
 * satisfy it with a Map. Nothing here should know about secret scopes, policy
 * modes or file layout.
 */
export interface ClusterSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Read this node's group key material, or null when it is not in a group. */
export async function loadGroupKeyMaterial(
  secrets: ClusterSecretStore,
  logger?: ClusterLogger,
): Promise<GroupKeyMaterial | null> {
  let raw: string | null;
  try {
    raw = await secrets.get(GROUP_MATERIAL_SECRET_KEY);
  } catch (error) {
    logger?.error('cluster: the encrypted secrets store could not be read; this node has no usable group membership', {
      error: error instanceof Error ? error.message : String(error),
      action: 'check that the secrets keyfile is readable, then run: goodvibes-daemon cluster status',
    });
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger?.error('cluster: the stored group key material is not readable JSON; this node is not in a group', {
      action: 'rejoin the group: goodvibes-daemon cluster join',
    });
    return null;
  }
  const material = readGroupKeyMaterial(parsed);
  if (!material) {
    logger?.error('cluster: the stored group key material is incomplete; this node is not in a group', {
      action: 'rejoin the group: goodvibes-daemon cluster join',
    });
  }
  return material;
}

/** Persist key material. Every write goes through here so nothing else formats it. */
export async function saveGroupKeyMaterial(
  secrets: ClusterSecretStore,
  material: GroupKeyMaterial,
): Promise<void> {
  await secrets.set(GROUP_MATERIAL_SECRET_KEY, JSON.stringify(material));
}

/** Forget this node's membership entirely. */
export async function clearGroupKeyMaterial(secrets: ClusterSecretStore): Promise<void> {
  await secrets.delete(GROUP_MATERIAL_SECRET_KEY);
}

/** Mint the key material for a brand-new group. */
export function createGroupKeyMaterial(input: {
  readonly groupId: string;
  readonly groupRoot: string;
  readonly joinKey: string;
  readonly joinSalt: string;
  readonly joinVerifier: string;
  readonly nodeId: string;
  readonly now: number;
}): GroupKeyMaterial {
  return {
    version: 1,
    groupId: input.groupId,
    groupRoot: input.groupRoot,
    joinKey: input.joinKey,
    joinSalt: input.joinSalt,
    joinVerifier: input.joinVerifier,
    keys: [{
      generation: 0,
      key: generateGroupKey(),
      createdAt: Math.trunc(input.now),
      mintedBy: input.nodeId,
    }],
    currentGeneration: 0,
    previousAcceptedUntil: 0,
    node: generateNodeKeyMaterial(),
    groupSigning: { ...generateGroupSigningKeyPair(), generation: 0 },
  };
}

/** Key material for a node that has proved itself and is being handed the group. */
export function joiningGroupKeyMaterial(input: {
  readonly groupId: string;
  readonly joinKey: string;
  readonly joinSalt: string;
  readonly joinVerifier: string;
  readonly keys: readonly GroupKeyRecord[];
  readonly currentGeneration: number;
  readonly node: NodeKeyMaterial;
  readonly groupSigning: GroupSigningMaterial;
  readonly now: number;
  readonly graceMs: number;
}): GroupKeyMaterial {
  return {
    version: 1,
    groupId: input.groupId,
    groupRoot: null,
    joinKey: input.joinKey,
    joinSalt: input.joinSalt,
    joinVerifier: input.joinVerifier,
    keys: sweepKeyHistory(input.keys, input.currentGeneration, input.now).keys,
    currentGeneration: input.currentGeneration,
    previousAcceptedUntil: Math.trunc(input.now + input.graceMs),
    node: input.node,
    groupSigning: input.groupSigning,
  };
}

/** Why a rotation happened — and therefore whether the old key stays acceptable. */
export type RotationCause = 'scheduled' | 'revocation';

/**
 * Advance to a new generation.
 *
 * `scheduled` opens the acceptance window for `graceMs`, so nobody's heartbeat
 * is dropped mid-cutover. `revocation` opens nothing: the previous key is
 * refused from this instant, which is what stops the machine that was just
 * removed from being heard.
 */
export function rotateGroupKeyMaterial(
  material: GroupKeyMaterial,
  cause: RotationCause,
  nodeId: string,
  now: number,
  graceMs: number,
): GroupKeyMaterial {
  const generation = material.currentGeneration + 1;
  const minted: GroupKeyRecord = {
    generation,
    key: generateGroupKey(),
    createdAt: Math.trunc(now),
    mintedBy: nodeId,
  };
  const swept = sweepKeyHistory([...material.keys, minted], generation, now);
  return {
    ...material,
    keys: swept.keys,
    currentGeneration: generation,
    previousAcceptedUntil: cause === 'scheduled' ? Math.trunc(now + graceMs) : 0,
    // A REMOVAL also replaces the key the group signs with, so the machine that
    // was just ejected can no longer speak as the group to anyone. A scheduled
    // rotation leaves it alone: it exists to be verifiable by a machine holding
    // a copy from months ago, and churning it would defeat that for no gain.
    groupSigning: cause === 'revocation'
      ? { ...generateGroupSigningKeyPair(), generation: material.groupSigning.generation + 1 }
      : material.groupSigning,
  };
}

/**
 * Adopt keys handed over by another member — on join, on a re-key, or on the
 * rotation announcement that follows a scheduled rotation.
 *
 * Two candidates for the SAME generation are resolved by
 * {@link preferredKeyRecord}, never by arrival order, so a partition that
 * produced two rotations converges on one key when it heals.
 *
 * The acceptance window is opened here too: a node that immediately started
 * refusing the generation its peers are still finishing a cutover on would drop
 * the very heartbeats it needs.
 */
export function adoptGroupKeys(
  material: GroupKeyMaterial,
  incoming: readonly GroupKeyRecord[],
  currentGeneration: number,
  now: number,
  graceMs: number,
): GroupKeyMaterial {
  const merged = new Map<number, GroupKeyRecord>();
  for (const record of [...material.keys, ...incoming]) {
    const existing = merged.get(record.generation);
    merged.set(record.generation, existing ? preferredKeyRecord(existing, record) : record);
  }
  const generation = Math.max(currentGeneration, material.currentGeneration);
  const swept = sweepKeyHistory([...merged.values()], generation, now);
  return {
    ...material,
    keys: swept.keys,
    currentGeneration: generation,
    previousAcceptedUntil: Math.trunc(now + graceMs),
  };
}

// ── roster file ─────────────────────────────────────────────────────────────

/**
 * Read the roster, swept and validated.
 *
 * A missing file is the normal first-run case. An unreadable or malformed one
 * is NOT fatal: the roster is replicated, so an empty document re-converges
 * from the first gossip the node hears. Losing it costs a round trip; refusing
 * to start would cost inbound messaging.
 */
export function loadGroupState(
  stateDirectory: string,
  groupId: string,
  now: number,
  logger?: ClusterLogger,
): GroupStateDocument {
  const filePath = join(stateDirectory, GROUP_STATE_FILENAME);
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    const document = readGroupStateDocument(parsed);
    if (document && document.groupId === groupId) return sweepGroupState(document, now).state;
    if (document) {
      logger?.warn('cluster: the stored roster belongs to a different group; starting from an empty one', { filePath });
    } else {
      logger?.warn('cluster: the stored roster was not readable; starting from an empty one', { filePath });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      logger?.warn('cluster: the roster file could not be read; starting from an empty one', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return createGroupStateDocument(groupId, DEFAULT_GROUP_DISPLAY_NAME);
}

/**
 * Read the replicated settings document.
 *
 * Content-validated through the caller's policy filter, so a file edited by
 * hand — or written by an older build with a wider policy — cannot smuggle a
 * node-local key into this machine's config on the next start.
 */
export function loadReplicaDocument<T>(
  stateDirectory: string,
  parse: (value: unknown) => T | null,
  logger?: ClusterLogger,
): T | null {
  const filePath = join(stateDirectory, GROUP_REPLICA_FILENAME);
  try {
    const parsed = parse(JSON.parse(readFileSync(filePath, 'utf8')));
    if (parsed) return parsed;
    logger?.warn('cluster: the stored replicated settings were not readable; starting from an empty set', {
      filePath,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      logger?.warn('cluster: the replicated settings file could not be read; starting from an empty set', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

/** Persist the replicated settings document. Never throws: it re-converges by gossip. */
export function saveReplicaDocument(
  stateDirectory: string,
  document: unknown,
  logger?: ClusterLogger,
): void {
  const filePath = join(stateDirectory, GROUP_REPLICA_FILENAME);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    logger?.warn('cluster: the replicated settings could not be written; they will be re-sent by the group', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Persist the roster. Failure is logged, never thrown: it re-converges by gossip. */
export function saveGroupState(
  stateDirectory: string,
  state: GroupStateDocument,
  logger?: ClusterLogger,
): void {
  const filePath = join(stateDirectory, GROUP_STATE_FILENAME);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    logger?.warn('cluster: the roster could not be written; it will be rebuilt from the group on the next gossip', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
