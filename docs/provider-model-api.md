# Provider & Model API Reference

**Version**: `@pellux/goodvibes-sdk` ≥ 0.21.3 (current: 0.25.1 — see SDK `CHANGELOG.md` for incremental provider-API changes; `secretsResolutionSkipped` has been always present since 0.21.36)
**Base path**: all routes are under `/api/providers`
**Authentication**: all routes require the standard daemon bearer token (`Authorization: Bearer <token>` or the operator session cookie).

---

## Endpoints

### `GET /api/providers`

List all registered providers and their models. Returns configured status and environment variable names for each provider.

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
| `providers[].configuredVia` | `"env" \| "secrets" \| "subscription" \| "anonymous" \| undefined` | How credentials are supplied: `"env"` = environment variable present; `"secrets"` = provider API key is stored in SecretsManager but not in the environment (added in 0.21.4); `"subscription"` = OAuth subscription token; `"anonymous"` = provider allows unauthenticated access (e.g. local SGLang); `undefined` = not configured |
| `providers[].envVars` | `string[]` | Environment variable names that configure this provider |
| `providers[].models` | `ProviderModelEntry[]` | All models exposed by this provider |
| `providers[].models[].registryKey` | `string` | Compound key to pass to `PATCH /api/providers/current` |
| `currentModel` | `ProviderModelRef \| null` | Currently-selected model; `null` if none configured |
| `secretsResolutionSkipped` | `boolean` | **Required since 0.21.36 (F-PROV-009)**: `true` when no `SecretsManager` was available during this response (secrets-tier providers will show `configured:false`); `false` when a secrets manager was consulted regardless of whether it resolved any keys. Always present. |

**curl example**

```bash
curl -H "Authorization: Bearer $GV_TOKEN" \
  http://localhost:5789/api/providers | jq .
```

---

### `GET /api/providers/current`

Return the currently-selected model and its configured status.

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
  http://localhost:5789/api/providers/current | jq .
```

---

### `PATCH /api/providers/current`

Switch the active model live — no daemon restart required. Persists the selection to config and emits a `MODEL_CHANGED` event to all subscribers.

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
  http://localhost:5789/api/providers/current

# Switch to OpenAI GPT-4o
curl -X PATCH \
  -H "Authorization: Bearer $GV_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"registryKey":"openai:gpt-4o"}' \
  http://localhost:5789/api/providers/current
```

---

## SSE: `model.changed` event

When a `PATCH /api/providers/current` succeeds, or when the model is changed via any other codepath (e.g. TUI settings), a `MODEL_CHANGED` event is emitted on the `providers` RuntimeEventBus domain.

**Companion SSE subscribers** receive this event automatically on their existing event stream (`GET /api/companion/chat/sessions/:id/events`). The `providers` domain is included in `DEFAULT_DOMAINS` as of 0.21.3 — no explicit domain subscription is needed.

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

As of 0.21.2, if the currently-selected provider is unconfigured and a companion chat turn is attempted, the provider adapter immediately yields a structured error chunk **before** making any network call:

```json
{
  "type": "error",
  "error": "Provider 'venice' is not configured. Set VENICE_API_KEY or configure via the TUI settings."
}
```

This replaces the previous behavior where the upstream API would respond with `401 Authentication failed` and the SDK would surface a confusing error string. No code changes are required in the companion app to benefit from this fix — the error arrives on the existing SSE `companion-chat.turn_error` event.

---

## Companion app integration pattern

1. On startup, call `GET /api/providers` to populate a model picker UI.
2. Display the `currentModel` from the response as the selected item.
3. When the user picks a new model, call `PATCH /api/providers/current` with the `registryKey`.
4. On success, update the picker. On `409`, show the `missingEnvVars` hint.
5. Subscribe to the `providers` domain SSE stream to receive live `MODEL_CHANGED` events and keep the picker in sync when the model is changed from the TUI.
