# Runtime Events Reference

Generated from the synced GoodVibes operator event contract for product version `0.25.13`.

## Transport endpoints

- SSE: `/api/control-plane/events`
- WebSocket: `/api/control-plane/ws`
- SSE query: `domains=comma-separated runtime domains`

Schema blocks below are emitted directly from the synced contract JSON and may contain contract-local `$ref` pointers.

## Runtime domains

### `agents`

- `runtime.agents` -> `agents`

#### `runtime.agents` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `automation`

- `runtime.automation` -> `automation`

#### `runtime.automation` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `communication`

- `runtime.communication` -> `communication`

#### `runtime.communication` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `compaction`

- `runtime.compaction` -> `compaction`

#### `runtime.compaction` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `control-plane`

- `runtime.control-plane` -> `control-plane`

#### `runtime.control-plane` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `deliveries`

- `runtime.deliveries` -> `deliveries`

#### `runtime.deliveries` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `forensics`

- `runtime.forensics` -> `forensics`

#### `runtime.forensics` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `knowledge`

- `runtime.knowledge` -> `knowledge`

#### `runtime.knowledge` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `mcp`

- `runtime.mcp` -> `mcp`

#### `runtime.mcp` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `ops`

- `runtime.ops` -> `ops`

#### `runtime.ops` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `orchestration`

- `runtime.orchestration` -> `orchestration`

#### `runtime.orchestration` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `permissions`

- `runtime.permissions` -> `permissions`

#### `runtime.permissions` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `planner`

- `runtime.planner` -> `planner`

#### `runtime.planner` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `plugins`

- `runtime.plugins` -> `plugins`

#### `runtime.plugins` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `providers`

- `runtime.providers` -> `providers`

#### `runtime.providers` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `routes`

- `runtime.routes` -> `routes`

#### `runtime.routes` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `security`

- `runtime.security` -> `security`

#### `runtime.security` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `session`

- `runtime.session` -> `session`

#### `runtime.session` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `surfaces`

- `runtime.surfaces` -> `surfaces`

#### `runtime.surfaces` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `tasks`

- `runtime.tasks` -> `tasks`

#### `runtime.tasks` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `tools`

- `runtime.tools` -> `tools`

#### `runtime.tools` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `transport`

- `runtime.transport` -> `transport`

#### `runtime.transport` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `turn`

- `runtime.turn` -> `turn`

#### `runtime.turn` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `ui`

- `runtime.ui` -> `ui`

#### `runtime.ui` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `watchers`

- `runtime.watchers` -> `watchers`

#### `runtime.watchers` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `workflows`

- `runtime.workflows` -> `workflows`

#### `runtime.workflows` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `workspace`

- `runtime.workspace` -> `workspace`

#### `runtime.workspace` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

## Named WRFC workflow events

The following named events are emitted on the `workflows` domain by the WRFC controller. They are not currently in the operator contract artifact — they are documented here as the authoritative reference.

---

### `WORKFLOW_CONSTRAINTS_ENUMERATED`

Emitted exactly once per WRFC chain immediately after the initial engineer agent completes and the controller has captured the constraint list from the engineer's report. Fixer re-runs do not re-emit this event.

| Field | Type | Description |
|-------|------|-------------|
| `chainId` | `string` | The WRFC chain that produced the constraints |
| `constraints` | `Constraint[]` | List of user-declared constraints extracted from the task prompt. Empty array when the task was non-build or unconstrained. |

`Constraint` shape:

```ts
interface Constraint {
  id: string;                      // "c1", "c2", …
  text: string;                    // quoted/near-quoted user phrasing
  source: 'prompt' | 'inherited'; // 'prompt' = engineer enumerated from this prompt
                                   // 'inherited' = from parent chain / gate-retry
}
```

**Trigger:** `WrfcController.handleEngineerCompletion` — fires when `!chain.constraintsEnumerated` (guards against duplicate emission on fixer re-runs).

**Semantics:** Signals the authoritative constraint list for the chain. An empty `constraints` array signals the zero-constraint (unconstrained) path — no constraint enforcement follows.

---

### `WORKFLOW_REVIEW_COMPLETED`

Emitted at the end of each reviewer cycle.

| Field | Type | Description |
|-------|------|-------------|
| `chainId` | `string` | The WRFC chain |
| `score` | `number` | Reviewer rubric score (0–10) |
| `passed` | `boolean` | `true` when `score >= threshold && !constraintFailure` |
| `constraintsSatisfied` | `number \| undefined` | Count of satisfied constraint findings. Present only when `chain.constraints.length > 0`. |
| `constraintsTotal` | `number \| undefined` | Total constraint findings evaluated. Present only when `chain.constraints.length > 0`. |
| `unsatisfiedConstraintIds` | `string[] \| undefined` | IDs of constraints that were not satisfied. Present only when `chain.constraints.length > 0`. |

When the chain has no constraints, `constraintsSatisfied`, `constraintsTotal`, and `unsatisfiedConstraintIds` are absent entirely (pre-0.23 consumers see no new fields).

---

### `WORKFLOW_FIX_ATTEMPTED`

Emitted at the start of each fixer cycle.

| Field | Type | Description |
|-------|------|-------------|
| `chainId` | `string` | The WRFC chain |
| `attempt` | `number` | Current fix attempt number (1-indexed) |
| `maxAttempts` | `number` | Maximum fix attempts configured for the chain |
| `targetConstraintIds` | `string[] \| undefined` | IDs of unsatisfied constraints this fix iteration is addressing. Present only when `chain.constraints.length > 0`. |

When the chain has no constraints, `targetConstraintIds` is absent (pre-0.23 consumers see no new fields).

For the full constraint propagation lifecycle, see [WRFC Constraint Propagation](./wrfc-constraint-propagation.md).
