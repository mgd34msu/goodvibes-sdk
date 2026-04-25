# Daemon Batch Processing

GoodVibes can queue daemon-side provider requests for upstream provider Batch APIs. This is opt-in and asynchronous.

## Defaults

Batching is off by default.

```json
{
  "batch.mode": "off",
  "batch.queueBackend": "local",
  "cloudflare.enabled": false
}
```

Live TUI, companion, and daemon chat behavior remains live unless a client uses the batch job API or explicitly opts a batch-capable daemon request into batch execution.

## Modes

`batch.mode` controls whether the daemon accepts batch work:

- `off` — reject batch jobs.
- `explicit` — accept requests sent to the batch job API. This is the intended default when a client exposes a per-message "run as batch" control.
- `eligible-by-default` — accept batch-capable daemon requests as batch by default. Current SDK-owned batch-capable request path is `/api/batch/jobs`; streaming chat paths do not silently convert to batch because provider Batch APIs are asynchronous and non-streaming.

`batch.fallback` is published for clients that need a policy decision when a request cannot be batched:

- `live` — clients may retry through their normal live path.
- `fail` — clients should surface the batch ineligibility as a hard error.

The `/api/batch/jobs` endpoint itself never executes a live response. It only queues provider-batch jobs.

## Provider Support

The SDK exposes provider Batch API adapters for:

- `openai` with API-key credentials, using OpenAI Batch API `/v1/chat/completions`.
- `anthropic` with API-key credentials, using Anthropic Message Batches `/v1/messages/batches`.

OpenAI subscription-backed routes are not used for provider Batch APIs. Batch APIs are provider API-key features, so a daemon that only has an OpenAI subscription session can continue using live OpenAI turns but cannot submit OpenAI Batch API jobs until an OpenAI API key is configured.

Provider runtime metadata exposes `usage.batch` so clients can discover whether a provider advertises batch support.

## Daemon API

All routes require the same daemon auth as other daemon APIs.

| Route | Method | Behavior |
|---|---:|---|
| `/api/batch/config` | `GET` | Returns batch mode, queue backend, Cloudflare settings, limits, and supported providers. |
| `/api/batch/jobs` | `POST` | Queues a chat batch job. Returns `202` with the job record. |
| `/api/batch/jobs` | `GET` | Lists recent jobs. Supports `?limit=100`. |
| `/api/batch/jobs/{jobId}` | `GET` | Reads one job. |
| `/api/batch/jobs/{jobId}/cancel` | `POST` | Cancels a queued job. Submitted jobs are provider-batch scoped and cannot be cancelled per job. |
| `/api/batch/tick` | `POST` | Submits eligible queued jobs and polls submitted provider batches. Body may include `{ "force": true }`. |

Example:

```json
{
  "provider": "openai",
  "model": "gpt-5.5",
  "request": {
    "messages": [
      { "role": "user", "content": "Summarize this repository status." }
    ],
    "systemPrompt": "You are a concise engineering assistant."
  },
  "metadata": {
    "client": "goodvibes-tui"
  },
  "flush": true
}
```

Jobs are persisted under the daemon config directory in `batch-jobs.json`.

## Cloudflare Integration

Cloudflare is optional. The daemon works without Cloudflare, and `cloudflare.enabled` defaults to `false`.

The SDK exports `@pellux/goodvibes-sdk/workers` for Worker deployments:

```ts
import { createGoodVibesCloudflareWorker } from '@pellux/goodvibes-sdk/workers';

export default createGoodVibesCloudflareWorker();
```

The Worker bridge can:

- Proxy `/batch/*` requests to the daemon's `/api/batch/*` routes.
- Queue small tick signals with `/batch/tick/enqueue`.
- Run scheduled events that call `/api/batch/tick`.
- Consume Cloudflare Queue messages and retry failures so Cloudflare dead-letter queues can capture exhausted messages.

By default, the Worker does not queue full prompt/job payloads. Queue messages should be small signals, not prompt archives or secrets. This keeps usage free-tier friendly and avoids putting sensitive prompt bodies into Cloudflare Queues. Full job payload queueing requires `createGoodVibesCloudflareWorker({ queueJobPayloads: true })`.

Configure dead-letter queues in Cloudflare/Wrangler for the queue binding; the SDK consumes retries and allows failed messages to flow to the configured DLQ.

## Free-Tier Guardrails

The defaults assume Cloudflare Queues are used as signal transport:

- `batch.maxQueuePayloadBytes`: `16384`
- `batch.maxQueueMessagesPerDay`: `1000`
- `cloudflare.maxQueueOpsPerDay`: `10000`
- `cloudflare.freeTierMode`: `true`

Do not put provider API keys, GoodVibes tokens, or long prompts in queue messages. Use the daemon's local store for job payloads and queue only tick or job-id signals unless you intentionally opt into full payload queueing.
