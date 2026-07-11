/**
 * method-catalog-stepup.ts
 *
 * Contract descriptors for the relay WebAuthn step-up ceremony verbs:
 *
 *   - stepup.credentials.register — store a passkey (credentialId + COSE public
 *     key + starting signature counter) and establish the deployment policy
 *     (rpId, allowed origins, user-verification requirement). Admin-gated; a
 *     self-hosted deployment registers the credential directly ('none'
 *     attestation), so there is no attestation chain to verify here (documented
 *     in docs/relay-zero-knowledge.md).
 *   - stepup.challenge.mint — issue a short-lived, single-use challenge bound to
 *     the calling session/rendezvous, which a surface feeds to
 *     `navigator.credentials.get` before making a mutating relay call.
 *
 * The assertion produced by the passkey is carried on the mutating call in the
 * `x-goodvibes-stepup-assertion` header and verified by the daemon's real
 * StepUpAssertionVerifier (relay/step-up-service.ts) — no operator verb reads or
 * returns assertions.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  entityOutputSchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const USER_VERIFICATION_SCHEMA = { type: 'string', enum: ['required', 'preferred', 'discouraged'] } as const;

export const STEP_UP_CREDENTIAL_SUMMARY_SCHEMA = objectSchema({
  credentialId: STRING_SCHEMA,
  label: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  signCount: NUMBER_SCHEMA,
}, ['credentialId', 'createdAt', 'signCount']);

export const STEP_UP_CREDENTIALS_REGISTER_INPUT_SCHEMA = objectSchema({
  rpId: STRING_SCHEMA,
  origin: STRING_SCHEMA,
  credentialId: STRING_SCHEMA,
  publicKeyCose: STRING_SCHEMA,
  signCount: NUMBER_SCHEMA,
  userVerification: USER_VERIFICATION_SCHEMA,
  label: STRING_SCHEMA,
}, ['rpId', 'origin', 'credentialId', 'publicKeyCose']);
export const STEP_UP_CREDENTIALS_REGISTER_OUTPUT_SCHEMA = entityOutputSchema('credential', STEP_UP_CREDENTIAL_SUMMARY_SCHEMA);

export const STEP_UP_CHALLENGE_MINT_INPUT_SCHEMA = objectSchema({
  rendezvousId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  ttlMs: NUMBER_SCHEMA,
}, []);
export const STEP_UP_CHALLENGE_MINT_OUTPUT_SCHEMA = objectSchema({
  challengeId: STRING_SCHEMA,
  challenge: STRING_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
}, ['challengeId', 'challenge', 'expiresAt']);

export const builtinGatewayStepUpMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'stepup.credentials.register',
    title: 'Register Step-up Credential',
    description: 'Store a WebAuthn (passkey) credential for relay step-up — its credentialId, COSE public key, and starting signature counter — and set the deployment policy (relying-party id, allowed origins, user-verification requirement). Admin/local-only: registering a step-up credential is itself a sensitive act. Self-hosted deployments register the credential directly (\'none\' attestation).',
    category: 'relay',
    scopes: ['write:relay'],
    access: 'admin',
    http: { method: 'POST', path: '/api/stepup/credentials' },
    inputSchema: STEP_UP_CREDENTIALS_REGISTER_INPUT_SCHEMA,
    outputSchema: STEP_UP_CREDENTIALS_REGISTER_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'stepup.challenge.mint',
    title: 'Mint Step-up Challenge',
    description: 'Issue a short-lived, single-use WebAuthn challenge bound to the calling session/rendezvous. A surface passes it to navigator.credentials.get and returns the assertion on its next mutating relay call. The freshness window (ttlMs) is clamped to 5s–300s (default 120s).',
    category: 'relay',
    scopes: ['read:relay'],
    access: 'authenticated',
    http: { method: 'POST', path: '/api/stepup/challenge' },
    inputSchema: STEP_UP_CHALLENGE_MINT_INPUT_SCHEMA,
    outputSchema: STEP_UP_CHALLENGE_MINT_OUTPUT_SCHEMA,
  }),
];
