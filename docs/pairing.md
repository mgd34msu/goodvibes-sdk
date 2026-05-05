# Companion App Pairing

## Overview

Pairing is the mechanism by which a companion app (mobile, desktop, browser) establishes a persistent authenticated connection to a running GoodVibes daemon.

The daemon runs locally on a host machine. Companion apps can be on the same machine or on a different device on the same network. Pairing solves the bootstrap problem: how does a companion app get a valid token without requiring the user to type credentials on a small screen?

The answer is a QR code displayed by the host surface (the TUI, a web UI, or the daemon's own HTTP endpoint). The user scans it with the companion app. The QR code encodes a pre-generated token plus connection details in a single JSON payload. The companion app extracts the token and stores it for all future API calls.

---

## Architecture

### Token-based authentication

GoodVibes companion pairing is built on the same bearer token mechanism documented in [authentication.md](./authentication.md). There is no separate pairing protocol at the network level — the companion app ultimately sends:

```http
Authorization: Bearer <companion-token>
```

on every request, just like any other bearer client.

What makes pairing distinct is how that token is provisioned: instead of a user typing it, the host surface generates it and encodes it into a QR code.

### Persistent tokens

Companion tokens are persistent. Unlike session tokens, they do not expire automatically. Rotation is explicit (the host calls `regenerateCompanionToken`, which invalidates the previous token). This means:

- The companion app only needs to pair once.
- The token survives daemon restarts.
- Revocation is manual: the host must explicitly regenerate to invalidate a compromised token.

### Storage

The companion/operator token is stored in a single global location under the daemon-home directory:

```
<daemonHomeDir>/operator-tokens.json
```

The canonical default is `~/.goodvibes/daemon/operator-tokens.json`. The file is written at mode `0600` and contains `{ token, peerId, createdAt }`. The surface name (`'tui'`, etc.) is retained on the API for context but does **not** partition the token path; all surfaces on a given host share one companion/operator token.

### Connection payload

The QR code encodes a `CompanionConnectionInfo` JSON object containing everything the companion app needs to connect:

```json
{
  "url": "http://192.168.1.42:3421",
  "token": "gv_abc123...",
  "username": "admin",
  "version": "host-product-version",
  "surface": "tui",
  "password": "<bootstrap-password, optional>"
}
```

| Field | Description |
| --- | --- |
| `url` | Base URL of the daemon HTTP endpoint |
| `token` | Pre-generated bearer token for all API calls (prefix `gv_`) |
| `username` | Default operator principal name (defaults to `admin`) |
| `version` | Host product version (SDK/TUI semver at time of issue) |
| `surface` | Surface name that generated the token, e.g. `tui` or `daemon` |
| `password` | Optional bootstrap password when local auth is active; omitted otherwise |

---

## QR Code Flow

### Step 1: Host generates a companion token

The host surface calls `getOrCreateCompanionToken(options)` to get an existing persistent token, or generate one if none exists:

```ts
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getOrCreateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';

const daemonHomeDir = join(homedir(), '.goodvibes', 'daemon');
const record = getOrCreateCompanionToken({ daemonHomeDir });
// record: { token, peerId, createdAt }
```

This is synchronous and idempotent. Calling it repeatedly returns the same record until `regenerateCompanionToken` is called. Token storage is daemon-home scoped (see [Storage](#storage)).

### Step 2: Host builds the connection payload

```ts
import { buildCompanionConnectionInfo } from '@pellux/goodvibes-sdk/platform/pairing';

const payload = buildCompanionConnectionInfo({
  daemonUrl: 'http://192.168.1.42:3421',
  token: record.token,
  username: 'admin',      // optional; defaults to 'admin'
  version: 'host-product-version', // optional
  surface: 'tui',          // optional; defaults to 'daemon'
  // password: 'bootstrap-pw',  // optional; include when local auth is active
});

// payload is a plain JSON-serializable CompanionConnectionInfo:
// { url, token, username, version, surface, password? }
```

The `daemonUrl` should be the address reachable by the companion device. For local-only use, `http://127.0.0.1:3421` works. For cross-device pairing, use the host machine's LAN address.

### Step 3: Host encodes the payload to a QR matrix

```ts
import { generateQrMatrix } from '@pellux/goodvibes-sdk/platform/pairing';

const matrix = generateQrMatrix(JSON.stringify(payload));
// matrix is a 2D boolean array: true = dark module, false = light module
```

### Step 4: Host renders the QR matrix

For TUI surfaces, use the built-in string renderer:

```ts
import { renderQrToString } from '@pellux/goodvibes-sdk/platform/pairing';

const qrString = renderQrToString(matrix);
console.log(qrString);
// Prints a block-character QR code suitable for terminal output
```

For graphical surfaces, iterate `matrix` directly to draw cells.

### Step 5: Companion scans the QR, extracts the payload

The companion app's QR scanner decodes the image and parses the JSON:

```ts
// Companion-side (pseudocode)
const raw = qrScanner.scan();
const payload = JSON.parse(raw) as CompanionConnectionPayload;

// Persist the token for future sessions
await tokenStore.setToken(payload.token);
const client = createCompanionClient({ baseUrl: payload.url, token: payload.token });
```

### Step 6: Companion uses the token as a Bearer header

All subsequent API calls from the companion app include the token:

```http
GET /api/control-plane/auth HTTP/1.1
Authorization: Bearer gv_abc123...
```

Use the SDK's standard auth helpers to handle this automatically:

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const tokenStore = createMemoryTokenStore();
await tokenStore.setToken(payload.token);

const sdk = createGoodVibesSdk({
  baseUrl: payload.url,
  tokenStore,
});

// All sdk.operator.* and sdk.realtime.* calls now include the Bearer header
const status = await sdk.operator.control.status();
```

For React Native or Expo, prefer the built-in secure token stores rather than rolling a custom adapter:

- **Expo**: `createExpoSecureTokenStore` from `@pellux/goodvibes-sdk/expo` — backed by `expo-secure-store`
- **iOS**: `createIOSKeychainTokenStore` from `@pellux/goodvibes-sdk/react-native` — backed by iOS Keychain
- **Android**: `createAndroidKeystoreTokenStore` from `@pellux/goodvibes-sdk/react-native` — backed by Android Keystore

```ts
import { createReactNativeGoodVibesSdk, createIOSKeychainTokenStore } from '@pellux/goodvibes-sdk/react-native';

const tokenStore = createIOSKeychainTokenStore({ service: 'com.example.gv' });
const sdk = createReactNativeGoodVibesSdk({
  baseUrl: payload.url,
  tokenStore,
});
```

For `createMemoryTokenStore` (non-persistent, suitable only for ephemeral use or development), import from `@pellux/goodvibes-sdk/auth`.

---

## Token Lifecycle

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

## Security Considerations

### Token storage on the host

The companion/operator token is stored as a plaintext JSON file at `<daemonHomeDir>/operator-tokens.json` (default: `~/.goodvibes/daemon/operator-tokens.json`). This file should have user-only read permissions. The SDK sets `0600` on creation and re-enforces it via `chmodSync` after write. Do not commit this file to source control; the daemon home directory should be outside any project tree.

### Token storage on the companion

On mobile companions:
- Use the platform's secure storage (iOS Keychain, Android Keystore).
- Use a `GoodVibesTokenStore` adapter backed by `expo-secure-store` or `react-native-keychain`, which use the platform keychain.
- Never store the token in AsyncStorage, localStorage, or other unencrypted stores.

### QR code exposure

The QR code encodes the token in plaintext. Treat the QR code display like a password prompt:
- Do not record or screenshot the QR display in shared environments.
- The QR is displayed on-demand; dismiss it promptly after pairing.
- Regenerate the token if you believe the QR was observed by an unintended party.

### HTTPS in production

When the daemon is exposed beyond loopback (e.g. across a LAN or through a tunnel), use HTTPS. Without TLS, the bearer token is transmitted in plaintext over the network. The daemon HTTP policy supports TLS configuration — consult your deployment guide.

For local-only pairing (`127.0.0.1`), HTTP is acceptable since traffic does not leave the machine.

### Token rotation schedule

There is no built-in automatic rotation. Implement an explicit rotation policy appropriate for your threat model:
- Low-risk local use: rotate on device loss or on demand.
- Cross-network or shared-host use: consider periodic rotation (e.g. monthly) via `regenerateCompanionToken`.

---

## Integration Examples

### TUI `/qrcode` command

The TUI exposes a `/qrcode` command that generates and displays the pairing QR code inline in the chat interface:

```
/qrcode
```

Internally this:
1. Calls `getOrCreateCompanionToken({ daemonHomeDir })`.
2. Calls `buildCompanionConnectionInfo({ daemonUrl, token, surface: 'tui', version, password? })`.
3. Calls `encodeConnectionPayload(info)` to serialize the JSON payload.
4. Calls `generateQrMatrix(payload)`.
5. Calls `renderQrToString(matrix)` and renders the result as a fixed-width block in the message view.

### Daemon standalone QR output

When the daemon is started with `--qrcode`, it prints a pairing QR code to stdout before entering its service loop. This is useful for headless environments where no TUI is running:

```bash
goodvibes-daemon --qrcode
```

The output is a block-character QR code followed by the raw JSON payload for debugging.

---

## Building a Companion App

### What the companion needs

A companion app requires:

1. **A QR scanner** — to capture and decode the pairing QR code displayed by the host surface. Native camera APIs or libraries like `expo-barcode-scanner` work.

2. **Persistent, secure token storage** — to retain the companion token across app restarts. See the token storage guidance above.

3. **An HTTP client** — for all request/response interactions. The SDK handles this when used as a client library. For native Kotlin/Swift apps without the SDK, use standard `fetch`/`URLSession`/`OkHttp` with the `Authorization: Bearer <token>` header.

4. **An SSE or WebSocket connection** — for realtime event delivery. The daemon exposes both:
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

// After scanning the QR code and parsing the payload:
async function onQrScanned(payloadJson: string) {
  const payload = JSON.parse(payloadJson);
  await tokenStore.setToken(payload.token);
  // sdk is now ready to use with the stored token
}
```

### Minimal integration pattern (native Android / iOS)

Native clients that do not use the TypeScript SDK can connect using standard HTTP:

```
# Verify the token is working
GET /api/control-plane/auth
Authorization: Bearer gv_abc123...
```

For realtime events, open a WebSocket to:

```
ws://<daemon-host>:<port>/api/control-plane/ws
```

with the same `Authorization: Bearer <token>` header (or as a query parameter if the WebSocket client library does not support custom headers).

Event envelopes arrive as JSON-serialized `RuntimeEventEnvelope` objects. The schema is defined in `@pellux/goodvibes-sdk/contracts`.

### Handling token invalidation

When the host regenerates the companion token, any active companion connections will start receiving `401` responses. Implement a re-pairing flow:

```ts
sdk.operator.control.status().catch(async (err) => {
  if (err.kind === 'auth') {
    // Token has been invalidated — prompt user to re-scan the QR code
    showRepairingScreen();
  }
});
```

The recommended UX is to show a re-pairing prompt rather than a generic error screen, since token invalidation is an expected operational event (not a crash or network failure).
