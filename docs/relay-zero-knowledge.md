# Zero-knowledge relay — reachability without a trusted operator

The relay makes a durable daemon (an always-on box) reachable from a surface
(webui / PWA on a phone) that is **off the LAN**, without any party — including
whoever runs the relay — being able to read the traffic. This page states the
design and, plainly, exactly what the relay can and cannot see.

The rule this implements: if GoodVibes ships reachability, it is the
zero-knowledge, self-hostable relay or nothing. Every vendor "remote control"
relay routes traffic the vendor can read; this one cannot.

## Shape

```
  surface (off-LAN)                relay (any VPS)                 daemon (home box)
        |                               |                                |
        |  connect(rid) ───────────────►|                                |
        |                               |◄────────────── register(rid) ──|  (outbound)
        |◄──────── connected(pipe) ─────|── pipe-open(pipe) ────────────►|
        |                               |                                |
        |═══ E2E handshake (NK) ════════╪════════════════════════════════|
        |═══ ciphertext ════════════════╪═══ ciphertext (═ [pipe]+ct) ═══|
```

- The **daemon dials the relay outbound** and registers under an unguessable
  **rendezvous id**. It needs no inbound port and no public IP.
- A **surface dials the same rendezvous id**; the relay pairs the two and
  multiplexes many surface pipes over the one daemon socket.
- Before any application byte, an **end-to-end (E2E) handshake** runs *inside*
  the pipe. Everything after it is ciphertext the relay forwards verbatim.

## The E2E handshake (primitives)

A Noise **NK**-style authenticated key exchange, built only from Web Crypto
primitives — no new dependency, nothing hand-rolled:

- **ECDH over NIST P-256** for key agreement (universally available across the
  browser PWA, Bun daemon, and Node; matches the curve already used for push
  encryption).
- **HKDF-SHA-256** to derive keys, bound to the full handshake transcript
  (rendezvous id + both ephemeral public keys + the daemon static public key).
- **AES-256-GCM** for the record layer, with per-direction keys and
  strictly-increasing counters so a (key, nonce) pair is never reused and
  replayed/reordered frames are rejected.

The surface pins the **daemon's static public key** from the pairing payload.
The derived keys mix a static-ephemeral DH against that pinned key, so:

- **Daemon authentication** — only the real daemon holds the matching private
  key, so a curious or malicious relay that tries to sit in the middle cannot
  derive the session keys; its forged handshake confirmation fails and the
  surface tears the pipe down.
- **Forward secrecy** — an ephemeral-ephemeral DH means recording ciphertext and
  later stealing the daemon's static key still does not reveal past sessions.

## Trust bootstrap: the pairing payload

Trust starts with a **pairing payload** — a compact, QR-encodable string
(`gvrelay1.…`) carrying the relay URL, the rendezvous id, and the daemon's
pinned static public key. Deliver it out-of-band (scan a QR on the same LAN,
copy the string). This is the same trust model as an SSH host-key fingerprint or
pairing a phone by scanning a code. **Treat a valid pairing payload like a
credential**: whoever holds one can reach the daemon through the relay.

## What the relay can and cannot see

**Cannot see** (structural, not policy):

- Request/response contents, paths, headers, bodies, auth tokens — all inside
  the AES-256-GCM tunnel. The operator's bearer token rides *inside* the tunnel.
- The E2E keys — every key derives from DH secrets the relay never receives.

**Can see** (connection metadata — stated plainly):

- Which rendezvous id a daemon registered and which surfaces paired with it.
- The multiplexed **pipe ids** it assigns for routing.
- **Traffic-analysis signals**: message sizes, counts, and timing.
- Network-level metadata (source IPs, connection lifetimes).

## What a malicious relay could do

- **Read content?** No — it only ever forwards ciphertext.
- **Impersonate the daemon (MITM)?** No — it lacks the pinned static private
  key, so it cannot complete the handshake.
- **Traffic analysis** — yes: it sees sizes/timing/pairing metadata and can
  fingerprint activity. If that matters, run your own relay.
- **Denial of service** — yes: like any middlebox it can drop or delay traffic,
  or refuse to pair. This is why the relay is **self-hostable** — the honest
  answer to "don't trust the operator" is "be the operator." A public instance
  is defended by caps (max daemons/pipes/per-daemon pipes/message size) and
  per-address handshake rate limiting so it cannot be turned into a liability,
  but it can never be made trustworthy for availability the way a self-hosted
  one is.
- **No accounts, no stored state** on the relay — nothing to breach there.

## Security controls around the path

- **WebAuthn step-up on mutating relay calls.** Reaching the daemon off-LAN is
  higher-risk than a call on the trusted LAN, so an operator can require that
  *state-changing* operator calls arriving via relay carry a recent WebAuthn
  (passkey) step-up assertion (`relay.requireStepUpForMutations`). Which methods
  are mutating comes straight from the operator catalog (read-only methods carry
  `read:<domain>` scope + a GET binding; mutating ones carry `write:<domain>` +
  POST/PUT/PATCH/DELETE). **Honest scope:** the SDK ships the *policy hook* and
  the verb metadata; actual assertion verification is a consumer-side ceremony
  (a credential store and per-call challenge), wired as an injected
  `StepUpAssertionVerifier`. Until one is wired, the policy **fails closed** —
  it denies rather than allowing or faking a pass. Nothing ever reports an
  unverified assertion as verified.
- **Daemon-minted LAN HTTPS.** `mintLanCertificate` mints a local CA + a SAN
  leaf certificate for the daemon's LAN endpoints so browsers stop warning on
  LAN access. **Honest scope:** it *generates* (via `openssl`, not hand-rolled
  ASN.1), *stores*, and returns paths that plug into the existing
  `controlPlane.tls` config to *serve*. **Trusting the minted CA on your OS /
  browser is your step** — the helper never touches the OS trust store.
- **Relay connections are visibly distinct.** Every tunneled request is tagged
  with an `x-goodvibes-via-relay` header (`isRelayTunneledRequest`), and the
  daemon exposes the relay registration status, so surfaces can show a
  connection as "via relay" and apply relay-specific policy.

## Enabling it

Reaching the daemon over the relay is **OFF by default** and triple-gated:

1. `relay.enabled` config (default `false`),
2. the graduating `relay-connect` feature flag (default disabled), and
3. a configured `relay.url`.

All three must agree before the daemon opens an outbound registration; otherwise
the relay path is byte-for-byte inert and the daemon stays LAN-only.

Run your own relay with the bundled server:

```
GOODVIBES_RELAY_PORT=8787 bun run --bun @pellux/goodvibes-daemon-sdk/relay-server-entry
```

Put it behind TLS (`wss://`) at the edge, point `relay.url` at it, pair a surface
with the daemon's QR, and you have reachability that no operator — not even you,
running the relay — can read.

## Deferrals (stated honestly)

- **SSE/event streaming over the relay is not yet bridged.** The relay tunnels
  unary request/response calls (the bulk of the operator surface); event
  streaming keeps using the direct realtime connectors on the LAN. A streaming
  bridge is future work, not faked.
- **WebAuthn verification** is a policy hook plus an injected verifier interface,
  not a bundled ceremony (see above). It fails closed until wired.
