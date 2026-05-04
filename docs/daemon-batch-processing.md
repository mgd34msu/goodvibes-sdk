# Daemon Batch Processing

GoodVibes can queue daemon-side provider requests for upstream provider Batch APIs. This is opt-in and asynchronous.

## Defaults

Batching is off by default.

```json
{
  "batch.mode": "off",
  "batch.queueBackend": "local",
  "cloudflare.enabled": false,
  "cloudflare.freeTierMode": true
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

The SDK owns Cloudflare service interaction. TUI/onboarding clients should gather user choices and call the daemon Cloudflare routes; they should not implement Cloudflare API calls themselves.

Cloudflare remains opt-in. The default provisioning target is still the batch Worker plus Queue/DLQ path, but callers can enable additional SDK-managed components with the `components` object:

```json
{
  "components": {
    "workers": true,
    "queues": true,
    "zeroTrustTunnel": true,
    "zeroTrustAccess": true,
    "dns": true,
    "kv": true,
    "durableObjects": true,
    "secretsStore": true,
    "r2": true
  }
}
```

Unset component keys use safe defaults: `workers` and `queues` are on for the existing batch integration, while Tunnel, Access, DNS, KV, Durable Objects, Secrets Store, and R2 stay off unless a client enables them.

### Provisioning Requirements

The SDK provisioning flow needs:

- A Cloudflare account id.
- A Cloudflare API token. Pass `apiToken`, configure `cloudflare.apiTokenRef`, store `CLOUDFLARE_API_TOKEN` in `SecretsManager`, or set the `CLOUDFLARE_API_TOKEN` environment variable.
- `cloudflare.daemonBaseUrl`, the origin URL the Cloudflare Worker or Tunnel should use for Worker-to-daemon calls. Without a Tunnel this must be public; with a Zero Trust Tunnel it may be a local daemon URL such as `http://127.0.0.1:3210`.
- A Worker-to-daemon operator token. By default the daemon uses its current operator token; callers may pass `operatorToken` or configure `cloudflare.workerTokenRef`.
- A Worker client bearer token. If one is not supplied, provisioning generates one, stores it in `SecretsManager`, writes `cloudflare.workerClientTokenRef`, and installs it as the Worker secret `GOODVIBES_WORKER_TOKEN`.
- For DNS automation, a selected Cloudflare zone via `zoneId` or `zoneName`.
- For Tunnel or Access automation, `daemonHostname` identifies the hostname to route/protect. Access application and service-token APIs are account-scoped; a zone is only required when GoodVibes should also create DNS records.

When a zone is selected, DNS and Access hostnames must belong to that zone. The SDK treats common onboarding placeholders such as `daemon.example.com` and `goodvibes.example.com` as stale placeholders and replaces them with zone-owned hostnames before provisioning. With zone `buzznet.dev`, the default daemon hostname becomes `daemon.buzznet.dev`, and the default Worker custom hostname becomes `goodvibes-batch-worker.buzznet.dev`. Non-placeholder hostnames outside the selected zone are skipped with warning steps before any DNS, Tunnel-ingress, or Access-app request is sent to Cloudflare.

Secrets are stored as `goodvibes://secrets/...` references when the provisioning route is asked to persist them. Raw Cloudflare tokens are never written into config.

### Token Bootstrap

Onboarding clients can either collect a manually-created operational Cloudflare API token or use the SDK bootstrap flow:

1. Call `GET /api/cloudflare/token/requirements` or `POST /api/cloudflare/token/requirements` with the desired `components`.
2. Ask the user to create a temporary user-owned bootstrap token from Cloudflare's **Create additional tokens** API token template, or with `User > API Tokens Write`.
3. Send that temporary token to `POST /api/cloudflare/token/create` as `bootstrapToken`.
4. The SDK uses Cloudflare's `/user/tokens` API to create a narrower operational user token with the returned GoodVibes permission list, stores it as `goodvibes://secrets/goodvibes/CLOUDFLARE_API_TOKEN` when `storeApiToken` is not `false`, and never persists the bootstrap token.

The returned permission list describes the operational token the SDK will create. It is not a list of permissions to add to the temporary bootstrap token. If DNS automation should be scoped to one zone, pass `zoneId` during token creation; otherwise the SDK may create a broader zone-scoped operational token so later provisioning can discover/select the zone.

The SDK resolves Cloudflare permission groups dynamically through the official Cloudflare TypeScript SDK. It resolves each required permission by `name` and Cloudflare scope, with aliases for Cloudflare's `Write`/`Edit` naming variants, before falling back to a broad catalog scan. If Cloudflare still returns account-specific permission names that do not match the SDK candidates, token creation fails with the missing permission names so the client can guide the user to create the operational token manually.

Token policies are emitted per Cloudflare resource scope. Account permissions are placed in an account policy, DNS permissions are placed in a zone policy, and R2 uses a separate bucket policy when Cloudflare exposes `Workers R2 Storage Write/Edit` as `com.cloudflare.edge.r2.bucket` scoped. This matches Cloudflare's documented token policy model where permission groups only apply to matching resource types.

After token creation, the SDK asks Cloudflare for the created token policy and refuses to store the token if no expected permission groups were persisted. If the dashboard shows a generated `GoodVibes Cloudflare Operational` token with `-` for permissions/resources, delete that unusable token and rerun the wizard with this SDK version.

Operational-token permissions are scoped to the selected account except for DNS, which uses the selected zone:

| Component | Permission candidates | Scope |
|---|---|---|
| Bootstrap token only | `API Tokens Write`, `API Tokens Edit` | User |
| Workers | `Workers Scripts Write`, `Workers Scripts Edit` | Account |
| Queues | `Queues Write`, `Queues Edit`, `Workers Queues Write`, `Cloudflare Queues Write` | Account |
| Zero Trust Tunnel | `Cloudflare Tunnel Write`, `Cloudflare Tunnel Edit` | Account |
| Zero Trust Access | `Access: Apps and Policies Write`, `Access: Service Tokens Write`, plus `Edit` variants | Account |
| DNS | `Zone Read`, `DNS Write`, `DNS Edit` | Zone |
| KV | `Workers KV Storage Write`, `Workers KV Storage Edit` | Account |
| Durable Objects | `Workers Scripts Write`, `Workers Scripts Edit` | Account |
| Secrets Store | `Account Secrets Store Write`, `Account Secrets Store Edit` | Account |
| R2 | `Workers R2 Storage Write`, `Workers R2 Storage Edit` | Account or R2 bucket, depending on Cloudflare's permission-group scope |

R2 provisioning uses Cloudflare's account-scoped R2 API for bucket creation/listing. Most Cloudflare accounts expose the R2 storage permission as account-scoped; accounts that expose it as `com.cloudflare.edge.r2.bucket` receive a separate `com.cloudflare.edge.r2.bucket.*` token policy so the permission group has a matching resource.

A user-owned bootstrap token can create account- and zone-scoped operational tokens when that Cloudflare user has access to those resources. "User" describes ownership of the API token management permission; it does not mean the generated token can only carry user-scoped permissions.

`POST /api/cloudflare/discover` lists accounts, zones, workers.dev subdomain, queues, KV namespaces, Durable Object namespaces, R2 buckets, Secrets Stores, Zero Trust Tunnels, and Access applications visible to the token. Use this for onboarding account/zone/domain selection. If no zone is available, Workers can still use a `workers.dev` URL.

### Cloudflare Daemon API

All Cloudflare routes require daemon authentication and admin privileges.

| Route | Method | Behavior |
|---|---:|---|
| `/api/cloudflare/status` | `GET` | Returns local Cloudflare config, readiness booleans, and warnings without making Cloudflare API calls. |
| `/api/cloudflare/token/requirements` | `GET` or `POST` | Returns the Cloudflare token permission shape for selected components and bootstrap instructions. |
| `/api/cloudflare/token/create` | `POST` | Uses a temporary bootstrap token to create and optionally store the narrower GoodVibes operational token. |
| `/api/cloudflare/discover` | `POST` | Discovers accounts, zones, and optional account-scoped Cloudflare resources visible to the token. |
| `/api/cloudflare/validate` | `POST` | Resolves the API token and validates Cloudflare account access. |
| `/api/cloudflare/provision` | `POST` | Creates or reuses enabled components: Worker, Queue/DLQ, Tunnel, Access app/service token, DNS CNAMEs, KV namespace, Durable Object binding, Secrets Store, R2 Standard bucket, config, and optional verification. |
| `/api/cloudflare/verify` | `POST` | Calls the Worker health endpoint and the Worker-to-daemon batch proxy. |
| `/api/cloudflare/disable` | `POST` | Disables local Cloudflare usage, returns queue backend to `local`, and can remove Worker cron/subdomain settings. |

Provisioning is idempotent for SDK-managed Cloudflare resources. The SDK checks for existing resources before creating Queues, queue consumers, KV namespaces, R2 buckets, Secrets Stores, Zero Trust Tunnels, Access service tokens/apps, DNS CNAMEs, account workers.dev subdomains, workers.dev script routes, and the `GoodVibesCoordinator` Durable Object namespace. Worker cron provisioning reads the current schedule before rewriting it, and disable flows check current schedule/subdomain state before removing settings. Hostname-bound DNS and Access operations are preflighted against the selected zone before Cloudflare receives create/update calls. Saved ids such as `cloudflare.kvNamespaceId`, `cloudflare.secretsStoreId`, `cloudflare.tunnelId`, `cloudflare.accessAppId`, and `cloudflare.accessServiceTokenId` are reused on later onboarding runs. This lets clients rerun provisioning after enabling extra Cloudflare features without recreating resources that already exist.

If Cloudflare returns an exists/quota-style create error after discovery, the SDK performs a second discovery pass and reuses a matching resource when it can. For Cloudflare Secrets Store, this includes the account-level `maximum_stores_exceeded` response: if the requested store already exists, or Cloudflare exposes a single existing store on the account, provisioning records and reuses that store instead of failing the entire onboarding pass. For account workers.dev subdomains, Cloudflare `10036` "Account already has an associated subdomain" responses are recovered by re-reading the existing account subdomain and using it as the canonical Worker URL base. For Durable Objects, Cloudflare `10074` "Cannot apply new-sqlite-class migration" responses are recovered by retrying the Worker upload without the first-run `new_sqlite_classes` migration while keeping the `GOODVIBES_COORDINATOR` binding.

Provisioning request example:

```json
{
  "accountId": "023e105f4ecef8ad9ca31a8372d0c353",
  "apiToken": "<cloudflare-api-token>",
  "storeApiToken": true,
  "daemonBaseUrl": "https://daemon.example.com",
  "daemonHostname": "daemon.example.com",
  "zoneName": "example.com",
  "workerName": "goodvibes-batch-worker",
  "queueName": "goodvibes-batch",
  "deadLetterQueueName": "goodvibes-batch-dlq",
  "components": {
    "workers": true,
    "queues": true,
    "zeroTrustTunnel": false,
    "zeroTrustAccess": false,
    "dns": false,
    "kv": false,
    "durableObjects": false,
    "secretsStore": false,
    "r2": false
  },
  "workerCron": "*/5 * * * *",
  "batchMode": "explicit",
  "returnGeneratedSecrets": true,
  "verify": true
}
```

`returnGeneratedSecrets` can return generated Worker client, Tunnel, or Access service-token credentials only for the provisioning response. Store them in the onboarding client only when that client must call those Cloudflare surfaces directly. Otherwise use the persisted `goodvibes://` refs.

When enabled, the optional components do the following:

- `zeroTrustTunnel`: creates or reuses a remotely-managed Tunnel and stores its cloudflared token under `cloudflare.tunnelTokenRef`.
- `zeroTrustAccess`: creates or reuses an Access service token and self-hosted application for `daemonHostname`; service-token credentials are stored as JSON under `cloudflare.accessServiceTokenRef`.
- `dns`: creates/updates proxied CNAMEs for `daemonHostname` to `<tunnelId>.cfargotunnel.com` and `workerHostname` to the Worker host.
- `kv`: creates or reuses `cloudflare.kvNamespaceName` and binds it to the Worker as `GOODVIBES_KV`.
- `durableObjects`: adds the `GoodVibesCoordinator` Durable Object class and Worker binding. The SDK applies the SQLite class migration only when the class is not already present.
- `secretsStore`: creates or reuses a Cloudflare Secrets Store for future Cloudflare-native secret placement.
- `r2`: creates or reuses a Standard storage class bucket and binds it to the Worker as `GOODVIBES_ARTIFACTS`.

The SDK exports `@pellux/goodvibes-sdk/workers` for Worker deployments:

```ts
import { createGoodVibesCloudflareWorker } from '@pellux/goodvibes-sdk/workers';

// Reads GOODVIBES_DAEMON_URL, GOODVIBES_OPERATOR_TOKEN, and
// GOODVIBES_WORKER_TOKEN from Worker environment bindings.
export default createGoodVibesCloudflareWorker();
```

Manual Worker deployments can still use that entry point, but SDK provisioning uploads an equivalent Worker module automatically. The Worker bridge can:

- Proxy `/batch/*` requests to the daemon's `/api/batch/*` routes.
- Queue small tick signals with `/batch/tick/enqueue`.
- Run scheduled events that call `/api/batch/tick`.
- Consume Cloudflare Queue messages and retry failures so Cloudflare dead-letter queues can capture exhausted messages.

Every Worker route except `/health` and `/batch/health` requires `Authorization: Bearer <token>` by default. Set the token with the Worker secret `GOODVIBES_WORKER_TOKEN` or `createGoodVibesCloudflareWorker({ workerAuthToken })`. The SDK provisioning flow generates and installs `GOODVIBES_WORKER_TOKEN` automatically. Manual deployments that intentionally put the Worker behind another trusted auth layer can pass `allowUnauthenticated: true`, but that is an explicit opt-out.

By default, the Worker does not queue full prompt/job payloads. Queue messages should be small signals, not prompt archives or secrets. This keeps usage free-tier friendly and avoids putting sensitive prompt bodies into Cloudflare Queues. Full job payload queueing requires `createGoodVibesCloudflareWorker({ queueJobPayloads: true })`.

The SDK provisioning route configures the queue consumer with `dead_letter_queue`. Manual deployments must configure the dead-letter queue in Cloudflare or Wrangler for the queue binding; the SDK Worker consumes retries and allows failed messages to flow to the configured DLQ.

## Free-Tier Guardrails

The defaults assume Cloudflare Queues are used as signal transport:

- `batch.maxQueuePayloadBytes`: `16384`
- `batch.maxQueueMessagesPerDay`: `1000`
- `cloudflare.maxQueueOpsPerDay`: `10000`
- `cloudflare.freeTierMode`: `true`

Do not put provider API keys, GoodVibes tokens, or long prompts in queue messages. Use the daemon's local store for job payloads and queue only tick or job-id signals unless you intentionally opt into full payload queueing.
