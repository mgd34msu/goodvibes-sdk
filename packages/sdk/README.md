# @pellux/goodvibes-sdk

TypeScript SDK for building GoodVibes operator, peer, web, mobile, and daemon-connected apps with typed contracts, auth, realtime events, and transport layers.

> **What this SDK is:** a client for the GoodVibes daemon. Not a direct provider SDK.
> See [Getting Started](../../docs/getting-started.md) for the full walkthrough.

Install:

```bash
npm install @pellux/goodvibes-sdk
```

Quick example (Bun):

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3421',
  tokenStore: createMemoryTokenStore(process.env.GOODVIBES_TOKEN ?? null),
});

console.log(await sdk.operator.control.snapshot());
```

Every supported import is an explicit subpath in the package `exports` map. The
table below covers the primary ones; the complete, stability-leveled list is
[public-surface.md](../../docs/public-surface.md).

| Entry point | Use it for |
| --- | --- |
| `@pellux/goodvibes-sdk` | The Bun client factory plus re-exported contracts, auth, operator, peer, and transport pieces |
| `/auth` | Token stores, login, and OAuth helpers for every surface |
| `/client-auth` | Session and permission management with auto-refresh middleware |
| `/operator`, `/peer` | The typed operator and peer clients on their own |
| `/contracts`, `/contracts/node` | Runtime-neutral contract types, schemas, and method IDs; the `/node` variant adds Node-only helpers |
| `/errors` | The typed error model (`SDKErrorKind`) |
| `/events` | Runtime event types and typeguards, with per-domain subpaths such as `/events/agents` and `/events/session` |
| `/observer` | The `SDKObserver` interface for first-class observability hooks on client factories |
| `/transport-core`, `/transport-http`, `/transport-realtime`, `/transport-direct` | Transport primitives, the HTTP transport, SSE and WebSocket realtime, and the in-process direct transport |
| `/browser`, `/web` | Browser client factories free of Bun globals; `/browser/agent`, `/browser/knowledge`, and `/browser/homeassistant` are scoped browser clients |
| `/workers` | The Cloudflare Worker bridge for daemon batch endpoints |
| `/react-native`, `/expo` | Mobile client factories with secure token stores |
| `/daemon` | Daemon route dispatch and embedding helpers for a Bun server host |
| `/embed` | SDK Embedding API 1.0, the stability-marked surface for hosting a GoodVibes session inside another app |

Cloudflare batch provisioning is exposed through daemon `/api/cloudflare/*`
routes. The `/workers` entry is for manual Worker deployments.

Advanced server/runtime consumers can use explicit `platform/...` subpaths such
as `@pellux/goodvibes-sdk/platform/node`,
`@pellux/goodvibes-sdk/platform/runtime`, and
`@pellux/goodvibes-sdk/platform/knowledge`. The package does not expose a
`platform/*` wildcard contract; only listed subpaths are supported.

The root SDK package is a facade over the monorepo packages for contracts,
errors, transports, daemon, operator, and peer clients. Those packages remain
the source of truth; this npm package provides the consumer-facing entrypoint
map.

Use this package when you want the main consumer-facing GoodVibes TypeScript SDK rather than lower-level pieces.
