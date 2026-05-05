# Tool Safety

> **Surface scope:** This document describes tool-call behavior for the **full surface (Bun runtime)**. See [Runtime Surfaces](./surfaces.md) for companion-surface constraints.

This guide covers how tool-call arguments move from raw streaming output through to your handler, what can go wrong at each step, and how to write tools that handle bad input gracefully.

---

## Tool-Call Lifecycle

When a provider streams a response that includes a tool call, the SDK processes it in three stages:

### 1. Delta accumulation

Each streaming chunk may carry a partial tool name or a partial argument string. Provider adapters (e.g. `anthropic.ts`, `anthropic-compat.ts`, `tool-formats.ts`) accumulate these deltas into a single buffer as they arrive. The accumulation happens inside the provider's stream-processing loop; no parsing occurs at this stage.

### 2. JSON parse with malformed-call drop

When the stream signals that a tool call is complete, the accumulated argument string is parsed. Provider adapters use the shared parser in `tool-formats.ts` for accumulated OpenAI-style calls, text-delimited calls, and streamed Anthropic/Responses-style argument buffers:

```ts
// shared provider parser
function parseToolCallArguments(raw: string): Record<string, unknown> | undefined {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logger.warn('tool-formats: failed to parse JSON tool arguments; dropping malformed tool call', {
      error: summarizeError(err),
    });
    return undefined;
  }
}
```

**Key behavior:** an empty accumulated argument string is treated as `{}` for no-argument tools. If the accumulated string is truncated or syntactically invalid JSON, the SDK emits a `warn`-level log and drops that malformed tool call. The tool handler is not called with manufactured empty arguments.

### 3. Handler dispatch

Only successfully parsed tool-call arguments are passed to handlers. If a provider reports a tool-call stop reason but no parseable tool calls remain, the orchestrator treats the response as malformed and emits the existing tool-reconciliation warning path instead of dispatching a handler with `{}`.

All model-originated tool calls should pass through the shared tool execution boundary before a handler is invoked. That boundary applies permission checks, Pre/Post/Fail hooks, runtime tool events, and normalized error handling. TUI/orchestrator turns and companion remote chat use this shared path; embedders that provide a `ToolRegistry` without a `PermissionManager` to companion chat receive denied tool results instead of direct handler execution.

Built-in batch tools also cap fanout to avoid accidental resource exhaustion:

| Tool | Per-call item cap | Parallel cap |
|---|---:|---:|
| `fetch` | 20 URLs | 5 concurrent requests |
| `exec` | 10 commands | 3 concurrent commands |
| `find` | 20 queries | 5 concurrent queries |
| `read` | 50 files | 8 concurrent reads |

---

## Why Argument Validation Still Matters

Most tool argument failures fall into two categories:

| Cause | Result |
|---|---|
| LLM produces partial/truncated JSON (common with aggressive max-token limits) | Malformed tool call is dropped before handler dispatch |
| LLM produces semantically wrong JSON (wrong keys, wrong types) | Handler receives a structurally valid but incorrect object |
| Network error mid-stream truncates the argument buffer | Malformed tool call is dropped before handler dispatch |
| LLM produces valid JSON with extra or missing fields | Handler receives the object as-is |

The SDK rejects malformed JSON before tool dispatch, but it does not schema-validate third-party arguments. It cannot know whether a valid JSON object is correct for your tool. **Validation is the tool author's responsibility.**

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

### Fail Loudly

Avoiding `throw` in handler code is reasonable (prevents unhandled promise rejections from aborting the turn), but returning a meaningful error payload is always better than ignoring missing fields. Returning `{}` or `null` gives the model nothing to act on.

---

## Detecting Dropped Parse Failures

When the SDK drops a malformed tool call due to a parse error, a log entry is emitted at `warn` level. To catch this in production:

- Configure your observability stack to alert on `tool-formats: failed to parse JSON tool arguments; dropping malformed tool call`
- Review malformed-stop-reason reconciliation events when a provider reported tool use but no parseable tool calls remained
- Use `inspect().sessionCount` to correlate with active sessions if diagnosing a regression

---

## Tool Contract Verification

Tool contract verification is implemented at registration time. Built-in tool
registration goes through `registerToolWithContractGate`, and the
`tool-contract-verification` feature flag is enabled by default when no host
feature manager is supplied.

The verifier checks the registered tool definition and phased-tool metadata
before the tool enters the registry: schema shape, timeout/cancellation support,
permission class, output policy, and idempotency metadata. Error-level
violations fail closed by throwing from `ToolRegistry.registerWithContract`;
warning-level violations are returned for diagnostics.

Handler-level argument validation is still required for untrusted runtime input.
Contract verification prevents malformed tools from being registered; it does
not replace validation inside a handler for model-provided arguments.
