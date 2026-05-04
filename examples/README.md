# GoodVibes SDK Examples

Small runnable examples for the published SDK entry points. Run all commands
from the **repository root** (not from `examples/`), because `examples/tsconfig.json`
extends `../tsconfig.base.json`. Build the SDK first:

```bash
bun run build
bun --cwd examples run typecheck
```

Most examples read environment variables at startup:

| Variable | Description |
| --- | --- |
| `GOODVIBES_BASE_URL` | HTTP base URL of the running GoodVibes daemon (defaults to `http://127.0.0.1:3421`). |
| `GOODVIBES_TOKEN` | Operator bearer token issued by the daemon. Copy from the TUI settings or daemon log on first boot. |

Keep example tokens local and never commit real credentials,
tokens, cookies, or screenshots containing them.
See the repository [security policy](../SECURITY.md) before adapting examples
that handle credentials, pairing tokens, or daemon URLs.

## Quickstarts

| File | Runner | Purpose |
| --- | --- | --- |
| `auth-login-and-token-store.ts` | `bun examples/auth-login-and-token-store.ts` | Login and token-store lifecycle. |
| `browser-web-ui-quickstart.ts` | typecheck only | Browser/web UI client setup. |
| `companion-approvals-feed.ts` | `bun examples/companion-approvals-feed.ts` | Approval feed via realtime events. |
| `daemon-fetch-handler-quickstart.ts` | `bun examples/daemon-fetch-handler-quickstart.ts` | Minimal daemon route handler composition. Note: uses a contract placeholder; end-to-end operation requires swapping in `buildOperatorContract()`. |
| `direct-transport-quickstart.ts` | `bun examples/direct-transport-quickstart.ts` | In-process direct transport usage. |
| `expo-quickstart.tsx` | typecheck only | Expo client setup; run inside an Expo app. |
| `operator-http-quickstart.mjs` | `bun examples/operator-http-quickstart.mjs` | Operator HTTP client calls. |
| `peer-http-quickstart.mjs` | `bun examples/peer-http-quickstart.mjs` | Peer HTTP client calls. |
| `react-native-quickstart.ts` | typecheck only | React Native client setup; run inside a React Native app. |
| `realtime-events-quickstart.mjs` | `bun examples/realtime-events-quickstart.mjs` | Runtime event streaming. |
| `retry-and-reconnect.mjs` | `bun examples/retry-and-reconnect.mjs` | Retry and reconnect policy configuration. |
| `submit-turn-quickstart.mjs` | `bun examples/submit-turn-quickstart.mjs` | Submit a conversation turn. |
| `android-kotlin-quickstart.kt` | not runnable by Bun | Android integration sketch; copy into an Android project. |
| `ios-swift-quickstart.swift` | not runnable by Bun | iOS integration sketch; copy into an iOS project. |

The `.tsx`, `.kt`, and `.swift` sketches are included for integration shape and
type/API review. They are not standalone `bun examples/...` scripts.

Examples that use TypeScript JSON import attributes, such as
`daemon-fetch-handler-quickstart.ts`, expect the repository's pinned Bun runtime
or Node 22.6+ with import-attributes support enabled.
