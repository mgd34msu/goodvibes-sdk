/**
 * push/vapid.ts
 *
 * VAPID (RFC 8292) key custody and request signing for browser push.
 *
 * KEY CUSTODY — the load-bearing rule of this file:
 *  - The daemon generates one P-256 keypair on first need.
 *  - The WHOLE keypair (including the private component) is persisted only
 *    through the SecretsManager, exactly like any other credential — into the
 *    secure store, or the plaintext secrets file, per the active secret policy.
 *    It is NEVER written into the config, so it can never ride out in the
 *    secret-free config snapshot.
 *  - The private key is used only here, to sign the short-lived VAPID JWT that
 *    authorizes one delivery. It is never logged and never returned by any read
 *    verb.
 *  - Only the PUBLIC key leaves the daemon: `getPublicKey()` feeds the
 *    `push.vapid.get` verb and the `k=` parameter of the Authorization header.
 */

import { createPrivateKey, generateKeyPairSync, sign as cryptoSign, type JsonWebKey } from 'node:crypto';

/** The narrow slice of SecretsManager this module needs — get/set one secret. */
export interface VapidSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

interface StoredVapidKeypair {
  /** Uncompressed P-256 public point, base64url — safe to hand out. */
  readonly publicKey: string;
  /** The private key as a JWK. Secret; never leaves this module. */
  readonly privateJwk: JsonWebKey;
}

export interface VapidManagerOptions {
  /**
   * The `sub` claim of the VAPID JWT — a `mailto:` or `https:` contact the push
   * service can reach. Defaults to a local mailto when unset.
   */
  readonly subject?: string | undefined;
}

/** The secret key under which the keypair is stored (a secrets-store key, not a config key). */
export const VAPID_SECRET_KEY = 'push.vapid.keypair';

const DEFAULT_SUBJECT = 'mailto:goodvibes-push@localhost';
/** VAPID JWTs are short-lived; RFC 8292 caps `exp` at 24h. Use 12h. */
const JWT_LIFETIME_SECONDS = 12 * 60 * 60;

function base64UrlFromBuffer(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Derive the 65-byte uncompressed public point (base64url) from a P-256 JWK. */
function publicKeyFromJwk(jwk: JsonWebKey): string {
  if (!jwk.x || !jwk.y) throw new Error('VAPID JWK is missing its public coordinates');
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return base64UrlFromBuffer(point);
}

export class VapidManager {
  private readonly subject: string;
  private inflight: Promise<StoredVapidKeypair> | null = null;

  constructor(private readonly store: VapidSecretStore, options: VapidManagerOptions = {}) {
    this.subject = options.subject && options.subject.length > 0 ? options.subject : DEFAULT_SUBJECT;
  }

  /** The public application-server key clients subscribe with. Generates on first call. */
  async getPublicKey(): Promise<string> {
    const keypair = await this.ensureKeypair();
    return keypair.publicKey;
  }

  /**
   * Build the `Authorization: vapid ...` header value for one delivery to
   * `endpoint`. The JWT's audience is the endpoint's origin (RFC 8292).
   */
  async buildAuthorizationHeader(endpoint: string): Promise<string> {
    const keypair = await this.ensureKeypair();
    const audience = new URL(endpoint).origin;
    const jwt = this.signJwt(audience, keypair.privateJwk);
    return `vapid t=${jwt}, k=${keypair.publicKey}`;
  }

  private signJwt(audience: string, privateJwk: JsonWebKey): string {
    const header = base64UrlJson({ typ: 'JWT', alg: 'ES256' });
    const payload = base64UrlJson({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + JWT_LIFETIME_SECONDS,
      sub: this.subject,
    });
    const signingInput = `${header}.${payload}`;
    const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
    // ieee-p1363 gives the raw r||s (64-byte) JOSE signature ES256 requires,
    // not Node's default DER encoding.
    const signature = cryptoSign('sha256', Buffer.from(signingInput, 'utf8'), {
      key,
      dsaEncoding: 'ieee-p1363',
    });
    return `${signingInput}.${base64UrlFromBuffer(signature)}`;
  }

  /**
   * Load the keypair from the secrets store, or generate and persist one on
   * first use. Concurrent callers share a single in-flight generation so two
   * simultaneous first-time deliveries cannot mint two keypairs.
   */
  private ensureKeypair(): Promise<StoredVapidKeypair> {
    if (this.inflight) return this.inflight;
    this.inflight = this.loadOrGenerate().catch((error) => {
      // A failed attempt must not poison every later call.
      this.inflight = null;
      throw error;
    });
    return this.inflight;
  }

  private async loadOrGenerate(): Promise<StoredVapidKeypair> {
    const existing = await this.store.get(VAPID_SECRET_KEY);
    if (existing) {
      const parsed = JSON.parse(existing) as StoredVapidKeypair;
      if (parsed.publicKey && parsed.privateJwk) return parsed;
    }
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateJwk = privateKey.export({ format: 'jwk' }) as JsonWebKey;
    const keypair: StoredVapidKeypair = {
      publicKey: publicKeyFromJwk(publicKey.export({ format: 'jwk' }) as JsonWebKey),
      privateJwk,
    };
    await this.store.set(VAPID_SECRET_KEY, JSON.stringify(keypair));
    return keypair;
  }
}
