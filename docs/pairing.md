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

Companion tokens are stored on disk under the surface's scoped directory:

```
.goodvibes/<surfaceRoot>/companion-token
```

If no `surfaceRoot` is configured, the token lands in the shared `.goodvibes/` root. Surfaces that use `surfaceRoot` (recommended) keep their companion token isolated from other surfaces.

### Connection payload

The QR code encodes a JSON object containing everything the companion app needs to connect:

```json
{
  "url": "http://192.168.1.42:3210",
  "token": "gvt_abc123...",
  "surface": "tui",
  "version": 1
}
```

| Field | Description |
| --- | --- |
| `url` | Base URL of the daemon HTTP endpoint |
| `token` | Pre-generated bearer token for all API calls |
| `surface` | The `surfaceRoot` that generated the token |
| `version` | Payload schema version (currently `1`) |

---

## QR Code Flow

### Step 1: Host generates a companion token

The host surface calls `getOrCreateCompanionToken(surfaceRoot)` to get an existing persistent token, or generate one if none exists:

```ts
import { getOrCreateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';

const token = await getOrCreateCompanionToken({
  surfaceRoot: 'tui',
  homeDir: os.homedir(),
});
```

This is idempotent — calling it multiple times with the same `surfaceRoot` returns the same token until `regenerateCompanionToken` is called.

### Step 2: Host builds the connection payload

```ts
import { buildCompanionConnectionInfo } from '@pellux/goodvibes-sdk/platform/pairing';

const payload = buildCompanionConnectionInfo({
  daemonUrl: 'http://192.168.1.42:3210',
  token,
  surfaceRoot: 'tui',
});

// payload is a plain JSON-serializable object
// { url, token, surface, version }
```

The `daemonUrl` should be the address reachable by the companion device. For local-only use, `http://127.0.0.1:3210` works. For cross-device pairing, use the host machine's LAN address.

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
await tokenStore.save(payload.token);
const client = createCompanionClient({ baseUrl: payload.url, token: payload.token });
```

### Step 6: Companion uses the token as a Bearer header

All subsequent API calls from the companion app include the token:

```http
GET /api/control-plane/auth HTTP/1.1
Authorization: Bearer gvt_abc123...
```

Use the SDK's standard auth helpers to handle this automatically:

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const tokenStore = createMemoryTokenStore();
await tokenStore.set(payload.token);

const sdk = createGoodVibesSdk({
  baseUrl: payload.url,
  tokenStore,
});

// All sdk.operator.* and sdk.realtime.* calls now include the Bearer header
const status = await sdk.operator.control.status();
```

For React Native or Expo, use `createMemoryTokenStore` from `@pellux/goodvibes-sdk/auth` or implement a custom `GoodVibesTokenStore` adapter backed by `expo-secure-store` or `react-native-keychain`:

```ts
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createGoodVibesSdk({
  baseUrl: payload.url,
  tokenStore: createMemoryTokenStore(),
});
```

---

## Token Lifecycle

### Creating a token

`getOrCreateCompanionToken` creates a token if none exists and returns it. Tokens are stored as plain text files under the surface's scoped directory.

### Regenerating a token

Calling `regenerateCompanionToken` issues a new token and writes it to disk, replacing the previous one. Any companion app holding the old token will receive `401 Unauthorized` on its next API call and must re-pair.

```ts
import { regenerateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';

const newToken = await regenerateCompanionToken({
  surfaceRoot: 'tui',
  homeDir: os.homedir(),
});
```

Rotate tokens proactively if:
- The companion device is lost or stolen.
- You believe the token may have been observed by a third party.
- You are decommissioning a companion app.

### Reading a stored token

```ts
import { readCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';

const token = await readCompanionToken({
  surfaceRoot: 'tui',
  homeDir: os.homedir(),
});
// Returns null if no token has been generated yet
```

---

## Security Considerations

### Token storage on the host

The companion token is stored as a plaintext file under `.goodvibes/<surfaceRoot>/companion-token`. This file should have user-only read permissions. The SDK sets `0600` on creation. Do not commit this file to source control; it should be in `.gitignore`.

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
1. Calls `getOrCreateCompanionToken({ surfaceRoot: 'tui', homeDir })`.
2. Calls `buildCompanionConnectionInfo({ daemonUrl, token, surfaceRoot: 'tui' })`.
3. Calls `generateQrMatrix(JSON.stringify(payload))`.
4. Calls `renderQrToString(matrix)` and renders the result as a fixed-width block in the message view.

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
   - SSE: suitable for Node/Bun and browser clients.
   - WebSocket: recommended for React Native and Expo because it has broader React Native support.

### Minimal integration pattern (React Native / Expo)

```ts
import { useState } from 'react';
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const tokenStore = createMemoryTokenStore();

export function usePairedSdk(baseUrl: string) {
  const sdk = createGoodVibesSdk({
    baseUrl,
    tokenStore,
  });
  return sdk;
}

// After scanning the QR code and parsing the payload:
async function onQrScanned(payloadJson: string) {
  const payload = JSON.parse(payloadJson);
  await tokenStore.set(payload.token);
  // sdk is now ready to use with the stored token
}
```

### Minimal integration pattern (native Android / iOS)

Native clients that do not use the TypeScript SDK can connect using standard HTTP:

```
# Verify the token is working
GET /api/control-plane/whoami
Authorization: Bearer gvt_abc123...
```

For realtime events, open a WebSocket to:

```
ws://<daemon-host>:<port>/realtime
```

with the same `Authorization: Bearer <token>` header (or as a query parameter if the WebSocket client library does not support custom headers).

Event envelopes arrive as JSON-serialized `RuntimeEventEnvelope` objects. The schema is defined in `@pellux/goodvibes-sdk/contracts`.

### Handling token invalidation

When the host regenerates the companion token, any active companion connections will start receiving `401` responses. Implement a re-pairing flow:

```ts
sdk.operator.control.status().catch(async (err) => {
  if (err.status === 401) {
    // Token has been invalidated — prompt user to re-scan the QR code
    showRepairingScreen();
  }
});
```

The recommended UX is to show a re-pairing prompt rather than a generic error screen, since token invalidation is an expected operational event (not a crash or network failure).
