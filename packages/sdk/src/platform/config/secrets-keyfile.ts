/**
 * secrets-keyfile.ts — keyfile lifecycle + envelope crypto for SecretsManager.
 *
 * Extracted from secrets.ts and hardened after a real incident (2026-07):
 * a keyfile went missing, several long-lived processes each minted their own
 * replacement key (non-exclusive generation, last write wins), and the losers
 * kept encrypting stores with cached keys nobody else had — surfacing days
 * later as generic GCM auth failures with no way to tell which key wrote the
 * store. Three guards close that class:
 *
 *  1. Exclusive generation — the keyfile is created with the `wx` flag; a
 *     process that loses the creation race adopts the winner's key instead of
 *     keeping a private in-memory one.
 *  2. Pre-write revalidation — every store write re-reads the keyfile and
 *     refuses to encrypt with a cached key that no longer matches (and
 *     restores a missing keyfile from the cached key, which at that point is
 *     the only surviving copy).
 *  3. Key fingerprints — every envelope records a short hash of the key that
 *     wrote it, so a mismatched read reports "written with key X, current is
 *     Y" instead of a bare authentication failure. The fingerprint reveals
 *     nothing about the key (8 hex chars of a SHA-256).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { dirname } from 'path';
import { hostname, userInfo } from 'os';
import { logger } from '../utils/logger.js';

/**
 * On-disk envelope for the encrypted store. `version` was introduced together
 * with keyfile-derived encryption; files without a `version` field are legacy
 * stores encrypted with a key derived from the machine's hostname + username,
 * and are migrated to the current format on first successful read. `keyId` is
 * additive and optional: stores written before it existed decrypt exactly as
 * before, and older SDK versions ignore it (the version number is unchanged).
 */
export interface EncryptedStoreEnvelope {
  version?: number;
  iv: string;
  tag: string;
  data: string;
  /** Fingerprint of the key that wrote this store (8 hex chars of SHA-256; reveals nothing). */
  keyId?: string;
}

export const SECRETS_STORE_FORMAT_VERSION = 2;

/**
 * Thrown when a secrets store file exists on disk but cannot be read back
 * (wrong key, tampered content, malformed JSON, or an unknown future format).
 * Writes to that store are refused so its contents are never overwritten.
 */
export class SecretStoreUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreUnreadableError';
  }
}

/** Short public fingerprint of an encryption key: 8 hex chars of its SHA-256. */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/**
 * Key derivation used by stores written before keyfile-derived encryption.
 * Kept solely so those stores can be decrypted once and migrated; never used
 * for new writes.
 */
export function deriveLegacyEncryptionKey(identity?: { readonly hostname?: string; readonly username?: string }): Buffer {
  const host = identity?.hostname ?? hostname();
  const user = identity?.username ?? userInfo().username;
  const seed = host + user + 'goodvibes-secrets';
  return createHash('sha256').update(seed, 'utf8').digest();
}

export function encryptStore(plaintext: string, key: Buffer): EncryptedStoreEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: SECRETS_STORE_FORMAT_VERSION,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
    keyId: keyFingerprint(key),
  };
}

export function decryptStore(store: EncryptedStoreEnvelope, key: Buffer): string {
  const iv = Buffer.from(store.iv, 'hex');
  const tag = Buffer.from(store.tag, 'hex');
  const data = Buffer.from(store.data, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

const KEYFILE_PATTERN = /^[0-9a-f]{64}$/i;

function readKeyfile(keyFilePath: string): Buffer {
  const raw = readFileSync(keyFilePath, 'utf-8').trim();
  if (!KEYFILE_PATTERN.test(raw)) {
    throw new SecretStoreUnreadableError(
      `Secrets keyfile at ${keyFilePath} is malformed. Restore it from backup; without the original key, existing encrypted stores cannot be read.`,
    );
  }
  return Buffer.from(raw, 'hex');
}

function writeKeyfileExclusive(keyFilePath: string, key: Buffer): boolean {
  mkdirSync(dirname(keyFilePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(keyFilePath), 0o700);
  try {
    writeFileSync(keyFilePath, `${key.toString('hex')}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  chmodSync(keyFilePath, 0o600);
  return true;
}

/**
 * Load the key from the keyfile, generating a fresh random key on first need.
 * Generation is EXCLUSIVE (`wx`): when two processes race to create the file,
 * exactly one key wins, and the loser adopts it instead of keeping a private
 * in-memory key that would write stores nobody else can read. The keyfile is
 * 0600 inside a 0700 directory; the key never derives from host identity, so
 * a store directory copied to another machine keeps decrypting.
 */
export function loadOrCreateKeyfile(keyFilePath: string): Buffer {
  if (existsSync(keyFilePath)) return readKeyfile(keyFilePath);
  const key = randomBytes(32);
  if (!writeKeyfileExclusive(keyFilePath, key)) {
    // Another process won the creation race — its key is the canonical one.
    return readKeyfile(keyFilePath);
  }
  logger.info('SecretsManager: generated new secrets keyfile', { path: keyFilePath });
  return key;
}

/**
 * Guard a store write against the on-disk key state. A cached key that no
 * longer matches the keyfile must never encrypt a store — every other process
 * (and this one, after restart) would be unable to read it. A MISSING keyfile
 * is restored from the cached key: at that moment the cache is the only
 * surviving copy, and persisting it keeps every store written so far readable.
 */
export function assertCachedKeyIsCurrent(keyFilePath: string, cachedKey: Buffer): void {
  if (existsSync(keyFilePath)) {
    const onDisk = readKeyfile(keyFilePath);
    if (!onDisk.equals(cachedKey)) {
      throw new SecretStoreUnreadableError(
        `Refusing to write a secrets store: this process's cached encryption key (fingerprint ${keyFingerprint(cachedKey)}) `
        + `no longer matches the keyfile at ${keyFilePath} (fingerprint ${keyFingerprint(onDisk)}). `
        + 'The keyfile changed after this process started; restart the process to pick up the current key.',
      );
    }
    return;
  }
  if (writeKeyfileExclusive(keyFilePath, cachedKey)) {
    logger.warn('SecretsManager: keyfile was missing; restored it from this process\'s cached key so stores stay readable', {
      path: keyFilePath,
    });
    return;
  }
  // Lost the restore race. Only accept the winner if it minted the same key
  // (impossible in practice) — otherwise refuse the write with the same
  // precise mismatch error as above.
  const onDisk = readKeyfile(keyFilePath);
  if (!onDisk.equals(cachedKey)) {
    throw new SecretStoreUnreadableError(
      `Refusing to write a secrets store: the keyfile at ${keyFilePath} was regenerated by another process `
      + `(fingerprint ${keyFingerprint(onDisk)}) and no longer matches this process's cached key `
      + `(fingerprint ${keyFingerprint(cachedKey)}). Restart the process to pick up the current key.`,
    );
  }
}
