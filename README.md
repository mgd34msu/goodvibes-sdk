# GoodVibes SDK

> ⚠️ **Active early development — pre-1.0.** This project is under active early development. APIs, contracts, file layouts, route paths, event shapes, and config defaults can and do change quickly — sometimes across patch releases. There are no legacy/compat shims. Documentation always describes the **current** behavior, not historical behavior. When 1.0.0 ships the project freezes to enterprise-grade stability guarantees (semver, deprecation windows, migration guides). Until then: pin exact versions and read `CHANGELOG.md` before upgrading.

> **What this SDK is:** `@pellux/goodvibes-sdk` is a client SDK for the GoodVibes daemon.
> It does **not** call Anthropic, OpenAI, Gemini, or any other AI provider directly — the daemon
> orchestrates those on your behalf. If you need to call a provider directly, use their official
> SDK instead. If you don't have a daemon yet, see [Daemon embedding](./docs/daemon-embedding.md).

TypeScript SDK for building GoodVibes operator, peer, web, mobile, and daemon-connected apps with typed contracts, auth, realtime events, and transport layers.

This package has two surfaces with different runtime requirements. See [Runtime Surfaces](./docs/surfaces.md) for the authoritative two-tier model:
- **Full surface** — Bun runtime consumers (TUI, daemon, CLI). Gets the complete agentic harness.
- **Companion surface** — Hermes (React Native / Expo), browser, or Cloudflare Workers consumers. Gets auth, transport, events, contracts, errors, observer, and the optional Cloudflare Worker bridge for daemon batch queue/tick integration. Cloudflare provisioning itself is SDK-owned through daemon `/api/cloudflare/*` routes, including token bootstrap, discovery, Workers, Queues, Tunnel, Access, DNS, KV, Durable Objects, Secrets Store, and R2.

## Install

This is one npm package with subpath exports.

> **Current version: `0.25.10`.** The 0.25.x line is the current pre-1.0 integration target; breaking changes continue to ship as patch/minor per the project's pre-1.0 policy and are documented in `CHANGELOG.md`. The 1.0.0 cut remains blocked on owner sign-off and final roadmap gates. See [the roadmap](./docs/tracking/road-to-1.0.md).


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

### Security: dependency audit posture

The SDK keeps Bash LSP bundled. Because upstream `bash-language-server@5.6.0`
still pins `editorconfig@2.0.1 -> minimatch@10.0.1`, the release tarball
vendors a patched `bash-language-server` package at
`vendor/bash-language-server`. The patch changes only its `editorconfig`
dependency to `3.0.2`, which resolves to the fixed `minimatch@10.2.5` line.

If your root audit policy needs explicit transitive pins for the SDK source
workspace, use root-level overrides:

```json
{
  "overrides": {
    "ajv": "8.18.0",
    "fast-xml-parser": "5.7.1",
    "google-auth-library": "10.6.2",
    "lodash": "4.18.1",
    "minimatch": "^10.2.5"
  }
}
```

The source workspace also carries root-level dependency-audit overrides,
including repo-local Bash LSP and Verdaccio `uuid` vendor patches. See
[Security Policy](./SECURITY.md) for the current disclosure.

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

```ts
// Manual Cloudflare Worker bridge for optional daemon batch queue/tick integration.
// Onboarding should usually call daemon /api/cloudflare/provision instead.
import { createGoodVibesCloudflareWorker } from '@pellux/goodvibes-sdk/workers';

export default createGoodVibesCloudflareWorker();
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
| `@pellux/goodvibes-sdk/workers` | Manual Cloudflare Worker bridge for daemon batch queue/tick integration | Companion |
| `@pellux/goodvibes-sdk/auth` | Token storage and auth flows | Companion |
| `@pellux/goodvibes-sdk/operator` | Operator/control-plane client only | Companion |
| `@pellux/goodvibes-sdk/peer` | Peer/distributed-runtime client only | Companion |
| `@pellux/goodvibes-sdk/contracts` | Runtime-neutral contract types and method IDs | Companion |
| `@pellux/goodvibes-sdk/contracts/node` | **Artifact path helpers only** (JSON schema file paths) — not a runtime target | N/A |
| `@pellux/goodvibes-sdk/errors` | Typed error classes | Companion |
| `@pellux/goodvibes-sdk/platform/*` | Advanced Bun-specific barrels (pairing, port-check, etc.) | Full |

> **Note on `/contracts/node`:** this entry exports filesystem path helpers for locating the JSON contract artifacts on disk. It is a build/tooling convenience, not a runtime surface. It does not indicate Node.js runtime support.

## Agentic Workflows

- **WRFC (Work-Review-Fix-Commit)** — Chains that run an engineer agent, review its output against a 10-dimension rubric, optionally fix, and gate on quality before committing. As of 0.23.0, WRFC chains also extract and enforce user-declared constraints from the task prompt as independent pass/fail criteria. See [WRFC Constraint Propagation](./docs/wrfc-constraint-propagation.md).

## Contract Reference

- [Operator API reference](./docs/reference-operator.md) — every method, scope, schema, and event exposed by the operator contract.
- [Peer API reference](./docs/reference-peer.md) — every endpoint exposed by the peer/distributed-runtime contract.
- [Runtime events reference](./docs/reference-runtime-events.md) — every runtime event domain and payload shape.

These three documents are generated from the checked-in contract artifact under `packages/contracts/artifacts/` and are the canonical method/event/endpoint inventory. For live inspection against a running daemon, fetch `/api/control-plane/methods` and `/api/control-plane/events/catalog`.

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
- [Daemon batch processing](./docs/daemon-batch-processing.md)
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
