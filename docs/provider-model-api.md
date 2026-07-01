# Provider & Model API Reference

**Base path**: model catalog routes are under `/api/models`; runtime provider metadata remains under `/api/providers`; companion remote-session routes are under `/api/companion/chat`
**Authentication**: all routes require the standard daemon bearer token (`Authorization: Bearer <token>` or the operator session cookie).

---

## Endpoints

### `GET /api/models`

List all registered providers and their models. Returns configured status, auth routes, and environment variable names for each provider.

**Response `200 OK`**

```json
{
  "providers": [
    {
      "id": "inceptionlabs",
      "label": "Inception Labs",
      "configured": true,
      "configuredVia": "env",
      "envVars": ["INCEPTION_API_KEY"],
      "routes": [
        {
          "route": "api-key",
          "label": "Ambient API key",
          "configured": true,
          "usable": true,
          "freshness": "healthy",
          "envVars": ["INCEPTION_API_KEY"]
        }
      ],
      "models": [
        {
          "id": "mercury-2",
          "registryKey": "inceptionlabs:mercury-2",
          "provider": "inceptionlabs",
          "label": "Mercury 2",
          "contextWindow": 32768
        }
      ]
    },
    {
      "id": "venice",
      "label": "Venice",
      "configured": false,
      "envVars": ["VENICE_API_KEY"],
      "models": [
        {
          "id": "llama-3.3-70b",
          "registryKey": "venice:llama-3.3-70b",
          "provider": "venice",
          "label": "Llama 3.3 70B",
          "contextWindow": 128000
        }
      ]
    }
  ],
  "currentModel": {
    "registryKey": "inceptionlabs:mercury-2",
    "provider": "inceptionlabs",
    "id": "mercury-2"
  },
  "secretsResolutionSkipped": false
}
```

**Field reference**

| Field | Type | Description |
|-------|------|-------------|
| `providers[].id` | `string` | Provider identifier (e.g. `"inceptionlabs"`, `"venice"`, `"openai"`) |
| `providers[].label` | `string` | Human-readable label |
| `providers[].configured` | `boolean` | `true` if the daemon has credentials for this provider |
| `providers[].configuredVia` | `"env" \| "secrets" \| "subscription" \| "anonymous" \| undefined` | Primary usable auth route for this provider. OpenAI reports `"subscription"` when a usable OpenAI subscription session exists, even if no OpenAI API key is configured; this matches the TUI turn-routing path. |
| `providers[].envVars` | `string[]` | Environment variable names that configure this provider |
| `providers[].routes` | `ProviderAuthRouteDescriptor[] \| undefined` | Runtime auth routes declared by the provider, such as `"api-key"`, `"secret-ref"`, `"service-oauth"`, `"subscription-oauth"`, `"anonymous"`, or `"none"`. See the descriptor field table below for the full per-route shape. |
| `providers[].models` | `ProviderModelEntry[]` | All models exposed by this provider |
| `providers[].models[].registryKey` | `string` | Provider-qualified model identity. Use it with `PATCH /api/models/current` for shared/TUI model selection. For companion chat sessions, pair the selected runtime provider row id with that row's model id, or with the registry key when the runtime provider is an alias for the catalog provider. Do not use a bare model id without a provider because different providers can expose the same `id`. |
| `currentModel` | `ProviderModelRef \| null` | Daemon/TUI currently-selected model; `null` if none configured |
| `secretsResolutionSkipped` | `boolean` | `true` when no `SecretsManager` was available during this response; `false` when a secrets manager was consulted regardless of whether it resolved any keys. Always present. |

**`ProviderAuthRouteDescriptor` fields** — each entry in `providers[].routes` (and the optional `routes` array on `GET /api/models/current`):

| Field | Type | Description |
|-------|------|-------------|
| `route` | `"api-key" \| "secret-ref" \| "service-oauth" \| "subscription-oauth" \| "anonymous" \| "none"` | Auth mechanism this route represents. `"none"` marks a provider that needs no credentials. |
| `label` | `string` | Human-readable route label. |
| `configured` | `boolean` | `true` when this route has credentials available. |
| `usable` | `boolean` (optional) | `true` when the route can currently serve turns. |
| `freshness` | `"healthy" \| "expiring" \| "expired" \| "pending" \| "unconfigured"` (optional) | Credential freshness, mainly for OAuth/subscription routes. |
| `detail` | `string` (optional) | Extra human-readable status detail. |
| `envVars` | `string[]` (optional) | Environment variables that configure this route. |
| `secretKeys` | `string[]` (optional) | `SecretsManager` keys this route reads. |
| `serviceNames` | `string[]` (optional) | Service-registry names backing this route. |
| `providerId` | `string` (optional) | Owning provider id when the route is shared or aliased. |
| `repairHints` | `string[]` (optional) | Actionable hints for fixing an unconfigured or expired route. |

**curl example**

```bash
curl -H "Authorization: Bearer $GV_TOKEN" \
  http://127.0.0.1:3421/api/models | jq .  # default control-plane port; configurable via controlPlane.port
```

---

### `GET /api/models/current`

Return the daemon/TUI currently-selected model and its configured status.

The optional `routes` array, when present, mirrors `providers[].routes` from `GET /api/models` for the selected model's provider.

**Response `200 OK`**

```json
{
  "model": {
    "registryKey": "inceptionlabs:mercury-2",
    "provider": "inceptionlabs",
    "id": "mercury-2"
  },
  "configured": true,
  "configuredVia": "env",
  "routes": [
    {
      "route": "api-key",
      "label": "Ambient API key",
      "configured": true,
      "usable": true,
      "freshness": "healthy",
      "envVars": ["INCEPTION_API_KEY"]
    }
  ]
}
```

When no model is configured:

```json
{
  "model": null,
  "configured": false
}
```

**curl example**

```bash
curl -H "Authorization: Bearer $GV_TOKEN" \
  http://127.0.0.1:3421/api/models/current | jq .
```

---

### `PATCH /api/models/current`

Switch the active model live — no daemon restart required. Persists the selection to config and emits a `MODEL_CHANGED` event to all subscribers.

This route is intentionally global. Use it for the live TUI/shared-session model picker. Do not use it for an isolated companion remote chat session that should keep its own provider/model.

**Request body**

```json
{ "registryKey": "inceptionlabs:mercury-2" }
```

| Field | Type | Description |
|-------|------|-------------|
| `registryKey` | `string` | The `registryKey` from `GET /api/models` (format: `provider:modelId`) |

**Response `200 OK`** — same shape as `GET /api/models/current` with the new model, plus `persisted`.

```json
{
  "model": {
    "registryKey": "inceptionlabs:mercury-2",
    "provider": "inceptionlabs",
    "id": "mercury-2"
  },
  "configured": true,
  "configuredVia": "env",
  "routes": [
    {
      "route": "api-key",
      "label": "Ambient API key",
      "configured": true,
      "usable": true,
      "freshness": "healthy",
      "envVars": ["INCEPTION_API_KEY"]
    }
  ],
  "persisted": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `persisted` | `boolean` | `true` if the selection was durably written to config; `false` if persistence failed (model is still switched in memory and the event is still emitted). |

**Error responses**

| Status | `code` | Meaning |
|--------|--------|---------|
| `400` | `INVALID_REQUEST` | Missing or non-string `registryKey` |
| `400` | `MODEL_NOT_FOUND` | `registryKey` not in the model registry |
| `400` | `SET_MODEL_FAILED` | Model found but not selectable |
| `409` | `PROVIDER_NOT_CONFIGURED` | Provider exists but has no credentials; `missingEnvVars` lists what's needed |

**`409` response body**

```json
{
  "error": "Provider 'venice' not configured: set one of [VENICE_API_KEY]",
  "code": "PROVIDER_NOT_CONFIGURED",
  "missingEnvVars": ["VENICE_API_KEY"]
}
```

**curl examples**

```bash
# Switch to Inception Labs mercury-2
curl -X PATCH \
  -H "Authorization: Bearer $GV_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"registryKey":"inceptionlabs:mercury-2"}' \
  http://127.0.0.1:3421/api/models/current

# Switch to OpenAI GPT-4o
curl -X PATCH \
  -H "Authorization: Bearer $GV_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"registryKey":"openai:gpt-4o"}' \
  http://127.0.0.1:3421/api/models/current
```

---

## SSE: `providers`-domain events

The daemon emits four event types on the `providers` RuntimeEventBus domain. Subscribers on a stream that includes the providers domain receive all of them.

| Event `type` | Emitted when | Payload fields |
|--------------|--------------|----------------|
| `PROVIDERS_CHANGED` | The set of registered providers changes | `added: string[]`, `removed: string[]`, `updated: string[]` |
| `PROVIDER_WARNING` | A provider raises a non-fatal warning | `message: string` |
| `MODEL_FALLBACK` | The runtime falls back from one model to another | `from: string`, `to: string`, `provider: string` |
| `MODEL_CHANGED` | The current model is switched (see below) | `registryKey: string`, `provider: string`, optional `previous: { registryKey, provider }` |

Only `MODEL_CHANGED` has an exported Zod contract (`ModelChangedEventSchema`); the other three are emitter-only event shapes.

### `MODEL_CHANGED`

When a `PATCH /api/models/current` succeeds, or when the model is changed via any other codepath (e.g. TUI settings), a `MODEL_CHANGED` event is emitted on the `providers` RuntimeEventBus domain.

**Companion SSE subscribers** receive this event automatically on their existing event stream (`GET /api/companion/chat/sessions/:sessionId/events`) when the providers domain is part of the stream.

**Event envelope** (SSE `data:` payload):

```json
{
  "type": "MODEL_CHANGED",
  "registryKey": "inceptionlabs:mercury-2",
  "provider": "inceptionlabs",
  "previous": {
    "registryKey": "venice:llama-3.3-70b",
    "provider": "venice"
  }
}
```

The `previous` field is omitted when there is no meaningful prior selection (e.g. first model set on boot).

---

## Zod contract schemas

Importable from `@pellux/goodvibes-sdk/contracts`:

```ts
import {
  ListProviderModelsResponseSchema,
  CurrentModelResponseSchema,
  PatchCurrentModelBodySchema,
  PatchCurrentModelErrorSchema,
  PatchCurrentModelResponseSchema,
  ModelChangedEventSchema,
} from '@pellux/goodvibes-sdk/contracts';

// Validate a response body at runtime:
const result = ListProviderModelsResponseSchema.safeParse(responseBody);
```

---

## Context-window fallback helpers (`./platform/providers`)

New in 0.35.0, `@pellux/goodvibes-sdk/platform/providers` exports `inferFallbackContextWindow(provider, modelId?)` and `FALLBACK_CONTEXT_WINDOW` (`128000`) so consumers can share the family-aware, pre-catalog context-window fallback instead of hardcoding their own. It is a last-resort default, used only when neither the live catalog nor the provider API reports a context window for a model.

```ts
import {
  inferFallbackContextWindow,
  FALLBACK_CONTEXT_WINDOW,
} from '@pellux/goodvibes-sdk/platform/providers';

const ctx = inferFallbackContextWindow('openai', 'gpt-5.5'); // 400000
```

---

## Error handling pattern (companion app)

```ts
async function switchModel(registryKey: string, token: string): Promise<void> {
  const res = await fetch('/api/models/current', {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ registryKey }),
  });

  if (!res.ok) {
    const err = await res.json();
    if (err.code === 'PROVIDER_NOT_CONFIGURED') {
      // Show the user which env vars are missing
      const vars = err.missingEnvVars.join(', ');
      throw new Error(`Provider not configured. Set: ${vars}`);
    }
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  const current = await res.json();
  console.log('Switched to', current.model.registryKey);
}
```

---

## Turn-time error posture

If the currently-selected provider is unconfigured and a companion chat turn is attempted, the provider adapter yields a structured error chunk **before** making any network call:

```json
{
  "type": "error",
  "error": "Provider 'venice' is not configured. Set VENICE_API_KEY or configure via the TUI settings."
}
```

The error arrives on the existing SSE `companion-chat.turn.error` event.

---

## Companion app integration pattern

Use different selection flows for shared sessions and true remote sessions:

1. On startup, call `GET /api/models` to populate a model picker UI.
2. For a shared TUI session, display `currentModel` as the selected item and call `PATCH /api/models/current` when the user changes it. This intentionally changes the daemon/TUI current model and emits `MODEL_CHANGED`.
3. For a true companion remote chat session, create or update the companion chat session with its own `provider` and `model`. Do not call `PATCH /api/models/current`.
4. On `409` from the global route, show the `missingEnvVars` hint. For remote chat turns, unconfigured-provider errors arrive on the companion session event stream.
5. Subscribe to the `providers` domain SSE stream only for shared/TUI model pickers. A remote session picker should track its own session record.

Remote session-local selection:

```http
POST /api/companion/chat/sessions
Content-Type: application/json

{ "title": "Mobile chat", "provider": "openai-subscriber", "model": "gpt-5.5" }
```

`provider` is the selected runtime provider row id from `GET /api/models`.
`model` is the selected model id for that provider row. If the provider row is
an alias for a catalog provider, such as `openai-subscriber` routing catalog
model `openai:gpt-5.5`, the daemon also accepts the provider-qualified registry
key as the `model` value:

```json
{ "provider": "openai-subscriber", "model": "openai:gpt-5.5" }
```

Do not send `provider: "openai"` for a subscription-backed runtime provider
row whose id is `openai-subscriber`; that is a different runtime route.

```http
PATCH /api/companion/chat/sessions/{sessionId}
Content-Type: application/json

{ "provider": "anthropic", "model": "claude-sonnet-4-5" }
```

`PATCH /api/companion/chat/sessions/{sessionId}` updates only that companion chat session. The daemon still hosts the turn and supplies runtime context such as working directory and tool/runtime services, but it does not mutate the TUI's current provider/model.

---

## Related

- [Providers](./providers.md) — provider surfaces overview and the default provider catalog (stable provider ids, labels, and env vars).
- Model ids are volatile and version frequently; treat `GET /api/models` as the live source of truth for available `registryKey` values rather than any hardcoded list.
