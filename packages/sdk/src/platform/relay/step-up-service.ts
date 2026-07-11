// relay/step-up-service.ts
//
// The daemon-side step-up ceremony: it owns the registered-credential store
// (persisted through the SecretsManager) and the short-lived, single-use
// challenge store (in-memory), and it produces the real StepUpAssertionVerifier
// that relay/daemon-wiring.ts installs. One instance is shared between the
// operator verbs (routes/stepup.ts: register a credential, mint a challenge) and
// the relay dispatch gate, so a challenge minted by a verb is the same object
// the gate later consumes.
//
// Persistence shape (SecretsManager key `relay.stepup.state`): the deployment
// policy (rpId, allowed origins, user-verification requirement) plus the array
// of registered credentials. The policy travels WITH the credentials because a
// self-hosted deployment establishes it at registration time; there is no
// separate config surface to keep in sync.

import { fromBase64Url, randomBytes, toBase64Url } from '@pellux/goodvibes-transport-core/relay';
import {
  coseP256ToRawPoint,
  verifyStepUpAssertion,
  type StepUpAssertionEnvelope,
  type StepUpVerifyFailure,
  type StoredStepUpCredential,
} from './step-up-webauthn.js';
import type { StepUpAssertionVerifier } from './step-up-policy.js';

/** User-verification requirement for the ceremony. Default `required`. */
export type UserVerificationRequirement = 'required' | 'preferred' | 'discouraged';

const STEP_UP_STATE_KEY = 'relay.stepup.state';
const DEFAULT_CHALLENGE_TTL_MS = 120_000;
const MIN_CHALLENGE_TTL_MS = 5_000;
const MAX_CHALLENGE_TTL_MS = 300_000;
const CHALLENGE_BYTES = 32;

interface StepUpState {
  rpId: string;
  origins: string[];
  userVerification: UserVerificationRequirement;
  credentials: StoredStepUpCredential[];
}

/** Minimal secret custody surface (the SecretsManager satisfies it). */
export interface StepUpSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface StepUpServiceOptions {
  readonly secrets: StepUpSecretStore;
  /** Clock injection for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
  /** Random-challenge source injection for tests. Default relay `randomBytes`. */
  readonly randomChallenge?: () => Uint8Array<ArrayBuffer>;
  readonly logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}

/** Input to register a step-up credential (an admin/local-only ceremony verb). */
export interface RegisterStepUpCredentialInput {
  readonly rpId: string;
  readonly origin: string | readonly string[];
  readonly credentialId: string;
  readonly publicKeyCose: string;
  readonly signCount?: number;
  readonly userVerification?: UserVerificationRequirement;
  readonly label?: string;
}

/** A public (no key material) summary of a registered credential. */
export interface StepUpCredentialSummary {
  readonly credentialId: string;
  readonly label?: string;
  readonly createdAt: number;
  readonly signCount: number;
}

/** Input to mint a challenge — bound to the session/rendezvous it is for. */
export interface MintStepUpChallengeInput {
  readonly rendezvousId?: string;
  readonly sessionId?: string;
  /** Freshness window in ms (clamped 5s–300s). Default 120s. */
  readonly ttlMs?: number;
}

/** A minted challenge a surface passes to `navigator.credentials.get`. */
export interface MintedStepUpChallenge {
  readonly challengeId: string;
  /** base64url challenge bytes. */
  readonly challenge: string;
  readonly expiresAt: number;
}

interface LiveChallenge {
  readonly id: string;
  readonly challenge: string;
  readonly rendezvousId?: string;
  readonly sessionId?: string;
  readonly expiresAt: number;
  consumed: boolean;
}

/** Refusal reasons the verifier surfaces beyond the crypto failures. */
export type StepUpChallengeFailure = 'no-credential' | 'unknown-challenge' | 'challenge-expired' | 'challenge-consumed';

function normalizeOrigins(origin: string | readonly string[]): string[] {
  const list = Array.isArray(origin) ? origin : [origin];
  return [...new Set(list.map((o) => String(o).trim()).filter((o) => o.length > 0))];
}

/**
 * The step-up ceremony service. Constructed once at RuntimeServices assembly and
 * shared between the ceremony verbs and the relay gate's verifier.
 */
export class StepUpService {
  private readonly secrets: StepUpSecretStore;
  private readonly now: () => number;
  private readonly randomChallenge: () => Uint8Array<ArrayBuffer>;
  private readonly logger: StepUpServiceOptions['logger'];
  private readonly challenges = new Map<string, LiveChallenge>();

  constructor(options: StepUpServiceOptions) {
    this.secrets = options.secrets;
    this.now = options.now ?? (() => Date.now());
    this.randomChallenge = options.randomChallenge ?? (() => randomBytes(CHALLENGE_BYTES));
    this.logger = options.logger;
  }

  private async loadState(): Promise<StepUpState> {
    const raw = await this.secrets.get(STEP_UP_STATE_KEY);
    if (!raw) return { rpId: '', origins: [], userVerification: 'required', credentials: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<StepUpState>;
      return {
        rpId: typeof parsed.rpId === 'string' ? parsed.rpId : '',
        origins: Array.isArray(parsed.origins) ? parsed.origins.filter((o): o is string => typeof o === 'string') : [],
        userVerification: parsed.userVerification ?? 'required',
        credentials: Array.isArray(parsed.credentials) ? parsed.credentials : [],
      };
    } catch {
      this.logger?.warn('step-up: stored state is unparseable; treating as empty');
      return { rpId: '', origins: [], userVerification: 'required', credentials: [] };
    }
  }

  private async saveState(state: StepUpState): Promise<void> {
    await this.secrets.set(STEP_UP_STATE_KEY, JSON.stringify(state));
  }

  /**
   * Register (or replace) a credential and establish the deployment policy. The
   * COSE public key must parse as an EC2 P-256 key or the registration is
   * refused — a broken key would only fail closed silently later.
   */
  async registerCredential(input: RegisterStepUpCredentialInput): Promise<StepUpCredentialSummary> {
    const rpId = input.rpId.trim();
    if (!rpId) throw new Error('rpId is required');
    const origins = normalizeOrigins(input.origin);
    if (origins.length === 0) throw new Error('at least one origin is required');
    if (!input.credentialId || !input.publicKeyCose) throw new Error('credentialId and publicKeyCose are required');
    let cose: Uint8Array<ArrayBuffer>;
    try {
      cose = fromBase64Url(input.publicKeyCose);
    } catch {
      throw new Error('publicKeyCose must be base64url');
    }
    if (!coseP256ToRawPoint(cose)) throw new Error('publicKeyCose is not a valid EC2 P-256 COSE key');

    const state = await this.loadState();
    state.rpId = rpId;
    state.origins = origins;
    state.userVerification = input.userVerification ?? state.userVerification ?? 'required';
    const credential: StoredStepUpCredential = {
      credentialId: input.credentialId,
      publicKeyCose: input.publicKeyCose,
      signCount: typeof input.signCount === 'number' && input.signCount >= 0 ? Math.floor(input.signCount) : 0,
      ...(input.label ? { label: input.label } : {}),
      createdAt: this.now(),
    };
    state.credentials = [...state.credentials.filter((c) => c.credentialId !== credential.credentialId), credential];
    await this.saveState(state);
    return {
      credentialId: credential.credentialId,
      ...(credential.label ? { label: credential.label } : {}),
      createdAt: credential.createdAt,
      signCount: credential.signCount,
    };
  }

  /** Mint a short-lived, single-use challenge bound to the session/rendezvous. */
  mintChallenge(input: MintStepUpChallengeInput = {}): MintedStepUpChallenge {
    this.pruneExpired();
    const ttl = Math.min(MAX_CHALLENGE_TTL_MS, Math.max(MIN_CHALLENGE_TTL_MS, input.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS));
    const challenge = toBase64Url(this.randomChallenge());
    const id = toBase64Url(randomBytes(16));
    const expiresAt = this.now() + ttl;
    this.challenges.set(challenge, {
      id,
      challenge,
      ...(input.rendezvousId ? { rendezvousId: input.rendezvousId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      expiresAt,
      consumed: false,
    });
    return { challengeId: id, challenge, expiresAt };
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.challenges) {
      if (entry.expiresAt <= now || entry.consumed) this.challenges.delete(key);
    }
  }

  /**
   * The real {@link StepUpAssertionVerifier}. It parses the header envelope,
   * confirms the signed challenge is one we minted and is still live+unconsumed,
   * runs the full WebAuthn verification against the registered credential, and —
   * only on complete success — consumes the challenge and advances the stored
   * signature counter. Every other path returns false (fail closed).
   */
  createVerifier(): StepUpAssertionVerifier {
    return async (assertion: string): Promise<boolean> => {
      const result = await this.verify(assertion);
      if (!result.ok) {
        this.logger?.warn('step-up: assertion refused', { reason: result.reason });
      }
      return result.ok;
    };
  }

  /** Verify an envelope, returning a specific outcome (used by the verifier and tests). */
  async verify(assertion: string): Promise<{ ok: true } | { ok: false; reason: StepUpVerifyFailure | StepUpChallengeFailure | 'malformed-envelope' }> {
    const envelope = parseAssertionHeader(assertion);
    if (!envelope) return { ok: false, reason: 'malformed-envelope' };
    const state = await this.loadState();
    const credential = state.credentials.find((c) => c.credentialId === envelope.credentialId);
    if (!credential) return { ok: false, reason: 'no-credential' };

    const signedChallenge = peekSignedChallenge(envelope);
    if (!signedChallenge) return { ok: false, reason: 'malformed-envelope' };
    // Look up BEFORE pruning so an expired-but-still-present challenge yields the
    // specific 'challenge-expired' reason rather than a generic 'unknown'. Sweeping
    // of expired entries happens on the next mint (pruneExpired there).
    const live = this.challenges.get(signedChallenge);
    if (!live) return { ok: false, reason: 'unknown-challenge' };
    if (live.consumed) return { ok: false, reason: 'challenge-consumed' };
    if (live.expiresAt <= this.now()) {
      this.challenges.delete(signedChallenge);
      return { ok: false, reason: 'challenge-expired' };
    }

    const verifyResult = await verifyStepUpAssertion({
      envelope,
      credential,
      expectedChallenge: signedChallenge,
      rpId: state.rpId,
      allowedOrigins: state.origins,
      requireUserVerification: (state.userVerification ?? 'required') === 'required',
    });
    if (!verifyResult.ok) return { ok: false, reason: verifyResult.reason };

    // Consume the challenge (single-use) and persist the advanced counter.
    live.consumed = true;
    this.challenges.delete(signedChallenge);
    const updated: StoredStepUpCredential = { ...credential, signCount: verifyResult.signCount };
    state.credentials = state.credentials.map((c) => (c.credentialId === credential.credentialId ? updated : c));
    await this.saveState(state);
    return { ok: true };
  }
}

/** Decode the `x-goodvibes-stepup-assertion` header value into an envelope. */
export function parseAssertionHeader(value: string): StepUpAssertionEnvelope | null {
  let json: string;
  try {
    json = new TextDecoder().decode(fromBase64Url(value.trim()));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const fields = ['credentialId', 'authenticatorData', 'clientDataJSON', 'signature'] as const;
  for (const field of fields) if (typeof record[field] !== 'string') return null;
  return {
    credentialId: record['credentialId'] as string,
    authenticatorData: record['authenticatorData'] as string,
    clientDataJSON: record['clientDataJSON'] as string,
    signature: record['signature'] as string,
  };
}

/** Encode an envelope into the header value form (base64url of the JSON). */
export function encodeAssertionHeader(envelope: StepUpAssertionEnvelope): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(envelope)) as Uint8Array<ArrayBuffer>);
}

/** Peek the challenge the authenticator signed (from clientDataJSON), without verifying. */
function peekSignedChallenge(envelope: StepUpAssertionEnvelope): string | null {
  try {
    const clientData = JSON.parse(new TextDecoder().decode(fromBase64Url(envelope.clientDataJSON))) as Record<string, unknown>;
    return typeof clientData['challenge'] === 'string' ? clientData['challenge'] : null;
  } catch {
    return null;
  }
}
