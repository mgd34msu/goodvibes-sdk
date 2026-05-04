# Network Defaults Reference

This document records every timeout, retry, and backoff default in the SDK.
All values are in milliseconds unless stated otherwise.

## HTTP Transport (`@pellux/goodvibes-sdk/transport-http`)

| Path | Default | Notes |
|------|---------|-------|
| `DEFAULT_HTTP_RETRY_POLICY.maxAttempts` | 1 | Single attempt (no retry) by default; callers opt-in via `retry.maxAttempts` |
| `DEFAULT_HTTP_RETRY_POLICY.baseDelayMs` | 250 | Base delay between retry attempts |
| `DEFAULT_HTTP_RETRY_POLICY.maxDelayMs` | 2 000 | Backoff cap per retry |
| `DEFAULT_HTTP_RETRY_POLICY.backoffFactor` | 2 | Exponential multiplier |
| `DEFAULT_HTTP_RETRY_POLICY.retryOnStatuses` | `[408, 429, 500, 502, 503, 504]` | HTTP statuses eligible for retry |
| `DEFAULT_HTTP_RETRY_POLICY.retryOnMethods` | `['GET', 'HEAD', 'OPTIONS']` | Safe methods only |
| `DEFAULT_HTTP_RETRY_POLICY.retryOnNetworkError` | `true` | Network-level failures are retried |
| Request timeout | None (platform fetch default) | Use `AbortSignal` with timeout on the call site |

**Rationale:** Single-attempt default keeps latency predictable for interactive workloads. Callers
increase `maxAttempts` for batch/background operations.

## SSE Stream Reconnect (`@pellux/goodvibes-sdk/transport-http` — `reconnect.ts`)

| Path | Default | Notes |
|------|---------|-------|
| `DEFAULT_STREAM_RECONNECT_POLICY.enabled` | `false` | Reconnect is opt-in |
| `DEFAULT_STREAM_RECONNECT_POLICY.maxAttempts` | 10 | Finite cap prevents infinite reconnect loops |
| `DEFAULT_STREAM_RECONNECT_POLICY.baseDelayMs` | 500 | Initial reconnect delay |
| `DEFAULT_STREAM_RECONNECT_POLICY.maxDelayMs` | 30 000 | Hard backoff cap (30 s) |
| `DEFAULT_STREAM_RECONNECT_POLICY.backoffFactor` | 2 | Exponential multiplier |

**Rationale:** a finite retry cap prevents unbounded reconnect loops during
persistent auth failure or server outage. `maxDelayMs: 30 000` caps worst-case
wait between attempts to 30 seconds.

## Daemon Batch Processing

| Config key | Default | Notes |
|------|---------|-------|
| `batch.mode` | `off` | Provider Batch APIs are opt-in. |
| `batch.queueBackend` | `local` | The daemon stores jobs locally unless a client explicitly uses the Cloudflare Worker bridge. |
| `batch.tickIntervalMs` | `60 000` | Local daemon batch scheduler interval. |
| `batch.maxDelayMs` | `300 000` | Max queued-job wait before local submission on a scheduler tick. |
| `batch.maxJobsPerProviderBatch` | `100` | SDK grouping limit before upstream provider-specific limits. |
| `batch.maxQueuePayloadBytes` | `16 384` | Cloudflare queue messages should be small signals, not full prompts. |
| `batch.maxQueueMessagesPerDay` | `1 000` | Free-tier-oriented client guardrail. |
| `cloudflare.enabled` | `false` | Cloudflare is optional and never required for daemon value. |
| `cloudflare.freeTierMode` | `true` | Prefer small queue signals and bounded daily usage. |
| `cloudflare.accountId` | empty string | Cloudflare account id used by SDK-owned provisioning. |
| `cloudflare.apiTokenRef` | empty string | Secret reference for the Cloudflare API token; empty falls back to `CLOUDFLARE_API_TOKEN`. |
| `cloudflare.zoneId` | empty string | Optional Cloudflare zone id used by DNS and Access automation. |
| `cloudflare.zoneName` | empty string | Optional Cloudflare zone name used during onboarding/discovery. |
| `cloudflare.workerName` | `goodvibes-batch-worker` | Worker script name managed by SDK provisioning. |
| `cloudflare.workerSubdomain` | empty string | Account workers.dev subdomain used to infer the Worker URL. |
| `cloudflare.workerHostname` | empty string | Optional custom Worker hostname managed through DNS automation. |
| `cloudflare.workerBaseUrl` | empty string | Public Worker URL clients use for batch proxy/queue calls. |
| `cloudflare.daemonBaseUrl` | empty string | Daemon origin URL the Worker or Tunnel uses for Worker-to-daemon calls. |
| `cloudflare.daemonHostname` | empty string | Optional daemon hostname managed through Tunnel, DNS, and Access automation. |
| `cloudflare.workerTokenRef` | empty string | Secret reference for the Worker-to-daemon bearer token. |
| `cloudflare.workerClientTokenRef` | empty string | Secret reference for the client-to-Worker bearer token. |
| `cloudflare.workerCron` | `*/5 * * * *` | Worker cron trigger for batch scheduler ticks. |
| `cloudflare.queueName` | `goodvibes-batch` | Cloudflare Queue name for GoodVibes batch signals. |
| `cloudflare.deadLetterQueueName` | `goodvibes-batch-dlq` | Cloudflare DLQ name for exhausted batch signal retries. |
| `cloudflare.tunnelName` | `goodvibes-daemon` | Zero Trust Tunnel name managed by optional provisioning. |
| `cloudflare.tunnelId` | empty string | Zero Trust Tunnel id selected or created by provisioning. |
| `cloudflare.tunnelTokenRef` | empty string | Secret reference for the cloudflared Tunnel token. |
| `cloudflare.accessAppId` | empty string | Zero Trust Access application id for the daemon hostname. |
| `cloudflare.accessServiceTokenId` | empty string | Zero Trust Access service token id. |
| `cloudflare.accessServiceTokenRef` | empty string | Secret reference for Access service-token client id/secret JSON. |
| `cloudflare.kvNamespaceName` | `goodvibes-runtime` | Optional KV namespace name for edge runtime state. |
| `cloudflare.kvNamespaceId` | empty string | KV namespace id bound to the Worker as `GOODVIBES_KV`. |
| `cloudflare.durableObjectNamespaceName` | `GoodVibesCoordinator` | Durable Object class/namespace name for edge coordination. |
| `cloudflare.durableObjectNamespaceId` | empty string | Durable Object namespace id discovered after Worker migration. |
| `cloudflare.r2BucketName` | `goodvibes-artifacts` | R2 Standard bucket name for optional artifacts. |
| `cloudflare.secretsStoreName` | `goodvibes` | Cloudflare Secrets Store name managed by optional provisioning. |
| `cloudflare.secretsStoreId` | empty string | Cloudflare Secrets Store id selected or created by provisioning. |
| `cloudflare.maxQueueOpsPerDay` | `10 000` | Free-tier-oriented queue operation budget. |

See [Daemon batch processing](./daemon-batch-processing.md) for provider support, routes, and Worker bridge behavior.

## Artifact Storage

| Config key | Default | Notes |
|------|---------|-------|
| `storage.artifacts.maxBytes` | `536 870 912` | Maximum stored artifact size for JSON path/URI acquisition, direct multipart upload, and raw binary upload. |

The default is `512 MiB`. JSON control bodies remain intentionally small; send
large content through multipart or raw binary upload routes.

## Home Assistant Surface

| Config key | Default | Notes |
|------|---------|-------|
| `surfaces.homeassistant.remoteSessionTtlMs` | `1 200 000` | Home Assistant remote conversation sessions close after 20 minutes of inactivity. |

See [Home Assistant integration](./homeassistant-integration.md) for the Assist conversation route and event delivery contract.

## OpenAI-Compatible Daemon Ingress

| Config key | Default | Notes |
|------|---------|-------|
| `controlPlane.openaiCompatible.enabled` | `true` | Exposes authenticated `/v1/models` and `/v1/chat/completions` OpenAI-style routes on the daemon. |
| `controlPlane.openaiCompatible.pathPrefix` | `/v1` | Path prefix used by OpenAI-compatible clients as their base URL suffix. |

See [Runtime orchestration](./runtime-orchestration.md#openai-compatible-ingress) for the contract and scope.

## Spoken Output / TTS

| Config key | Default | Notes |
|------|---------|-------|
| `tts.provider` | `elevenlabs` | Default streaming TTS provider when a request omits `providerId`. |
| `tts.voice` | empty string | Default voice id when a request omits `voiceId`; providers may still apply their own fallback. |
| `tts.llmProvider` | empty string | Reserved optional spoken-output LLM provider override; empty means use the active chat provider. |
| `tts.llmModel` | empty string | Reserved optional spoken-output LLM model override; empty means use the active chat model. |

See [Voice and streaming TTS](./voice.md) for the provider-agnostic streaming route and TUI integration contract.

## WebSocket Reconnect (`@pellux/goodvibes-sdk/transport-realtime`)

| Path | Default | Notes |
|------|---------|-------|
| `DEFAULT_WS_MAX_ATTEMPTS` | 10 | Shared constant in `@pellux/goodvibes-sdk/transport-realtime`; passed to `normalizeStreamReconnectPolicy` |
| `reconnect.baseDelayMs` | 500 (inherited from SSE policy) | |
| `reconnect.maxDelayMs` | 30 000 (inherited from SSE policy) | |
| `reconnect.backoffFactor` | 2 | |

**Rationale:** Matches SSE for a symmetric schedule. Finite cap prevents infinite auth-failure loops.

## Auth (`@pellux/goodvibes-sdk/auth`)

| Path | Timeout | Max Retries | Notes |
|------|---------|-------------|-------|
| `SessionManager.login` / `current` | None explicit | Delegates to HTTP transport | HTTP retry policy applies |
| `TokenStore.getToken / setToken / clearToken` | None | N/A | Synchronous-ish; no network I/O |

**Rationale:** Auth calls go through the HTTP transport layer which applies `DEFAULT_HTTP_RETRY_POLICY`.
There is no separate auth-specific timeout; callers should pass an `AbortSignal` for bounded waits.

## Session Auth (`@pellux/goodvibes-sdk/daemon` — daemon embedders)

| Constant | Default | Notes |
|----------|---------|-------|
| `DEFAULT_SESSION_TTL_MS` | `3 600 000` (1 hour) | Session tokens expire after 1 hour of creation; expired sessions are rejected and pruned on access |

**Source:** `packages/sdk/src/platform/auth/user-auth-manager.ts`. Not a public configurable — set via daemon config `auth.sessionTtlMs` if your embedding exposes it.

## Rate Limits (daemon built-in)

| Limiter | Default | Notes |
|---------|---------|-------|
| General rate limiter | 60 requests / minute / IP | Applied to all routes except login; configurable via `rateLimit` daemon option |
| Login rate limiter | 5 requests / minute / IP | Applied to `POST /login` only; configurable via `loginRateLimit` daemon option |

## Outbound Producer Queue (`@pellux/goodvibes-sdk/transport-realtime` — `runtime-events.ts`)

| Field | Value | Notes |
|-------|-------|-------|
| `MAX_OUTBOUND_QUEUE` | 1 024 | Max buffered outbound messages while socket is not open |
| Drop policy | Oldest dropped first | `droppedOutboundCount` incremented on each drop; `onError` is called |
