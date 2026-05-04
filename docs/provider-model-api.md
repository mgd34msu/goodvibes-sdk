# Provider & Model API Reference

**Base path**: provider routes are under `/api/providers`; companion remote-session routes are under `/api/companion/chat`
**Authentication**: all routes require the standard daemon bearer token (`Authorization: Bearer <token>` or the operator session cookie).

---

## Endpoints

### `GET /api/providers`

List all registered providers and their models. Returns configured status, auth routes, and environment variable names for each provider.

**Response `200 OK`**

```json
{
  "providers": [
    {
      "id": "inception",
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
          "registryKey": "inception:mercury-2",
          "provider": "inception",
          "label": "Mercury 2",
          "contextWindow": 32768
        }
      ]
    },
    {
      "id": "venice",
      "label": "Venice",
      "configured": false,
      "configuredVia": null,
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
    "registryKey": "inception:mercury-2",
    "provider": "inception",
    "id": "mercury-2"
  },
  "secretsResolutionSkipped": false
}
```

**Field reference**

| Field | Type | Description |
|-------|------|-------------|
| `providers[].id` | `string` | Provider identifier (e.g. `"inception"`, `"venice"`, `"openai"`) |
| `providers[].label` | `string` | Human-readable label |
| `providers[].configured` | `boolean` | `true` if the daemon has credentials for this provider |
| `providers[].configuredVia` | `"env" \| "secrets" \| "subscription" \| "anonymous" \| undefined` | Primary usable auth route for this provider. OpenAI reports `"subscription"` when a usable OpenAI subscription session exists, even if no OpenAI API key is configured; this matches the TUI turn-routing path. |
| `providers[].envVars` | `string[]` | Environment variable names that configure this provider |
| `providers[].routes` | `ProviderAuthRouteDescriptor[] \| undefined` | Runtime auth routes declared by the provider, such as `"api-key"`, `"secret-ref"`, `"service-oauth"`, `"subscription-oauth"`, or `"anonymous"`. Each route includes `configured`, optional `usable`, optional `freshness`, and repair metadata when available. |
| `providers[].models` | `ProviderModelEntry[]` | All models exposed by this provider |
| `providers[].models[].registryKey` | `string` | Compound key for model selection. Use it with `PATCH /api/providers/current` for shared/TUI model selection, or store it on a companion chat session for a remote-session-local selection. |
| `currentModel` | `ProviderModelRef \| null` | Daemon/TUI currently-selected model; `null` if none configured |
| `secretsResolutionSkipped` | `boolean` | `true` when no `SecretsManager` was available during this response; `false` when a secrets manager was consulted regardless of whether it resolved any keys. Always present. |

**curl example**

```bash
curl -H "Authorization: Bearer $GV_TOKEN" \
  http://127.0.0.1:3421/api/providers | jq .  # default control-plane port; configurable via controlPlane.port
```

---

### `GET /api/providers/current`

Return the daemon/TUI currently-selected model and its configured status.

**Response `200 OK`**

```json
{
  "model": {
    "registryKey": "inception:mercury-2",
    "provider": "inception",
    "id": "mercury-2"
  },
  "configured": true,
  "configuredVia": "env"
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
  http://127.0.0.1:3421/api/providers/current | jq .
```

---

### `PATCH /api/providers/current`

Switch the active model live — no daemon restart required. Persists the selection to config and emits a `MODEL_CHANGED` event to all subscribers.

This route is intentionally global. Use it for the live TUI/shared-session model picker. Do not use it for an isolated companion remote chat session that should keep its own provider/model.

**Request body**

```json
{ "registryKey": "inception:mercury-2" }
```

| Field | Type | Description |
|-------|------|-------------|
| `registryKey` | `string` | The `registryKey` from `GET /api/providers` (format: `provider:modelId`) |

**Response `200 OK`** — same shape as `GET /api/providers/current` with the new model, plus `persisted`.

```json
{
  "model": {
    "registryKey": "inception:mercury-2",
    "provider": "inception",
    "id": "mercury-2"
  },
  "configured": true,
  "configuredVia": "env",
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
# Switch to Inception mercury-2
curl -X PATCH \
  -H "Authorization: Bearer $GV_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"registryKey":"inception:mercury-2"}' \
  http://127.0.0.1:3421/api/providers/current

# Switch to OpenAI GPT-4o
curl -X PATCH \
  -H "Authorization: Bearer $GV_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"registryKey":"openai:gpt-4o"}' \
  http://127.0.0.1:3421/api/providers/current
```

---

## SSE: `model.changed` event

When a `PATCH /api/providers/current` succeeds, or when the model is changed via any other codepath (e.g. TUI settings), a `MODEL_CHANGED` event is emitted on the `providers` RuntimeEventBus domain.

**Companion SSE subscribers** receive this event automatically on their existing event stream (`GET /api/companion/chat/sessions/:id/events`) when the providers domain is part of the stream.

**Event envelope** (SSE `data:` payload):

```json
{
  "type": "MODEL_CHANGED",
  "registryKey": "inception:mercury-2",
  "provider": "inception",
  "previous": {
    "registryKey": "venice:llama-3.3-70b",
    "provider": "venice"
  }
}
```

The `previous` field is omitted when there is no meaningful prior selection (e.g. first model set on boot).

---

## Zod contract schemas

Importable from `@pellux/contracts`:

```typescript
import {
  ListProvidersResponseSchema,
  CurrentModelResponseSchema,
  PatchCurrentModelBodySchema,
  PatchCurrentModelErrorSchema,
  PatchCurrentModelResponseSchema,
  ModelChangedEventSchema,
} from '@pellux/contracts';

// Validate a response body at runtime:
const result = ListProvidersResponseSchema.safeParse(responseBody);
```

---

## Error handling pattern (companion app)

```typescript
async function switchModel(registryKey: string, token: string): Promise<void> {
  const res = await fetch('/api/providers/current', {
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

The error arrives on the existing SSE `companion-chat.turn_error` event.

---

## Companion app integration pattern

Use different selection flows for shared sessions and true remote sessions:

1. On startup, call `GET /api/providers` to populate a model picker UI.
2. For a shared TUI session, display `currentModel` as the selected item and call `PATCH /api/providers/current` when the user changes it. This intentionally changes the daemon/TUI current model and emits `MODEL_CHANGED`.
3. For a true companion remote chat session, create or update the companion chat session with its own `provider` and `model`. Do not call `PATCH /api/providers/current`.
4. On `409` from the global route, show the `missingEnvVars` hint. For remote chat turns, unconfigured-provider errors arrive on the companion session event stream.
5. Subscribe to the `providers` domain SSE stream only for shared/TUI model pickers. A remote session picker should track its own session record.

Remote session-local selection:

```http
POST /api/companion/chat/sessions
Content-Type: application/json

{ "title": "Mobile chat", "provider": "openai", "model": "gpt-5.5" }
```

```http
PATCH /api/companion/chat/sessions/{sessionId}
Content-Type: application/json

{ "provider": "anthropic", "model": "claude-sonnet-4-5" }
```

`PATCH /api/companion/chat/sessions/{sessionId}` updates only that companion chat session. The daemon still hosts the turn and supplies runtime context such as working directory and tool/runtime services, but it does not mutate the TUI's current provider/model.
