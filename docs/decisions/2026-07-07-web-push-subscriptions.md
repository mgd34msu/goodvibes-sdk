# Decision: browser push (Web Push) subscriptions, VAPID key custody, and the delivery seam

Date: 2026-07-07
Scope: SDK enabler for the desktop web UI — the headline PWA capability (receive
approvals/completions as browser push notifications). Lands on SDK main.
Status: accepted

## Context

Before this, browser push did not exist anywhere in the SDK: a grep for
`vapid` / `webpush` / `pushSubscription` across all packages returned zero hits,
and notifications went out through delivery channels (ntfy/slack/etc.), never as
Web Push. A PWA cannot receive a native notification without a Web Push
subscription + VAPID-signed delivery, so this had to be built from nothing.

Two facts shaped the design:

1. **Subscription endpoints are capability URLs and the VAPID private key is a
   secret.** Anyone holding a subscription endpoint can push to that device;
   anyone holding the VAPID private key can forge deliveries. Both must be kept
   off the wire and handled like credentials.
2. **The SDK already has the pieces to do this without a new dependency.** Node's
   built-in `crypto` covers P-256 keygen, ECDH, HKDF, AES-128-GCM, and ES256
   signing — everything RFC 8291 (message encryption) and RFC 8292 (VAPID)
   require. The channels delivery seam is prior art for fanning an event out to
   many destinations, and the approval broker already exposes a `subscribe()`
   listener seam.

## Decision

### 1. Verbs (core-verb spec compliant)

A new `push.*` group, declared as descriptors in
`control-plane/method-catalog-push.ts` and wired into `BUILTIN_GATEWAY_METHODS`,
with handlers attached at RuntimeServices construction time via
`catalog.register(descriptor, handler)` (the same mechanism `fleet.*` uses),
reached over real HTTP through the generic
`/api/control-plane/methods/{id}/invoke` endpoint:

- `push.vapid.get` — serve the public application-server key. (`get`, core)
- `push.subscriptions.create` — register a device (endpoint + p256dh/auth).
  (`create`, core — "subscribe")
- `push.subscriptions.list` — list the caller's devices, redacted. (`list`, core)
- `push.subscriptions.delete` — unsubscribe. (`delete`, core — delete means delete)
- `push.subscriptions.verify` — send a live test push, return an honest receipt.

`verify` is not a generic CRUD word, so it is documented in a new `push-delivery`
category in `packages/contracts/src/core-verbs.ts` rather than smuggled in — a
single-purpose delivery probe, per the spec's own extension path.

### 2. VAPID key custody — private key as a secret, never in the config

`push/vapid.ts` generates one P-256 keypair on first real need (lazy — a daemon
that never uses push never mints or stores a key) and persists the WHOLE keypair
(including the private JWK) only through the `SecretsManager`, under the secret
key `push.vapid.keypair`. That means it lands in the secure store (or the
plaintext secrets file) per the active secret policy — **never** in the config,
so it can never ride out in the secret-free config snapshot. The private key is
used only to sign the short-lived VAPID JWT for one delivery; it is never logged
and never returned by any read verb. Only the public key leaves the daemon
(`push.vapid.get` and the `k=` parameter of the `Authorization` header).

Subscription endpoints and key material are treated the same way: stored on disk
in the daemon's own state directory (an atomic JSON store, same posture as the
approval/session stores), and never returned over the wire. Read verbs hand back
a redacted `PublicPushSubscription` (id, endpoint origin + short hash,
timestamps, last outcome) — enough to manage a device without handing the
capability back out.

### 3. Delivery seam — one path, honest failure, one real event source

`push/delivery.ts` is the single place a message is encrypted (RFC 8291 +
`aes128gcm`, Node crypto) and POSTed to the subscription endpoint with the
`Content-Encoding`, `TTL`, `Urgency`, and VAPID `Authorization` headers. The
endpoint is whatever the browser registered — in tests a local HTTP sink, in
production the browser vendor's push service; this module never contacts a
hard-coded service of its own.

Honest degrade is centralized here: a `2xx` is `delivered`; a `404/410 gone`
prunes the subscription (delete means delete on prune too) and reports `pruned`
with the status that proved it dead; any other non-2xx or transport error is
`failed` with the reason — never a faked success. No subscriptions means an
empty receipt list, not a silent success.

The **real event source** wired for this landing is the approval broker: when an
approval is created (`status: pending`), `PushService.attachApprovalSource`
fans a high-urgency push to every registered device. Later re-publishes of the
same approval (claimed/approved/denied) do not re-notify. This reuses the
broker's existing `subscribe()` listener seam rather than adding a stub, per the
no-deferral rule. Turn/agent-completion is a natural second source on the same
`deliver()` dispatch point and can be added the same way.

### 4. No new dependency

RFC 8291 encryption and RFC 8292 signing are implemented directly on Node's
built-in `crypto` (validated to work under Bun): `generateKeyPairSync('ec',
prime256v1)`, `createECDH`, HKDF over `createHmac`, `createCipheriv('aes-128-gcm')`,
and `sign('sha256', …, { dsaEncoding: 'ieee-p1363' })` for the raw-r||s ES256
signature. Pulling in a third-party `web-push` package would have added a
dependency for primitives the platform already ships. The push module is
daemon-side only and is not imported by the runtime-neutral or browser bundles.

## Verification

`test/web-push-daemon-wire.test.ts` — a real `bootDaemon` proof (isolated home,
ephemeral port, token auth) against a **local fake push sink** (never a real
push service, never the external network):

- `push.vapid.get` returns a 65-byte public key and no private material.
- subscribe stores a device and `list` shows it; both wire views are redacted
  (no capability URL, no key material).
- `verify` produces a real encrypted delivery: correct `aes128gcm` body shape +
  `TTL`/`Urgency`/VAPID headers, and the ciphertext **decrypts** back to the test
  payload (RFC 8291 round trip proven by a receiver-side decrypt in the test).
- a created approval fans out as a high-urgency push that decrypts to the
  approval summary.
- a `410`-gone endpoint is pruned with a `pruned` receipt and vanishes from the
  list.
- unsubscribe removes the record; a second delete is an honest `404`.
- the VAPID private key is retrievable only through the SecretsManager, never
  appears in any config/settings file, and is never returned by a read verb.

Contract/verb/parity gates green: `refresh:contracts:check`, `contracts:check`,
`docs:check`, `line:check`, `any:check`, and the core-verbs conformance +
operator-contract catalog + transport-parity suites.
