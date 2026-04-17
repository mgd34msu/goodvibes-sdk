# Tool Safety

This guide covers how tool-call arguments move from raw streaming output through to your handler, what can go wrong at each step, and how to write tools that handle bad input gracefully.

---

## Tool-Call Lifecycle

When a provider streams a response that includes a tool call, the SDK processes it in three stages:

### 1. Delta accumulation

Each streaming chunk may carry a partial tool name or a partial argument string. Provider adapters (e.g. `anthropic.ts`, `anthropic-compat.ts`, `tool-formats.ts`) accumulate these deltas into a single buffer as they arrive. The accumulation happens inside the provider's stream-processing loop; no parsing occurs at this stage.

### 2. JSON parse with silent fallback

When the stream signals that a tool call is complete, the accumulated argument string is parsed. All provider adapters use a shared helper pattern:

```ts
// from packages/sdk/src/_internal/platform/providers/tool-formats.ts
function parseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logger.warn('tool-formats: failed to parse JSON tool arguments', { error: summarizeError(err) });
    return {};
  }
}
```

Other adapters follow the same pattern inline:

```ts
// from anthropic.ts and anthropic-compat.ts
try {
  parsedInput = JSON.parse(block.args || '{}') as Record<string, unknown>;
} catch {
  logger.debug('Anthropic: failed to parse tool args JSON', { name: block.name, args: block.args });
}
```

**Key behavior:** if the accumulated argument string is empty, truncated by a network error, or syntactically invalid JSON, the parse silently returns `{}`. A `warn`-level log is emitted (visible in daemon logs), but the tool handler is still called — with an empty argument object.

### 3. Handler dispatch

The parsed argument object is passed directly to your tool handler. If the tool was called with malformed arguments, your handler receives `{}`.

---

## Why Silent Fallback Matters

Most tool argument failures fall into two categories:

| Cause | Result |
|---|---|
| LLM produces partial/truncated JSON (common with aggressive max-token limits) | Handler receives `{}` |
| LLM produces semantically wrong JSON (wrong keys, wrong types) | Handler receives a structurally valid but incorrect object |
| Network error mid-stream truncates the argument buffer | Handler receives `{}` |
| LLM produces valid JSON with extra or missing fields | Handler receives the object as-is |

In all cases, the SDK does not raise an error before calling your handler. This is intentional — the SDK has no schema for third-party tools and cannot know what is valid. **Validation is the tool author's responsibility.**

---

## Recommendations for Tool Authors

### Always validate tool input

Every tool handler should validate its arguments before using them. Do not assume that because the LLM was given a schema, it produced valid output conforming to that schema.

### Example: validation with Zod

```ts
import { z } from 'zod';

const SearchArgsSchema = z.object({
  query: z.string().min(1, 'query is required'),
  limit: z.number().int().min(1).max(100).default(10),
});

async function handleSearch(rawArgs: Record<string, unknown>) {
  const result = SearchArgsSchema.safeParse(rawArgs);

  if (!result.success) {
    // Return a structured error the LLM can reason about and retry
    return {
      error: 'invalid_arguments',
      details: result.error.flatten(),
    };
  }

  const { query, limit } = result.data;
  // ... proceed with validated args
}
```

Returning a structured error object (rather than throwing) allows the model to observe the failure and potentially self-correct on the next turn.

### Example: validation with AJV

```ts
import Ajv from 'ajv';

const ajv = new Ajv({ coerceTypes: true });
const validate = ajv.compile({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
  },
  required: ['query'],
});

async function handleSearch(rawArgs: Record<string, unknown>) {
  if (!validate(rawArgs)) {
    return { error: 'invalid_arguments', details: validate.errors };
  }
  // rawArgs is coerced and valid here
}
```

### Fail loudly, not silently

Avoiding `throw` in handler code is reasonable (prevents unhandled promise rejections from aborting the turn), but returning a meaningful error payload is always better than silently ignoring missing fields. Returning `{}` or `null` gives the model nothing to act on.

---

## Detecting Silent Parse Failures

When the SDK falls back to `{}` due to a parse error, a log entry is emitted at `warn` level. To catch this in production:

- Configure your observability stack to alert on `tool-formats: failed to parse JSON tool arguments`
- Review provider-specific debug logs for `failed to parse tool args JSON` messages (Anthropic adapter emits at `debug` level)
- Use `inspect().sessionCount` to correlate with active sessions if diagnosing a regression

---

## Tool Contract Work (Deferred)

A formal tool-contract system (R4 from the Tier 4 roadmap) is planned but not yet implemented. When it lands, tool schemas registered with the SDK will be used to validate arguments automatically before dispatch, making handler-level validation optional for tools that opt in. Until then, handler-level validation as shown above is the recommended approach.

Cross-reference: the tool contract feature is tracked under the Tier 4 deferred items in the release roadmap.
