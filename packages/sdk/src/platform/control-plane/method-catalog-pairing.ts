/**
 * method-catalog-pairing.ts
 *
 * Per-pairing operator token verbs: every paired device holds its own named,
 * individually-revocable token. These verbs list the paired devices (never the
 * secret), rename one, revoke one (immediately), mint a fresh one, and migrate
 * a client off the legacy single shared token (and revoke that shared token).
 *
 * Like the other handler-registered verb groups (fleet.*, push.*, checkpoints.*)
 * these declare `transport: ['ws']` and carry NO dedicated REST `http` binding:
 * they are served by the registered in-process handler through the generic
 * `/api/control-plane/methods/{id}/invoke` endpoint. `mint`, `revoke`, `rename`
 * and `list` are the core CRUD tails; `migrate` (move a shared-token client to
 * its own per-device token) and `revokeShared` (turn the legacy token off) are
 * documented in the `pairing-tokens` exempt category in
 * packages/contracts/src/core-verbs.ts.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

/** Browser-push subscription key material (p256dh + auth), for the notifications offer. */
const PUSH_SUBSCRIPTION_KEYS_SCHEMA = objectSchema({
  p256dh: STRING_SCHEMA,
  auth: STRING_SCHEMA,
}, ['p256dh', 'auth']);

/** The redacted, wire-safe view of a pairing token — name/created/last-seen, never the secret. */
const PUBLIC_PAIRING_TOKEN_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  name: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  lastSeenAt: NUMBER_SCHEMA,
}, ['id', 'name', 'createdAt']);

/** The minted token — the ONE shape that carries the plaintext secret, returned once. */
const MINTED_PAIRING_TOKEN_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  name: STRING_SCHEMA,
  token: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
}, ['id', 'name', 'token', 'createdAt']);

export const builtinGatewayPairingMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'pairing.tokens.list',
    title: 'List Paired Device Tokens',
    description: 'List the per-pairing operator tokens (paired devices/browsers) as redacted views: id, user-visible name, created timestamp, and last-seen timestamp. The token secret is never stored in listable form and is never returned.',
    category: 'pairing',
    scopes: ['read:control-plane'],
    transport: ['ws'],
    outputSchema: objectSchema({
      tokens: arraySchema(PUBLIC_PAIRING_TOKEN_SCHEMA),
      legacySharedRevoked: BOOLEAN_SCHEMA,
    }, ['tokens', 'legacySharedRevoked']),
  }),
  methodDescriptor({
    id: 'pairing.tokens.create',
    title: 'Mint Paired Device Token',
    description: 'Mint a new named per-device operator token and return its plaintext secret EXACTLY ONCE (for a QR / pairing hand-off). Only a hash is persisted; the secret is never listed or returned again. The name is user-visible and editable.',
    category: 'pairing',
    scopes: ['write:control-plane'],
    transport: ['ws'],
    inputSchema: objectSchema({ name: STRING_SCHEMA }, ['name']),
    outputSchema: objectSchema({ token: MINTED_PAIRING_TOKEN_SCHEMA }, ['token']),
  }),
  methodDescriptor({
    id: 'pairing.tokens.rename',
    title: 'Rename Paired Device Token',
    description: 'Change the user-visible name of a paired device token. An unknown id is a 404 PAIRING_TOKEN_NOT_FOUND.',
    category: 'pairing',
    scopes: ['write:control-plane'],
    transport: ['ws'],
    inputSchema: objectSchema({ id: STRING_SCHEMA, name: STRING_SCHEMA }, ['id', 'name']),
    outputSchema: objectSchema({ id: STRING_SCHEMA, renamed: BOOLEAN_SCHEMA }, ['id', 'renamed']),
  }),
  methodDescriptor({
    id: 'pairing.tokens.delete',
    title: 'Revoke Paired Device Token',
    description: 'Revoke (permanently delete) one paired device token. Revocation is immediate: the token fails the very next request with a 401, and every OTHER paired device keeps working. An unknown id is a 404 PAIRING_TOKEN_NOT_FOUND, never a 200-noop.',
    category: 'pairing',
    scopes: ['write:control-plane'],
    transport: ['ws'],
    inputSchema: objectSchema({ id: STRING_SCHEMA }, ['id']),
    outputSchema: objectSchema({ id: STRING_SCHEMA, revoked: BOOLEAN_SCHEMA }, ['id', 'revoked']),
  }),
  methodDescriptor({
    id: 'pairing.tokens.migrate',
    title: 'Migrate Off The Shared Token',
    description: 'A client currently authenticated with the legacy single shared token mints its OWN named per-device token and receives the plaintext secret once — the honest migration path. This does NOT revoke the shared token; that is a separate explicit step (pairing.tokens.revokeShared).',
    category: 'pairing',
    scopes: ['write:control-plane'],
    transport: ['ws'],
    inputSchema: objectSchema({ name: STRING_SCHEMA }, ['name']),
    outputSchema: objectSchema({ token: MINTED_PAIRING_TOKEN_SCHEMA }, ['token']),
  }),
  methodDescriptor({
    id: 'pairing.tokens.revokeShared',
    title: 'Revoke The Legacy Shared Token',
    description: 'Turn off the legacy single shared operator token. After this, only per-device pairing tokens (and user sessions) authenticate; the shared token stops working immediately. Idempotent.',
    category: 'pairing',
    scopes: ['write:control-plane'],
    transport: ['ws'],
    outputSchema: objectSchema({ legacySharedRevoked: BOOLEAN_SCHEMA }, ['legacySharedRevoked']),
  }),
  methodDescriptor({
    id: 'pairing.handoff.create',
    title: 'Create Pairing Hand-off',
    description: 'Mint a per-device token AND assemble the set-up OFFER SET this daemon can satisfy (notifications — carrying the VAPID public key; relay; passkey step-up), so a freshly-paired surface can complete them in one pass. Returns the offer set, the `#pair=<token>` deep-link fragment (the exact URL-fragment shape the web app consumes — token in `pair=`, offers in `offers=`), and a full deep link when a web origin is configured. The token secret is returned exactly once. Each offer is independently declinable at completion.',
    category: 'pairing',
    scopes: ['write:control-plane'],
    transport: ['ws'],
    inputSchema: objectSchema({
      name: STRING_SCHEMA,
      offers: arraySchema(STRING_SCHEMA),
    }, ['name']),
    outputSchema: objectSchema({
      token: MINTED_PAIRING_TOKEN_SCHEMA,
      offers: arraySchema(objectSchema({
        kind: STRING_SCHEMA,
        available: BOOLEAN_SCHEMA,
        vapidPublicKey: STRING_SCHEMA,
      }, ['kind', 'available'])),
      fragment: STRING_SCHEMA,
      deepLink: STRING_SCHEMA,
    }, ['token', 'offers', 'fragment']),
  }),
  methodDescriptor({
    id: 'pairing.handoff.complete',
    title: 'Complete Pairing Hand-off',
    description: 'Apply the surface\'s per-offer decisions in ONE pass: an accepted notifications offer registers the browser push subscription (endpoint + keys, optional deviceId), an accepted passkey offer registers the WebAuthn credential, an accepted relay offer is acknowledged. Each offer returns an honest per-offer result (completed / declined / unavailable / failed); an omitted or false offer is reported as declined, never silently half-applied.',
    category: 'pairing',
    scopes: ['write:control-plane'],
    transport: ['ws'],
    inputSchema: objectSchema({
      accept: objectSchema({
        notifications: objectSchema({
          endpoint: STRING_SCHEMA,
          keys: PUSH_SUBSCRIPTION_KEYS_SCHEMA,
          deviceId: STRING_SCHEMA,
        }, ['endpoint', 'keys']),
        relay: BOOLEAN_SCHEMA,
        passkey: objectSchema({
          rpId: STRING_SCHEMA,
          origin: STRING_SCHEMA,
          credentialId: STRING_SCHEMA,
          publicKeyCose: STRING_SCHEMA,
        }, ['rpId', 'origin', 'credentialId', 'publicKeyCose']),
      }, []),
    }, []),
    outputSchema: objectSchema({
      results: arraySchema(objectSchema({
        kind: STRING_SCHEMA,
        status: STRING_SCHEMA,
        detail: STRING_SCHEMA,
      }, ['kind', 'status'])),
    }, ['results']),
  }),
];
