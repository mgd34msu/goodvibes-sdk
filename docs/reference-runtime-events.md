# Runtime Events Reference

Generated from the synced GoodVibes operator event contract artifact.

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

### `config`

- `runtime.config` -> `config`

#### `runtime.config` payload schema

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

### `fleet`

- `runtime.fleet` -> `fleet`

#### `runtime.fleet` payload schema

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

- `control.approval_update` -> `approval-update`
- `runtime.permissions` -> `permissions`

#### `control.approval_update` payload schema

```json
{
  "type": "object",
  "properties": {
    "approval": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "callId": {
          "type": "string"
        },
        "sessionId": {
          "type": "string"
        },
        "routeId": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "pending",
            "claimed",
            "approved",
            "denied",
            "cancelled",
            "expired"
          ]
        },
        "request": {
          "type": "object",
          "properties": {
            "callId": {
              "type": "string"
            },
            "tool": {
              "type": "string"
            },
            "args": {
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
                    "type": "object",
                    "additionalProperties": {}
                  },
                  {
                    "type": "array",
                    "items": {}
                  }
                ]
              }
            },
            "category": {
              "type": "string",
              "enum": [
                "read",
                "write",
                "execute",
                "delegate"
              ]
            },
            "analysis": {
              "type": "object",
              "properties": {
                "classification": {
                  "type": "string"
                },
                "riskLevel": {
                  "type": "string",
                  "enum": [
                    "low",
                    "medium",
                    "high",
                    "critical"
                  ]
                },
                "summary": {
                  "type": "string"
                },
                "reasons": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "target": {
                  "type": "string"
                },
                "targetKind": {
                  "type": "string",
                  "enum": [
                    "command",
                    "path",
                    "url",
                    "task",
                    "generic"
                  ]
                },
                "surface": {
                  "type": "string",
                  "enum": [
                    "filesystem",
                    "shell",
                    "network",
                    "orchestration",
                    "platform",
                    "generic"
                  ]
                },
                "blastRadius": {
                  "type": "string",
                  "enum": [
                    "local",
                    "project",
                    "external",
                    "delegated",
                    "platform"
                  ]
                },
                "sideEffects": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "host": {
                  "type": "string"
                }
              },
              "required": [
                "classification",
                "riskLevel",
                "summary",
                "reasons"
              ],
              "additionalProperties": false
            },
            "workingDirectory": {
              "type": "string"
            },
            "attribution": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "background-agent"
                      ]
                    },
                    "agentId": {
                      "type": "string"
                    },
                    "template": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "kind",
                    "agentId"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "mcp-server"
                      ]
                    },
                    "serverName": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "kind",
                    "serverName"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "sandbox-escalation"
                      ]
                    },
                    "sandbox": {
                      "type": "string"
                    },
                    "escalations": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    }
                  },
                  "required": [
                    "kind",
                    "sandbox",
                    "escalations"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "rememberOptions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "tier": {
                    "type": "string",
                    "enum": [
                      "session",
                      "exact",
                      "command-class",
                      "path",
                      "tool"
                    ]
                  },
                  "label": {
                    "type": "string"
                  },
                  "detail": {
                    "type": "string"
                  }
                },
                "required": [
                  "tier",
                  "label",
                  "detail"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "callId",
            "tool",
            "args",
            "category",
            "analysis"
          ],
          "additionalProperties": false
        },
        "createdAt": {
          "type": "number"
        },
        "updatedAt": {
          "type": "number"
        },
        "claimedBy": {
          "type": "string"
        },
        "claimedAt": {
          "type": "number"
        },
        "resolvedAt": {
          "type": "number"
        },
        "resolvedBy": {
          "type": "string"
        },
        "decision": {
          "type": "object",
          "properties": {
            "approved": {
              "type": "boolean"
            },
            "remember": {
              "type": "boolean"
            },
            "rememberTier": {
              "type": "string",
              "enum": [
                "session",
                "exact",
                "command-class",
                "path",
                "tool"
              ]
            },
            "reason": {
              "type": "string"
            },
            "modifiedArgs": {
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
                    "type": "object",
                    "additionalProperties": {}
                  },
                  {
                    "type": "array",
                    "items": {}
                  }
                ]
              }
            }
          },
          "required": [
            "approved"
          ],
          "additionalProperties": false
        },
        "fixSessionId": {
          "type": "string"
        },
        "fixSessionError": {
          "type": "string"
        },
        "metadata": {
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
                "type": "object",
                "additionalProperties": {}
              },
              {
                "type": "array",
                "items": {}
              }
            ]
          }
        },
        "audit": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "action": {
                "type": "string",
                "enum": [
                  "created",
                  "claimed",
                  "approved",
                  "denied",
                  "cancelled",
                  "expired",
                  "updated"
                ]
              },
              "actor": {
                "type": "string"
              },
              "actorSurface": {
                "type": "string"
              },
              "createdAt": {
                "type": "number"
              },
              "note": {
                "type": "string"
              }
            },
            "required": [
              "id",
              "action",
              "actor",
              "createdAt"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "id",
        "callId",
        "status",
        "request",
        "createdAt",
        "updatedAt",
        "metadata",
        "audit"
      ],
      "additionalProperties": false
    },
    "createdAt": {
      "type": "number"
    }
  },
  "required": [
    "approval",
    "createdAt"
  ],
  "additionalProperties": false
}
```

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

- `control.hosted_session_update` -> `hosted-session-update`
- `runtime.session` -> `session`

#### `control.hosted_session_update` payload schema

```json
{
  "type": "object",
  "properties": {
    "event": {
      "type": "string",
      "enum": [
        "hosted-session-created",
        "hosted-session-attached",
        "hosted-session-detached",
        "hosted-session-turn-started",
        "hosted-session-turn-ended",
        "hosted-session-terminated",
        "hosted-session-restored"
      ]
    },
    "session": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceRoot": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "idle",
            "running",
            "terminated"
          ]
        },
        "detachPolicy": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "kill",
                "survive"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "effectiveDetachPolicy": {
          "type": "string",
          "enum": [
            "kill",
            "survive"
          ]
        },
        "attachedClients": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "providerId": {
          "type": "string"
        },
        "modelId": {
          "type": "string"
        },
        "createdAt": {
          "type": "number"
        },
        "updatedAt": {
          "type": "number"
        },
        "turnCount": {
          "type": "number"
        },
        "messageCount": {
          "type": "number"
        },
        "lastTurnAt": {
          "type": "number"
        },
        "terminatedAt": {
          "type": "number"
        },
        "terminatedReason": {
          "type": "string"
        },
        "restoredFromDisk": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "workspaceRoot",
        "title",
        "status",
        "detachPolicy",
        "effectiveDetachPolicy",
        "attachedClients",
        "createdAt",
        "updatedAt",
        "turnCount",
        "messageCount",
        "restoredFromDisk"
      ],
      "additionalProperties": false
    },
    "createdAt": {
      "type": "number"
    },
    "clientId": {
      "type": "string"
    },
    "detail": {
      "type": "string"
    }
  },
  "required": [
    "event",
    "session",
    "createdAt"
  ],
  "additionalProperties": false
}
```

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

When the chain has no constraints, `constraintsSatisfied`, `constraintsTotal`, and `unsatisfiedConstraintIds` are absent entirely.

---

### `WORKFLOW_FIX_ATTEMPTED`

Emitted at the start of each fixer cycle.

| Field | Type | Description |
|-------|------|-------------|
| `chainId` | `string` | The WRFC chain |
| `attempt` | `number` | Current fix attempt number (1-indexed) |
| `maxAttempts` | `number` | Maximum fix attempts configured for the chain |
| `targetConstraintIds` | `string[] \| undefined` | IDs of unsatisfied constraints this fix iteration is addressing. Present only when `chain.constraints.length > 0`. |

When the chain has no constraints, `targetConstraintIds` is absent.

For the full constraint propagation lifecycle, see [WRFC Constraint Propagation](./wrfc-constraint-propagation.md).
