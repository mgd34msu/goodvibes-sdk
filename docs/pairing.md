# Companion app pairing

## Overview

Pairing is the mechanism by which a companion app (mobile, desktop, browser) establishes a persistent authenticated connection to a running GoodVibes daemon.

The daemon runs locally on a host machine. Companion apps can be on the same machine or on a different device on the same network. Pairing solves the bootstrap problem: how does a companion app get a valid token without requiring the user to type credentials on a small screen?

The answer is a QR code (or a tappable deep link) displayed by the host surface (the TUI, a web UI, or the daemon's own HTTP endpoint). The user scans it, or opens the link, with the companion app or a browser. The code carries a one-time, per-device token as a URL fragment; the device that scans it lands already signed in. The companion app persists that token for all future API calls.

There are two token shapes in play, and both authenticate the same way at the network level:

- **Per-device pairing tokens** (current). Every pairing mints its own named,
  individually-revocable token. This is what a fresh `/qrcode` scan, or a `pairing.handoff.create`
  call, gives you today.
- **The legacy shared token.** One bearer token every companion held before per-device
  pairing existed. It still authenticates until an operator explicitly turns it off, and
  existing installs migrate off it device by device rather than all at once. See
  [Legacy: the shared token](#legacy-the-shared-token) below.

---

## Architecture

### Token-based authentication

GoodVibes companion pairing is built on the same bearer token mechanism documented in [authentication.md](./authentication.md). There is no separate pairing protocol at the network level. The companion app ultimately sends:

```http
Authorization: Bearer <token>
```

on every request, just like any other bearer client, whichever of the two token shapes it holds.

What makes pairing distinct is how that token is provisioned. Instead of a user typing it, the host surface mints it and encodes it into a QR code or deep link.

### Two token shapes

| | Per-device pairing token (current) | Legacy shared token |
| --- | --- | --- |
| Prefix | `gvp_` | `gv_` |
| Scope | One token per paired device, individually named | One token, shared by every companion that has not migrated off it |
| At-rest storage | Only a SHA-256 hash is persisted; the plaintext is returned exactly once, at mint time | The plaintext token itself is persisted |
| Revocation | `pairing.tokens.delete` revokes one device without affecting any other | `pairing.tokens.revokeShared` turns it off for every client still using it |
| Storage location | `<surfaceRoot>/control-plane/pairing-tokens.json` | `<daemonHomeDir>/operator-tokens.json` |

A presented bearer token is checked against per-device pairing tokens first, then the legacy
shared token (unless it has been revoked), then user sessions. Both a per-device token and the
legacy shared token carry full operator authority, identically to the bootstrap token.

### Persistent tokens

Both token shapes are persistent. Unlike session tokens, they do not expire automatically.
Revocation is always explicit:

- A per-device pairing token is minted once per pairing and stays valid until it is
  individually revoked (`pairing.tokens.delete`) or renamed (`pairing.tokens.rename`).
- The legacy shared token survives daemon restarts and stays valid until an operator calls
  `pairing.tokens.revokeShared`; the older, host-level `regenerateCompanionToken` API also
  replaces it (see [Legacy: the shared token](#legacy-the-shared-token)).

### Storage

**Per-device pairing tokens** live at:

```
<surfaceRoot>/control-plane/pairing-tokens.json
```

under the daemon's home directory. A daemon's `surfaceRoot` is `tui` for historical reasons;
the terminal app, the chat host, and the web app all read the same directory. The file holds only a
SHA-256 hash per token, never the plaintext, plus each token's id, user-visible name, created
timestamp, and last-seen timestamp. It is written at mode `0600`.

**The legacy shared token** is stored in a single global location under the daemon-home directory:

```
<daemonHomeDir>/operator-tokens.json
```

The canonical default is `~/.goodvibes/daemon/operator-tokens.json`. The file is written at mode `0600` and contains `{ token, peerId, createdAt }` in plaintext. The surface name (`'tui'`, etc.) is retained on the older host-level API for context but does **not** partition this path; all surfaces on a given host share one legacy token.

### Deep-link / QR content

The QR code (or tappable link) encodes the `#pair=<token>` URL fragment, plus an `offers=` key
naming which setup steps the pairing carries (see [Offer set](#offer-set) below):

```
https://app.example.com/#pair=gvp_AbC123...&offers=notifications,relay
```

The token rides in the URL **fragment**, never the query string, so it is never sent to a server:
no access-log entry, no `Referer` header exposure. A camera scan of the QR opens the web app
already carrying the one-time token, so the device lands signed in without any JSON blob to
parse. No producer encodes a raw JSON connection object as the QR content; that shape only
exists in the legacy flow described below.

---

## Pairing flow

### Step 1: Host mints a hand-off

The host surface calls the `pairing.handoff.create` gateway verb (or, for host code composing
the SDK directly, `mintPairingHandoff()` from `@pellux/goodvibes-sdk/platform/pairing`) with a
device name and the offer set it wants to present:

```ts
import { mintPairingHandoff, availablePairingOffers, defaultPairingTokenName } from '@pellux/goodvibes-sdk/platform/pairing';

const offers = availablePairingOffers({
  relayEnabled: true,       // relay.enabled + relay.url configured
  stepUpAvailable: true,    // a WebAuthn step-up verifier is wired
});

const handoff = mintPairingHandoff({
  pairingTokens,             // a PairingTokenManager instance
  name: defaultPairingTokenName(), // e.g. 'paired device (2026-08-21 10:00)'
  offers,
  webOrigin: 'https://app.example.com', // the web app origin the link opens
});

// handoff.token.token is the plaintext secret, returned exactly once.
// handoff.fragment is '#pair=<token>&offers=...'
// handoff.deepLink is '<webOrigin>/#pair=<token>&offers=...' when webOrigin was given
// handoff.posture is the origin's honest TLS/capability posture (see below)
```

This mints a brand-new per-device token every time; it is not idempotent the way the legacy
`getOrCreateCompanionToken` was. Opening the pairing UI again mints a fresh token and QR rather
than reprinting the last one.

### Step 2: Host renders the QR

```ts
import { generateQrMatrix, renderQrToString, pairingQrContent } from '@pellux/goodvibes-sdk/platform/pairing';

const matrix = generateQrMatrix(pairingQrContent(handoff));
// matrix is a QrMatrix object: { size: number; modules: readonly boolean[][] }; modules[row][col] === true means a dark module
```

For TUI surfaces, `renderQrToString(matrix)` prints a block-character QR code. For graphical
surfaces, iterate `matrix.modules` over `matrix.size` rows and columns to draw the cells.

### Offer set

A single pairing exchange can carry an **offer set**, so a freshly-paired device completes
several setup steps in one pass instead of a separate flow per feature. Each offer is
independently declinable:

- **`notifications`.** Registers the device for browser push (the response carries the VAPID
  public key needed to subscribe). Always available; browser push needs no server-side
  prerequisite beyond the key the daemon mints on demand.
- **`relay`.** Acknowledges that the surface may connect through the rendezvous relay for
  off-LAN reach. Available only when the relay is configured; see
  [Zero-knowledge relay](./relay-zero-knowledge.md).
- **`passkey`.** Registers a WebAuthn credential for relay step-up. Available only when a
  step-up verifier is wired.

`pairing.handoff.create` returns the offers actually available on this daemon; a surface
presents only those. After the device scans and completes its side of each accepted offer, it
calls `pairing.handoff.complete` with its per-offer decisions in one pass. Each offer resolves
to an honest per-offer result (`completed` / `declined` / `unavailable` / `failed`); an omitted
or explicitly declined offer is reported as `declined`, never silently half-applied.

### Origin posture

Every hand-off carries the honest TLS/capability posture of the web origin the link opens (also
readable standalone via `pairing.posture.get`): whether the origin is plain http on a private
network (a supported posture, not an error), and, for each browser-gated capability (service
worker/PWA install, push notifications, microphone), whether it is available or needs https. See
[TLS posture](#tls-posture-http-on-your-lan-tailscale-for-the-full-pwa) below for the full
picture.

### Device cap

Pairing is bounded by `device.nodes.maxPaired`. A **new** device pairing at the cap is refused
with a named, actionable error (`PairingLimitReachedError`, wire code `DEVICE_NODES_MAX_PAIRED`)
that states the setting, the cap, and the current count. A device **re-pairing under a name it
already holds** is never refused by the cap. Its previous token is superseded, which is what
"re-pair this device" means, and the paired count does not creep upward. Lowering the cap below
the current count does not unpair anyone; it only blocks the next new pairing until enough
devices are unpaired to fit under it again.

---

## Per-device token lifecycle

- **List** paired devices with `pairing.tokens.list`: id, user-visible name, created timestamp,
  and last-seen timestamp for every device, plus whether the legacy shared token has been
  revoked. The secret is never returned by this call.
- **Rename** a device with `pairing.tokens.rename({ id, name })`. An unknown id is a 404
  `PAIRING_TOKEN_NOT_FOUND`.
- **Revoke** one device with `pairing.tokens.delete({ id })`. Revocation is immediate; the token
  fails the very next request with a 401, and every other paired device keeps working. An unknown
  id is a 404 `PAIRING_TOKEN_NOT_FOUND`, never a `200`-noop.
- **Mint** a fresh token for the same use case pairing normally does, `pairing.tokens.create({
  name })` or `pairing.handoff.create`, both bounded by [the device cap](#device-cap).

## Legacy: the shared token

Before per-device pairing tokens existed, every companion app shared one bearer token, and the
QR code encoded a raw JSON connection object instead of a deep link. This mechanism still works
today for backward compatibility and existing installs migrate off it device by device, but new
pairings should use the [Pairing flow](#pairing-flow) above instead.

### Generating the shared token

The host surface calls `getOrCreateCompanionToken(options)` to get the existing shared token, or generate one if none exists:

```ts
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getOrCreateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';

const daemonHomeDir = join(homedir(), '.goodvibes', 'daemon');
const record = getOrCreateCompanionToken({ daemonHomeDir });
// record: { token, peerId, createdAt }
```

This is synchronous and idempotent. Calling it repeatedly returns the same record until
`regenerateCompanionToken` (host-level) or `pairing.tokens.revokeShared` (the operator verb) is
called. Token storage is daemon-home scoped (see [Storage](#storage)).

### Building the legacy connection payload

```ts
import { buildCompanionConnectionInfo, encodeConnectionPayload } from '@pellux/goodvibes-sdk/platform/pairing';

const payload = buildCompanionConnectionInfo({
  daemonUrl: 'http://192.168.1.42:3421',
  token: record.token,
  username: 'admin',      // optional; defaults to 'admin'
  version: 'host-product-version', // optional
  surface: 'tui',          // optional; defaults to 'daemon'
  // password: 'bootstrap-pw',  // optional; include when local auth is active
});

const json = encodeConnectionPayload(payload);
// { url, token, username, version, surface, password? }, JSON-encoded for the QR
```

The `daemonUrl` should be the address reachable by the companion device. For local-only use, `http://127.0.0.1:3421` works. For cross-device pairing, use the host machine's LAN address.

### Encoding and rendering

```ts
import { generateQrMatrix, renderQrToString } from '@pellux/goodvibes-sdk/platform/pairing';

const matrix = generateQrMatrix(json);
const qrString = renderQrToString(matrix); // block-character QR for terminal output
```

### Companion side: parsing the legacy payload

```ts
// Companion-side (pseudocode)
const raw = qrScanner.scan();
const payload = JSON.parse(raw) as CompanionConnectionInfo;
await tokenStore.setToken(payload.token);
const sdk = createGoodVibesSdk({ baseUrl: payload.url, tokenStore });
```

### Migrating off the shared token

A client currently authenticated with the shared token calls `pairing.tokens.migrate` (giving it
a name) to mint its own per-device token without disrupting any other client still on the shared
token. This does **not** revoke the shared token; that is the separate, explicit
`pairing.tokens.revokeShared` call, which an operator makes once every client has migrated.

---

## Companion connects

Once a companion holds a token, whichever shape it is, every subsequent API call carries it as a
Bearer header:

```http
GET /api/control-plane/auth HTTP/1.1
Authorization: Bearer <token>
```

Use the SDK's standard auth helpers to handle this automatically:

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const tokenStore = createMemoryTokenStore();
await tokenStore.setToken(token);

const sdk = createGoodVibesSdk({
  baseUrl,
  tokenStore,
});

// All sdk.operator.* and sdk.realtime.* calls now include the Bearer header
const status = await sdk.operator.control.status();
```

For React Native or Expo, prefer the built-in secure token stores rather than rolling a custom adapter:

- **Expo**: `createExpoSecureTokenStore` from `@pellux/goodvibes-sdk/expo`, backed by `expo-secure-store`
- **iOS**: `createIOSKeychainTokenStore` from `@pellux/goodvibes-sdk/react-native`, backed by iOS Keychain
- **Android**: `createAndroidKeystoreTokenStore` from `@pellux/goodvibes-sdk/react-native`, backed by Android Keystore

```ts
import { createReactNativeGoodVibesSdk, createIOSKeychainTokenStore } from '@pellux/goodvibes-sdk/react-native';

const tokenStore = createIOSKeychainTokenStore({ service: 'com.example.gv' });
const sdk = createReactNativeGoodVibesSdk({
  baseUrl,
  tokenStore,
});
```

For `createMemoryTokenStore` (non-persistent, suitable only for ephemeral use or development), import from `@pellux/goodvibes-sdk/auth`.

---

## Legacy shared-token lifecycle

### Creating a token

`getOrCreateCompanionToken({ daemonHomeDir })` creates a JSON record (`{ token, peerId, createdAt }`) if none exists at `<daemonHomeDir>/operator-tokens.json` and returns it. The file is written at mode `0600`.

### Regenerating a token

Calling `regenerateCompanionToken({ daemonHomeDir })` (equivalent to `getOrCreateCompanionToken` with `regenerate: true`) issues a new token and replaces the stored record. Any companion app holding the previous token will receive `401 Unauthorized` on its next API call and must re-pair.

```ts
import { regenerateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';

const newRecord = regenerateCompanionToken({ daemonHomeDir });
```

Rotate tokens proactively if:
- The companion device is lost or stolen.
- You believe the token may have been observed by a third party.
- You are decommissioning a companion app.

### Reading a stored token

There is no dedicated `readCompanionToken` export. To inspect the stored record without regenerating, read `<daemonHomeDir>/operator-tokens.json` directly, or call `getOrCreateCompanionToken({ daemonHomeDir })`; it is idempotent and returns the existing record if present.

---

## Security considerations

> These notes are companion-pairing specific. For the daemon's full security model, authentication modes, token management, and secret handling, see [Security best practices](./security.md).

### Token storage on the host

Per-device pairing tokens are stored **hashed** (SHA-256): the file at
`<surfaceRoot>/control-plane/pairing-tokens.json` never holds a usable secret, only the hash,
the device's name, and its created/last-seen timestamps.

The legacy shared token is stored as a plaintext JSON file at `<daemonHomeDir>/operator-tokens.json` (default: `~/.goodvibes/daemon/operator-tokens.json`). This file should have user-only read permissions. The SDK sets `0600` on creation and re-enforces it via `chmodSync` after write. Do not commit either file to source control; the daemon home directory should be outside any project tree.

### Token storage on the companion

On mobile companions:
- Use the platform's secure storage (iOS Keychain, Android Keystore).
- Use a `GoodVibesTokenStore` adapter backed by `expo-secure-store` or `react-native-keychain`, which use the platform keychain.
- Never store the token in AsyncStorage, localStorage, or other unencrypted stores.

### QR code exposure

The QR code (or deep link) encodes the token in plaintext, in the URL fragment. Treat the QR
code display like a password prompt:
- Do not record or screenshot the QR display in shared environments.
- The QR is displayed on-demand; each open mints a fresh per-device token, so scrolling it off
  the screen costs nothing.
- If you believe a shown code was observed by an unintended party, revoke that device's token
  (`pairing.tokens.delete`) rather than leaving it live; for the legacy shared token, regenerate
  it (see [Legacy shared-token lifecycle](#legacy-shared-token-lifecycle)).

### TLS posture: http on your LAN, tailscale for the full PWA

This is the honest picture, stated once (surfaces render the same line from the
pairing contract, never as a recurring nag):

**Plain http on your LAN works, and is a supported posture.** A phone on the
same private network (a `10.x`/`172.16-31.x`/`192.168.x` address, a `.local`
mDNS name, or localhost) uses the full cockpit over http. The transport does
not refuse private-network origins. Two things are true about it:

1. The connection is unencrypted on your local network. Anyone who can already
   capture traffic on your LAN can read it, including the bearer token.
2. Browsers gate a few capabilities on a *secure context* (https, or the
   localhost loopback): **service worker or PWA install, push notifications,
   and the microphone**. On plain http over the LAN these are unavailable.
   the daemon reports each one in the pairing/posture contract
   (`pairing.posture.get`, and the `posture` field of `pairing.handoff.create`)
   so surfaces show a "needs https, available via tailscale" label instead of
   a dead button. Localhost keeps all three.

**Full PWA needs TLS, and TLS on a home network is your responsibility.** The
daemon never mints certificates and never provisions its own CA. If you
already run real TLS (a reverse proxy with a real certificate), that works
as-is via the daemon HTTP policy's TLS configuration.

**Tailscale is the recommended path.** Encrypted access and a real https URL
with zero certificate handling on your side. Worked example:

```bash
# One-time: install tailscale on the daemon host and the phone, log both in.
tailscale up

# Front the daemon's web surface (default port 3423) at your MagicDNS name.
# TLS is terminated by tailscale; the daemon never touches a certificate.
tailscale serve --bg 3423

# The daemon is now at e.g. https://yourhost.your-tailnet.ts.net;
# open that on the phone: secure context, full PWA, push, microphone.
```

The daemon offers this as a one-action affordance: `tailscale.get` (read-only
detection: binary, logged-in state, MagicDNS name; where tailscale is absent,
nothing nags) and `tailscale.serve.run` (runs the serve command above for you,
records an honest receipt, and updates `web.publicBaseUrl` to the https URL).

### Token rotation

Per-device tokens do not need scheduled rotation the way the legacy shared token did. Every
device already holds its own token, so revoking one (`pairing.tokens.delete`) never disrupts
any other device, and the low-friction response to loss, theft, or suspected exposure is to
revoke that one device and let it re-pair, not to rotate a token every device shares.

For the legacy shared token, implement an explicit rotation policy appropriate for your threat
model:
- Low-risk local use: rotate on device loss or on demand.
- Cross-network or shared-host use: consider periodic rotation (e.g. monthly) via `regenerateCompanionToken`, or migrate every client off it (`pairing.tokens.migrate`) and revoke it (`pairing.tokens.revokeShared`) instead.

---

## Integration examples

### TUI `/qrcode` command

The TUI exposes a `/qrcode` command (aliases `/qr`, `/pair`) that opens the device-pairing modal:
a QR of the `#pair=<token>` deep link plus the offer set.

```
/qrcode
```

Each open mints its own named per-device token, so `/qrcode regenerate` no longer rotates a
shared token the way it once did; it simply re-opens the modal, which mints a fresh token and QR
in place. The token shown by a previous open stays valid until it is explicitly revoked in the
device management surface (`/settings` → security → devices, or `pairing.tokens.delete`).

### Daemon CLI `pair` command

`goodvibes-daemon pair` (aliases `qr`, `qrcode`) prints the pairing block, made up of the web
origin, the offer set, and a QR code encoding the deep link.

```bash
# Local form: reprint the daemon's own pairing block.
goodvibes-daemon pair

# Remote form: mint a NEW per-device token on another daemon and print its block.
goodvibes-daemon pair --host <name> [-y]
```

**Local form** (no `--host`, or one naming this machine) reprints the **existing shared token**
rather than minting a new one, so a link printed here and the one printed at boot are the same
link; scrolling the startup banner off the screen costs nothing.

**Remote form** (`--host` naming another machine) asks that daemon to **mint a new** per-device
pairing token and prints the pairing block for it. Minting is a different act than reprinting:
it is a fresh token, and every token that daemon already issued, its shared token included, is
left untouched. Because this changes state on a daemon that may not be the local process's own,
it states the plan and asks for confirmation before acting (`-y`/`--yes` for the non-interactive
answer); an unreachable daemon, a rejected token, or a daemon too old to serve the mint verb are
each refused by name.

> **SDK vs host wiring:** The `/qrcode` TUI command and the `goodvibes-daemon pair` subcommand
> are host-application wrappers, not SDK exports. The primitives they compose,
> `mintPairingHandoff`, `generateQrMatrix`, `renderQrToString`, and (for the legacy path)
> `getOrCreateCompanionToken`, `buildCompanionConnectionInfo`, `encodeConnectionPayload`, are all
> exported from `@pellux/goodvibes-sdk/platform/pairing` and can be composed directly by any
> embedder.

---

## Building a companion app

### What the companion needs

A companion app requires:

1. **A QR scanner, or a deep-link handler.** To capture the pairing code displayed by the host surface, either a camera scan (native camera APIs or libraries like `expo-barcode-scanner`) or, for a web/PWA companion, handling its own app being opened at a `#pair=<token>` URL. Either way, parse the result with `parsePairingHandoffLink()` from `@pellux/goodvibes-sdk/platform/pairing` (current flow) or `JSON.parse()` (legacy payload; see [Legacy: the shared token](#legacy-the-shared-token)).

2. **Persistent, secure token storage.** To retain the companion token across app restarts. See the token storage guidance above.

3. **An HTTP client.** For all request/response interactions. The SDK handles this when used as a client library. For native Kotlin/Swift apps without the SDK, use standard `fetch`, `URLSession`, or `OkHttp` with the `Authorization: Bearer <token>` header.

4. **An SSE or WebSocket connection.** For realtime event delivery. The daemon exposes both:
   - SSE: suitable for Bun and browser clients.
   - WebSocket: recommended for React Native and Expo because it has broader React Native support.

### Minimal integration pattern (React Native / Expo)

```ts
import { createReactNativeGoodVibesSdk, createIOSKeychainTokenStore } from '@pellux/goodvibes-sdk/react-native';

// createIOSKeychainTokenStore and createAndroidKeystoreTokenStore are available from
// @pellux/goodvibes-sdk/react-native. For Expo, use createExpoSecureTokenStore
// from @pellux/goodvibes-sdk/expo.
const tokenStore = createIOSKeychainTokenStore({ service: 'com.example.goodvibes' });

export function usePairedSdk(baseUrl: string) {
  const sdk = createReactNativeGoodVibesSdk({
    baseUrl,
    tokenStore,
  });
  return sdk;
}

// After scanning the QR code (or opening the deep link):
import { parsePairingHandoffLink } from '@pellux/goodvibes-sdk/platform/pairing';

async function onPairingLinkReceived(scannedOrOpenedUrl: string) {
  const parsed = parsePairingHandoffLink(scannedOrOpenedUrl);
  if (!parsed) return; // not a pairing link
  await tokenStore.setToken(parsed.token);
  // parsed.offers names which setup steps (notifications/relay/passkey) this
  // pairing carries; complete them with pairing.handoff.complete.
  // sdk is now ready to use with the stored token
}
```

### Minimal integration pattern (native Android / iOS)

Native clients that do not use the TypeScript SDK can connect using standard HTTP:

```
# Verify the token is working
GET /api/control-plane/auth
Authorization: Bearer gvp_abc123...
```

For realtime events, open a WebSocket to:

```
ws://<daemon-host>:<port>/api/control-plane/ws
```

with the same `Authorization: Bearer <token>` header (or as a query parameter if the WebSocket client library does not support custom headers).

Event envelopes arrive as JSON-serialized `SerializedEventEnvelope` objects. The schema is exported as `SerializedEventEnvelopeSchema` from `@pellux/goodvibes-sdk/contracts`.

### Handling token invalidation

When a device's token is revoked (`pairing.tokens.delete`), or the legacy shared token is
regenerated or turned off, that device's connection starts receiving `401` responses. Implement a re-pairing flow:

```ts
sdk.operator.control.status().catch(async (err) => {
  if (err.kind === 'auth') {
    // Token has been invalidated; prompt user to re-scan the QR code
    showRepairingScreen();
  }
});
```

The recommended UX is to show a re-pairing prompt rather than a generic error screen, since token invalidation is an expected operational event (not a crash or network failure).
