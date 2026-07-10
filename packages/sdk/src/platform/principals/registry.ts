/**
 * principals/registry.ts
 *
 * The principal identity registry: the CRUD gateway backing store plus the one
 * operation channel intake actually depends on — resolveByIdentity, which turns
 * a channel-specific sender identity into the named principal it belongs to (or
 * the honest unknown principal when nothing maps).
 *
 * Identity uniqueness is a hard invariant: a given {channel, value} identity
 * belongs to at most one principal. create/update refuse (CONFLICT) to attach an
 * identity already claimed by a different principal rather than silently moving
 * it — reattaching an identity must be a deliberate delete-then-recreate.
 */
import { randomUUID } from 'node:crypto';
import type { PrincipalStore } from './store.js';
import {
  PrincipalRegistryError,
  identityKey,
  normalizeIdentity,
  unknownPrincipal,
  type PrincipalIdentity,
  type PrincipalKind,
  type PrincipalRecord,
  PRINCIPAL_KINDS,
} from './types.js';

export interface CreatePrincipalInput {
  readonly name: string;
  readonly kind: PrincipalKind;
  readonly identities?: readonly PrincipalIdentity[] | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface UpdatePrincipalInput {
  readonly name?: string | undefined;
  readonly kind?: PrincipalKind | undefined;
  readonly identities?: readonly PrincipalIdentity[] | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** The outcome of resolving a sender identity: the principal plus whether it was a real mapping. */
export interface PrincipalResolution {
  readonly principal: PrincipalRecord;
  readonly known: boolean;
}

function requireKind(kind: unknown): PrincipalKind {
  if (typeof kind !== 'string' || !PRINCIPAL_KINDS.includes(kind as PrincipalKind)) {
    throw new PrincipalRegistryError(
      `kind must be one of ${PRINCIPAL_KINDS.join(', ')}`,
      'INVALID_ARGUMENT',
    );
  }
  return kind as PrincipalKind;
}

function normalizeIdentities(identities: readonly PrincipalIdentity[] | undefined): PrincipalIdentity[] {
  if (!identities) return [];
  const seen = new Set<string>();
  const out: PrincipalIdentity[] = [];
  for (const raw of identities) {
    if (typeof raw?.channel !== 'string' || typeof raw?.value !== 'string') {
      throw new PrincipalRegistryError('each identity needs a string channel and value', 'INVALID_ARGUMENT');
    }
    const normalized = normalizeIdentity(raw);
    if (!normalized.channel || !normalized.value) {
      throw new PrincipalRegistryError('identity channel and value must be non-empty', 'INVALID_ARGUMENT');
    }
    const key = identityKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export class PrincipalRegistry {
  private records: PrincipalRecord[] | null = null;

  constructor(private readonly store: PrincipalStore) {}

  private async all(): Promise<PrincipalRecord[]> {
    if (this.records === null) {
      this.records = await this.store.load();
    }
    return this.records;
  }

  /** Throw CONFLICT if any of `identities` already belongs to a principal other than `exceptId`. */
  private assertIdentitiesFree(
    records: readonly PrincipalRecord[],
    identities: readonly PrincipalIdentity[],
    exceptId: string | null,
  ): void {
    const owner = new Map<string, string>();
    for (const record of records) {
      if (record.id === exceptId) continue;
      for (const identity of record.identities) owner.set(identityKey(identity), record.id);
    }
    for (const identity of identities) {
      const existing = owner.get(identityKey(identity));
      if (existing) {
        throw new PrincipalRegistryError(
          `identity ${identity.channel}:${identity.value} is already mapped to principal ${existing}`,
          'CONFLICT',
        );
      }
    }
  }

  async list(): Promise<PrincipalRecord[]> {
    return [...(await this.all())];
  }

  async get(id: string): Promise<PrincipalRecord> {
    const record = (await this.all()).find((r) => r.id === id);
    if (!record) throw new PrincipalRegistryError(`No principal with id ${id}`, 'NOT_FOUND');
    return record;
  }

  async create(input: CreatePrincipalInput): Promise<PrincipalRecord> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new PrincipalRegistryError('name is required', 'INVALID_ARGUMENT');
    const kind = requireKind(input.kind);
    const identities = normalizeIdentities(input.identities);
    const records = await this.all();
    this.assertIdentitiesFree(records, identities, null);
    const now = Date.now();
    const record: PrincipalRecord = {
      id: `principal:${randomUUID().slice(0, 12)}`,
      name,
      kind,
      identities,
      createdAt: now,
      updatedAt: now,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    records.push(record);
    await this.store.save(records);
    return record;
  }

  async update(id: string, input: UpdatePrincipalInput): Promise<PrincipalRecord> {
    const records = await this.all();
    const index = records.findIndex((r) => r.id === id);
    if (index === -1) throw new PrincipalRegistryError(`No principal with id ${id}`, 'NOT_FOUND');
    const current = records[index]!;
    const identities = input.identities !== undefined
      ? normalizeIdentities(input.identities)
      : current.identities;
    if (input.identities !== undefined) this.assertIdentitiesFree(records, identities, id);
    const name = input.name !== undefined ? input.name.trim() : current.name;
    if (!name) throw new PrincipalRegistryError('name cannot be empty', 'INVALID_ARGUMENT');
    const next: PrincipalRecord = {
      ...current,
      name,
      kind: input.kind !== undefined ? requireKind(input.kind) : current.kind,
      identities,
      updatedAt: Date.now(),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    records[index] = next;
    await this.store.save(records);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const records = await this.all();
    const index = records.findIndex((r) => r.id === id);
    if (index === -1) return false;
    records.splice(index, 1);
    await this.store.save(records);
    return true;
  }

  /**
   * Resolve a channel-specific sender identity to its named principal. An
   * unmapped identity resolves to the unknown principal with known:false — the
   * registry never guesses.
   */
  async resolveByIdentity(identity: PrincipalIdentity): Promise<PrincipalResolution> {
    if (typeof identity?.channel !== 'string' || typeof identity?.value !== 'string') {
      throw new PrincipalRegistryError('channel and value are required', 'INVALID_ARGUMENT');
    }
    const normalized = normalizeIdentity(identity);
    if (!normalized.channel || !normalized.value) {
      throw new PrincipalRegistryError('channel and value must be non-empty', 'INVALID_ARGUMENT');
    }
    const key = identityKey(normalized);
    const record = (await this.all()).find((r) => r.identities.some((i) => identityKey(i) === key));
    if (record) return { principal: record, known: true };
    return { principal: unknownPrincipal(normalized), known: false };
  }
}
