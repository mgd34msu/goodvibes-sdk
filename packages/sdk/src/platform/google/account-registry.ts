/**
 * Durable record of every account the agent created in the owner's name.
 *
 * Autonomous signup without this file is invisible sprawl: accounts nobody can
 * enumerate, audit, or revoke. Everything the agent signs up for lands here, at creation
 * time, before the credential is even stored.
 *
 * What is NOT here: the credential. Only `credentialSecretKey`, the NAME of the entry in
 * the secret store that holds it. This registry is a plain JSON file; a password in it
 * would be a password on disk in the clear. `record()` rejects secret-looking text in
 * every field, and there is a test asserting the credential value never reaches the file.
 *
 * Follows the platform registry conventions, caller-supplied store path, versioned
 * store file, defensive parse, atomic write, with one deliberate divergence noted at
 * `readStore`.
 *
 * The store path and the secret-shaped-text predicate both arrive from the caller.
 * The path, because where a product keeps its state is the product's decision. The
 * predicate, because "what looks like a credential" is a policy each surface already
 * owns, and quietly shipping a second copy of those patterns here would let the two
 * drift, a value this registry accepted would then be one the surface's own memory
 * guard rejected, or worse, the other way round.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeDomain, normalizeEmailAddress } from './signup-address.js';

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

export interface AgentAccountRecord {
  readonly id: string;
  /** Registered domain of the service, normalized. */
  readonly serviceDomain: string;
  /** The page the account was created at. */
  readonly serviceUrl: string;
  /** The per-signup alias minted by `signup-address.ts`. */
  readonly aliasAddress: string;
  readonly createdAt: string;
  readonly purpose: string;
  /**
   * The NAME of the secret-store entry holding the credential. Never the credential.
   * Revocation starts here: look up this key, rotate or delete it.
   */
  readonly credentialSecretKey: string;
}

export interface AgentAccountCreateInput {
  readonly serviceDomain: string;
  readonly serviceUrl: string;
  readonly aliasAddress: string;
  readonly purpose: string;
  readonly credentialSecretKey: string;
  readonly now?: Date;
}

export interface AgentAccountSweepInput {
  readonly now?: Date;
  /**
   * Keys the secret store actually holds. When supplied, records pointing at a key that
   * no longer exists are orphans and get dropped, the credential is already gone.
   */
  readonly knownSecretKeys?: readonly string[];
  /** When supplied, records older than this are dropped. */
  readonly maxAgeDays?: number;
}

export interface AgentAccountSweepResult {
  readonly removed: readonly AgentAccountRecord[];
  readonly remaining: number;
}

export interface AgentAccountSnapshot {
  readonly path: string;
  readonly accounts: readonly AgentAccountRecord[];
  /** Records dropped by the last read because they failed validation. */
  readonly droppedOnRead: number;
}

interface AccountStoreFile {
  readonly version: 1;
  readonly accounts: readonly AgentAccountRecord[];
}

interface ParsedStore {
  readonly store: AccountStoreFile;
  readonly dropped: number;
}

// ──────────────────────────────────────────────────────────────────
// Constants and helpers
// ──────────────────────────────────────────────────────────────────

const STORE_VERSION = 1;
/** Bound on persisted records. Sprawl has a ceiling, and hitting it is loud. */
export const MAX_ACCOUNT_RECORDS = 500;
/** A secret-store key name: an identifier, never a value. */
const SECRET_KEY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'account';
}

function isValidTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * "Does this text look like a credential rather than a name?"
 *
 * Supplied by the caller; see the module header for why it is not defined here.
 */
export type SecretLikeTextPredicate = (text: string) => boolean;

/**
 * Validate a record by content. Anything that fails is dropped on read rather than
 * throwing, a single hand-edited entry must not make the whole registry unreadable.
 */
function parseAccount(value: unknown, containsSecretLikeText: SecretLikeTextPredicate): AgentAccountRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim().toLowerCase();
  const serviceDomain = normalizeDomain(readString(value.serviceDomain));
  const serviceUrl = readString(value.serviceUrl).trim();
  const aliasAddress = normalizeEmailAddress(readString(value.aliasAddress));
  const purpose = readString(value.purpose).trim();
  const credentialSecretKey = readString(value.credentialSecretKey).trim();
  const createdAt = readString(value.createdAt).trim();

  if (!ID_PATTERN.test(id)) return null;
  if (!serviceDomain.includes('.')) return null;
  if (!isHttpUrl(serviceUrl)) return null;
  if (!aliasAddress.includes('@')) return null;
  if (!purpose) return null;
  if (!SECRET_KEY_NAME_PATTERN.test(credentialSecretKey)) return null;
  if (!isValidTimestamp(createdAt)) return null;
  // Belt and braces: if a credential ever got written here by a future caller, the
  // record is dropped on read rather than served back out.
  if ([serviceUrl, purpose, credentialSecretKey, aliasAddress].some((text) => containsSecretLikeText(text))) {
    return null;
  }

  return { id, serviceDomain, serviceUrl, aliasAddress, createdAt, purpose, credentialSecretKey };
}

function parseStore(raw: string, containsSecretLikeText: SecretLikeTextPredicate): ParsedStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { store: { version: STORE_VERSION, accounts: [] }, dropped: 0 };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.accounts)) {
    return { store: { version: STORE_VERSION, accounts: [] }, dropped: 0 };
  }
  const entries = parsed.accounts;
  const accounts = entries
    .map((entry) => parseAccount(entry, containsSecretLikeText))
    .filter((entry): entry is AgentAccountRecord => entry !== null);
  const deduped: AgentAccountRecord[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.id)) continue;
    seen.add(account.id);
    deduped.push(account);
  }
  // Bound defensively: a tampered or runaway file is trimmed to the newest MAX.
  const sorted = [...deduped].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const bounded = sorted.slice(Math.max(0, sorted.length - MAX_ACCOUNT_RECORDS));
  return {
    store: { version: STORE_VERSION, accounts: bounded },
    dropped: entries.length - bounded.length,
  };
}

function formatStore(store: AccountStoreFile): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

/**
 * The path segments below a surface's own storage root that this registry occupies.
 *
 * Exported so a product composes its own root with these rather than inventing a
 * second layout: `resolveUserPath(<surface root>, ...ACCOUNT_REGISTRY_PATH_SEGMENTS)`.
 */
export const ACCOUNT_REGISTRY_PATH_SEGMENTS: readonly string[] = ['signup', 'accounts.json'];

// ──────────────────────────────────────────────────────────────────
// Base address for alias minting
// ──────────────────────────────────────────────────────────────────

/**
 * Supplies the owner's real delivery address when no mail account is configured.
 *
 * A registered reader rather than an import of `platform/owner-profile`: this
 * module is reachable from surfaces that never load a profile, and it has to keep
 * working there unchanged. With nothing registered, {@link resolveSignupBaseAddress}
 * returns exactly what its caller passed in.
 */
export type SignupBaseAddressSource = () => string | undefined;

let signupBaseAddressFallback: SignupBaseAddressSource | null = null;

/** Register (or clear, with `null`) the profile-backed base-address fallback. */
export function registerSignupBaseAddressFallback(source: SignupBaseAddressSource | null): void {
  signupBaseAddressFallback = source;
}

/**
 * The base address every minted alias resolves back to, "the owner's real
 * delivery address this alias resolves to", in `signup-address.ts`'s own words.
 *
 * A configured mail account always wins. The profile's `contact.email` fills the
 * gap, which is the point of wiring it: without it, an autonomous signup on a
 * machine with no mail account configured has nowhere to send the confirmation
 * and cannot proceed, even though the owner told the runtime their address
 * weeks ago.
 *
 * `signup-address.ts` is untouched by this. It is alias-minting machinery, not a
 * store of owner facts, and it stays a pure function of the base address it is
 * handed.
 *
 * Note what this deliberately does NOT feed: `security/owner-identity.ts`'s
 * `resolveOwnerAddresses()`. That set gates the one exemption to the
 * content-taint rule and reads configuration only, on purpose, see
 * `owner-profile/consumers.ts` for the reasoning.
 */
export function resolveSignupBaseAddress(configuredMailAddress?: string | undefined): string | undefined {
  const configured = configuredMailAddress?.trim() ?? '';
  if (configured.length > 0) return configured;
  const fromProfile = signupBaseAddressFallback?.()?.trim() ?? '';
  return fromProfile.length > 0 ? normalizeEmailAddress(fromProfile) : undefined;
}

export interface AgentAccountRegistryOptions {
  /** Absolute path to the registry's JSON store. */
  readonly storePath: string;
  /** See `SecretLikeTextPredicate` and the module header. */
  readonly containsSecretLikeText: SecretLikeTextPredicate;
}

// ──────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────

export class AgentAccountRegistry {
  private readonly storePath: string;
  private readonly containsSecretLikeText: SecretLikeTextPredicate;

  public constructor(options: AgentAccountRegistryOptions) {
    this.storePath = options.storePath;
    this.containsSecretLikeText = options.containsSecretLikeText;
  }

  public snapshot(): AgentAccountSnapshot {
    const parsed = this.readStore();
    const accounts = [...parsed.store.accounts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { path: this.storePath, accounts, droppedOnRead: parsed.dropped };
  }

  public list(): readonly AgentAccountRecord[] {
    return this.snapshot().accounts;
  }

  public get(id: string): AgentAccountRecord | null {
    const lookup = id.trim().toLowerCase();
    if (!lookup) return null;
    return this.list().find((account) => account.id === lookup) ?? null;
  }

  /** Record an account the agent just created. Call this before storing the credential. */
  public record(input: AgentAccountCreateInput): AgentAccountRecord {
    const parsed = this.readStore();
    const serviceDomain = normalizeDomain(input.serviceDomain);
    const serviceUrl = input.serviceUrl.trim();
    const aliasAddress = normalizeEmailAddress(input.aliasAddress);
    const purpose = input.purpose.trim();
    const credentialSecretKey = input.credentialSecretKey.trim();

    if (!serviceDomain.includes('.')) throw new Error('An account record requires the service domain the account was created at.');
    if (!isHttpUrl(serviceUrl)) throw new Error('An account record requires the http(s) URL the account was created at.');
    if (!aliasAddress.includes('@')) throw new Error('An account record requires the per-signup alias address.');
    if (!purpose) throw new Error('An account record requires a stated purpose.');
    if (!SECRET_KEY_NAME_PATTERN.test(credentialSecretKey)) {
      throw new Error('credentialSecretKey must be a secret-store key NAME (letters, digits, . _ : / -), never the credential itself.');
    }
    if ([serviceUrl, purpose, credentialSecretKey, aliasAddress].some((text) => this.containsSecretLikeText(text))) {
      throw new Error('The account registry cannot store secret-looking values. Store the secret in the secret store and record only its key name.');
    }
    if (parsed.store.accounts.length >= MAX_ACCOUNT_RECORDS) {
      throw new Error(
        `The account registry is at its ${MAX_ACCOUNT_RECORDS}-record limit. Sweep or forget stale accounts before creating another; records are never silently discarded.`,
      );
    }

    const createdAt = (input.now ?? new Date()).toISOString();
    const account: AgentAccountRecord = {
      id: this.nextId(serviceDomain, parsed.store.accounts),
      serviceDomain,
      serviceUrl,
      aliasAddress,
      createdAt,
      purpose,
      credentialSecretKey,
    };
    this.writeStore({ ...parsed.store, accounts: [...parsed.store.accounts, account] });
    return account;
  }

  public forget(id: string): AgentAccountRecord {
    const parsed = this.readStore();
    const lookup = id.trim().toLowerCase();
    const existing = parsed.store.accounts.find((account) => account.id === lookup);
    if (!existing) throw new Error(`Unknown account record ${id}`);
    this.writeStore({ ...parsed.store, accounts: parsed.store.accounts.filter((account) => account.id !== existing.id) });
    return existing;
  }

  /**
   * Reap expired and orphaned entries and compact the file.
   *
   * With no arguments this still rewrites the store from the validated read, which drops
   * malformed and duplicate entries that a hand edit may have introduced.
   */
  public sweep(input: AgentAccountSweepInput = {}): AgentAccountSweepResult {
    const parsed = this.readStore();
    const now = input.now ?? new Date();
    const knownKeys = input.knownSecretKeys ? new Set(input.knownSecretKeys) : null;
    const cutoff = input.maxAgeDays === undefined ? null : now.getTime() - input.maxAgeDays * 86_400_000;

    const kept: AgentAccountRecord[] = [];
    const removed: AgentAccountRecord[] = [];
    for (const account of parsed.store.accounts) {
      const orphaned = knownKeys !== null && !knownKeys.has(account.credentialSecretKey);
      const expired = cutoff !== null && Date.parse(account.createdAt) < cutoff;
      if (orphaned || expired) removed.push(account);
      else kept.push(account);
    }
    this.writeStore({ ...parsed.store, accounts: kept });
    return { removed, remaining: kept.length };
  }

  private nextId(serviceDomain: string, accounts: readonly AgentAccountRecord[]): string {
    const base = slugify(serviceDomain);
    const ids = new Set(accounts.map((account) => account.id));
    if (!ids.has(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!ids.has(candidate)) return candidate;
    }
    throw new Error(`Could not allocate an account id for ${serviceDomain}.`);
  }

  /**
   * Divergence from `calendar-registry.ts`: that registry throws when the store cannot be
   * read. This one must not. A corrupt accounts file would otherwise take down every
   * caller that just wants to enumerate what the agent signed up for, which is exactly
   * when enumeration matters most. Unreadable content yields an empty, still-writable
   * store; malformed records are dropped individually and counted in `droppedOnRead`.
   */
  private readStore(): ParsedStore {
    if (!existsSync(this.storePath)) return { store: { version: STORE_VERSION, accounts: [] }, dropped: 0 };
    try {
      return parseStore(readFileSync(this.storePath, 'utf-8'), this.containsSecretLikeText);
    } catch {
      return { store: { version: STORE_VERSION, accounts: [] }, dropped: 0 };
    }
  }

  private writeStore(store: AccountStoreFile): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const tmpPath = `${this.storePath}.tmp`;
    writeFileSync(tmpPath, formatStore(store), 'utf-8');
    renameSync(tmpPath, this.storePath);
  }
}
