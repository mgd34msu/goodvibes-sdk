# GoodVibes SDK Examples

Small runnable examples for the published SDK entry points. Build the SDK first
when running directly from the repository:

```sh
bun run build
bun --cwd examples run typecheck
```

Most examples read `GOODVIBES_BASE_URL` and `GOODVIBES_TOKEN` from the
environment. Keep example tokens local and never commit real credentials,
tokens, cookies, or screenshots containing them.

## Quickstarts

| File | Runner | Purpose |
| --- | --- | --- |
| `auth-login-and-token-store.ts` | `bun examples/auth-login-and-token-store.ts` | Login and token-store lifecycle. |
| `browser-web-ui-quickstart.ts` | typecheck only | Browser/web UI client setup. |
| `companion-approvals-feed.ts` | `bun examples/companion-approvals-feed.ts` | Approval feed via realtime events. |
| `daemon-fetch-handler-quickstart.ts` | `bun examples/daemon-fetch-handler-quickstart.ts` | Minimal daemon route handler composition. |
| `direct-transport-quickstart.ts` | `bun examples/direct-transport-quickstart.ts` | In-process direct transport usage. |
| `expo-quickstart.tsx` | typecheck only | Expo client setup; run inside an Expo app. |
| `operator-http-quickstart.mjs` | `node examples/operator-http-quickstart.mjs` | Operator HTTP client calls. |
| `peer-http-quickstart.mjs` | `node examples/peer-http-quickstart.mjs` | Peer HTTP client calls. |
| `react-native-quickstart.ts` | typecheck only | React Native client setup; run inside a React Native app. |
| `realtime-events-quickstart.mjs` | `node examples/realtime-events-quickstart.mjs` | Runtime event streaming. |
| `retry-and-reconnect.mjs` | `node examples/retry-and-reconnect.mjs` | Retry and reconnect policy configuration. |
| `submit-turn-quickstart.mjs` | `node examples/submit-turn-quickstart.mjs` | Submit a conversation turn. |
| `android-kotlin-quickstart.kt` | not runnable by Bun | Android integration sketch; copy into an Android project. |
| `ios-swift-quickstart.swift` | not runnable by Bun | iOS integration sketch; copy into an iOS project. |

The `.tsx`, `.kt`, and `.swift` sketches are included for integration shape and
type/API review. They are not standalone `bun examples/...` scripts.

Examples that use TypeScript JSON import attributes, such as
`daemon-fetch-handler-quickstart.ts`, expect the repository's pinned Bun runtime
or a Node runtime that supports import attributes.
