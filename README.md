# GoodVibes SDK

> **What this SDK is:** `@pellux/goodvibes-sdk` is a client SDK for the GoodVibes daemon.
> It does **not** call Anthropic, OpenAI, Gemini, or any other AI provider directly — the daemon
> orchestrates those on your behalf. If you need to call a provider directly, use their official
> SDK instead. If you don't have a daemon yet, see [Daemon embedding](./docs/daemon-embedding.md).

TypeScript SDK for building GoodVibes operator, peer, web, mobile, and daemon-connected apps with typed contracts, auth, realtime events, and transport layers.

This package has two surfaces with different runtime requirements. See [Runtime Surfaces](./docs/surfaces.md) for the authoritative two-tier model:
- **Full surface** — Bun runtime consumers (TUI, daemon, CLI). Gets the complete agentic harness.
- **Companion surface** — Hermes (React Native / Expo), browser, or Cloudflare Workers consumers. Gets auth, transport, events, contracts, errors, and observer only.

## Install

This is one npm package with subpath exports.

> **0.21.0 is the soak-period release.** If you are integrating the SDK, this is the stable target. The next version jump is to 1.0.0 pending owner sign-off. See [the roadmap](./docs/tracking/road-to-1.0.md).


```bash
bun add @pellux/goodvibes-sdk
# or
npm install @pellux/goodvibes-sdk
```

Alternate registry:
- npmjs primary: `@pellux/goodvibes-sdk`
- GitHub Packages mirror: `@mgd34msu/goodvibes-sdk`

GitHub Packages requires a scoped registry mapping:

```ini
@mgd34msu:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

### Security: postinstall patcher

This package ships a `postinstall` script that automatically upgrades a vulnerable `minimatch` transitive dependency in your `node_modules`. The patcher remediates three ReDoS advisories (GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74) that stem from `bash-language-server → editorconfig → minimatch@10.0.1`. It exits 0 on all errors and never breaks your install.

**If your environment uses `--ignore-scripts`** (e.g., CI hardening, Yarn PnP strict mode), the patcher will not run. Add this to your own `package.json` as a fallback:

```json
"overrides": { "minimatch": "^10.2.5" }
```

**Bun users:** if your project's trust policy restricts lifecycle scripts, run:

```bash
bun pm trust @pellux/goodvibes-sdk
```

Or add the `overrides` block above instead.

## Quick Start

Prerequisite: a reachable GoodVibes daemon endpoint. The SDK is a client — it does not start the platform for you.

### Bun (TUI / daemon / CLI)

For Bun services, TUI apps, and CLI tools, import from the root entry:

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createGoodVibesSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3210',
  tokenStore: createMemoryTokenStore(process.env.GOODVIBES_TOKEN ?? null),
});

console.log(await sdk.operator.control.snapshot());
```

For daemon embedding:

```ts
import { dispatchDaemonApiRoutes } from '@pellux/goodvibes-sdk/daemon';
```

### Companion (React Native / Expo / browser / Cloudflare Workers)

For mobile and browser companion apps, use the runtime-specific entry point:

```ts
// React Native / Expo
import { createReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';
// or: import { createExpoGoodVibesSdk } from '@pellux/goodvibes-sdk/expo';

const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: await SecureStore.getItemAsync('gv-token'),
});
```

```ts
// Browser / web app
import { createWebGoodVibesSdk } from '@pellux/goodvibes-sdk/web';
import { createBrowserTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createWebGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  tokenStore: createBrowserTokenStore(),
});
```

For the full walkthrough — login flows, token persistence, realtime transports, error handling, and observability — see **[Getting Started](./docs/getting-started.md)**.

## Runtime Entry Points

| Entry point | Consumer | Surface |
|---|---|---|
| `@pellux/goodvibes-sdk` | Bun apps (TUI, daemon, CLI) | Full |
| `@pellux/goodvibes-sdk/daemon` | Bun server hosts embedding daemon routes | Full |
| `@pellux/goodvibes-sdk/react-native` | React Native (Hermes) | Companion |
| `@pellux/goodvibes-sdk/expo` | Expo (alias of `/react-native`) | Companion |
| `@pellux/goodvibes-sdk/browser` | Browser apps | Companion |
| `@pellux/goodvibes-sdk/web` | Web apps (alias of `/browser`) | Companion |
| `@pellux/goodvibes-sdk/auth` | Token storage and auth flows | Companion |
| `@pellux/goodvibes-sdk/operator` | Operator/control-plane client only | Companion |
| `@pellux/goodvibes-sdk/peer` | Peer/distributed-runtime client only | Companion |
| `@pellux/goodvibes-sdk/contracts` | Runtime-neutral contract types and method IDs | Companion |
| `@pellux/goodvibes-sdk/contracts/node` | **Artifact path helpers only** (JSON schema file paths) — not a runtime target | N/A |
| `@pellux/goodvibes-sdk/errors` | Typed error classes | Companion |
| `@pellux/goodvibes-sdk/platform/*` | Advanced Bun-specific barrels (pairing, port-check, etc.) | Full |

> **Note on `/contracts/node`:** this entry exports filesystem path helpers for locating the JSON contract artifacts on disk. It is a build/tooling convenience, not a runtime surface. It does not indicate Node.js runtime support.

## Contract Reference

- operator methods: `213`
- operator events: `29`
- peer endpoints: `6`

See [Operator API reference](./docs/reference-operator.md) and [Peer API reference](./docs/reference-peer.md) for full contract details.

## Realtime

The SDK supports both realtime transports:
- SSE via `sdk.realtime.viaSse()`
- WebSocket via `sdk.realtime.viaWebSocket()`

Recommended defaults:
- Bun (TUI / daemon): SSE
- Browser web UI: SSE for same-origin sessions, WebSocket for persistent duplex
- React Native / Expo: WebSocket

The transport layers support HTTP retry/backoff, SSE replay via `Last-Event-ID`, SSE reconnect, WebSocket reconnect, and dynamic auth token resolution for long-lived clients.

## Platform Configuration

### tools.llmEnabled

Tool LLM calls are opt-in via the `tools.llmEnabled` config key (default: `false`). When disabled, `resolveToolLLM()` returns an empty string instead of silently falling through to the main conversation model.

```ts
// goodvibes.config.ts
tools: {
  llmEnabled: true,
  // ...provider config
}
```

### Component health monitoring

The health monitoring infrastructure uses `ComponentHealthMonitor`, `ComponentResourceContract`, and `ComponentHealthState`. The old `Panel*` names remain as deprecated aliases for backward compatibility.

## Docs

- [Runtime surfaces](./docs/surfaces.md) — two-tier model definition
- [Public surface reference](./docs/public-surface.md) — full exports map
- [Docs index](./docs/README.md)
- [Getting started](./docs/getting-started.md)
- [Package guide](./docs/packages.md)
- [Authentication](./docs/authentication.md)
- [Error handling](./docs/error-handling.md)
- [Error kinds reference](./docs/error-kinds.md)
- [Observability](./docs/observability.md)
- [Browser integration](./docs/browser-integration.md)
- [Web UI integration](./docs/web-ui-integration.md)
- [React Native integration](./docs/react-native-integration.md)
- [Expo integration](./docs/expo-integration.md)
- [Android integration](./docs/android-integration.md)
- [iOS integration](./docs/ios-integration.md)
- [Daemon embedding](./docs/daemon-embedding.md)
- [Realtime and telemetry](./docs/realtime-and-telemetry.md)
- [Retries and reconnect](./docs/retries-and-reconnect.md)
- [Companion app patterns](./docs/companion-app-patterns.md)
- [Companion message routing](./docs/companion-message-routing.md)
- [Companion app pairing](./docs/pairing.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Compatibility](./docs/compatibility.md)
- [Release and publishing](./docs/release-and-publishing.md)
- [Testing and validation](./docs/testing-and-validation.md)
- [Operator API reference](./docs/reference-operator.md)
- [Peer API reference](./docs/reference-peer.md)
- [Runtime events reference](./docs/reference-runtime-events.md)
- [Changelog](./CHANGELOG.md)

## Examples

- [Submit turn quickstart](./examples/submit-turn-quickstart.mjs) — create session, submit message, stream tokens to stdout
- [Operator quickstart](./examples/operator-http-quickstart.mjs)
- [Peer quickstart](./examples/peer-http-quickstart.mjs)
- [Realtime quickstart](./examples/realtime-events-quickstart.mjs)
- [Auth and token store quickstart](./examples/auth-login-and-token-store.ts)
- [Retry and reconnect quickstart](./examples/retry-and-reconnect.mjs)
- [Companion approvals feed](./examples/companion-approvals-feed.ts)
- [Browser web UI quickstart](./examples/browser-web-ui-quickstart.ts)
- [React Native quickstart](./examples/react-native-quickstart.ts)
- [Expo quickstart](./examples/expo-quickstart.tsx)
- [Android Kotlin quickstart](./examples/android-kotlin-quickstart.kt)
- [iOS Swift quickstart](./examples/ios-swift-quickstart.swift)
- [Daemon embedding quickstart](./examples/daemon-fetch-handler-quickstart.ts)
- [Direct transport quickstart](./examples/direct-transport-quickstart.ts)

## Maintainers

- Contributor workflow: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security process: [SECURITY.md](./SECURITY.md)
