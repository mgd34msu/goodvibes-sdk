# Runtime Events Reference

Generated from the synced GoodVibes operator event contract for product version `0.18.2`.

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
      {
        "$ref": "$.operator.events[0].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[0].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[1].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[1].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[2].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[2].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[3].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[3].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[4].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[4].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[5].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[5].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[6].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[6].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[7].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[7].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[8].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[8].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[9].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[9].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[10].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[10].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[11].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[11].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[12].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[12].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[13].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[13].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[14].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[14].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[15].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[15].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[16].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[16].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[17].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[17].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[18].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[18].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[19].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[19].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[20].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[20].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[21].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[21].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[22].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[22].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[23].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[23].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[24].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[24].outputSchema.additionalProperties"
        }
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
      {
        "$ref": "$.operator.events[25].outputSchema"
      },
      {
        "type": "array",
        "items": {
          "$ref": "$.operator.events[25].outputSchema.additionalProperties"
        }
      }
    ]
  }
}
```

