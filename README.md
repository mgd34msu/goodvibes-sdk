# GoodVibes SDK

GoodVibes SDK is the TypeScript SDK for building clients, daemon hosts, remote
surfaces, and automation around the GoodVibes daemon. The daemon owns provider
calls, tools, orchestration, memory, channels, and host resources; SDK clients
connect to it through typed contracts, authenticated transports, and realtime
events.

This project is pre-1.0. The public contract is intentionally moving quickly:
APIs, config keys, route paths, event shapes, and file layouts can change before
the 1.0 stability line. Pin exact package versions and read `CHANGELOG.md`
before upgrading.

## Install

```bash
bun add @pellux/goodvibes-sdk
# or
npm install @pellux/goodvibes-sdk
```

Alternate registry:

```ini
@mgd34msu:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

## What The SDK Provides

- **Client SDKs** for operator, peer, browser, web, React Native, Expo, and
  Cloudflare Worker environments.
- **Typed contracts** for operator methods, peer endpoints, auth, scopes,
  realtime events, schemas, and method IDs.
- **Daemon embedding** helpers for hosts that run the GoodVibes daemon in a Bun
  process.
- **Realtime transports** over SSE and WebSocket with reconnect, typed event
  domains, and session-filtered event views.
- **Auth and token storage** for session login, shared bearer tokens, memory
  stores, browser localStorage, iOS Keychain, Android Keystore, and Expo Secure
  Store.
- **Provider/model runtime** for OpenAI, OpenAI subscription/Codex, Anthropic,
  Gemini, Bedrock, Vertex, GitHub Copilot, local/custom providers,
  OpenAI-compatible providers, model catalogs, health, pricing, context limits,
  caching, and failover.
- **Agentic runtime** with sessions, turns, tools, agents, WRFC review/fix
  chains, compaction, session memory, and remote companion sessions.
- **Knowledge/wiki system** with structured SQLite storage, URL/bookmark/file/
  artifact/browser-history ingest, Readability extraction, graph links,
  GraphQL, packets, projections, usage records, and consolidation.
- **Channel surfaces** for Slack, Discord, ntfy, Home Assistant, Telegram,
  Google Chat, Signal, WhatsApp, iMessage, MSTeams, BlueBubbles, Mattermost,
  Matrix, generic webhooks, and GitHub automation webhooks.
- **Cloudflare integration** for optional Workers, Queues, DLQs, cron, token
  planning/creation, discovery, DNS, Zero Trust Tunnel, Access, KV, Durable
  Objects, R2, Secrets Store, and verification.
- **Batch processing** for opt-in provider Batch API usage through local or
  Cloudflare-backed queueing.
- **Media, voice, and search** through artifact storage, multimodal analysis,
  image understanding, generation, streaming TTS, STT, realtime voice sessions,
  and provider-backed web search.
- **Security and operations** through permissions, feature gates, fetch
  protections, secret refs, policy tooling, health, telemetry, diagnostics,
  performance budgets, retention, services, watchers, and automation.

## Quick Start

The SDK is a client of a reachable GoodVibes daemon. It does not start the
daemon for you unless you are using the daemon embedding APIs.

```ts
import {
  createGoodVibesSdk,
  createMemoryTokenStore,
} from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3210',
  tokenStore: createMemoryTokenStore(process.env.GOODVIBES_TOKEN ?? null),
});

const snapshot = await sdk.operator.control.snapshot();
console.log(snapshot);
```

Browser clients:

```ts
import { createWebGoodVibesSdk } from '@pellux/goodvibes-sdk/web';
import { createBrowserTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createWebGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  tokenStore: createBrowserTokenStore(),
});
```

React Native and Expo clients:

```ts
import { createReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';

const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: await SecureStore.getItemAsync('gv-token'),
});
```

Cloudflare Worker bridge:

```ts
import { createGoodVibesCloudflareWorker } from '@pellux/goodvibes-sdk/workers';

export default createGoodVibesCloudflareWorker();
```

## Runtime Entry Points

| Entry point | Purpose |
|---|---|
| `@pellux/goodvibes-sdk` | Full Bun SDK: client factory plus contracts, daemon, auth, operator, peer, and transports |
| `@pellux/goodvibes-sdk/daemon` | Daemon route dispatch and embedding helpers |
| `@pellux/goodvibes-sdk/operator` | Operator/control-plane client only |
| `@pellux/goodvibes-sdk/peer` | Peer/distributed-runtime client only |
| `@pellux/goodvibes-sdk/contracts` | Runtime-neutral contract artifacts, schemas, method IDs, and types |
| `@pellux/goodvibes-sdk/contracts/node` | Filesystem helpers for contract JSON artifacts |
| `@pellux/goodvibes-sdk/auth` | Auth client, token stores, OAuth helpers, mobile secure stores |
| `@pellux/goodvibes-sdk/browser` | Browser client factory with browser defaults |
| `@pellux/goodvibes-sdk/web` | Web alias of the browser client factory |
| `@pellux/goodvibes-sdk/react-native` | React Native client factory and mobile secure stores |
| `@pellux/goodvibes-sdk/expo` | Expo alias of the React Native client factory with Expo token store exports |
| `@pellux/goodvibes-sdk/workers` | Cloudflare Worker bridge for daemon batch endpoints |
| `@pellux/goodvibes-sdk/platform/*` | Bun/full-surface platform modules for advanced embedders |

## Current Documentation

- [Documentation index](./docs/README.md)
- [Getting started](./docs/getting-started.md)
- [Packages and entry points](./docs/packages.md)
- [Runtime surfaces](./docs/surfaces.md)
- [Authentication](./docs/authentication.md)
- [Configuration defaults](./docs/defaults.md)
- [Secret references](./docs/secrets.md)
- [Provider and model API](./docs/provider-model-api.md)
- [Daemon embedding](./docs/daemon-embedding.md)
- [Companion app patterns](./docs/companion-app-patterns.md)
- [Realtime and telemetry](./docs/realtime-and-telemetry.md)
- [Knowledge system](./docs/knowledge.md)
- [Browser knowledge ingestion](./docs/knowledge-browser-history.md)
- [Tool system](./docs/tools.md)
- [Channel surfaces](./docs/surfaces.md)
- [Home Assistant integration](./docs/homeassistant-integration.md)
- [Cloudflare and batch processing](./docs/daemon-batch-processing.md)
- [Voice and streaming TTS](./docs/voice.md)
- [Security](./docs/security.md)
- [Feature flags](./docs/feature-flags.md)
- [Testing and validation](./docs/testing-and-validation.md)
- [Release and publishing](./docs/release-and-publishing.md)

Generated references:

- [Operator API reference](./docs/reference-operator.md)
- [Peer API reference](./docs/reference-peer.md)
- [Runtime events reference](./docs/reference-runtime-events.md)

## Security Posture

The SDK carries source-level overrides for reviewed transitive dependencies and
publishes a release artifact with the patched Bash LSP dependency graph. Bash
LSP remains bundled because shell language support is part of the SDK feature
set. See [SECURITY.md](./SECURITY.md) and [Security](./docs/security.md) for
the current dependency and runtime security posture.

## Examples

- [Submit turn quickstart](./examples/submit-turn-quickstart.mjs)
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
- Release history: [CHANGELOG.md](./CHANGELOG.md)
