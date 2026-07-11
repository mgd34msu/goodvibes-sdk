import type { MockDaemonFixtureMap } from '../testing/mock-daemon.js';

/**
 * GENERATED — do not edit. Regenerate with `bun run refresh:contracts`.
 *
 * A schema-valid sample response per cataloged operator method, generated
 * from the contract's own output schemas (see testing/mock-daemon.ts). The
 * webui Playwright mocks and Home Assistant test fixtures generate from this
 * instead of hand-authoring a response per method.
 */
export const MOCK_DAEMON_FIXTURES: MockDaemonFixtureMap = {
  "accounts.snapshot": {
    "methodId": "accounts.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/accounts"
    },
    "status": 200,
    "body": {
      "capturedAt": 0,
      "providers": [
        {
          "providerId": "sample",
          "active": false,
          "modelCount": 0,
          "configured": false,
          "oauthReady": false,
          "pendingLogin": false,
          "availableRoutes": [
            "api-key"
          ],
          "preferredRoute": "api-key",
          "activeRoute": "api-key",
          "activeRouteReason": "sample",
          "authFreshness": "healthy",
          "fallbackRoute": "api-key",
          "fallbackRisk": "sample",
          "expiresAt": 0,
          "tokenType": "sample",
          "notes": [
            "sample"
          ],
          "usageWindows": [
            {
              "label": "sample",
              "detail": "sample"
            }
          ],
          "issues": [
            "sample"
          ],
          "recommendedActions": [
            "sample"
          ],
          "routeRecords": [
            {
              "route": "api-key",
              "usable": false,
              "freshness": "healthy",
              "detail": "sample",
              "issues": [
                "sample"
              ]
            }
          ]
        }
      ],
      "configuredCount": 0,
      "issueCount": 0
    }
  },
  "approvals.approve": {
    "methodId": "approvals.approve",
    "http": {
      "method": "POST",
      "path": "/api/approvals/{approvalId}/approve"
    },
    "status": 200,
    "body": {
      "approval": {
        "id": "sample",
        "callId": "sample",
        "sessionId": "sample",
        "routeId": "sample",
        "status": "pending",
        "request": {
          "callId": "sample",
          "tool": "sample",
          "args": {},
          "category": "read",
          "analysis": {
            "classification": "sample",
            "riskLevel": "low",
            "summary": "sample",
            "reasons": [
              "sample"
            ],
            "target": "sample",
            "targetKind": "command",
            "surface": "filesystem",
            "blastRadius": "local",
            "sideEffects": [
              "sample"
            ],
            "host": "sample"
          },
          "workingDirectory": "sample",
          "attribution": {
            "kind": "background-agent",
            "agentId": "sample",
            "template": "sample"
          }
        },
        "createdAt": 0,
        "updatedAt": 0,
        "claimedBy": "sample",
        "claimedAt": 0,
        "resolvedAt": 0,
        "resolvedBy": "sample",
        "decision": {
          "approved": false,
          "remember": false,
          "modifiedArgs": {}
        },
        "metadata": {},
        "audit": [
          {
            "id": "sample",
            "action": "created",
            "actor": "sample",
            "actorSurface": "sample",
            "createdAt": 0,
            "note": "sample"
          }
        ]
      }
    }
  },
  "approvals.cancel": {
    "methodId": "approvals.cancel",
    "http": {
      "method": "POST",
      "path": "/api/approvals/{approvalId}/cancel"
    },
    "status": 200,
    "body": {
      "approval": {
        "id": "sample",
        "callId": "sample",
        "sessionId": "sample",
        "routeId": "sample",
        "status": "pending",
        "request": {
          "callId": "sample",
          "tool": "sample",
          "args": {},
          "category": "read",
          "analysis": {
            "classification": "sample",
            "riskLevel": "low",
            "summary": "sample",
            "reasons": [
              "sample"
            ],
            "target": "sample",
            "targetKind": "command",
            "surface": "filesystem",
            "blastRadius": "local",
            "sideEffects": [
              "sample"
            ],
            "host": "sample"
          },
          "workingDirectory": "sample",
          "attribution": {
            "kind": "background-agent",
            "agentId": "sample",
            "template": "sample"
          }
        },
        "createdAt": 0,
        "updatedAt": 0,
        "claimedBy": "sample",
        "claimedAt": 0,
        "resolvedAt": 0,
        "resolvedBy": "sample",
        "decision": {
          "approved": false,
          "remember": false,
          "modifiedArgs": {}
        },
        "metadata": {},
        "audit": [
          {
            "id": "sample",
            "action": "created",
            "actor": "sample",
            "actorSurface": "sample",
            "createdAt": 0,
            "note": "sample"
          }
        ]
      }
    }
  },
  "approvals.claim": {
    "methodId": "approvals.claim",
    "http": {
      "method": "POST",
      "path": "/api/approvals/{approvalId}/claim"
    },
    "status": 200,
    "body": {
      "approval": {
        "id": "sample",
        "callId": "sample",
        "sessionId": "sample",
        "routeId": "sample",
        "status": "pending",
        "request": {
          "callId": "sample",
          "tool": "sample",
          "args": {},
          "category": "read",
          "analysis": {
            "classification": "sample",
            "riskLevel": "low",
            "summary": "sample",
            "reasons": [
              "sample"
            ],
            "target": "sample",
            "targetKind": "command",
            "surface": "filesystem",
            "blastRadius": "local",
            "sideEffects": [
              "sample"
            ],
            "host": "sample"
          },
          "workingDirectory": "sample",
          "attribution": {
            "kind": "background-agent",
            "agentId": "sample",
            "template": "sample"
          }
        },
        "createdAt": 0,
        "updatedAt": 0,
        "claimedBy": "sample",
        "claimedAt": 0,
        "resolvedAt": 0,
        "resolvedBy": "sample",
        "decision": {
          "approved": false,
          "remember": false,
          "modifiedArgs": {}
        },
        "metadata": {},
        "audit": [
          {
            "id": "sample",
            "action": "created",
            "actor": "sample",
            "actorSurface": "sample",
            "createdAt": 0,
            "note": "sample"
          }
        ]
      }
    }
  },
  "approvals.deny": {
    "methodId": "approvals.deny",
    "http": {
      "method": "POST",
      "path": "/api/approvals/{approvalId}/deny"
    },
    "status": 200,
    "body": {
      "approval": {
        "id": "sample",
        "callId": "sample",
        "sessionId": "sample",
        "routeId": "sample",
        "status": "pending",
        "request": {
          "callId": "sample",
          "tool": "sample",
          "args": {},
          "category": "read",
          "analysis": {
            "classification": "sample",
            "riskLevel": "low",
            "summary": "sample",
            "reasons": [
              "sample"
            ],
            "target": "sample",
            "targetKind": "command",
            "surface": "filesystem",
            "blastRadius": "local",
            "sideEffects": [
              "sample"
            ],
            "host": "sample"
          },
          "workingDirectory": "sample",
          "attribution": {
            "kind": "background-agent",
            "agentId": "sample",
            "template": "sample"
          }
        },
        "createdAt": 0,
        "updatedAt": 0,
        "claimedBy": "sample",
        "claimedAt": 0,
        "resolvedAt": 0,
        "resolvedBy": "sample",
        "decision": {
          "approved": false,
          "remember": false,
          "modifiedArgs": {}
        },
        "metadata": {},
        "audit": [
          {
            "id": "sample",
            "action": "created",
            "actor": "sample",
            "actorSurface": "sample",
            "createdAt": 0,
            "note": "sample"
          }
        ]
      }
    }
  },
  "approvals.list": {
    "methodId": "approvals.list",
    "http": {
      "method": "GET",
      "path": "/api/approvals"
    },
    "status": 200,
    "body": {
      "awaitingDecision": false,
      "mode": "default",
      "lastDecision": {
        "callId": "sample",
        "toolName": "sample",
        "category": "read",
        "machineState": "collect_rules",
        "outcome": "approved",
        "reason": "config_allow",
        "sourceLayer": "config_policy",
        "persisted": false,
        "classification": "sample",
        "riskLevel": "low",
        "summary": "sample",
        "decidedAt": 0
      },
      "approvalCount": 0,
      "denialCount": 0,
      "cachedChecks": 0,
      "totalChecks": 0,
      "approvals": [
        {
          "id": "sample",
          "callId": "sample",
          "sessionId": "sample",
          "routeId": "sample",
          "status": "pending",
          "request": {
            "callId": "sample",
            "tool": "sample",
            "args": {},
            "category": "read",
            "analysis": {
              "classification": "sample",
              "riskLevel": "low",
              "summary": "sample",
              "reasons": [
                "sample"
              ],
              "target": "sample",
              "targetKind": "command",
              "surface": "filesystem",
              "blastRadius": "local",
              "sideEffects": [
                "sample"
              ],
              "host": "sample"
            },
            "workingDirectory": "sample",
            "attribution": {
              "kind": "background-agent",
              "agentId": "sample",
              "template": "sample"
            }
          },
          "createdAt": 0,
          "updatedAt": 0,
          "claimedBy": "sample",
          "claimedAt": 0,
          "resolvedAt": 0,
          "resolvedBy": "sample",
          "decision": {
            "approved": false,
            "remember": false,
            "modifiedArgs": {}
          },
          "metadata": {},
          "audit": [
            {
              "id": "sample",
              "action": "created",
              "actor": "sample",
              "actorSurface": "sample",
              "createdAt": 0,
              "note": "sample"
            }
          ]
        }
      ]
    }
  },
  "artifacts.content.get": {
    "methodId": "artifacts.content.get",
    "http": {
      "method": "GET",
      "path": "/api/artifacts/{artifactId}/content"
    },
    "status": 200,
    "body": {
      "contentType": "sample",
      "contentLength": 0
    }
  },
  "artifacts.create": {
    "methodId": "artifacts.create",
    "http": {
      "method": "POST",
      "path": "/api/artifacts"
    },
    "status": 200,
    "body": {
      "artifact": {
        "id": "sample",
        "kind": "sample",
        "mimeType": "sample",
        "filename": "sample",
        "sizeBytes": 0,
        "sha256": "sample",
        "createdAt": 0,
        "expiresAt": 0,
        "sourceUri": "sample",
        "acquisitionMode": "sample",
        "fetchMode": "sample",
        "metadata": {}
      }
    }
  },
  "artifacts.get": {
    "methodId": "artifacts.get",
    "http": {
      "method": "GET",
      "path": "/api/artifacts/{artifactId}"
    },
    "status": 200,
    "body": {
      "artifact": {
        "id": "sample",
        "kind": "sample",
        "mimeType": "sample",
        "filename": "sample",
        "sizeBytes": 0,
        "sha256": "sample",
        "createdAt": 0,
        "expiresAt": 0,
        "sourceUri": "sample",
        "acquisitionMode": "sample",
        "fetchMode": "sample",
        "metadata": {}
      }
    }
  },
  "artifacts.list": {
    "methodId": "artifacts.list",
    "http": {
      "method": "GET",
      "path": "/api/artifacts"
    },
    "status": 200,
    "body": {
      "artifacts": [
        {
          "id": "sample",
          "kind": "sample",
          "mimeType": "sample",
          "filename": "sample",
          "sizeBytes": 0,
          "sha256": "sample",
          "createdAt": 0,
          "expiresAt": 0,
          "sourceUri": "sample",
          "acquisitionMode": "sample",
          "fetchMode": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "local_auth.bootstrap.delete": {
    "methodId": "local_auth.bootstrap.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/local-auth/bootstrap-file"
    },
    "status": 200,
    "body": {
      "removed": false
    }
  },
  "local_auth.sessions.delete": {
    "methodId": "local_auth.sessions.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/local-auth/sessions/{sessionId}"
    },
    "status": 200,
    "body": {
      "revoked": false
    }
  },
  "local_auth.status": {
    "methodId": "local_auth.status",
    "http": {
      "method": "GET",
      "path": "/api/local-auth"
    },
    "status": 200,
    "body": {
      "userStorePath": "sample",
      "bootstrapCredentialPath": "sample",
      "bootstrapCredentialPresent": false,
      "userCount": 0,
      "sessionCount": 0,
      "users": [
        {
          "username": "sample",
          "roles": [
            "sample"
          ]
        }
      ],
      "sessions": [
        {
          "tokenFingerprint": "sample",
          "username": "sample",
          "expiresAt": 0
        }
      ]
    }
  },
  "local_auth.users.create": {
    "methodId": "local_auth.users.create",
    "http": {
      "method": "POST",
      "path": "/api/local-auth/users"
    },
    "status": 200,
    "body": {
      "user": {
        "username": "sample",
        "roles": [
          "sample"
        ]
      }
    }
  },
  "local_auth.users.delete": {
    "methodId": "local_auth.users.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/local-auth/users/{username}"
    },
    "status": 200,
    "body": {
      "deleted": false
    }
  },
  "local_auth.users.password.rotate": {
    "methodId": "local_auth.users.password.rotate",
    "http": {
      "method": "POST",
      "path": "/api/local-auth/users/{username}/password"
    },
    "status": 200,
    "body": {
      "rotated": false
    }
  },
  "automation.heartbeat.list": {
    "methodId": "automation.heartbeat.list",
    "http": {
      "method": "GET",
      "path": "/api/automation/heartbeat"
    },
    "status": 200,
    "body": {
      "pending": [
        {
          "jobId": "sample",
          "jobName": "sample",
          "trigger": "scheduled",
          "dueRun": false,
          "attempt": 0,
          "queuedAt": 0,
          "reason": "sample"
        }
      ]
    }
  },
  "automation.heartbeat.run": {
    "methodId": "automation.heartbeat.run",
    "http": {
      "method": "POST",
      "path": "/api/automation/heartbeat"
    },
    "status": 200,
    "body": {
      "processed": [
        {
          "id": "sample",
          "jobId": "sample",
          "labels": [
            "sample"
          ],
          "createdAt": 0,
          "updatedAt": 0,
          "status": "queued",
          "agentId": "sample",
          "triggeredBy": {
            "id": "sample",
            "kind": "schedule",
            "label": "sample",
            "surfaceKind": "tui",
            "routeId": "sample",
            "enabled": false,
            "createdAt": 0,
            "updatedAt": 0,
            "lastSeenAt": 0,
            "metadata": {}
          },
          "target": {
            "kind": "isolated",
            "sessionId": "sample",
            "routeId": "sample",
            "threadId": "sample",
            "channelId": "sample",
            "surfaceKind": "tui",
            "pinnedSessionId": "sample",
            "preserveThread": false,
            "createIfMissing": false
          },
          "execution": {
            "prompt": "sample",
            "template": "sample",
            "target": {
              "kind": "isolated",
              "sessionId": "sample",
              "routeId": "sample",
              "threadId": "sample",
              "channelId": "sample",
              "surfaceKind": "tui",
              "pinnedSessionId": "sample",
              "preserveThread": false,
              "createIfMissing": false
            },
            "modelProvider": "sample",
            "modelId": "sample",
            "fallbackModels": [
              "sample"
            ],
            "routing": {
              "providerSelection": "inherit-current",
              "providerFailurePolicy": "ordered-fallbacks",
              "fallbackModels": [
                "sample"
              ]
            },
            "executionIntent": {
              "riskClass": "safe",
              "requiresApproval": false,
              "networkPolicy": "inherit",
              "filesystemPolicy": "inherit"
            },
            "reasoningEffort": "instant",
            "thinking": "sample",
            "wakeMode": "next-heartbeat",
            "timeoutMs": 0,
            "maxAttempts": 0,
            "toolAllowlist": [
              "sample"
            ],
            "autoApprove": false,
            "sandboxMode": "inherit",
            "allowUnsafeExternalContent": false,
            "externalContentSource": "gmail",
            "lightContext": false
          },
          "scheduleKind": "at",
          "queuedAt": 0,
          "startedAt": 0,
          "endedAt": 0,
          "durationMs": 0,
          "forceRun": false,
          "dueRun": false,
          "attempt": 0,
          "sessionId": "sample",
          "routeId": "sample",
          "route": {
            "id": "sample",
            "kind": "session",
            "surfaceKind": "tui",
            "surfaceId": "sample",
            "externalId": "sample",
            "sessionPolicy": "create-or-bind",
            "threadPolicy": "preserve",
            "deliveryGuarantee": "best-effort",
            "threadId": "sample",
            "channelId": "sample",
            "sessionId": "sample",
            "jobId": "sample",
            "runId": "sample",
            "title": "sample",
            "lastSeenAt": 0,
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          },
          "continuationMode": "spawn",
          "executionIntent": {
            "mode": "spawn",
            "targetKind": "isolated"
          },
          "deliveryIds": [
            "sample"
          ],
          "deliveryAttempts": [
            {
              "id": "sample",
              "runId": "sample",
              "jobId": "sample",
              "target": {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              },
              "status": "pending",
              "startedAt": 0,
              "endedAt": 0,
              "error": "sample",
              "responseId": "sample"
            }
          ],
          "modelId": "sample",
          "providerId": "sample",
          "telemetry": {
            "usage": {
              "inputTokens": 0,
              "outputTokens": 0,
              "cacheReadTokens": 0,
              "cacheWriteTokens": 0,
              "reasoningTokens": 0
            },
            "llmCallCount": 0,
            "toolCallCount": 0,
            "turnCount": 0,
            "modelId": "sample",
            "providerId": "sample",
            "reasoningSummaryPresent": false,
            "source": "local-agent"
          },
          "result": "sample",
          "error": "sample",
          "cancelledReason": "sample",
          "metadata": {}
        }
      ],
      "failed": [
        {
          "jobId": "sample",
          "error": "sample"
        }
      ],
      "pending": [
        {
          "jobId": "sample",
          "jobName": "sample",
          "trigger": "scheduled",
          "dueRun": false,
          "attempt": 0,
          "queuedAt": 0,
          "reason": "sample"
        }
      ],
      "checkedAt": 0
    }
  },
  "automation.integration.snapshot": {
    "methodId": "automation.integration.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/automation"
    },
    "status": 200,
    "body": {
      "totals": {
        "jobs": 0,
        "enabled": 0,
        "paused": 0,
        "runs": 0
      },
      "jobs": [
        {
          "id": "sample",
          "name": "sample",
          "enabled": false,
          "status": "enabled",
          "schedule": {
            "kind": "at",
            "at": 0
          },
          "nextRunAt": 0,
          "lastRunAt": 0,
          "runCount": 0,
          "failureCount": 0
        }
      ],
      "recentRuns": [
        {
          "id": "sample",
          "jobId": "sample",
          "status": "sample",
          "trigger": "sample",
          "queuedAt": 0,
          "startedAt": 0,
          "endedAt": 0,
          "agentId": "sample",
          "error": "sample"
        }
      ]
    }
  },
  "automation.jobs.create": {
    "methodId": "automation.jobs.create",
    "http": {
      "method": "POST",
      "path": "/api/automation/jobs"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "name": "sample",
      "description": "sample",
      "labels": [
        "sample"
      ],
      "createdAt": 0,
      "updatedAt": 0,
      "status": "enabled",
      "enabled": false,
      "schedule": {
        "kind": "at",
        "at": 0
      },
      "execution": {
        "prompt": "sample",
        "template": "sample",
        "target": {
          "kind": "isolated",
          "sessionId": "sample",
          "routeId": "sample",
          "threadId": "sample",
          "channelId": "sample",
          "surfaceKind": "tui",
          "pinnedSessionId": "sample",
          "preserveThread": false,
          "createIfMissing": false
        },
        "modelProvider": "sample",
        "modelId": "sample",
        "fallbackModels": [
          "sample"
        ],
        "routing": {
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ]
        },
        "executionIntent": {
          "riskClass": "safe",
          "requiresApproval": false,
          "networkPolicy": "inherit",
          "filesystemPolicy": "inherit"
        },
        "reasoningEffort": "instant",
        "thinking": "sample",
        "wakeMode": "next-heartbeat",
        "timeoutMs": 0,
        "maxAttempts": 0,
        "toolAllowlist": [
          "sample"
        ],
        "autoApprove": false,
        "sandboxMode": "inherit",
        "allowUnsafeExternalContent": false,
        "externalContentSource": "gmail",
        "lightContext": false
      },
      "delivery": {
        "mode": "none",
        "targets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "fallbackTargets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "includeSummary": false,
        "includeTranscript": false,
        "includeLinks": false,
        "replyToRouteId": "sample"
      },
      "failure": {
        "action": "retry",
        "maxConsecutiveFailures": 0,
        "cooldownMs": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "delayMs": 0,
          "strategy": "fixed",
          "maxDelayMs": 0,
          "jitterMs": 0
        },
        "deadLetterRouteId": "sample",
        "disableAfterFailures": false,
        "notifyRouteId": "sample"
      },
      "source": {
        "id": "sample",
        "kind": "schedule",
        "label": "sample",
        "surfaceKind": "tui",
        "routeId": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "lastSeenAt": 0,
        "metadata": {}
      },
      "nextRunAt": 0,
      "lastRunAt": 0,
      "lastRunId": "sample",
      "runCount": 0,
      "successCount": 0,
      "failureCount": 0,
      "pausedReason": "sample",
      "deleteAfterRun": false,
      "archivedAt": 0,
      "metadata": {}
    }
  },
  "automation.jobs.delete": {
    "methodId": "automation.jobs.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/automation/jobs/{jobId}"
    },
    "status": 200,
    "body": {
      "removed": false,
      "id": "sample"
    }
  },
  "automation.jobs.disable": {
    "methodId": "automation.jobs.disable",
    "http": {
      "method": "POST",
      "path": "/api/automation/jobs/{jobId}/disable"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "enabled": false
    }
  },
  "automation.jobs.enable": {
    "methodId": "automation.jobs.enable",
    "http": {
      "method": "POST",
      "path": "/api/automation/jobs/{jobId}/enable"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "enabled": false
    }
  },
  "automation.jobs.list": {
    "methodId": "automation.jobs.list",
    "http": {
      "method": "GET",
      "path": "/api/automation/jobs"
    },
    "status": 200,
    "body": {
      "jobs": [
        {
          "id": "sample",
          "name": "sample",
          "description": "sample",
          "labels": [
            "sample"
          ],
          "createdAt": 0,
          "updatedAt": 0,
          "status": "enabled",
          "enabled": false,
          "schedule": {
            "kind": "at",
            "at": 0
          },
          "execution": {
            "prompt": "sample",
            "template": "sample",
            "target": {
              "kind": "isolated",
              "sessionId": "sample",
              "routeId": "sample",
              "threadId": "sample",
              "channelId": "sample",
              "surfaceKind": "tui",
              "pinnedSessionId": "sample",
              "preserveThread": false,
              "createIfMissing": false
            },
            "modelProvider": "sample",
            "modelId": "sample",
            "fallbackModels": [
              "sample"
            ],
            "routing": {
              "providerSelection": "inherit-current",
              "providerFailurePolicy": "ordered-fallbacks",
              "fallbackModels": [
                "sample"
              ]
            },
            "executionIntent": {
              "riskClass": "safe",
              "requiresApproval": false,
              "networkPolicy": "inherit",
              "filesystemPolicy": "inherit"
            },
            "reasoningEffort": "instant",
            "thinking": "sample",
            "wakeMode": "next-heartbeat",
            "timeoutMs": 0,
            "maxAttempts": 0,
            "toolAllowlist": [
              "sample"
            ],
            "autoApprove": false,
            "sandboxMode": "inherit",
            "allowUnsafeExternalContent": false,
            "externalContentSource": "gmail",
            "lightContext": false
          },
          "delivery": {
            "mode": "none",
            "targets": [
              {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              }
            ],
            "fallbackTargets": [
              {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              }
            ],
            "includeSummary": false,
            "includeTranscript": false,
            "includeLinks": false,
            "replyToRouteId": "sample"
          },
          "failure": {
            "action": "retry",
            "maxConsecutiveFailures": 0,
            "cooldownMs": 0,
            "retryPolicy": {
              "maxAttempts": 0,
              "delayMs": 0,
              "strategy": "fixed",
              "maxDelayMs": 0,
              "jitterMs": 0
            },
            "deadLetterRouteId": "sample",
            "disableAfterFailures": false,
            "notifyRouteId": "sample"
          },
          "source": {
            "id": "sample",
            "kind": "schedule",
            "label": "sample",
            "surfaceKind": "tui",
            "routeId": "sample",
            "enabled": false,
            "createdAt": 0,
            "updatedAt": 0,
            "lastSeenAt": 0,
            "metadata": {}
          },
          "nextRunAt": 0,
          "lastRunAt": 0,
          "lastRunId": "sample",
          "runCount": 0,
          "successCount": 0,
          "failureCount": 0,
          "pausedReason": "sample",
          "deleteAfterRun": false,
          "archivedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "automation.jobs.run": {
    "methodId": "automation.jobs.run",
    "http": {
      "method": "POST",
      "path": "/api/automation/jobs/{jobId}/run"
    },
    "status": 200,
    "body": {
      "jobId": "sample",
      "runId": "sample",
      "agentId": "sample",
      "status": "sample"
    }
  },
  "automation.jobs.update": {
    "methodId": "automation.jobs.update",
    "http": {
      "method": "PATCH",
      "path": "/api/automation/jobs/{jobId}"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "name": "sample",
      "description": "sample",
      "labels": [
        "sample"
      ],
      "createdAt": 0,
      "updatedAt": 0,
      "status": "enabled",
      "enabled": false,
      "schedule": {
        "kind": "at",
        "at": 0
      },
      "execution": {
        "prompt": "sample",
        "template": "sample",
        "target": {
          "kind": "isolated",
          "sessionId": "sample",
          "routeId": "sample",
          "threadId": "sample",
          "channelId": "sample",
          "surfaceKind": "tui",
          "pinnedSessionId": "sample",
          "preserveThread": false,
          "createIfMissing": false
        },
        "modelProvider": "sample",
        "modelId": "sample",
        "fallbackModels": [
          "sample"
        ],
        "routing": {
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ]
        },
        "executionIntent": {
          "riskClass": "safe",
          "requiresApproval": false,
          "networkPolicy": "inherit",
          "filesystemPolicy": "inherit"
        },
        "reasoningEffort": "instant",
        "thinking": "sample",
        "wakeMode": "next-heartbeat",
        "timeoutMs": 0,
        "maxAttempts": 0,
        "toolAllowlist": [
          "sample"
        ],
        "autoApprove": false,
        "sandboxMode": "inherit",
        "allowUnsafeExternalContent": false,
        "externalContentSource": "gmail",
        "lightContext": false
      },
      "delivery": {
        "mode": "none",
        "targets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "fallbackTargets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "includeSummary": false,
        "includeTranscript": false,
        "includeLinks": false,
        "replyToRouteId": "sample"
      },
      "failure": {
        "action": "retry",
        "maxConsecutiveFailures": 0,
        "cooldownMs": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "delayMs": 0,
          "strategy": "fixed",
          "maxDelayMs": 0,
          "jitterMs": 0
        },
        "deadLetterRouteId": "sample",
        "disableAfterFailures": false,
        "notifyRouteId": "sample"
      },
      "source": {
        "id": "sample",
        "kind": "schedule",
        "label": "sample",
        "surfaceKind": "tui",
        "routeId": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "lastSeenAt": 0,
        "metadata": {}
      },
      "nextRunAt": 0,
      "lastRunAt": 0,
      "lastRunId": "sample",
      "runCount": 0,
      "successCount": 0,
      "failureCount": 0,
      "pausedReason": "sample",
      "deleteAfterRun": false,
      "archivedAt": 0,
      "metadata": {}
    }
  },
  "automation.runs.cancel": {
    "methodId": "automation.runs.cancel",
    "http": {
      "method": "POST",
      "path": "/api/automation/runs/{runId}/cancel"
    },
    "status": 200,
    "body": {
      "run": {
        "id": "sample",
        "jobId": "sample",
        "labels": [
          "sample"
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "status": "queued",
        "agentId": "sample",
        "triggeredBy": {
          "id": "sample",
          "kind": "schedule",
          "label": "sample",
          "surfaceKind": "tui",
          "routeId": "sample",
          "enabled": false,
          "createdAt": 0,
          "updatedAt": 0,
          "lastSeenAt": 0,
          "metadata": {}
        },
        "target": {
          "kind": "isolated",
          "sessionId": "sample",
          "routeId": "sample",
          "threadId": "sample",
          "channelId": "sample",
          "surfaceKind": "tui",
          "pinnedSessionId": "sample",
          "preserveThread": false,
          "createIfMissing": false
        },
        "execution": {
          "prompt": "sample",
          "template": "sample",
          "target": {
            "kind": "isolated",
            "sessionId": "sample",
            "routeId": "sample",
            "threadId": "sample",
            "channelId": "sample",
            "surfaceKind": "tui",
            "pinnedSessionId": "sample",
            "preserveThread": false,
            "createIfMissing": false
          },
          "modelProvider": "sample",
          "modelId": "sample",
          "fallbackModels": [
            "sample"
          ],
          "routing": {
            "providerSelection": "inherit-current",
            "providerFailurePolicy": "ordered-fallbacks",
            "fallbackModels": [
              "sample"
            ]
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "reasoningEffort": "instant",
          "thinking": "sample",
          "wakeMode": "next-heartbeat",
          "timeoutMs": 0,
          "maxAttempts": 0,
          "toolAllowlist": [
            "sample"
          ],
          "autoApprove": false,
          "sandboxMode": "inherit",
          "allowUnsafeExternalContent": false,
          "externalContentSource": "gmail",
          "lightContext": false
        },
        "scheduleKind": "at",
        "queuedAt": 0,
        "startedAt": 0,
        "endedAt": 0,
        "durationMs": 0,
        "forceRun": false,
        "dueRun": false,
        "attempt": 0,
        "sessionId": "sample",
        "routeId": "sample",
        "route": {
          "id": "sample",
          "kind": "session",
          "surfaceKind": "tui",
          "surfaceId": "sample",
          "externalId": "sample",
          "sessionPolicy": "create-or-bind",
          "threadPolicy": "preserve",
          "deliveryGuarantee": "best-effort",
          "threadId": "sample",
          "channelId": "sample",
          "sessionId": "sample",
          "jobId": "sample",
          "runId": "sample",
          "title": "sample",
          "lastSeenAt": 0,
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        },
        "continuationMode": "spawn",
        "executionIntent": {
          "mode": "spawn",
          "targetKind": "isolated"
        },
        "deliveryIds": [
          "sample"
        ],
        "deliveryAttempts": [
          {
            "id": "sample",
            "runId": "sample",
            "jobId": "sample",
            "target": {
              "kind": "none",
              "surfaceKind": "tui",
              "address": "sample",
              "routeId": "sample",
              "label": "sample"
            },
            "status": "pending",
            "startedAt": 0,
            "endedAt": 0,
            "error": "sample",
            "responseId": "sample"
          }
        ],
        "modelId": "sample",
        "providerId": "sample",
        "telemetry": {
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0
          },
          "llmCallCount": 0,
          "toolCallCount": 0,
          "turnCount": 0,
          "modelId": "sample",
          "providerId": "sample",
          "reasoningSummaryPresent": false,
          "source": "local-agent"
        },
        "result": "sample",
        "error": "sample",
        "cancelledReason": "sample",
        "metadata": {}
      }
    }
  },
  "automation.runs.get": {
    "methodId": "automation.runs.get",
    "http": {
      "method": "GET",
      "path": "/api/automation/runs/{runId}"
    },
    "status": 200,
    "body": {
      "run": {
        "id": "sample",
        "jobId": "sample",
        "labels": [
          "sample"
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "status": "queued",
        "agentId": "sample",
        "triggeredBy": {
          "id": "sample",
          "kind": "schedule",
          "label": "sample",
          "surfaceKind": "tui",
          "routeId": "sample",
          "enabled": false,
          "createdAt": 0,
          "updatedAt": 0,
          "lastSeenAt": 0,
          "metadata": {}
        },
        "target": {
          "kind": "isolated",
          "sessionId": "sample",
          "routeId": "sample",
          "threadId": "sample",
          "channelId": "sample",
          "surfaceKind": "tui",
          "pinnedSessionId": "sample",
          "preserveThread": false,
          "createIfMissing": false
        },
        "execution": {
          "prompt": "sample",
          "template": "sample",
          "target": {
            "kind": "isolated",
            "sessionId": "sample",
            "routeId": "sample",
            "threadId": "sample",
            "channelId": "sample",
            "surfaceKind": "tui",
            "pinnedSessionId": "sample",
            "preserveThread": false,
            "createIfMissing": false
          },
          "modelProvider": "sample",
          "modelId": "sample",
          "fallbackModels": [
            "sample"
          ],
          "routing": {
            "providerSelection": "inherit-current",
            "providerFailurePolicy": "ordered-fallbacks",
            "fallbackModels": [
              "sample"
            ]
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "reasoningEffort": "instant",
          "thinking": "sample",
          "wakeMode": "next-heartbeat",
          "timeoutMs": 0,
          "maxAttempts": 0,
          "toolAllowlist": [
            "sample"
          ],
          "autoApprove": false,
          "sandboxMode": "inherit",
          "allowUnsafeExternalContent": false,
          "externalContentSource": "gmail",
          "lightContext": false
        },
        "scheduleKind": "at",
        "queuedAt": 0,
        "startedAt": 0,
        "endedAt": 0,
        "durationMs": 0,
        "forceRun": false,
        "dueRun": false,
        "attempt": 0,
        "sessionId": "sample",
        "routeId": "sample",
        "route": {
          "id": "sample",
          "kind": "session",
          "surfaceKind": "tui",
          "surfaceId": "sample",
          "externalId": "sample",
          "sessionPolicy": "create-or-bind",
          "threadPolicy": "preserve",
          "deliveryGuarantee": "best-effort",
          "threadId": "sample",
          "channelId": "sample",
          "sessionId": "sample",
          "jobId": "sample",
          "runId": "sample",
          "title": "sample",
          "lastSeenAt": 0,
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        },
        "continuationMode": "spawn",
        "executionIntent": {
          "mode": "spawn",
          "targetKind": "isolated"
        },
        "deliveryIds": [
          "sample"
        ],
        "deliveryAttempts": [
          {
            "id": "sample",
            "runId": "sample",
            "jobId": "sample",
            "target": {
              "kind": "none",
              "surfaceKind": "tui",
              "address": "sample",
              "routeId": "sample",
              "label": "sample"
            },
            "status": "pending",
            "startedAt": 0,
            "endedAt": 0,
            "error": "sample",
            "responseId": "sample"
          }
        ],
        "modelId": "sample",
        "providerId": "sample",
        "telemetry": {
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0
          },
          "llmCallCount": 0,
          "toolCallCount": 0,
          "turnCount": 0,
          "modelId": "sample",
          "providerId": "sample",
          "reasoningSummaryPresent": false,
          "source": "local-agent"
        },
        "result": "sample",
        "error": "sample",
        "cancelledReason": "sample",
        "metadata": {}
      },
      "deliveries": [
        {
          "id": "sample",
          "runId": "sample",
          "jobId": "sample",
          "target": {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          },
          "status": "pending",
          "startedAt": 0,
          "endedAt": 0,
          "error": "sample",
          "responseId": "sample"
        }
      ]
    }
  },
  "automation.runs.list": {
    "methodId": "automation.runs.list",
    "http": {
      "method": "GET",
      "path": "/api/automation/runs"
    },
    "status": 200,
    "body": {
      "runs": [
        {
          "id": "sample",
          "jobId": "sample",
          "labels": [
            "sample"
          ],
          "createdAt": 0,
          "updatedAt": 0,
          "status": "queued",
          "agentId": "sample",
          "triggeredBy": {
            "id": "sample",
            "kind": "schedule",
            "label": "sample",
            "surfaceKind": "tui",
            "routeId": "sample",
            "enabled": false,
            "createdAt": 0,
            "updatedAt": 0,
            "lastSeenAt": 0,
            "metadata": {}
          },
          "target": {
            "kind": "isolated",
            "sessionId": "sample",
            "routeId": "sample",
            "threadId": "sample",
            "channelId": "sample",
            "surfaceKind": "tui",
            "pinnedSessionId": "sample",
            "preserveThread": false,
            "createIfMissing": false
          },
          "execution": {
            "prompt": "sample",
            "template": "sample",
            "target": {
              "kind": "isolated",
              "sessionId": "sample",
              "routeId": "sample",
              "threadId": "sample",
              "channelId": "sample",
              "surfaceKind": "tui",
              "pinnedSessionId": "sample",
              "preserveThread": false,
              "createIfMissing": false
            },
            "modelProvider": "sample",
            "modelId": "sample",
            "fallbackModels": [
              "sample"
            ],
            "routing": {
              "providerSelection": "inherit-current",
              "providerFailurePolicy": "ordered-fallbacks",
              "fallbackModels": [
                "sample"
              ]
            },
            "executionIntent": {
              "riskClass": "safe",
              "requiresApproval": false,
              "networkPolicy": "inherit",
              "filesystemPolicy": "inherit"
            },
            "reasoningEffort": "instant",
            "thinking": "sample",
            "wakeMode": "next-heartbeat",
            "timeoutMs": 0,
            "maxAttempts": 0,
            "toolAllowlist": [
              "sample"
            ],
            "autoApprove": false,
            "sandboxMode": "inherit",
            "allowUnsafeExternalContent": false,
            "externalContentSource": "gmail",
            "lightContext": false
          },
          "scheduleKind": "at",
          "queuedAt": 0,
          "startedAt": 0,
          "endedAt": 0,
          "durationMs": 0,
          "forceRun": false,
          "dueRun": false,
          "attempt": 0,
          "sessionId": "sample",
          "routeId": "sample",
          "route": {
            "id": "sample",
            "kind": "session",
            "surfaceKind": "tui",
            "surfaceId": "sample",
            "externalId": "sample",
            "sessionPolicy": "create-or-bind",
            "threadPolicy": "preserve",
            "deliveryGuarantee": "best-effort",
            "threadId": "sample",
            "channelId": "sample",
            "sessionId": "sample",
            "jobId": "sample",
            "runId": "sample",
            "title": "sample",
            "lastSeenAt": 0,
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          },
          "continuationMode": "spawn",
          "executionIntent": {
            "mode": "spawn",
            "targetKind": "isolated"
          },
          "deliveryIds": [
            "sample"
          ],
          "deliveryAttempts": [
            {
              "id": "sample",
              "runId": "sample",
              "jobId": "sample",
              "target": {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              },
              "status": "pending",
              "startedAt": 0,
              "endedAt": 0,
              "error": "sample",
              "responseId": "sample"
            }
          ],
          "modelId": "sample",
          "providerId": "sample",
          "telemetry": {
            "usage": {
              "inputTokens": 0,
              "outputTokens": 0,
              "cacheReadTokens": 0,
              "cacheWriteTokens": 0,
              "reasoningTokens": 0
            },
            "llmCallCount": 0,
            "toolCallCount": 0,
            "turnCount": 0,
            "modelId": "sample",
            "providerId": "sample",
            "reasoningSummaryPresent": false,
            "source": "local-agent"
          },
          "result": "sample",
          "error": "sample",
          "cancelledReason": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "automation.runs.retry": {
    "methodId": "automation.runs.retry",
    "http": {
      "method": "POST",
      "path": "/api/automation/runs/{runId}/retry"
    },
    "status": 200,
    "body": {
      "run": {
        "id": "sample",
        "jobId": "sample",
        "labels": [
          "sample"
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "status": "queued",
        "agentId": "sample",
        "triggeredBy": {
          "id": "sample",
          "kind": "schedule",
          "label": "sample",
          "surfaceKind": "tui",
          "routeId": "sample",
          "enabled": false,
          "createdAt": 0,
          "updatedAt": 0,
          "lastSeenAt": 0,
          "metadata": {}
        },
        "target": {
          "kind": "isolated",
          "sessionId": "sample",
          "routeId": "sample",
          "threadId": "sample",
          "channelId": "sample",
          "surfaceKind": "tui",
          "pinnedSessionId": "sample",
          "preserveThread": false,
          "createIfMissing": false
        },
        "execution": {
          "prompt": "sample",
          "template": "sample",
          "target": {
            "kind": "isolated",
            "sessionId": "sample",
            "routeId": "sample",
            "threadId": "sample",
            "channelId": "sample",
            "surfaceKind": "tui",
            "pinnedSessionId": "sample",
            "preserveThread": false,
            "createIfMissing": false
          },
          "modelProvider": "sample",
          "modelId": "sample",
          "fallbackModels": [
            "sample"
          ],
          "routing": {
            "providerSelection": "inherit-current",
            "providerFailurePolicy": "ordered-fallbacks",
            "fallbackModels": [
              "sample"
            ]
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "reasoningEffort": "instant",
          "thinking": "sample",
          "wakeMode": "next-heartbeat",
          "timeoutMs": 0,
          "maxAttempts": 0,
          "toolAllowlist": [
            "sample"
          ],
          "autoApprove": false,
          "sandboxMode": "inherit",
          "allowUnsafeExternalContent": false,
          "externalContentSource": "gmail",
          "lightContext": false
        },
        "scheduleKind": "at",
        "queuedAt": 0,
        "startedAt": 0,
        "endedAt": 0,
        "durationMs": 0,
        "forceRun": false,
        "dueRun": false,
        "attempt": 0,
        "sessionId": "sample",
        "routeId": "sample",
        "route": {
          "id": "sample",
          "kind": "session",
          "surfaceKind": "tui",
          "surfaceId": "sample",
          "externalId": "sample",
          "sessionPolicy": "create-or-bind",
          "threadPolicy": "preserve",
          "deliveryGuarantee": "best-effort",
          "threadId": "sample",
          "channelId": "sample",
          "sessionId": "sample",
          "jobId": "sample",
          "runId": "sample",
          "title": "sample",
          "lastSeenAt": 0,
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        },
        "continuationMode": "spawn",
        "executionIntent": {
          "mode": "spawn",
          "targetKind": "isolated"
        },
        "deliveryIds": [
          "sample"
        ],
        "deliveryAttempts": [
          {
            "id": "sample",
            "runId": "sample",
            "jobId": "sample",
            "target": {
              "kind": "none",
              "surfaceKind": "tui",
              "address": "sample",
              "routeId": "sample",
              "label": "sample"
            },
            "status": "pending",
            "startedAt": 0,
            "endedAt": 0,
            "error": "sample",
            "responseId": "sample"
          }
        ],
        "modelId": "sample",
        "providerId": "sample",
        "telemetry": {
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0
          },
          "llmCallCount": 0,
          "toolCallCount": 0,
          "turnCount": 0,
          "modelId": "sample",
          "providerId": "sample",
          "reasoningSummaryPresent": false,
          "source": "local-agent"
        },
        "result": "sample",
        "error": "sample",
        "cancelledReason": "sample",
        "metadata": {}
      }
    }
  },
  "automation.schedules.create": {
    "methodId": "automation.schedules.create",
    "http": {
      "method": "POST",
      "path": "/api/automation/schedules"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "name": "sample",
      "description": "sample",
      "labels": [
        "sample"
      ],
      "createdAt": 0,
      "updatedAt": 0,
      "status": "enabled",
      "enabled": false,
      "schedule": {
        "kind": "at",
        "at": 0
      },
      "execution": {
        "prompt": "sample",
        "template": "sample",
        "target": {
          "kind": "isolated",
          "sessionId": "sample",
          "routeId": "sample",
          "threadId": "sample",
          "channelId": "sample",
          "surfaceKind": "tui",
          "pinnedSessionId": "sample",
          "preserveThread": false,
          "createIfMissing": false
        },
        "modelProvider": "sample",
        "modelId": "sample",
        "fallbackModels": [
          "sample"
        ],
        "routing": {
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ]
        },
        "executionIntent": {
          "riskClass": "safe",
          "requiresApproval": false,
          "networkPolicy": "inherit",
          "filesystemPolicy": "inherit"
        },
        "reasoningEffort": "instant",
        "thinking": "sample",
        "wakeMode": "next-heartbeat",
        "timeoutMs": 0,
        "maxAttempts": 0,
        "toolAllowlist": [
          "sample"
        ],
        "autoApprove": false,
        "sandboxMode": "inherit",
        "allowUnsafeExternalContent": false,
        "externalContentSource": "gmail",
        "lightContext": false
      },
      "delivery": {
        "mode": "none",
        "targets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "fallbackTargets": [
          {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          }
        ],
        "includeSummary": false,
        "includeTranscript": false,
        "includeLinks": false,
        "replyToRouteId": "sample"
      },
      "failure": {
        "action": "retry",
        "maxConsecutiveFailures": 0,
        "cooldownMs": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "delayMs": 0,
          "strategy": "fixed",
          "maxDelayMs": 0,
          "jitterMs": 0
        },
        "deadLetterRouteId": "sample",
        "disableAfterFailures": false,
        "notifyRouteId": "sample"
      },
      "source": {
        "id": "sample",
        "kind": "schedule",
        "label": "sample",
        "surfaceKind": "tui",
        "routeId": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "lastSeenAt": 0,
        "metadata": {}
      },
      "nextRunAt": 0,
      "lastRunAt": 0,
      "lastRunId": "sample",
      "runCount": 0,
      "successCount": 0,
      "failureCount": 0,
      "pausedReason": "sample",
      "deleteAfterRun": false,
      "archivedAt": 0,
      "metadata": {}
    }
  },
  "automation.schedules.delete": {
    "methodId": "automation.schedules.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/automation/schedules/{scheduleId}"
    },
    "status": 200,
    "body": {
      "removed": false,
      "id": "sample"
    }
  },
  "automation.schedules.disable": {
    "methodId": "automation.schedules.disable",
    "http": {
      "method": "POST",
      "path": "/api/automation/schedules/{scheduleId}/disable"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "enabled": false
    }
  },
  "automation.schedules.enable": {
    "methodId": "automation.schedules.enable",
    "http": {
      "method": "POST",
      "path": "/api/automation/schedules/{scheduleId}/enable"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "enabled": false
    }
  },
  "automation.schedules.list": {
    "methodId": "automation.schedules.list",
    "http": {
      "method": "GET",
      "path": "/api/automation/schedules"
    },
    "status": 200,
    "body": {
      "jobs": [
        {
          "id": "sample",
          "name": "sample",
          "description": "sample",
          "labels": [
            "sample"
          ],
          "createdAt": 0,
          "updatedAt": 0,
          "status": "enabled",
          "enabled": false,
          "schedule": {
            "kind": "at",
            "at": 0
          },
          "execution": {
            "prompt": "sample",
            "template": "sample",
            "target": {
              "kind": "isolated",
              "sessionId": "sample",
              "routeId": "sample",
              "threadId": "sample",
              "channelId": "sample",
              "surfaceKind": "tui",
              "pinnedSessionId": "sample",
              "preserveThread": false,
              "createIfMissing": false
            },
            "modelProvider": "sample",
            "modelId": "sample",
            "fallbackModels": [
              "sample"
            ],
            "routing": {
              "providerSelection": "inherit-current",
              "providerFailurePolicy": "ordered-fallbacks",
              "fallbackModels": [
                "sample"
              ]
            },
            "executionIntent": {
              "riskClass": "safe",
              "requiresApproval": false,
              "networkPolicy": "inherit",
              "filesystemPolicy": "inherit"
            },
            "reasoningEffort": "instant",
            "thinking": "sample",
            "wakeMode": "next-heartbeat",
            "timeoutMs": 0,
            "maxAttempts": 0,
            "toolAllowlist": [
              "sample"
            ],
            "autoApprove": false,
            "sandboxMode": "inherit",
            "allowUnsafeExternalContent": false,
            "externalContentSource": "gmail",
            "lightContext": false
          },
          "delivery": {
            "mode": "none",
            "targets": [
              {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              }
            ],
            "fallbackTargets": [
              {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              }
            ],
            "includeSummary": false,
            "includeTranscript": false,
            "includeLinks": false,
            "replyToRouteId": "sample"
          },
          "failure": {
            "action": "retry",
            "maxConsecutiveFailures": 0,
            "cooldownMs": 0,
            "retryPolicy": {
              "maxAttempts": 0,
              "delayMs": 0,
              "strategy": "fixed",
              "maxDelayMs": 0,
              "jitterMs": 0
            },
            "deadLetterRouteId": "sample",
            "disableAfterFailures": false,
            "notifyRouteId": "sample"
          },
          "source": {
            "id": "sample",
            "kind": "schedule",
            "label": "sample",
            "surfaceKind": "tui",
            "routeId": "sample",
            "enabled": false,
            "createdAt": 0,
            "updatedAt": 0,
            "lastSeenAt": 0,
            "metadata": {}
          },
          "nextRunAt": 0,
          "lastRunAt": 0,
          "lastRunId": "sample",
          "runCount": 0,
          "successCount": 0,
          "failureCount": 0,
          "pausedReason": "sample",
          "deleteAfterRun": false,
          "archivedAt": 0,
          "metadata": {}
        }
      ],
      "runs": [
        {
          "id": "sample",
          "jobId": "sample",
          "labels": [
            "sample"
          ],
          "createdAt": 0,
          "updatedAt": 0,
          "status": "queued",
          "agentId": "sample",
          "triggeredBy": {
            "id": "sample",
            "kind": "schedule",
            "label": "sample",
            "surfaceKind": "tui",
            "routeId": "sample",
            "enabled": false,
            "createdAt": 0,
            "updatedAt": 0,
            "lastSeenAt": 0,
            "metadata": {}
          },
          "target": {
            "kind": "isolated",
            "sessionId": "sample",
            "routeId": "sample",
            "threadId": "sample",
            "channelId": "sample",
            "surfaceKind": "tui",
            "pinnedSessionId": "sample",
            "preserveThread": false,
            "createIfMissing": false
          },
          "execution": {
            "prompt": "sample",
            "template": "sample",
            "target": {
              "kind": "isolated",
              "sessionId": "sample",
              "routeId": "sample",
              "threadId": "sample",
              "channelId": "sample",
              "surfaceKind": "tui",
              "pinnedSessionId": "sample",
              "preserveThread": false,
              "createIfMissing": false
            },
            "modelProvider": "sample",
            "modelId": "sample",
            "fallbackModels": [
              "sample"
            ],
            "routing": {
              "providerSelection": "inherit-current",
              "providerFailurePolicy": "ordered-fallbacks",
              "fallbackModels": [
                "sample"
              ]
            },
            "executionIntent": {
              "riskClass": "safe",
              "requiresApproval": false,
              "networkPolicy": "inherit",
              "filesystemPolicy": "inherit"
            },
            "reasoningEffort": "instant",
            "thinking": "sample",
            "wakeMode": "next-heartbeat",
            "timeoutMs": 0,
            "maxAttempts": 0,
            "toolAllowlist": [
              "sample"
            ],
            "autoApprove": false,
            "sandboxMode": "inherit",
            "allowUnsafeExternalContent": false,
            "externalContentSource": "gmail",
            "lightContext": false
          },
          "scheduleKind": "at",
          "queuedAt": 0,
          "startedAt": 0,
          "endedAt": 0,
          "durationMs": 0,
          "forceRun": false,
          "dueRun": false,
          "attempt": 0,
          "sessionId": "sample",
          "routeId": "sample",
          "route": {
            "id": "sample",
            "kind": "session",
            "surfaceKind": "tui",
            "surfaceId": "sample",
            "externalId": "sample",
            "sessionPolicy": "create-or-bind",
            "threadPolicy": "preserve",
            "deliveryGuarantee": "best-effort",
            "threadId": "sample",
            "channelId": "sample",
            "sessionId": "sample",
            "jobId": "sample",
            "runId": "sample",
            "title": "sample",
            "lastSeenAt": 0,
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          },
          "continuationMode": "spawn",
          "executionIntent": {
            "mode": "spawn",
            "targetKind": "isolated"
          },
          "deliveryIds": [
            "sample"
          ],
          "deliveryAttempts": [
            {
              "id": "sample",
              "runId": "sample",
              "jobId": "sample",
              "target": {
                "kind": "none",
                "surfaceKind": "tui",
                "address": "sample",
                "routeId": "sample",
                "label": "sample"
              },
              "status": "pending",
              "startedAt": 0,
              "endedAt": 0,
              "error": "sample",
              "responseId": "sample"
            }
          ],
          "modelId": "sample",
          "providerId": "sample",
          "telemetry": {
            "usage": {
              "inputTokens": 0,
              "outputTokens": 0,
              "cacheReadTokens": 0,
              "cacheWriteTokens": 0,
              "reasoningTokens": 0
            },
            "llmCallCount": 0,
            "toolCallCount": 0,
            "turnCount": 0,
            "modelId": "sample",
            "providerId": "sample",
            "reasoningSummaryPresent": false,
            "source": "local-agent"
          },
          "result": "sample",
          "error": "sample",
          "cancelledReason": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "automation.schedules.run": {
    "methodId": "automation.schedules.run",
    "http": {
      "method": "POST",
      "path": "/api/automation/schedules/{scheduleId}/run"
    },
    "status": 200,
    "body": {
      "jobId": "sample",
      "runId": "sample",
      "agentId": "sample",
      "status": "sample"
    }
  },
  "calendar.events.create": {
    "methodId": "calendar.events.create",
    "http": {
      "method": "POST",
      "path": "/api/calendar/events"
    },
    "status": 200,
    "body": {
      "eventId": "sample",
      "uid": "sample",
      "createdAt": "sample"
    }
  },
  "calendar.events.get": {
    "methodId": "calendar.events.get",
    "http": {
      "method": "GET",
      "path": "/api/calendar/events/{eventId}"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "uid": "sample",
      "title": "sample",
      "start": "sample",
      "end": "sample",
      "location": "sample",
      "description": "sample",
      "attendees": [
        "sample"
      ],
      "recurrence": "sample"
    }
  },
  "calendar.events.list": {
    "methodId": "calendar.events.list",
    "http": {
      "method": "GET",
      "path": "/api/calendar/events"
    },
    "status": 200,
    "body": {
      "events": [
        {
          "id": "sample",
          "title": "sample",
          "start": "sample",
          "end": "sample",
          "location": "sample",
          "description": "sample",
          "attendees": [
            "sample"
          ]
        }
      ]
    }
  },
  "calendar.ics.export": {
    "methodId": "calendar.ics.export",
    "http": {
      "method": "GET",
      "path": "/api/calendar/ics/export"
    },
    "status": 200,
    "body": {
      "icsContent": "sample",
      "eventCount": 0
    }
  },
  "calendar.ics.import": {
    "methodId": "calendar.ics.import",
    "http": {
      "method": "POST",
      "path": "/api/calendar/ics/import"
    },
    "status": 200,
    "body": {
      "imported": 0,
      "eventIds": [
        "sample"
      ],
      "errors": [
        "sample"
      ]
    }
  },
  "channels.accounts.action.default": {
    "methodId": "channels.accounts.action.default",
    "http": {
      "method": "POST",
      "path": "/api/channels/accounts/{surface}/actions/{action}"
    },
    "status": 200,
    "body": {
      "surface": "sample",
      "accountId": "sample",
      "action": "sample",
      "result": {
        "surface": "sample",
        "accountId": "sample",
        "action": "sample",
        "ok": false,
        "state": "sample",
        "authState": "sample",
        "account": {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "enabled": false,
          "configured": false,
          "linked": false,
          "state": "sample",
          "authState": "sample",
          "accountId": "sample",
          "workspaceId": "sample",
          "secrets": [
            {
              "field": "sample",
              "label": "sample",
              "configured": false,
              "source": "sample"
            }
          ],
          "actions": [
            {
              "id": "sample",
              "label": "sample",
              "kind": "sample",
              "available": false
            }
          ],
          "metadata": {}
        },
        "message": "sample",
        "login": {
          "kind": "sample",
          "url": "sample",
          "qr": "sample",
          "expiresAt": 0,
          "instructions": "sample"
        },
        "metadata": {}
      }
    }
  },
  "channels.accounts.action.named": {
    "methodId": "channels.accounts.action.named",
    "http": {
      "method": "POST",
      "path": "/api/channels/accounts/{surface}/{accountId}/actions/{action}"
    },
    "status": 200,
    "body": {
      "surface": "sample",
      "accountId": "sample",
      "action": "sample",
      "result": {
        "surface": "sample",
        "accountId": "sample",
        "action": "sample",
        "ok": false,
        "state": "sample",
        "authState": "sample",
        "account": {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "enabled": false,
          "configured": false,
          "linked": false,
          "state": "sample",
          "authState": "sample",
          "accountId": "sample",
          "workspaceId": "sample",
          "secrets": [
            {
              "field": "sample",
              "label": "sample",
              "configured": false,
              "source": "sample"
            }
          ],
          "actions": [
            {
              "id": "sample",
              "label": "sample",
              "kind": "sample",
              "available": false
            }
          ],
          "metadata": {}
        },
        "message": "sample",
        "login": {
          "kind": "sample",
          "url": "sample",
          "qr": "sample",
          "expiresAt": 0,
          "instructions": "sample"
        },
        "metadata": {}
      }
    }
  },
  "channels.accounts.get": {
    "methodId": "channels.accounts.get",
    "http": {
      "method": "GET",
      "path": "/api/channels/accounts/{surface}/{accountId}"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "surface": "sample",
      "label": "sample",
      "enabled": false,
      "configured": false,
      "linked": false,
      "state": "sample",
      "authState": "sample",
      "accountId": "sample",
      "workspaceId": "sample",
      "secrets": [
        {
          "field": "sample",
          "label": "sample",
          "configured": false,
          "source": "sample"
        }
      ],
      "actions": [
        {
          "id": "sample",
          "label": "sample",
          "kind": "sample",
          "available": false
        }
      ],
      "metadata": {}
    }
  },
  "channels.accounts.list": {
    "methodId": "channels.accounts.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/accounts"
    },
    "status": 200,
    "body": {
      "accounts": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "enabled": false,
          "configured": false,
          "linked": false,
          "state": "sample",
          "authState": "sample",
          "accountId": "sample",
          "workspaceId": "sample",
          "secrets": [
            {
              "field": "sample",
              "label": "sample",
              "configured": false,
              "source": "sample"
            }
          ],
          "actions": [
            {
              "id": "sample",
              "label": "sample",
              "kind": "sample",
              "available": false
            }
          ],
          "metadata": {}
        }
      ]
    }
  },
  "channels.accounts.surface.list": {
    "methodId": "channels.accounts.surface.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/accounts/{surface}"
    },
    "status": 200,
    "body": {
      "accounts": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "enabled": false,
          "configured": false,
          "linked": false,
          "state": "sample",
          "authState": "sample",
          "accountId": "sample",
          "workspaceId": "sample",
          "secrets": [
            {
              "field": "sample",
              "label": "sample",
              "configured": false,
              "source": "sample"
            }
          ],
          "actions": [
            {
              "id": "sample",
              "label": "sample",
              "kind": "sample",
              "available": false
            }
          ],
          "metadata": {}
        }
      ]
    }
  },
  "channels.actions.invoke": {
    "methodId": "channels.actions.invoke",
    "http": {
      "method": "POST",
      "path": "/api/channels/actions/{surface}/{actionId}"
    },
    "status": 200,
    "body": {
      "actionId": "sample",
      "surface": "sample",
      "result": {}
    }
  },
  "channels.actions.list": {
    "methodId": "channels.actions.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/actions"
    },
    "status": 200,
    "body": {
      "actions": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "description": "sample",
          "dangerous": false,
          "inputSchema": {},
          "metadata": {}
        }
      ]
    }
  },
  "channels.actions.surface.list": {
    "methodId": "channels.actions.surface.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/actions/{surface}"
    },
    "status": 200,
    "body": {
      "actions": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "description": "sample",
          "dangerous": false,
          "inputSchema": {},
          "metadata": {}
        }
      ]
    }
  },
  "channels.agent_tools.list": {
    "methodId": "channels.agent_tools.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/agent-tools"
    },
    "status": 200,
    "body": {
      "tools": [
        {
          "name": "sample",
          "description": "sample",
          "parameters": {},
          "sideEffects": [
            "sample"
          ],
          "concurrency": "sample",
          "supportsProgress": false,
          "supportsStreamingOutput": false
        }
      ]
    }
  },
  "channels.agent_tools.surface.list": {
    "methodId": "channels.agent_tools.surface.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/agent-tools/{surface}"
    },
    "status": 200,
    "body": {
      "tools": [
        {
          "name": "sample",
          "description": "sample",
          "parameters": {},
          "sideEffects": [
            "sample"
          ],
          "concurrency": "sample",
          "supportsProgress": false,
          "supportsStreamingOutput": false
        }
      ]
    }
  },
  "channels.allowlist.edit": {
    "methodId": "channels.allowlist.edit",
    "http": {
      "method": "POST",
      "path": "/api/channels/allowlist/{surface}/edit"
    },
    "status": 200,
    "body": {
      "surface": "sample",
      "updatedPolicy": {
        "surface": "sample",
        "enabled": false,
        "requireMention": false,
        "allowDirectMessages": false,
        "allowGroupMessages": false,
        "allowThreadMessages": false,
        "dmPolicy": "sample",
        "groupPolicy": "sample",
        "allowTextCommandsWithoutMention": false,
        "allowlistUserIds": [
          "sample"
        ],
        "allowlistChannelIds": [
          "sample"
        ],
        "allowlistGroupIds": [
          "sample"
        ],
        "allowedCommands": [
          "sample"
        ],
        "groupPolicies": [
          {
            "id": "sample",
            "label": "sample",
            "groupId": "sample",
            "channelId": "sample",
            "workspaceId": "sample",
            "requireMention": false,
            "allowGroupMessages": false,
            "allowThreadMessages": false,
            "allowTextCommandsWithoutMention": false,
            "allowlistUserIds": [
              "sample"
            ],
            "allowlistChannelIds": [
              "sample"
            ],
            "allowlistGroupIds": [
              "sample"
            ],
            "allowedCommands": [
              "sample"
            ],
            "metadata": {}
          }
        ],
        "updatedAt": 0,
        "metadata": {}
      },
      "resolution": {
        "surface": "sample",
        "resolved": [
          {
            "kind": "sample",
            "input": "sample",
            "id": "sample",
            "label": "sample",
            "metadata": {}
          }
        ],
        "unresolved": [
          "sample"
        ],
        "metadata": {}
      },
      "metadata": {}
    }
  },
  "channels.allowlist.resolve": {
    "methodId": "channels.allowlist.resolve",
    "http": {
      "method": "POST",
      "path": "/api/channels/allowlist/{surface}/resolve"
    },
    "status": 200,
    "body": {
      "surface": "sample",
      "resolved": [
        {
          "kind": "sample",
          "input": "sample",
          "id": "sample",
          "label": "sample",
          "metadata": {}
        }
      ],
      "unresolved": [
        "sample"
      ],
      "metadata": {}
    }
  },
  "channels.authorize": {
    "methodId": "channels.authorize",
    "http": {
      "method": "POST",
      "path": "/api/channels/authorize/{surface}"
    },
    "status": 200,
    "body": {
      "surface": "sample",
      "result": {
        "allowed": false,
        "reason": "sample",
        "account": {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "enabled": false,
          "configured": false,
          "linked": false,
          "state": "sample",
          "authState": "sample",
          "accountId": "sample",
          "workspaceId": "sample",
          "secrets": [
            {
              "field": "sample",
              "label": "sample",
              "configured": false,
              "source": "sample"
            }
          ],
          "actions": [
            {
              "id": "sample",
              "label": "sample",
              "kind": "sample",
              "available": false
            }
          ],
          "metadata": {}
        },
        "actionAvailable": false,
        "metadata": {}
      }
    }
  },
  "channels.capabilities.list": {
    "methodId": "channels.capabilities.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/capabilities"
    },
    "status": 200,
    "body": {
      "capabilities": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "scope": "sample",
          "supported": false,
          "detail": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "channels.capabilities.surface.list": {
    "methodId": "channels.capabilities.surface.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/capabilities/{surface}"
    },
    "status": 200,
    "body": {
      "capabilities": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "scope": "sample",
          "supported": false,
          "detail": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "channels.directory.query": {
    "methodId": "channels.directory.query",
    "http": {
      "method": "GET",
      "path": "/api/channels/directory/{surface}"
    },
    "status": 200,
    "body": {
      "entries": [
        {
          "id": "sample",
          "surface": "sample",
          "kind": "sample",
          "label": "sample",
          "handle": "sample",
          "accountId": "sample",
          "workspaceId": "sample",
          "groupId": "sample",
          "threadId": "sample",
          "parentId": "sample",
          "memberCount": 0,
          "memberIds": [
            "sample"
          ],
          "aliases": [
            "sample"
          ],
          "isSelf": false,
          "isDirect": false,
          "isGroupConversation": false,
          "searchText": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "channels.doctor.get": {
    "methodId": "channels.doctor.get",
    "http": {
      "method": "GET",
      "path": "/api/channels/doctor/{surface}"
    },
    "status": 200,
    "body": {
      "surface": "sample",
      "accountId": "sample",
      "state": "sample",
      "summary": "sample",
      "checkedAt": 0,
      "checks": [
        {
          "id": "sample",
          "label": "sample",
          "status": "sample",
          "detail": "sample",
          "repairActionId": "sample",
          "metadata": {}
        }
      ],
      "repairActions": [
        {
          "id": "sample",
          "label": "sample",
          "description": "sample",
          "dangerous": false,
          "inputSchema": {},
          "metadata": {}
        }
      ],
      "metadata": {}
    }
  },
  "channels.drafts.delete": {
    "methodId": "channels.drafts.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/channels/drafts/{draftId}"
    },
    "status": 200,
    "body": {
      "deleted": false,
      "draftId": "sample"
    }
  },
  "channels.drafts.get": {
    "methodId": "channels.drafts.get",
    "http": {
      "method": "GET",
      "path": "/api/channels/drafts/{draftId}"
    },
    "status": 200,
    "body": {
      "version": 0,
      "id": "sample",
      "createdAt": "sample",
      "updatedAt": "sample",
      "status": "sample",
      "title": "sample",
      "message": "sample",
      "channel": "sample",
      "route": "sample",
      "webhook": "sample",
      "link": "sample",
      "tags": [
        "sample"
      ],
      "sentResponseId": "sample",
      "sendError": "sample",
      "notFound": false
    }
  },
  "channels.drafts.list": {
    "methodId": "channels.drafts.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/drafts"
    },
    "status": 200,
    "body": {
      "drafts": [
        {
          "version": 0,
          "id": "sample",
          "createdAt": "sample",
          "updatedAt": "sample",
          "status": "sample",
          "title": "sample",
          "message": "sample",
          "channel": "sample",
          "route": "sample",
          "webhook": "sample",
          "link": "sample",
          "tags": [
            "sample"
          ],
          "sentResponseId": "sample",
          "sendError": "sample"
        }
      ],
      "total": 0
    }
  },
  "channels.drafts.save": {
    "methodId": "channels.drafts.save",
    "http": {
      "method": "POST",
      "path": "/api/channels/drafts"
    },
    "status": 200,
    "body": {
      "draft": {
        "version": 0,
        "id": "sample",
        "createdAt": "sample",
        "updatedAt": "sample",
        "status": "sample",
        "title": "sample",
        "message": "sample",
        "channel": "sample",
        "route": "sample",
        "webhook": "sample",
        "link": "sample",
        "tags": [
          "sample"
        ],
        "sentResponseId": "sample",
        "sendError": "sample"
      },
      "created": false
    }
  },
  "channels.inbox.list": {
    "methodId": "channels.inbox.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/inbox"
    },
    "status": 200,
    "body": {
      "items": [
        {
          "id": "sample",
          "provider": "sample",
          "kind": "sample",
          "from": "sample",
          "fromAddress": "sample",
          "subject": "sample",
          "bodyPreview": "sample",
          "receivedAt": 0,
          "unread": false,
          "routeId": "sample",
          "threadId": "sample",
          "attachmentCount": 0
        }
      ],
      "total": 0,
      "truncated": false,
      "cursor": "sample"
    }
  },
  "channels.lifecycle.get": {
    "methodId": "channels.lifecycle.get",
    "http": {
      "method": "GET",
      "path": "/api/channels/lifecycle/{surface}"
    },
    "status": 200,
    "body": {
      "surface": "sample",
      "accountId": "sample",
      "currentVersion": 0,
      "targetVersion": 0,
      "metadata": {}
    }
  },
  "channels.policies.audit": {
    "methodId": "channels.policies.audit",
    "http": {
      "method": "GET",
      "path": "/api/channels/policies/audit"
    },
    "status": 200,
    "body": {
      "audit": [
        {
          "id": "sample",
          "surface": "sample",
          "createdAt": 0,
          "allowed": false,
          "reason": "sample",
          "userId": "sample",
          "channelId": "sample",
          "groupId": "sample",
          "threadId": "sample",
          "conversationKind": "sample",
          "matchedGroupPolicyId": "sample",
          "text": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "channels.policies.list": {
    "methodId": "channels.policies.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/policies"
    },
    "status": 200,
    "body": {
      "policies": [
        {
          "surface": "sample",
          "enabled": false,
          "requireMention": false,
          "allowDirectMessages": false,
          "allowGroupMessages": false,
          "allowThreadMessages": false,
          "dmPolicy": "sample",
          "groupPolicy": "sample",
          "allowTextCommandsWithoutMention": false,
          "allowlistUserIds": [
            "sample"
          ],
          "allowlistChannelIds": [
            "sample"
          ],
          "allowlistGroupIds": [
            "sample"
          ],
          "allowedCommands": [
            "sample"
          ],
          "groupPolicies": [
            {
              "id": "sample",
              "label": "sample",
              "groupId": "sample",
              "channelId": "sample",
              "workspaceId": "sample",
              "requireMention": false,
              "allowGroupMessages": false,
              "allowThreadMessages": false,
              "allowTextCommandsWithoutMention": false,
              "allowlistUserIds": [
                "sample"
              ],
              "allowlistChannelIds": [
                "sample"
              ],
              "allowlistGroupIds": [
                "sample"
              ],
              "allowedCommands": [
                "sample"
              ],
              "metadata": {}
            }
          ],
          "updatedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "channels.policies.update": {
    "methodId": "channels.policies.update",
    "http": {
      "method": "POST",
      "path": "/api/channels/policies/{surface}"
    },
    "status": 200,
    "body": {
      "surface": "sample",
      "enabled": false,
      "requireMention": false,
      "allowDirectMessages": false,
      "allowGroupMessages": false,
      "allowThreadMessages": false,
      "dmPolicy": "sample",
      "groupPolicy": "sample",
      "allowTextCommandsWithoutMention": false,
      "allowlistUserIds": [
        "sample"
      ],
      "allowlistChannelIds": [
        "sample"
      ],
      "allowlistGroupIds": [
        "sample"
      ],
      "allowedCommands": [
        "sample"
      ],
      "groupPolicies": [
        {
          "id": "sample",
          "label": "sample",
          "groupId": "sample",
          "channelId": "sample",
          "workspaceId": "sample",
          "requireMention": false,
          "allowGroupMessages": false,
          "allowThreadMessages": false,
          "allowTextCommandsWithoutMention": false,
          "allowlistUserIds": [
            "sample"
          ],
          "allowlistChannelIds": [
            "sample"
          ],
          "allowlistGroupIds": [
            "sample"
          ],
          "allowedCommands": [
            "sample"
          ],
          "metadata": {}
        }
      ],
      "updatedAt": 0,
      "metadata": {}
    }
  },
  "channels.profiles.delete": {
    "methodId": "channels.profiles.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/channels/profiles/{surfaceKind}"
    },
    "status": 200,
    "body": {
      "surfaceKind": "sample",
      "channelId": "sample",
      "deleted": false
    }
  },
  "channels.profiles.get": {
    "methodId": "channels.profiles.get",
    "http": {
      "method": "GET",
      "path": "/api/channels/profiles/{surfaceKind}"
    },
    "status": 200,
    "body": {
      "binding": {
        "id": "sample",
        "surfaceKind": "sample",
        "channelId": "sample",
        "model": "sample",
        "provider": "sample",
        "permissionMode": "plan",
        "updatedAt": 0,
        "metadata": {}
      }
    }
  },
  "channels.profiles.list": {
    "methodId": "channels.profiles.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/profiles"
    },
    "status": 200,
    "body": {
      "bindings": [
        {
          "id": "sample",
          "surfaceKind": "sample",
          "channelId": "sample",
          "model": "sample",
          "provider": "sample",
          "permissionMode": "plan",
          "updatedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "channels.profiles.set": {
    "methodId": "channels.profiles.set",
    "http": {
      "method": "POST",
      "path": "/api/channels/profiles"
    },
    "status": 200,
    "body": {
      "binding": {
        "id": "sample",
        "surfaceKind": "sample",
        "channelId": "sample",
        "model": "sample",
        "provider": "sample",
        "permissionMode": "plan",
        "updatedAt": 0,
        "metadata": {}
      }
    }
  },
  "channels.repairs.list": {
    "methodId": "channels.repairs.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/repair-actions/{surface}"
    },
    "status": 200,
    "body": {
      "actions": [
        {
          "id": "sample",
          "label": "sample",
          "description": "sample",
          "dangerous": false,
          "inputSchema": {},
          "metadata": {}
        }
      ]
    }
  },
  "channels.routing.assign": {
    "methodId": "channels.routing.assign",
    "http": {
      "method": "POST",
      "path": "/api/channels/routing"
    },
    "status": 200,
    "body": {
      "assignmentId": "sample",
      "channelId": "sample",
      "surfaceKind": "sample",
      "routeId": "sample",
      "profileId": "sample",
      "label": "sample",
      "createdAt": "sample",
      "updatedAt": "sample"
    }
  },
  "channels.routing.delete": {
    "methodId": "channels.routing.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/channels/routing/{assignmentId}"
    },
    "status": 200,
    "body": {
      "deleted": false,
      "assignmentId": "sample"
    }
  },
  "channels.routing.list": {
    "methodId": "channels.routing.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/routing"
    },
    "status": 200,
    "body": {
      "routes": [
        {
          "id": "sample",
          "createdAt": "sample",
          "updatedAt": "sample",
          "surfaceKind": "sample",
          "routeId": "sample",
          "profileId": "sample",
          "label": "sample"
        }
      ],
      "total": 0
    }
  },
  "channels.setup.get": {
    "methodId": "channels.setup.get",
    "http": {
      "method": "GET",
      "path": "/api/channels/setup/{surface}"
    },
    "status": 200,
    "body": {
      "surface": "sample",
      "version": 0,
      "label": "sample",
      "setupMode": "sample",
      "description": "sample",
      "fields": [
        {
          "id": "sample",
          "label": "sample",
          "kind": "sample",
          "required": false,
          "detail": "sample",
          "placeholder": "sample",
          "configKey": "sample",
          "secretTargetId": "sample",
          "defaultValue": "sample",
          "options": [
            {
              "value": "sample",
              "label": "sample"
            }
          ],
          "metadata": {}
        }
      ],
      "secretTargets": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "required": false,
          "supports": [
            "sample"
          ],
          "serviceName": "sample",
          "serviceField": "sample",
          "envKeys": [
            "sample"
          ],
          "configKeys": [
            "sample"
          ],
          "detail": "sample",
          "metadata": {}
        }
      ],
      "externalSteps": [
        "sample"
      ],
      "metadata": {}
    }
  },
  "channels.status": {
    "methodId": "channels.status",
    "http": {
      "method": "GET",
      "path": "/api/channels/status"
    },
    "status": 200,
    "body": {
      "channels": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "state": "sample",
          "enabled": false,
          "accountId": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "channels.targets.resolve": {
    "methodId": "channels.targets.resolve",
    "http": {
      "method": "POST",
      "path": "/api/channels/targets/{surface}/resolve"
    },
    "status": 200,
    "body": {
      "surface": "sample",
      "target": {
        "surface": "sample",
        "input": "sample",
        "normalized": "sample",
        "kind": "sample",
        "to": "sample",
        "display": "sample",
        "accountId": "sample",
        "workspaceId": "sample",
        "channelId": "sample",
        "groupId": "sample",
        "threadId": "sample",
        "parentId": "sample",
        "sessionId": "sample",
        "sessionTarget": "sample",
        "bindingId": "sample",
        "directoryEntryId": "sample",
        "source": "sample",
        "metadata": {}
      }
    }
  },
  "channels.test.send": {
    "methodId": "channels.test.send",
    "http": null,
    "status": 200,
    "body": {
      "surface": "sample",
      "delivered": false,
      "responseId": "sample",
      "address": "sample",
      "error": "sample"
    }
  },
  "channels.tools.invoke": {
    "methodId": "channels.tools.invoke",
    "http": {
      "method": "POST",
      "path": "/api/channels/tools/{surface}/{toolId}"
    },
    "status": 200,
    "body": {
      "toolId": "sample",
      "surface": "sample",
      "result": {}
    }
  },
  "channels.tools.list": {
    "methodId": "channels.tools.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/tools"
    },
    "status": 200,
    "body": {
      "tools": [
        {
          "id": "sample",
          "surface": "sample",
          "name": "sample",
          "description": "sample",
          "actionIds": [
            "sample"
          ],
          "inputSchema": {},
          "metadata": {}
        }
      ]
    }
  },
  "channels.tools.surface.list": {
    "methodId": "channels.tools.surface.list",
    "http": {
      "method": "GET",
      "path": "/api/channels/tools/{surface}"
    },
    "status": 200,
    "body": {
      "tools": [
        {
          "id": "sample",
          "surface": "sample",
          "name": "sample",
          "description": "sample",
          "actionIds": [
            "sample"
          ],
          "inputSchema": {},
          "metadata": {}
        }
      ]
    }
  },
  "checkin.config.get": {
    "methodId": "checkin.config.get",
    "http": {
      "method": "GET",
      "path": "/api/checkin/config"
    },
    "status": 200,
    "body": {
      "config": {
        "enabled": false,
        "cadence": "sample",
        "deliveryChannel": "sample",
        "quietHours": "sample"
      }
    }
  },
  "checkin.config.set": {
    "methodId": "checkin.config.set",
    "http": {
      "method": "POST",
      "path": "/api/checkin/config"
    },
    "status": 200,
    "body": {
      "config": {
        "enabled": false,
        "cadence": "sample",
        "deliveryChannel": "sample",
        "quietHours": "sample"
      }
    }
  },
  "checkin.receipts.list": {
    "methodId": "checkin.receipts.list",
    "http": {
      "method": "GET",
      "path": "/api/checkin/receipts"
    },
    "status": 200,
    "body": {
      "receipts": [
        {
          "id": "sample",
          "ranAt": 0,
          "trigger": "scheduled",
          "outcome": "delivered",
          "briefingSummary": "sample",
          "decisionReason": "sample",
          "deliveredMessage": "sample",
          "deliveryChannel": "sample",
          "deliveryId": "sample",
          "error": "sample"
        }
      ]
    }
  },
  "checkin.run": {
    "methodId": "checkin.run",
    "http": {
      "method": "POST",
      "path": "/api/checkin/run"
    },
    "status": 200,
    "body": {
      "outcome": "delivered",
      "summary": "sample",
      "deliveryId": "sample"
    }
  },
  "checkpoints.create": {
    "methodId": "checkpoints.create",
    "http": null,
    "status": 200,
    "body": {
      "checkpoint": {
        "id": "sample",
        "kind": "turn",
        "label": "sample",
        "createdAt": 0,
        "parentId": "sample",
        "turnId": "sample",
        "agentId": "sample",
        "sessionId": "sample",
        "retentionClass": "short",
        "commit": "sample",
        "sizeBytes": 0
      },
      "noop": false
    }
  },
  "checkpoints.diff": {
    "methodId": "checkpoints.diff",
    "http": null,
    "status": 200,
    "body": {
      "diff": {
        "from": "sample",
        "to": "sample",
        "files": [
          "sample"
        ],
        "unifiedDiff": "sample",
        "stat": "sample"
      }
    }
  },
  "checkpoints.list": {
    "methodId": "checkpoints.list",
    "http": null,
    "status": 200,
    "body": {
      "checkpoints": [
        {
          "id": "sample",
          "kind": "turn",
          "label": "sample",
          "createdAt": 0,
          "parentId": "sample",
          "turnId": "sample",
          "agentId": "sample",
          "sessionId": "sample",
          "retentionClass": "short",
          "commit": "sample",
          "sizeBytes": 0
        }
      ]
    }
  },
  "checkpoints.restore": {
    "methodId": "checkpoints.restore",
    "http": null,
    "status": 200,
    "body": {
      "result": {
        "checkpointId": "sample",
        "safetyCheckpointId": "sample",
        "restoredFiles": [
          "sample"
        ],
        "removedFiles": [
          "sample"
        ]
      },
      "refused": false,
      "refusal": {
        "reason": "sample",
        "confirmField": "sample",
        "previewMethod": "sample",
        "options": [
          "sample"
        ]
      }
    }
  },
  "checkpoints.restorePreview": {
    "methodId": "checkpoints.restorePreview",
    "http": null,
    "status": 200,
    "body": {
      "token": "sample",
      "expiresAt": 0,
      "preview": {
        "checkpointId": "sample",
        "label": "sample",
        "affectedPathCount": 0,
        "affectedPathSample": [
          "sample"
        ],
        "stat": "sample"
      }
    }
  },
  "checkpoints.revertHunk": {
    "methodId": "checkpoints.revertHunk",
    "http": null,
    "status": 200,
    "body": {
      "receipt": {
        "reverted": false,
        "path": "sample",
        "hunkHeader": "sample",
        "addedLinesRemoved": 0,
        "removedLinesRestored": 0,
        "safetyCheckpointId": "sample",
        "undo": {
          "restoreCheckpointId": "sample"
        }
      },
      "refused": false,
      "refusal": {
        "reason": "sample",
        "confirmField": "sample",
        "previewMethod": "sample",
        "options": [
          "sample"
        ]
      }
    }
  },
  "checkpoints.revertHunkPreview": {
    "methodId": "checkpoints.revertHunkPreview",
    "http": null,
    "status": 200,
    "body": {
      "path": "sample",
      "applies": false,
      "conflict": "sample",
      "hunkHeader": "sample",
      "addedLinesRemoved": 0,
      "removedLinesRestored": 0,
      "matchedAtLine": 0,
      "token": "sample",
      "expiresAt": 0
    }
  },
  "ci.status": {
    "methodId": "ci.status",
    "http": {
      "method": "POST",
      "path": "/api/ci/status"
    },
    "status": 200,
    "body": {
      "report": {
        "repo": "sample",
        "ref": "sample",
        "prNumber": 0,
        "overall": "passed",
        "jobs": [
          {
            "name": "sample",
            "status": "queued",
            "conclusion": "sample",
            "continueOnError": false,
            "url": "sample"
          }
        ],
        "violations": [
          "sample"
        ],
        "checkedAt": 0
      }
    }
  },
  "ci.watches.create": {
    "methodId": "ci.watches.create",
    "http": {
      "method": "POST",
      "path": "/api/ci/watches"
    },
    "status": 200,
    "body": {
      "watch": {
        "id": "sample",
        "repo": "sample",
        "ref": "sample",
        "prNumber": 0,
        "deliveryChannel": "sample",
        "triggerFixSession": false,
        "lastOverall": "passed",
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "ci.watches.delete": {
    "methodId": "ci.watches.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/ci/watches/{watchId}"
    },
    "status": 200,
    "body": {
      "watchId": "sample",
      "deleted": false
    }
  },
  "ci.watches.list": {
    "methodId": "ci.watches.list",
    "http": {
      "method": "GET",
      "path": "/api/ci/watches"
    },
    "status": 200,
    "body": {
      "watches": [
        {
          "id": "sample",
          "repo": "sample",
          "ref": "sample",
          "prNumber": 0,
          "deliveryChannel": "sample",
          "triggerFixSession": false,
          "lastOverall": "passed",
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "ci.watches.run": {
    "methodId": "ci.watches.run",
    "http": {
      "method": "POST",
      "path": "/api/ci/watches/{watchId}/run"
    },
    "status": 200,
    "body": {
      "report": {
        "repo": "sample",
        "ref": "sample",
        "prNumber": 0,
        "overall": "passed",
        "jobs": [
          {
            "name": "sample",
            "status": "queued",
            "conclusion": "sample",
            "continueOnError": false,
            "url": "sample"
          }
        ],
        "violations": [
          "sample"
        ],
        "checkedAt": 0
      },
      "notified": false,
      "notificationId": "sample",
      "fixSessionTriggered": false,
      "fixSessionId": "sample"
    }
  },
  "companion.chat.events.stream": {
    "methodId": "companion.chat.events.stream",
    "http": {
      "method": "GET",
      "path": "/api/companion/chat/sessions/{sessionId}/events"
    },
    "status": 200,
    "body": {}
  },
  "companion.chat.messages.create": {
    "methodId": "companion.chat.messages.create",
    "http": {
      "method": "POST",
      "path": "/api/companion/chat/sessions/{sessionId}/messages"
    },
    "status": 200,
    "body": {
      "messageId": "sample"
    }
  },
  "companion.chat.messages.edit": {
    "methodId": "companion.chat.messages.edit",
    "http": {
      "method": "POST",
      "path": "/api/companion/chat/sessions/{sessionId}/messages/edit"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "editedFrom": "sample",
      "messageId": "sample",
      "supersededMessageIds": [
        "sample"
      ],
      "turnStarted": false
    }
  },
  "companion.chat.messages.list": {
    "methodId": "companion.chat.messages.list",
    "http": {
      "method": "GET",
      "path": "/api/companion/chat/sessions/{sessionId}/messages"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "messages": [
        {
          "id": "sample",
          "sessionId": "sample",
          "role": "user",
          "content": "sample",
          "attachments": [
            {
              "id": "sample",
              "artifactId": "sample",
              "kind": "sample",
              "mimeType": "sample",
              "filename": "sample",
              "sizeBytes": 0,
              "sha256": "sample",
              "createdAt": 0,
              "expiresAt": 0,
              "sourceUri": "sample",
              "acquisitionMode": "sample",
              "fetchMode": "sample",
              "label": "sample",
              "metadata": {}
            }
          ],
          "createdAt": 0,
          "deliveryState": "cancelled",
          "inReplyTo": "sample"
        }
      ]
    }
  },
  "companion.chat.messages.retry": {
    "methodId": "companion.chat.messages.retry",
    "http": {
      "method": "POST",
      "path": "/api/companion/chat/sessions/{sessionId}/messages/retry"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "regeneratedFrom": "sample",
      "supersededMessageIds": [
        "sample"
      ],
      "turnStarted": false
    }
  },
  "companion.chat.messages.steer": {
    "methodId": "companion.chat.messages.steer",
    "http": {
      "method": "POST",
      "path": "/api/companion/chat/sessions/{sessionId}/messages/steer"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "messageId": "sample",
      "steered": false,
      "cancelledTurnId": "sample",
      "turnStarted": false
    }
  },
  "companion.chat.sessions.close": {
    "methodId": "companion.chat.sessions.close",
    "http": {
      "method": "POST",
      "path": "/api/companion/chat/sessions/{sessionId}/close"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "status": "sample"
    }
  },
  "companion.chat.sessions.create": {
    "methodId": "companion.chat.sessions.create",
    "http": {
      "method": "POST",
      "path": "/api/companion/chat/sessions"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "createdAt": 0,
      "session": {
        "id": "sample",
        "kind": "companion-chat",
        "title": "sample",
        "model": "sample",
        "provider": "sample",
        "systemPrompt": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "closedAt": 0,
        "messageCount": 0
      }
    }
  },
  "companion.chat.sessions.delete": {
    "methodId": "companion.chat.sessions.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/companion/chat/sessions/{sessionId}"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "deleted": false
    }
  },
  "companion.chat.sessions.get": {
    "methodId": "companion.chat.sessions.get",
    "http": {
      "method": "GET",
      "path": "/api/companion/chat/sessions/{sessionId}"
    },
    "status": 200,
    "body": {
      "session": {
        "id": "sample",
        "kind": "companion-chat",
        "title": "sample",
        "model": "sample",
        "provider": "sample",
        "systemPrompt": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "closedAt": 0,
        "messageCount": 0
      },
      "messages": [
        {
          "id": "sample",
          "sessionId": "sample",
          "role": "user",
          "content": "sample",
          "attachments": [
            {
              "id": "sample",
              "artifactId": "sample",
              "kind": "sample",
              "mimeType": "sample",
              "filename": "sample",
              "sizeBytes": 0,
              "sha256": "sample",
              "createdAt": 0,
              "expiresAt": 0,
              "sourceUri": "sample",
              "acquisitionMode": "sample",
              "fetchMode": "sample",
              "label": "sample",
              "metadata": {}
            }
          ],
          "createdAt": 0,
          "deliveryState": "cancelled",
          "inReplyTo": "sample"
        }
      ]
    }
  },
  "companion.chat.sessions.list": {
    "methodId": "companion.chat.sessions.list",
    "http": {
      "method": "GET",
      "path": "/api/companion/chat/sessions"
    },
    "status": 200,
    "body": {
      "sessions": [
        {
          "id": "sample",
          "kind": "companion-chat",
          "title": "sample",
          "model": "sample",
          "provider": "sample",
          "systemPrompt": "sample",
          "status": "active",
          "createdAt": 0,
          "updatedAt": 0,
          "closedAt": 0,
          "messageCount": 0
        }
      ],
      "totals": {
        "sessions": 0,
        "active": 0,
        "closed": 0
      }
    }
  },
  "companion.chat.sessions.update": {
    "methodId": "companion.chat.sessions.update",
    "http": {
      "method": "PATCH",
      "path": "/api/companion/chat/sessions/{sessionId}"
    },
    "status": 200,
    "body": {
      "session": {
        "id": "sample",
        "kind": "companion-chat",
        "title": "sample",
        "model": "sample",
        "provider": "sample",
        "systemPrompt": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "closedAt": 0,
        "messageCount": 0
      }
    }
  },
  "companion.chat.turns.cancel": {
    "methodId": "companion.chat.turns.cancel",
    "http": {
      "method": "POST",
      "path": "/api/companion/chat/sessions/{sessionId}/turns/cancel"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "turnId": "sample",
      "cancelled": false,
      "alreadyCancelled": false,
      "partialPersisted": false
    }
  },
  "config.get": {
    "methodId": "config.get",
    "http": {
      "method": "GET",
      "path": "/config"
    },
    "status": 200,
    "body": {
      "danger": {},
      "controlPlane": {},
      "web": {},
      "network": {},
      "service": {},
      "providers": {},
      "ui": {},
      "channels": {},
      "watchers": {},
      "memory": {}
    }
  },
  "config.set": {
    "methodId": "config.set",
    "http": {
      "method": "POST",
      "path": "/config"
    },
    "status": 200,
    "body": {
      "success": false,
      "key": "sample",
      "value": "sample"
    }
  },
  "credentials.get": {
    "methodId": "credentials.get",
    "http": {
      "method": "GET",
      "path": "/config/credentials"
    },
    "status": 200,
    "body": {
      "available": false,
      "credentials": [
        {
          "key": "sample",
          "configured": false,
          "usable": false,
          "source": "sample",
          "scope": "sample",
          "secure": false,
          "overriddenByEnv": false,
          "refSource": "sample"
        }
      ]
    }
  },
  "continuity.snapshot": {
    "methodId": "continuity.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/continuity"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "status": "sample",
      "recoveryState": "sample",
      "lastSessionPointer": "sample",
      "recoveryFilePresent": false,
      "recoveryFile": {
        "title": "sample",
        "timestamp": 0,
        "sessionId": "sample",
        "returnContext": {
          "activityLabel": "sample",
          "statusLabel": "sample",
          "lastUserPrompt": "sample",
          "lastAssistantReply": "sample",
          "pendingApprovals": 0,
          "toolCallCount": 0,
          "toolResultCount": 0,
          "assistantTurnCount": 0,
          "userTurnCount": 0,
          "lastRole": "sample",
          "activeTasks": 0,
          "blockedTasks": 0,
          "remoteContracts": 0,
          "remoteRunners": [
            "sample"
          ],
          "worktreeCount": 0,
          "worktreePaths": [
            "sample"
          ],
          "openPanels": [
            "sample"
          ],
          "lines": [
            "sample"
          ],
          "assistedNarrative": "sample"
        }
      }
    }
  },
  "control.auth.current": {
    "methodId": "control.auth.current",
    "http": {
      "method": "GET",
      "path": "/api/control-plane/auth"
    },
    "status": 200,
    "body": {
      "authenticated": false,
      "authMode": "anonymous",
      "tokenPresent": false,
      "authorizationHeaderPresent": false,
      "sessionCookiePresent": false,
      "principalId": "sample",
      "principalKind": "user",
      "admin": false,
      "scopes": [
        "sample"
      ],
      "roles": [
        "sample"
      ]
    }
  },
  "control.auth.login": {
    "methodId": "control.auth.login",
    "http": {
      "method": "POST",
      "path": "/login"
    },
    "status": 200,
    "body": {
      "authenticated": false,
      "token": "sample",
      "username": "sample",
      "expiresAt": 0
    }
  },
  "control.clients.list": {
    "methodId": "control.clients.list",
    "http": {
      "method": "GET",
      "path": "/api/control-plane/clients"
    },
    "status": 200,
    "body": {
      "clients": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "connectedAt": 0,
          "lastSeenAt": 0,
          "userId": "sample"
        }
      ]
    }
  },
  "control.contract": {
    "methodId": "control.contract",
    "http": {
      "method": "GET",
      "path": "/api/control-plane/contract"
    },
    "status": 200,
    "body": {
      "contract": {
        "version": 0,
        "product": {
          "id": "sample",
          "surface": "sample",
          "version": "sample"
        },
        "auth": {
          "modes": [
            "sample"
          ],
          "login": {
            "method": "sample",
            "path": "sample",
            "requestSchema": {
              "username": "sample",
              "password": "sample"
            },
            "responseSchema": {
              "authenticated": false,
              "token": "sample",
              "username": "sample",
              "expiresAt": 0
            }
          },
          "current": {
            "method": "sample",
            "path": "sample",
            "aliasPaths": [
              "sample"
            ],
            "responseSchema": {
              "authenticated": false,
              "authMode": "anonymous",
              "tokenPresent": false,
              "authorizationHeaderPresent": false,
              "sessionCookiePresent": false,
              "principalId": "sample",
              "principalKind": "user",
              "admin": false,
              "scopes": [
                "sample"
              ],
              "roles": [
                "sample"
              ]
            }
          },
          "sessionCookie": {
            "name": "sample",
            "httpOnly": false,
            "sameSite": "sample",
            "path": "sample"
          },
          "bearer": {
            "header": "sample",
            "queryParameters": [
              "sample"
            ]
          }
        },
        "transports": {
          "http": {
            "statusPath": "sample",
            "methodsPath": "sample",
            "eventsCatalogPath": "sample"
          },
          "sse": {
            "path": "sample",
            "query": {
              "domains": "sample"
            }
          },
          "websocket": {
            "path": "sample",
            "clientFrames": [
              {
                "type": "sample",
                "fields": [
                  "sample"
                ]
              }
            ],
            "serverFrames": [
              {
                "type": "sample",
                "fields": [
                  "sample"
                ]
              }
            ]
          }
        },
        "operator": {
          "methods": [
            {
              "id": "sample",
              "title": "sample",
              "description": "sample",
              "category": "sample",
              "source": "sample",
              "access": "sample",
              "transport": [
                "sample"
              ],
              "scopes": [
                "sample"
              ],
              "http": {
                "method": "sample",
                "path": "sample"
              },
              "events": [
                "sample"
              ],
              "inputSchema": {},
              "outputSchema": {},
              "pluginId": "sample",
              "dangerous": false,
              "invokable": false,
              "metadata": {}
            }
          ],
          "events": [
            {
              "id": "sample",
              "title": "sample",
              "description": "sample",
              "category": "sample",
              "source": "sample",
              "transport": [
                "sample"
              ],
              "scopes": [
                "sample"
              ],
              "domains": [
                "sample"
              ],
              "wireEvents": [
                "sample"
              ],
              "outputSchema": {},
              "pluginId": "sample",
              "metadata": {}
            }
          ],
          "schemaCoverage": {
            "methods": 0,
            "typedInputs": 0,
            "genericInputs": 0,
            "typedOutputs": 0,
            "genericOutputs": 0
          },
          "eventCoverage": {
            "events": 0,
            "withDomains": 0,
            "withWireEvents": 0
          },
          "validationCoverage": {
            "methods": 0,
            "validated": 0,
            "skippedGeneric": 0,
            "skippedUntyped": 0
          }
        },
        "peer": {
          "contractPath": "sample",
          "relationship": "sample"
        }
      }
    }
  },
  "control.events.catalog": {
    "methodId": "control.events.catalog",
    "http": {
      "method": "GET",
      "path": "/api/control-plane/events/catalog"
    },
    "status": 200,
    "body": {
      "events": [
        {
          "id": "sample",
          "title": "sample",
          "description": "sample",
          "category": "sample",
          "source": "sample",
          "transport": [
            "sample"
          ],
          "scopes": [
            "sample"
          ],
          "domains": [
            "sample"
          ],
          "wireEvents": [
            "sample"
          ],
          "outputSchema": {},
          "pluginId": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "control.events.stream": {
    "methodId": "control.events.stream",
    "http": {
      "method": "GET",
      "path": "/api/control-plane/events"
    },
    "status": 200,
    "body": {
      "contentType": "sample",
      "mode": "sample"
    }
  },
  "control.messages.list": {
    "methodId": "control.messages.list",
    "http": {
      "method": "GET",
      "path": "/api/control-plane/messages"
    },
    "status": 200,
    "body": {
      "messages": [
        {
          "id": "sample",
          "surface": "sample",
          "createdAt": 0,
          "title": "sample",
          "body": "sample",
          "level": "info",
          "routeId": "sample",
          "surfaceId": "sample",
          "clientId": "sample",
          "attachments": [
            {
              "id": "sample",
              "artifactId": "sample",
              "kind": "sample",
              "mimeType": "sample",
              "filename": "sample",
              "sizeBytes": 0,
              "sha256": "sample",
              "createdAt": 0,
              "expiresAt": 0,
              "sourceUri": "sample",
              "acquisitionMode": "sample",
              "fetchMode": "sample",
              "contentPath": "sample",
              "contentUrl": "sample",
              "dataBase64": "sample",
              "label": "sample",
              "metadata": {}
            }
          ],
          "metadata": {}
        }
      ]
    }
  },
  "control.methods.get": {
    "methodId": "control.methods.get",
    "http": {
      "method": "GET",
      "path": "/api/control-plane/methods/{methodId}"
    },
    "status": 200,
    "body": {
      "method": {
        "id": "sample",
        "title": "sample",
        "description": "sample",
        "category": "sample",
        "source": "sample",
        "access": "sample",
        "transport": [
          "sample"
        ],
        "scopes": [
          "sample"
        ],
        "http": {
          "method": "sample",
          "path": "sample"
        },
        "events": [
          "sample"
        ],
        "inputSchema": {},
        "outputSchema": {},
        "pluginId": "sample",
        "dangerous": false,
        "invokable": false,
        "metadata": {}
      }
    }
  },
  "control.methods.list": {
    "methodId": "control.methods.list",
    "http": {
      "method": "GET",
      "path": "/api/control-plane/methods"
    },
    "status": 200,
    "body": {
      "methods": [
        {
          "id": "sample",
          "title": "sample",
          "description": "sample",
          "category": "sample",
          "source": "sample",
          "access": "sample",
          "transport": [
            "sample"
          ],
          "scopes": [
            "sample"
          ],
          "http": {
            "method": "sample",
            "path": "sample"
          },
          "events": [
            "sample"
          ],
          "inputSchema": {},
          "outputSchema": {},
          "pluginId": "sample",
          "dangerous": false,
          "invokable": false,
          "metadata": {}
        }
      ]
    }
  },
  "control.snapshot": {
    "methodId": "control.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/control-plane"
    },
    "status": 200,
    "body": {
      "server": {
        "enabled": false,
        "host": "sample",
        "port": 0,
        "baseUrl": "sample",
        "streamingMode": "sse",
        "sessionTtlMs": 0
      },
      "totals": {
        "clients": 0,
        "activeClients": 0,
        "surfaceMessages": 0,
        "recentEvents": 0,
        "requests": 0,
        "errors": 0
      },
      "clients": [
        {
          "id": "sample",
          "surface": "sample",
          "label": "sample",
          "connectedAt": 0,
          "lastSeenAt": 0,
          "userId": "sample"
        }
      ],
      "messages": [
        {
          "id": "sample",
          "surface": "sample",
          "createdAt": 0,
          "title": "sample",
          "body": "sample",
          "level": "info",
          "routeId": "sample",
          "surfaceId": "sample",
          "clientId": "sample",
          "attachments": [
            {
              "id": "sample",
              "artifactId": "sample",
              "kind": "sample",
              "mimeType": "sample",
              "filename": "sample",
              "sizeBytes": 0,
              "sha256": "sample",
              "createdAt": 0,
              "expiresAt": 0,
              "sourceUri": "sample",
              "acquisitionMode": "sample",
              "fetchMode": "sample",
              "contentPath": "sample",
              "contentUrl": "sample",
              "dataBase64": "sample",
              "label": "sample",
              "metadata": {}
            }
          ],
          "metadata": {}
        }
      ],
      "recentEvents": [
        {
          "id": "sample",
          "event": "sample",
          "createdAt": 0,
          "payload": "sample"
        }
      ]
    }
  },
  "control.status": {
    "methodId": "control.status",
    "http": {
      "method": "GET",
      "path": "/status"
    },
    "status": 200,
    "body": {
      "status": "sample",
      "version": "sample"
    }
  },
  "control.web": {
    "methodId": "control.web",
    "http": {
      "method": "GET",
      "path": "/api/control-plane/web"
    },
    "status": 200,
    "body": {
      "html": "sample"
    }
  },
  "cost.attribution.get": {
    "methodId": "cost.attribution.get",
    "http": null,
    "status": 200,
    "body": {
      "window": "24h",
      "windowStartMs": 0,
      "dimension": "agent",
      "totalCostUsd": 0,
      "costState": "priced",
      "pricedRecordCount": 0,
      "unpricedRecordCount": 0,
      "tokens": {
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0
      },
      "rows": [
        {
          "key": "sample",
          "costUsd": 0,
          "costState": "priced",
          "pricedRecordCount": 0,
          "unpricedRecordCount": 0,
          "tokens": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0
          }
        }
      ]
    }
  },
  "deliveries.get": {
    "methodId": "deliveries.get",
    "http": {
      "method": "GET",
      "path": "/api/deliveries/{deliveryId}"
    },
    "status": 200,
    "body": {
      "delivery": {
        "id": "sample",
        "runId": "sample",
        "jobId": "sample",
        "target": {
          "kind": "none",
          "surfaceKind": "tui",
          "address": "sample",
          "routeId": "sample",
          "label": "sample"
        },
        "status": "pending",
        "startedAt": 0,
        "endedAt": 0,
        "error": "sample",
        "responseId": "sample"
      }
    }
  },
  "deliveries.list": {
    "methodId": "deliveries.list",
    "http": {
      "method": "GET",
      "path": "/api/deliveries"
    },
    "status": 200,
    "body": {
      "totals": {
        "queued": 0,
        "started": 0,
        "succeeded": 0,
        "failed": 0,
        "deadLettered": 0
      },
      "attempts": [
        {
          "id": "sample",
          "runId": "sample",
          "jobId": "sample",
          "target": {
            "kind": "none",
            "surfaceKind": "tui",
            "address": "sample",
            "routeId": "sample",
            "label": "sample"
          },
          "status": "pending",
          "startedAt": 0,
          "endedAt": 0,
          "error": "sample",
          "responseId": "sample"
        }
      ]
    }
  },
  "email.draft.create": {
    "methodId": "email.draft.create",
    "http": {
      "method": "POST",
      "path": "/api/email/drafts"
    },
    "status": 200,
    "body": {
      "uid": 0,
      "draftId": "sample"
    }
  },
  "email.inbox.list": {
    "methodId": "email.inbox.list",
    "http": {
      "method": "GET",
      "path": "/api/email/inbox"
    },
    "status": 200,
    "body": {
      "messages": [
        {
          "uid": 0,
          "from": "sample",
          "subject": "sample",
          "date": "sample",
          "unread": false,
          "bodyPreview": "sample",
          "messageId": "sample"
        }
      ],
      "total": 0
    }
  },
  "email.inbox.read": {
    "methodId": "email.inbox.read",
    "http": {
      "method": "GET",
      "path": "/api/email/inbox/{uid}"
    },
    "status": 200,
    "body": {
      "uid": 0,
      "from": "sample",
      "subject": "sample",
      "date": "sample",
      "messageId": "sample",
      "bodyText": "sample",
      "bodyHtml": "sample",
      "attachments": [
        {
          "filename": "sample",
          "contentType": "sample",
          "sizeBytes": 0
        }
      ]
    }
  },
  "email.send": {
    "methodId": "email.send",
    "http": {
      "method": "POST",
      "path": "/api/email/send"
    },
    "status": 200,
    "body": {
      "messageId": "sample",
      "sentAt": "sample"
    }
  },
  "flags.graduation.report": {
    "methodId": "flags.graduation.report",
    "http": null,
    "status": 200,
    "body": {
      "generatedAt": 0,
      "entries": [
        {
          "flagId": "sample",
          "name": "sample",
          "tier": 0,
          "currentDefault": "enabled",
          "runtimeToggleable": false,
          "state": "dark",
          "evidence": {
            "instrumentation": "divergence-simulation",
            "divergence": {
              "divergenceRate": 0,
              "totalEvaluations": 0,
              "gateStatus": "allowed"
            },
            "note": "sample"
          },
          "blocker": {
            "reason": "sample",
            "date": "sample"
          },
          "note": "sample"
        }
      ],
      "summary": {
        "total": 0,
        "dark": 0,
        "soaking": 0,
        "graduateCandidate": 0,
        "graduated": 0,
        "blocked": 0
      },
      "releaseBlockers": [
        "sample"
      ]
    }
  },
  "fleet.archive": {
    "methodId": "fleet.archive",
    "http": null,
    "status": 200,
    "body": {
      "archived": false,
      "count": 0,
      "reason": "sample"
    }
  },
  "fleet.archived.list": {
    "methodId": "fleet.archived.list",
    "http": null,
    "status": 200,
    "body": {
      "capturedAt": 0,
      "nodes": [
        {
          "id": "sample",
          "kind": "agent",
          "parentId": "sample",
          "label": "sample",
          "task": "sample",
          "state": "thinking",
          "startedAt": 0,
          "completedAt": 0,
          "elapsedMs": 0,
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "llmCallCount": 0,
            "turnCount": 0,
            "toolCallCount": 0
          },
          "model": "sample",
          "provider": "sample",
          "costUsd": 0,
          "costState": "priced",
          "currentActivity": {
            "kind": "tool",
            "text": "sample",
            "toolName": "sample",
            "at": 0
          },
          "capabilities": {
            "interruptible": false,
            "killable": false,
            "pausable": false,
            "resumable": false,
            "steerable": false
          },
          "needsAttention": {
            "reason": "approval",
            "detail": "sample"
          },
          "sessionRef": {
            "sessionId": "sample",
            "agentId": "sample"
          }
        }
      ]
    }
  },
  "fleet.archiveFinished": {
    "methodId": "fleet.archiveFinished",
    "http": null,
    "status": 200,
    "body": {
      "archivedCount": 0
    }
  },
  "fleet.attempts.judge": {
    "methodId": "fleet.attempts.judge",
    "http": null,
    "status": 200,
    "body": {
      "proposedWinnerItemId": "sample",
      "reasons": [
        "sample"
      ],
      "model": "sample",
      "scoredBy": "model"
    }
  },
  "fleet.attempts.list": {
    "methodId": "fleet.attempts.list",
    "http": null,
    "status": 200,
    "body": {
      "groups": [
        {
          "groupId": "sample",
          "workstreamId": "sample",
          "sourceTitle": "sample",
          "ready": false,
          "candidates": [
            {
              "itemId": "sample",
              "attemptIndex": 0,
              "state": "held-merge",
              "title": "sample",
              "worktreePath": "sample",
              "branch": "sample",
              "usage": {
                "inputTokens": 0,
                "outputTokens": 0,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "reasoningTokens": 0,
                "llmCallCount": 0,
                "turnCount": 0,
                "toolCallCount": 0,
                "costUsd": 0,
                "costState": "priced"
              },
              "failureReason": "sample",
              "diff": {
                "files": [
                  "sample"
                ],
                "unifiedDiff": "sample",
                "stat": "sample"
              }
            }
          ],
          "autoAccept": false,
          "judgment": {
            "proposedWinnerItemId": "sample",
            "reasons": [
              "sample"
            ],
            "model": "sample",
            "scoredBy": "model"
          }
        }
      ]
    }
  },
  "fleet.attempts.pick": {
    "methodId": "fleet.attempts.pick",
    "http": null,
    "status": 200,
    "body": {
      "groupId": "sample",
      "winnerItemId": "sample",
      "loserItemIds": [
        "sample"
      ],
      "auto": false
    }
  },
  "fleet.list": {
    "methodId": "fleet.list",
    "http": null,
    "status": 200,
    "body": {
      "items": [
        {
          "id": "sample",
          "kind": "agent",
          "parentId": "sample",
          "label": "sample",
          "task": "sample",
          "state": "thinking",
          "startedAt": 0,
          "completedAt": 0,
          "elapsedMs": 0,
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "llmCallCount": 0,
            "turnCount": 0,
            "toolCallCount": 0
          },
          "model": "sample",
          "provider": "sample",
          "costUsd": 0,
          "costState": "priced",
          "currentActivity": {
            "kind": "tool",
            "text": "sample",
            "toolName": "sample",
            "at": 0
          },
          "capabilities": {
            "interruptible": false,
            "killable": false,
            "pausable": false,
            "resumable": false,
            "steerable": false
          },
          "needsAttention": {
            "reason": "approval",
            "detail": "sample"
          },
          "sessionRef": {
            "sessionId": "sample",
            "agentId": "sample"
          }
        }
      ],
      "nextCursor": "sample",
      "hasMore": false,
      "capturedAt": 0
    }
  },
  "fleet.snapshot": {
    "methodId": "fleet.snapshot",
    "http": null,
    "status": 200,
    "body": {
      "capturedAt": 0,
      "nodes": [
        {
          "id": "sample",
          "kind": "agent",
          "parentId": "sample",
          "label": "sample",
          "task": "sample",
          "state": "thinking",
          "startedAt": 0,
          "completedAt": 0,
          "elapsedMs": 0,
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "llmCallCount": 0,
            "turnCount": 0,
            "toolCallCount": 0
          },
          "model": "sample",
          "provider": "sample",
          "costUsd": 0,
          "costState": "priced",
          "currentActivity": {
            "kind": "tool",
            "text": "sample",
            "toolName": "sample",
            "at": 0
          },
          "capabilities": {
            "interruptible": false,
            "killable": false,
            "pausable": false,
            "resumable": false,
            "steerable": false
          },
          "needsAttention": {
            "reason": "approval",
            "detail": "sample"
          },
          "sessionRef": {
            "sessionId": "sample",
            "agentId": "sample"
          }
        }
      ],
      "truncated": false,
      "totalCount": 0
    }
  },
  "fleet.unarchive": {
    "methodId": "fleet.unarchive",
    "http": null,
    "status": 200,
    "body": {
      "restored": 0
    }
  },
  "health.snapshot": {
    "methodId": "health.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/health"
    },
    "status": 200,
    "body": {
      "overall": "healthy",
      "degradedDomains": [
        "sample"
      ],
      "providerProblems": [
        "sample"
      ],
      "mcpProblems": {
        "degraded": [
          "sample"
        ],
        "quarantined": [
          "sample"
        ]
      },
      "integrationProblems": [
        "sample"
      ],
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "intelligence.snapshot": {
    "methodId": "intelligence.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/intelligence"
    },
    "status": 200,
    "body": {
      "diagnosticsStatus": "sample",
      "symbolSearchStatus": "sample",
      "completionsStatus": "sample",
      "hoverStatus": "sample",
      "errorCount": 0,
      "warningCount": 0,
      "totalRequests": 0,
      "avgLatencyMs": 0
    }
  },
  "homeassistant.homeGraph.askHomeGraph": {
    "methodId": "homeassistant.homeGraph.askHomeGraph",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/ask"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "query": "sample",
      "answer": {},
      "results": [
        "sample"
      ]
    }
  },
  "homeassistant.homeGraph.browse": {
    "methodId": "homeassistant.homeGraph.browse",
    "http": {
      "method": "GET",
      "path": "/api/homeassistant/home-graph/browse"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "nodes": [
        {
          "id": "sample",
          "kind": "sample",
          "slug": "sample",
          "title": "sample",
          "summary": "sample",
          "aliases": [
            "sample"
          ],
          "status": "sample",
          "confidence": 0,
          "sourceId": "sample",
          "subject": "sample",
          "subjectIds": [
            "sample"
          ],
          "targetHints": [
            {}
          ],
          "linkedObjectIds": [
            "sample"
          ],
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "edges": [
        {
          "id": "sample",
          "fromKind": "sample",
          "fromId": "sample",
          "toKind": "sample",
          "toId": "sample",
          "relation": "sample",
          "weight": 0,
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "homeassistant.homeGraph.export": {
    "methodId": "homeassistant.homeGraph.export",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/export"
    },
    "status": 200,
    "body": {
      "version": 0,
      "exportedAt": 0,
      "spaceId": "sample",
      "installationId": "sample",
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "nodes": [
        {
          "id": "sample",
          "kind": "sample",
          "slug": "sample",
          "title": "sample",
          "summary": "sample",
          "aliases": [
            "sample"
          ],
          "status": "sample",
          "confidence": 0,
          "sourceId": "sample",
          "subject": "sample",
          "subjectIds": [
            "sample"
          ],
          "targetHints": [
            {}
          ],
          "linkedObjectIds": [
            "sample"
          ],
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "edges": [
        {
          "id": "sample",
          "fromKind": "sample",
          "fromId": "sample",
          "toKind": "sample",
          "toId": "sample",
          "relation": "sample",
          "weight": 0,
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "extractions": [
        {
          "id": "sample",
          "sourceId": "sample",
          "artifactId": "sample",
          "extractorId": "sample",
          "format": "sample",
          "title": "sample",
          "summary": "sample",
          "excerpt": "sample",
          "sections": [
            "sample"
          ],
          "links": [
            "sample"
          ],
          "estimatedTokens": 0,
          "structure": {},
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "homeassistant.homeGraph.generateHomeGraphPacket": {
    "methodId": "homeassistant.homeGraph.generateHomeGraphPacket",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/packet"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "title": "sample",
      "markdown": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifact": {}
    }
  },
  "homeassistant.homeGraph.generateRoomPage": {
    "methodId": "homeassistant.homeGraph.generateRoomPage",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/room-page"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "title": "sample",
      "markdown": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifact": {}
    }
  },
  "homeassistant.homeGraph.import": {
    "methodId": "homeassistant.homeGraph.import",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/import"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "imported": {}
    }
  },
  "homeassistant.homeGraph.ingestHomeGraphArtifact": {
    "methodId": "homeassistant.homeGraph.ingestHomeGraphArtifact",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/ingest/artifact"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifactId": "sample",
      "extraction": {
        "id": "sample",
        "sourceId": "sample",
        "artifactId": "sample",
        "extractorId": "sample",
        "format": "sample",
        "title": "sample",
        "summary": "sample",
        "excerpt": "sample",
        "sections": [
          "sample"
        ],
        "links": [
          "sample"
        ],
        "estimatedTokens": 0,
        "structure": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "homeassistant.homeGraph.ingestHomeGraphNote": {
    "methodId": "homeassistant.homeGraph.ingestHomeGraphNote",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/ingest/note"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifactId": "sample",
      "extraction": {
        "id": "sample",
        "sourceId": "sample",
        "artifactId": "sample",
        "extractorId": "sample",
        "format": "sample",
        "title": "sample",
        "summary": "sample",
        "excerpt": "sample",
        "sections": [
          "sample"
        ],
        "links": [
          "sample"
        ],
        "estimatedTokens": 0,
        "structure": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "homeassistant.homeGraph.ingestHomeGraphUrl": {
    "methodId": "homeassistant.homeGraph.ingestHomeGraphUrl",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/ingest/url"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifactId": "sample",
      "extraction": {
        "id": "sample",
        "sourceId": "sample",
        "artifactId": "sample",
        "extractorId": "sample",
        "format": "sample",
        "title": "sample",
        "summary": "sample",
        "excerpt": "sample",
        "sections": [
          "sample"
        ],
        "links": [
          "sample"
        ],
        "estimatedTokens": 0,
        "structure": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "homeassistant.homeGraph.linkHomeGraphKnowledge": {
    "methodId": "homeassistant.homeGraph.linkHomeGraphKnowledge",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/link"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "edge": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "target": {}
    }
  },
  "homeassistant.homeGraph.listHomeGraphIssues": {
    "methodId": "homeassistant.homeGraph.listHomeGraphIssues",
    "http": {
      "method": "GET",
      "path": "/api/homeassistant/home-graph/issues"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "homeassistant.homeGraph.map": {
    "methodId": "homeassistant.homeGraph.map",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/map"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "title": "sample",
      "generatedAt": 0,
      "width": 0,
      "height": 0,
      "nodeCount": 0,
      "edgeCount": 0,
      "totalNodeCount": 0,
      "totalEdgeCount": 0,
      "facets": {
        "recordKinds": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "nodeKinds": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "sourceTypes": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "sourceStatuses": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "nodeStatuses": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "issueCodes": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "issueStatuses": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "issueSeverities": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "edgeRelations": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "tags": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "homeAssistant": {}
      },
      "nodes": [
        {
          "id": "sample",
          "recordKind": "sample",
          "kind": "sample",
          "title": "sample",
          "summary": "sample",
          "x": 0,
          "y": 0,
          "radius": 0,
          "metadata": {}
        }
      ],
      "edges": [
        {
          "id": "sample",
          "fromId": "sample",
          "toId": "sample",
          "source": "sample",
          "target": "sample",
          "fromTitle": "sample",
          "toTitle": "sample",
          "sourceTitle": "sample",
          "targetTitle": "sample",
          "relation": "sample",
          "weight": 0,
          "metadata": {}
        }
      ],
      "svg": "sample"
    }
  },
  "homeassistant.homeGraph.pages.list": {
    "methodId": "homeassistant.homeGraph.pages.list",
    "http": {
      "method": "GET",
      "path": "/api/homeassistant/home-graph/pages"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "pages": [
        "sample"
      ]
    }
  },
  "homeassistant.homeGraph.refinement.run": {
    "methodId": "homeassistant.homeGraph.refinement.run",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/refinement/run"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "result": {
        "scannedGaps": 0,
        "candidateGaps": 0,
        "processedGaps": 0,
        "createdGaps": 0,
        "repairableGaps": 0,
        "suppressedGaps": 0,
        "skippedGaps": 0,
        "searched": 0,
        "ingestedSources": 0,
        "linkedRepairs": 0,
        "blockedGaps": 0,
        "closedGaps": 0,
        "queuedTasks": 0,
        "requestedLimit": 0,
        "effectiveLimit": 0,
        "coalesced": false,
        "truncated": false,
        "budgetExhausted": false,
        "taskIds": [
          "sample"
        ],
        "ingestedSourceIds": [
          "sample"
        ],
        "errors": [
          "sample"
        ]
      }
    }
  },
  "homeassistant.homeGraph.refinement.task.cancel": {
    "methodId": "homeassistant.homeGraph.refinement.task.cancel",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/refinement/tasks/{id}/cancel"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "task": {
        "id": "sample",
        "spaceId": "sample",
        "subjectKind": "sample",
        "subjectId": "sample",
        "subjectTitle": "sample",
        "subjectType": "sample",
        "gapId": "sample",
        "issueId": "sample",
        "state": "detected",
        "priority": "low",
        "trigger": "ingest",
        "budget": {},
        "attemptCount": 0,
        "blockedReason": "sample",
        "nextRepairAttemptAt": 0,
        "acceptedSourceIds": [
          "sample"
        ],
        "ingestedSourceIds": [
          "sample"
        ],
        "rejectedSourceUrls": [
          "sample"
        ],
        "promotedFactCount": 0,
        "sourceAssessments": [
          "sample"
        ],
        "trace": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "homeassistant.homeGraph.refinement.task.get": {
    "methodId": "homeassistant.homeGraph.refinement.task.get",
    "http": {
      "method": "GET",
      "path": "/api/homeassistant/home-graph/refinement/tasks/{id}"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "task": {
        "id": "sample",
        "spaceId": "sample",
        "subjectKind": "sample",
        "subjectId": "sample",
        "subjectTitle": "sample",
        "subjectType": "sample",
        "gapId": "sample",
        "issueId": "sample",
        "state": "detected",
        "priority": "low",
        "trigger": "ingest",
        "budget": {},
        "attemptCount": 0,
        "blockedReason": "sample",
        "nextRepairAttemptAt": 0,
        "acceptedSourceIds": [
          "sample"
        ],
        "ingestedSourceIds": [
          "sample"
        ],
        "rejectedSourceUrls": [
          "sample"
        ],
        "promotedFactCount": 0,
        "sourceAssessments": [
          "sample"
        ],
        "trace": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "homeassistant.homeGraph.refinement.tasks.list": {
    "methodId": "homeassistant.homeGraph.refinement.tasks.list",
    "http": {
      "method": "GET",
      "path": "/api/homeassistant/home-graph/refinement/tasks"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "tasks": [
        {
          "id": "sample",
          "spaceId": "sample",
          "subjectKind": "sample",
          "subjectId": "sample",
          "subjectTitle": "sample",
          "subjectType": "sample",
          "gapId": "sample",
          "issueId": "sample",
          "state": "detected",
          "priority": "low",
          "trigger": "ingest",
          "budget": {},
          "attemptCount": 0,
          "blockedReason": "sample",
          "nextRepairAttemptAt": 0,
          "acceptedSourceIds": [
            "sample"
          ],
          "ingestedSourceIds": [
            "sample"
          ],
          "rejectedSourceUrls": [
            "sample"
          ],
          "promotedFactCount": 0,
          "sourceAssessments": [
            "sample"
          ],
          "trace": [
            "sample"
          ],
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "homeassistant.homeGraph.refreshDevicePassport": {
    "methodId": "homeassistant.homeGraph.refreshDevicePassport",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/device-passport"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "title": "sample",
      "markdown": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifact": {}
    }
  },
  "homeassistant.homeGraph.reindex": {
    "methodId": "homeassistant.homeGraph.reindex",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/reindex"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "scanned": 0,
      "reparsed": 0,
      "skipped": 0,
      "failed": 0,
      "changedSourceCount": 0,
      "forcedSourceCount": 0,
      "skippedGeneratedPageArtifactCount": 0,
      "refreshedGeneratedPageCount": 0,
      "generatedPagePolicyVersion": "sample",
      "coalesced": false,
      "truncated": false,
      "budgetExhausted": false,
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "failures": [
        "sample"
      ],
      "linked": [
        "sample"
      ],
      "semantic": {},
      "generated": {}
    }
  },
  "homeassistant.homeGraph.reset": {
    "methodId": "homeassistant.homeGraph.reset",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/reset"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "installationId": "sample",
      "dryRun": false,
      "deleted": {},
      "artifactDeleteCandidates": 0,
      "deletedArtifacts": 0,
      "preservedArtifacts": 0,
      "artifactsDeleted": false
    }
  },
  "homeassistant.homeGraph.reviewHomeGraphFact": {
    "methodId": "homeassistant.homeGraph.reviewHomeGraphFact",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/facts/review"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "issue": {
        "id": "sample",
        "severity": "sample",
        "code": "sample",
        "message": "sample",
        "status": "sample",
        "sourceId": "sample",
        "nodeId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "node": {
        "id": "sample",
        "kind": "sample",
        "slug": "sample",
        "title": "sample",
        "summary": "sample",
        "aliases": [
          "sample"
        ],
        "status": "sample",
        "confidence": 0,
        "sourceId": "sample",
        "subject": "sample",
        "subjectIds": [
          "sample"
        ],
        "targetHints": [
          {}
        ],
        "linkedObjectIds": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "homeassistant.homeGraph.sources.list": {
    "methodId": "homeassistant.homeGraph.sources.list",
    "http": {
      "method": "GET",
      "path": "/api/homeassistant/home-graph/sources"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "homeassistant.homeGraph.status": {
    "methodId": "homeassistant.homeGraph.status",
    "http": {
      "method": "GET",
      "path": "/api/homeassistant/home-graph/status"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "installationId": "sample",
      "sourceCount": 0,
      "nodeCount": 0,
      "edgeCount": 0,
      "issueCount": 0,
      "extractionCount": 0,
      "lastSnapshotAt": 0,
      "readiness": {},
      "capabilities": [
        "sample"
      ]
    }
  },
  "homeassistant.homeGraph.syncHomeGraph": {
    "methodId": "homeassistant.homeGraph.syncHomeGraph",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/sync"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "installationId": "sample",
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "home": {
        "id": "sample",
        "kind": "sample",
        "slug": "sample",
        "title": "sample",
        "summary": "sample",
        "aliases": [
          "sample"
        ],
        "status": "sample",
        "confidence": 0,
        "sourceId": "sample",
        "subject": "sample",
        "subjectIds": [
          "sample"
        ],
        "targetHints": [
          {}
        ],
        "linkedObjectIds": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "created": {},
      "generated": {
        "devicePassports": 0,
        "roomPages": 0,
        "artifacts": 0,
        "sources": 0,
        "deferredDevicePassports": 0,
        "deferredRoomPages": 0,
        "truncated": false,
        "errors": [
          "sample"
        ]
      },
      "counts": {}
    }
  },
  "homeassistant.homeGraph.unlinkHomeGraphKnowledge": {
    "methodId": "homeassistant.homeGraph.unlinkHomeGraphKnowledge",
    "http": {
      "method": "POST",
      "path": "/api/homeassistant/home-graph/unlink"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "edge": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "target": {}
    }
  },
  "knowledge.ask": {
    "methodId": "knowledge.ask",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/ask"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "query": "sample",
      "answer": {
        "text": "sample",
        "mode": "sample",
        "confidence": 0,
        "sources": [
          {
            "id": "sample",
            "connectorId": "sample",
            "sourceType": "url",
            "title": "sample",
            "sourceUri": "sample",
            "canonicalUri": "sample",
            "summary": "sample",
            "description": "sample",
            "tags": [
              "sample"
            ],
            "folderPath": "sample",
            "status": "sample",
            "artifactId": "sample",
            "contentHash": "sample",
            "lastCrawledAt": 0,
            "crawlError": "sample",
            "sessionId": "sample",
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          }
        ],
        "linkedObjects": [
          {
            "id": "sample",
            "kind": "sample",
            "slug": "sample",
            "title": "sample",
            "summary": "sample",
            "aliases": [
              "sample"
            ],
            "status": "sample",
            "confidence": 0,
            "sourceId": "sample",
            "subject": "sample",
            "subjectIds": [
              "sample"
            ],
            "targetHints": [
              {}
            ],
            "linkedObjectIds": [
              "sample"
            ],
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          }
        ],
        "facts": [
          {
            "id": "sample",
            "kind": "sample",
            "slug": "sample",
            "title": "sample",
            "summary": "sample",
            "aliases": [
              "sample"
            ],
            "status": "sample",
            "confidence": 0,
            "sourceId": "sample",
            "subject": "sample",
            "subjectIds": [
              "sample"
            ],
            "targetHints": [
              {}
            ],
            "linkedObjectIds": [
              "sample"
            ],
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          }
        ],
        "gaps": [
          {
            "id": "sample",
            "kind": "sample",
            "slug": "sample",
            "title": "sample",
            "summary": "sample",
            "aliases": [
              "sample"
            ],
            "status": "sample",
            "confidence": 0,
            "sourceId": "sample",
            "subject": "sample",
            "subjectIds": [
              "sample"
            ],
            "targetHints": [
              {}
            ],
            "linkedObjectIds": [
              "sample"
            ],
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          }
        ],
        "synthesized": false
      },
      "results": [
        {
          "kind": "sample",
          "id": "sample",
          "score": 0,
          "reason": "sample",
          "source": {
            "id": "sample",
            "connectorId": "sample",
            "sourceType": "url",
            "title": "sample",
            "sourceUri": "sample",
            "canonicalUri": "sample",
            "summary": "sample",
            "description": "sample",
            "tags": [
              "sample"
            ],
            "folderPath": "sample",
            "status": "sample",
            "artifactId": "sample",
            "contentHash": "sample",
            "lastCrawledAt": 0,
            "crawlError": "sample",
            "sessionId": "sample",
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          },
          "node": {
            "id": "sample",
            "kind": "sample",
            "slug": "sample",
            "title": "sample",
            "summary": "sample",
            "aliases": [
              "sample"
            ],
            "status": "sample",
            "confidence": 0,
            "sourceId": "sample",
            "subject": "sample",
            "subjectIds": [
              "sample"
            ],
            "targetHints": [
              {}
            ],
            "linkedObjectIds": [
              "sample"
            ],
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          }
        }
      ]
    }
  },
  "knowledge.candidate.decide": {
    "methodId": "knowledge.candidate.decide",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/candidates/{id}/decide"
    },
    "status": 200,
    "body": {
      "candidate": {
        "id": "sample",
        "candidateType": "sample",
        "status": "sample",
        "subjectKind": "sample",
        "subjectId": "sample",
        "title": "sample",
        "summary": "sample",
        "score": 0,
        "evidence": [
          "sample"
        ],
        "suggestedMemoryClass": "sample",
        "suggestedScope": "sample",
        "decidedAt": 0,
        "decidedBy": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.candidate.get": {
    "methodId": "knowledge.candidate.get",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/candidates/{id}"
    },
    "status": 200,
    "body": {
      "candidate": {
        "id": "sample",
        "candidateType": "sample",
        "status": "sample",
        "subjectKind": "sample",
        "subjectId": "sample",
        "title": "sample",
        "summary": "sample",
        "score": 0,
        "evidence": [
          "sample"
        ],
        "suggestedMemoryClass": "sample",
        "suggestedScope": "sample",
        "decidedAt": 0,
        "decidedBy": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.candidates.list": {
    "methodId": "knowledge.candidates.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/candidates"
    },
    "status": 200,
    "body": {
      "candidates": [
        {
          "id": "sample",
          "candidateType": "sample",
          "status": "sample",
          "subjectKind": "sample",
          "subjectId": "sample",
          "title": "sample",
          "summary": "sample",
          "score": 0,
          "evidence": [
            "sample"
          ],
          "suggestedMemoryClass": "sample",
          "suggestedScope": "sample",
          "decidedAt": 0,
          "decidedBy": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.connector.doctor": {
    "methodId": "knowledge.connector.doctor",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/connectors/{id}/doctor"
    },
    "status": 200,
    "body": {
      "report": {
        "connectorId": "sample",
        "ready": false,
        "summary": "sample",
        "checks": [
          {
            "id": "sample",
            "label": "sample",
            "status": "pass",
            "detail": "sample",
            "metadata": {}
          }
        ],
        "hints": [
          "sample"
        ],
        "metadata": {}
      }
    }
  },
  "knowledge.connector.get": {
    "methodId": "knowledge.connector.get",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/connectors/{id}"
    },
    "status": 200,
    "body": {
      "connector": {
        "id": "sample",
        "displayName": "sample",
        "version": "sample",
        "description": "sample",
        "sourceType": "url",
        "inputSchema": {},
        "examples": [
          "sample"
        ],
        "capabilities": [
          "sample"
        ],
        "setup": {
          "version": "sample",
          "summary": "sample",
          "transportHints": [
            "sample"
          ],
          "steps": [
            "sample"
          ],
          "fields": [
            {
              "key": "sample",
              "label": "sample",
              "kind": "text",
              "optional": false,
              "source": "inline",
              "description": "sample"
            }
          ],
          "metadata": {}
        },
        "metadata": {}
      }
    }
  },
  "knowledge.connectors.list": {
    "methodId": "knowledge.connectors.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/connectors"
    },
    "status": 200,
    "body": {
      "connectors": [
        {
          "id": "sample",
          "displayName": "sample",
          "version": "sample",
          "description": "sample",
          "sourceType": "url",
          "inputSchema": {},
          "examples": [
            "sample"
          ],
          "capabilities": [
            "sample"
          ],
          "setup": {
            "version": "sample",
            "summary": "sample",
            "transportHints": [
              "sample"
            ],
            "steps": [
              "sample"
            ],
            "fields": [
              {
                "key": "sample",
                "label": "sample",
                "kind": "text",
                "optional": false,
                "source": "inline",
                "description": "sample"
              }
            ],
            "metadata": {}
          },
          "metadata": {}
        }
      ]
    }
  },
  "knowledge.extraction.get": {
    "methodId": "knowledge.extraction.get",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/extractions/{id}"
    },
    "status": 200,
    "body": {
      "extraction": {
        "id": "sample",
        "sourceId": "sample",
        "artifactId": "sample",
        "extractorId": "sample",
        "format": "sample",
        "title": "sample",
        "summary": "sample",
        "excerpt": "sample",
        "sections": [
          "sample"
        ],
        "links": [
          "sample"
        ],
        "estimatedTokens": 0,
        "structure": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.extractions.list": {
    "methodId": "knowledge.extractions.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/extractions"
    },
    "status": 200,
    "body": {
      "extractions": [
        {
          "id": "sample",
          "sourceId": "sample",
          "artifactId": "sample",
          "extractorId": "sample",
          "format": "sample",
          "title": "sample",
          "summary": "sample",
          "excerpt": "sample",
          "sections": [
            "sample"
          ],
          "links": [
            "sample"
          ],
          "estimatedTokens": 0,
          "structure": {},
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.graphql.execute": {
    "methodId": "knowledge.graphql.execute",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/graphql"
    },
    "status": 200,
    "body": {
      "data": {},
      "errors": [
        "sample"
      ],
      "extensions": {}
    }
  },
  "knowledge.graphql.schema": {
    "methodId": "knowledge.graphql.schema",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/graphql/schema"
    },
    "status": 200,
    "body": {
      "language": "sample",
      "domain": "sample",
      "schema": "sample"
    }
  },
  "knowledge.ingest.artifact": {
    "methodId": "knowledge.ingest.artifact",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/ingest/artifact"
    },
    "status": 200,
    "body": {
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifactId": "sample",
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.ingest.bookmarks": {
    "methodId": "knowledge.ingest.bookmarks",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/ingest/bookmarks"
    },
    "status": 200,
    "body": {
      "imported": 0,
      "failed": 0,
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "errors": [
        "sample"
      ]
    }
  },
  "knowledge.ingest.browserHistory": {
    "methodId": "knowledge.ingest.browserHistory",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/ingest/browser-history"
    },
    "status": 200,
    "body": {
      "imported": 0,
      "failed": 0,
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "errors": [
        "sample"
      ],
      "profiles": [
        {
          "family": "sample",
          "browser": "sample",
          "profileName": "sample",
          "profilePath": "sample",
          "historyPath": "sample",
          "bookmarksPath": "sample"
        }
      ]
    }
  },
  "knowledge.ingest.connector": {
    "methodId": "knowledge.ingest.connector",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/ingest/connector"
    },
    "status": 200,
    "body": {
      "imported": 0,
      "failed": 0,
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "errors": [
        "sample"
      ]
    }
  },
  "knowledge.ingest.url": {
    "methodId": "knowledge.ingest.url",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/ingest/url"
    },
    "status": 200,
    "body": {
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifactId": "sample",
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.ingest.urls": {
    "methodId": "knowledge.ingest.urls",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/ingest/urls"
    },
    "status": 200,
    "body": {
      "imported": 0,
      "failed": 0,
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "errors": [
        "sample"
      ]
    }
  },
  "knowledge.issue.review": {
    "methodId": "knowledge.issue.review",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/issues/{id}/review"
    },
    "status": 200,
    "body": {
      "ok": false,
      "issue": {
        "id": "sample",
        "severity": "sample",
        "code": "sample",
        "message": "sample",
        "status": "sample",
        "sourceId": "sample",
        "nodeId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "node": {
        "id": "sample",
        "kind": "sample",
        "slug": "sample",
        "title": "sample",
        "summary": "sample",
        "aliases": [
          "sample"
        ],
        "status": "sample",
        "confidence": 0,
        "sourceId": "sample",
        "subject": "sample",
        "subjectIds": [
          "sample"
        ],
        "targetHints": [
          {}
        ],
        "linkedObjectIds": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "suppression": {},
      "appliedFacts": {}
    }
  },
  "knowledge.issues.list": {
    "methodId": "knowledge.issues.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/issues"
    },
    "status": 200,
    "body": {
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.item.get": {
    "methodId": "knowledge.item.get",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/items/{id}"
    },
    "status": 200,
    "body": {
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "node": {
        "id": "sample",
        "kind": "sample",
        "slug": "sample",
        "title": "sample",
        "summary": "sample",
        "aliases": [
          "sample"
        ],
        "status": "sample",
        "confidence": 0,
        "sourceId": "sample",
        "subject": "sample",
        "subjectIds": [
          "sample"
        ],
        "targetHints": [
          {}
        ],
        "linkedObjectIds": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "issue": {
        "id": "sample",
        "severity": "sample",
        "code": "sample",
        "message": "sample",
        "status": "sample",
        "sourceId": "sample",
        "nodeId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "relatedEdges": [
        {
          "id": "sample",
          "fromKind": "sample",
          "fromId": "sample",
          "toKind": "sample",
          "toId": "sample",
          "relation": "sample",
          "weight": 0,
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "linkedSources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "linkedNodes": [
        {
          "id": "sample",
          "kind": "sample",
          "slug": "sample",
          "title": "sample",
          "summary": "sample",
          "aliases": [
            "sample"
          ],
          "status": "sample",
          "confidence": 0,
          "sourceId": "sample",
          "subject": "sample",
          "subjectIds": [
            "sample"
          ],
          "targetHints": [
            {}
          ],
          "linkedObjectIds": [
            "sample"
          ],
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.job-runs.list": {
    "methodId": "knowledge.job-runs.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/job-runs"
    },
    "status": 200,
    "body": {
      "runs": [
        {
          "id": "sample",
          "jobId": "sample",
          "status": "queued",
          "mode": "inline",
          "requestedAt": 0,
          "startedAt": 0,
          "completedAt": 0,
          "error": "sample",
          "result": {},
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.job.get": {
    "methodId": "knowledge.job.get",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/jobs/{jobId}"
    },
    "status": 200,
    "body": {
      "job": {
        "id": "sample",
        "kind": "lint",
        "title": "sample",
        "description": "sample",
        "defaultMode": "inline",
        "metadata": {}
      }
    }
  },
  "knowledge.job.run": {
    "methodId": "knowledge.job.run",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/jobs/{jobId}/run"
    },
    "status": 200,
    "body": {
      "run": {
        "id": "sample",
        "jobId": "sample",
        "status": "queued",
        "mode": "inline",
        "requestedAt": 0,
        "startedAt": 0,
        "completedAt": 0,
        "error": "sample",
        "result": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.jobs.list": {
    "methodId": "knowledge.jobs.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/jobs"
    },
    "status": 200,
    "body": {
      "jobs": [
        {
          "id": "sample",
          "kind": "lint",
          "title": "sample",
          "description": "sample",
          "defaultMode": "inline",
          "metadata": {}
        }
      ]
    }
  },
  "knowledge.lint": {
    "methodId": "knowledge.lint",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/lint"
    },
    "status": 200,
    "body": {
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.map": {
    "methodId": "knowledge.map",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/map"
    },
    "status": 200,
    "body": {
      "ok": false,
      "spaceId": "sample",
      "title": "sample",
      "generatedAt": 0,
      "width": 0,
      "height": 0,
      "nodeCount": 0,
      "edgeCount": 0,
      "totalNodeCount": 0,
      "totalEdgeCount": 0,
      "facets": {
        "recordKinds": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "nodeKinds": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "sourceTypes": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "sourceStatuses": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "nodeStatuses": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "issueCodes": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "issueStatuses": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "issueSeverities": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "edgeRelations": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "tags": [
          {
            "value": "sample",
            "count": 0,
            "label": "sample"
          }
        ],
        "homeAssistant": {}
      },
      "nodes": [
        {
          "id": "sample",
          "recordKind": "sample",
          "kind": "sample",
          "title": "sample",
          "summary": "sample",
          "x": 0,
          "y": 0,
          "radius": 0,
          "metadata": {}
        }
      ],
      "edges": [
        {
          "id": "sample",
          "fromId": "sample",
          "toId": "sample",
          "source": "sample",
          "target": "sample",
          "fromTitle": "sample",
          "toTitle": "sample",
          "sourceTitle": "sample",
          "targetTitle": "sample",
          "relation": "sample",
          "weight": 0,
          "metadata": {}
        }
      ],
      "svg": "sample"
    }
  },
  "knowledge.nodes.list": {
    "methodId": "knowledge.nodes.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/nodes"
    },
    "status": 200,
    "body": {
      "nodes": [
        {
          "id": "sample",
          "kind": "sample",
          "slug": "sample",
          "title": "sample",
          "summary": "sample",
          "aliases": [
            "sample"
          ],
          "status": "sample",
          "confidence": 0,
          "sourceId": "sample",
          "subject": "sample",
          "subjectIds": [
            "sample"
          ],
          "targetHints": [
            {}
          ],
          "linkedObjectIds": [
            "sample"
          ],
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.packet": {
    "methodId": "knowledge.packet",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/packet"
    },
    "status": 200,
    "body": {
      "task": "sample",
      "writeScope": [
        "sample"
      ],
      "generatedAt": 0,
      "detail": "compact",
      "strategy": "sample",
      "budgetLimit": 0,
      "estimatedTokens": 0,
      "truncated": false,
      "totalCandidates": 0,
      "droppedCount": 0,
      "droppedForBudget": 0,
      "budgetExhausted": false,
      "items": [
        {
          "kind": "sample",
          "id": "sample",
          "title": "sample",
          "summary": "sample",
          "uri": "sample",
          "reason": "sample",
          "score": 0,
          "estimatedTokens": 0,
          "related": [
            "sample"
          ],
          "evidence": [
            "sample"
          ],
          "metadata": {}
        }
      ]
    }
  },
  "knowledge.projection.materialize": {
    "methodId": "knowledge.projection.materialize",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/projections/materialize"
    },
    "status": 200,
    "body": {
      "bundle": {
        "id": "sample",
        "target": {
          "targetId": "sample",
          "kind": "sample",
          "title": "sample",
          "description": "sample",
          "itemId": "sample",
          "defaultPath": "sample",
          "defaultFilename": "sample",
          "metadata": {}
        },
        "generatedAt": 0,
        "pageCount": 0,
        "pages": [
          {
            "path": "sample",
            "title": "sample",
            "format": "sample",
            "content": "sample",
            "itemIds": [
              "sample"
            ],
            "metadata": {}
          }
        ],
        "metadata": {}
      },
      "artifact": {
        "id": "sample",
        "kind": "sample",
        "mimeType": "sample",
        "filename": "sample",
        "sizeBytes": 0,
        "sha256": "sample",
        "createdAt": 0,
        "expiresAt": 0,
        "sourceUri": "sample",
        "acquisitionMode": "sample",
        "fetchMode": "sample",
        "metadata": {}
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "linked": {
        "id": "sample",
        "fromKind": "sample",
        "fromId": "sample",
        "toKind": "sample",
        "toId": "sample",
        "relation": "sample",
        "weight": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      },
      "artifactCreated": false
    }
  },
  "knowledge.projection.render": {
    "methodId": "knowledge.projection.render",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/projections/render"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "target": {
        "targetId": "sample",
        "kind": "sample",
        "title": "sample",
        "description": "sample",
        "itemId": "sample",
        "defaultPath": "sample",
        "defaultFilename": "sample",
        "metadata": {}
      },
      "generatedAt": 0,
      "pageCount": 0,
      "pages": [
        {
          "path": "sample",
          "title": "sample",
          "format": "sample",
          "content": "sample",
          "itemIds": [
            "sample"
          ],
          "metadata": {}
        }
      ],
      "metadata": {}
    }
  },
  "knowledge.projections.list": {
    "methodId": "knowledge.projections.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/projections"
    },
    "status": 200,
    "body": {
      "targets": [
        {
          "targetId": "sample",
          "kind": "sample",
          "title": "sample",
          "description": "sample",
          "itemId": "sample",
          "defaultPath": "sample",
          "defaultFilename": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "knowledge.refinement.run": {
    "methodId": "knowledge.refinement.run",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/refinement/run"
    },
    "status": 200,
    "body": {
      "scannedGaps": 0,
      "candidateGaps": 0,
      "processedGaps": 0,
      "createdGaps": 0,
      "repairableGaps": 0,
      "suppressedGaps": 0,
      "skippedGaps": 0,
      "searched": 0,
      "ingestedSources": 0,
      "linkedRepairs": 0,
      "blockedGaps": 0,
      "closedGaps": 0,
      "queuedTasks": 0,
      "requestedLimit": 0,
      "effectiveLimit": 0,
      "coalesced": false,
      "truncated": false,
      "budgetExhausted": false,
      "taskIds": [
        "sample"
      ],
      "ingestedSourceIds": [
        "sample"
      ],
      "errors": [
        "sample"
      ]
    }
  },
  "knowledge.refinement.task.cancel": {
    "methodId": "knowledge.refinement.task.cancel",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/refinement/tasks/{id}/cancel"
    },
    "status": 200,
    "body": {
      "task": {
        "id": "sample",
        "spaceId": "sample",
        "subjectKind": "sample",
        "subjectId": "sample",
        "subjectTitle": "sample",
        "subjectType": "sample",
        "gapId": "sample",
        "issueId": "sample",
        "state": "detected",
        "priority": "low",
        "trigger": "ingest",
        "budget": {},
        "attemptCount": 0,
        "blockedReason": "sample",
        "nextRepairAttemptAt": 0,
        "acceptedSourceIds": [
          "sample"
        ],
        "ingestedSourceIds": [
          "sample"
        ],
        "rejectedSourceUrls": [
          "sample"
        ],
        "promotedFactCount": 0,
        "sourceAssessments": [
          "sample"
        ],
        "trace": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.refinement.task.get": {
    "methodId": "knowledge.refinement.task.get",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/refinement/tasks/{id}"
    },
    "status": 200,
    "body": {
      "task": {
        "id": "sample",
        "spaceId": "sample",
        "subjectKind": "sample",
        "subjectId": "sample",
        "subjectTitle": "sample",
        "subjectType": "sample",
        "gapId": "sample",
        "issueId": "sample",
        "state": "detected",
        "priority": "low",
        "trigger": "ingest",
        "budget": {},
        "attemptCount": 0,
        "blockedReason": "sample",
        "nextRepairAttemptAt": 0,
        "acceptedSourceIds": [
          "sample"
        ],
        "ingestedSourceIds": [
          "sample"
        ],
        "rejectedSourceUrls": [
          "sample"
        ],
        "promotedFactCount": 0,
        "sourceAssessments": [
          "sample"
        ],
        "trace": [
          "sample"
        ],
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.refinement.tasks.list": {
    "methodId": "knowledge.refinement.tasks.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/refinement/tasks"
    },
    "status": 200,
    "body": {
      "tasks": [
        {
          "id": "sample",
          "spaceId": "sample",
          "subjectKind": "sample",
          "subjectId": "sample",
          "subjectTitle": "sample",
          "subjectType": "sample",
          "gapId": "sample",
          "issueId": "sample",
          "state": "detected",
          "priority": "low",
          "trigger": "ingest",
          "budget": {},
          "attemptCount": 0,
          "blockedReason": "sample",
          "nextRepairAttemptAt": 0,
          "acceptedSourceIds": [
            "sample"
          ],
          "ingestedSourceIds": [
            "sample"
          ],
          "rejectedSourceUrls": [
            "sample"
          ],
          "promotedFactCount": 0,
          "sourceAssessments": [
            "sample"
          ],
          "trace": [
            "sample"
          ],
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.reindex": {
    "methodId": "knowledge.reindex",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/reindex"
    },
    "status": 200,
    "body": {
      "status": {
        "ready": false,
        "storagePath": "sample",
        "sourceCount": 0,
        "nodeCount": 0,
        "edgeCount": 0,
        "issueCount": 0,
        "extractionCount": 0,
        "jobRunCount": 0,
        "refinementTaskCount": 0,
        "usageCount": 0,
        "candidateCount": 0,
        "reportCount": 0,
        "scheduleCount": 0
      },
      "issues": [
        {
          "id": "sample",
          "severity": "sample",
          "code": "sample",
          "message": "sample",
          "status": "sample",
          "sourceId": "sample",
          "nodeId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.report.get": {
    "methodId": "knowledge.report.get",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/reports/{id}"
    },
    "status": 200,
    "body": {
      "report": {
        "id": "sample",
        "kind": "sample",
        "title": "sample",
        "summary": "sample",
        "highlights": [
          "sample"
        ],
        "metrics": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.reports.list": {
    "methodId": "knowledge.reports.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/reports"
    },
    "status": 200,
    "body": {
      "reports": [
        {
          "id": "sample",
          "kind": "sample",
          "title": "sample",
          "summary": "sample",
          "highlights": [
            "sample"
          ],
          "metrics": {},
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.schedule.delete": {
    "methodId": "knowledge.schedule.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/knowledge/schedules/{id}"
    },
    "status": 200,
    "body": {
      "deleted": false
    }
  },
  "knowledge.schedule.enable": {
    "methodId": "knowledge.schedule.enable",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/schedules/{id}/enabled"
    },
    "status": 200,
    "body": {
      "schedule": {
        "id": "sample",
        "jobId": "sample",
        "label": "sample",
        "enabled": false,
        "schedule": {
          "kind": "at",
          "at": 0
        },
        "lastRunAt": 0,
        "nextRunAt": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.schedule.get": {
    "methodId": "knowledge.schedule.get",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/schedules/{id}"
    },
    "status": 200,
    "body": {
      "schedule": {
        "id": "sample",
        "jobId": "sample",
        "label": "sample",
        "enabled": false,
        "schedule": {
          "kind": "at",
          "at": 0
        },
        "lastRunAt": 0,
        "nextRunAt": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.schedule.save": {
    "methodId": "knowledge.schedule.save",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/schedules"
    },
    "status": 200,
    "body": {
      "schedule": {
        "id": "sample",
        "jobId": "sample",
        "label": "sample",
        "enabled": false,
        "schedule": {
          "kind": "at",
          "at": 0
        },
        "lastRunAt": 0,
        "nextRunAt": 0,
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.schedules.list": {
    "methodId": "knowledge.schedules.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/schedules"
    },
    "status": 200,
    "body": {
      "schedules": [
        {
          "id": "sample",
          "jobId": "sample",
          "label": "sample",
          "enabled": false,
          "schedule": {
            "kind": "at",
            "at": 0
          },
          "lastRunAt": 0,
          "nextRunAt": 0,
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.search": {
    "methodId": "knowledge.search",
    "http": {
      "method": "POST",
      "path": "/api/knowledge/search"
    },
    "status": 200,
    "body": {
      "results": [
        {
          "kind": "sample",
          "id": "sample",
          "score": 0,
          "reason": "sample",
          "source": {
            "id": "sample",
            "connectorId": "sample",
            "sourceType": "url",
            "title": "sample",
            "sourceUri": "sample",
            "canonicalUri": "sample",
            "summary": "sample",
            "description": "sample",
            "tags": [
              "sample"
            ],
            "folderPath": "sample",
            "status": "sample",
            "artifactId": "sample",
            "contentHash": "sample",
            "lastCrawledAt": 0,
            "crawlError": "sample",
            "sessionId": "sample",
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          },
          "node": {
            "id": "sample",
            "kind": "sample",
            "slug": "sample",
            "title": "sample",
            "summary": "sample",
            "aliases": [
              "sample"
            ],
            "status": "sample",
            "confidence": 0,
            "sourceId": "sample",
            "subject": "sample",
            "subjectIds": [
              "sample"
            ],
            "targetHints": [
              {}
            ],
            "linkedObjectIds": [
              "sample"
            ],
            "metadata": {},
            "createdAt": 0,
            "updatedAt": 0
          }
        }
      ]
    }
  },
  "knowledge.source.extraction.get": {
    "methodId": "knowledge.source.extraction.get",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/sources/{id}/extraction"
    },
    "status": 200,
    "body": {
      "extraction": {
        "id": "sample",
        "sourceId": "sample",
        "artifactId": "sample",
        "extractorId": "sample",
        "format": "sample",
        "title": "sample",
        "summary": "sample",
        "excerpt": "sample",
        "sections": [
          "sample"
        ],
        "links": [
          "sample"
        ],
        "estimatedTokens": 0,
        "structure": {},
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "knowledge.sources.list": {
    "methodId": "knowledge.sources.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/sources"
    },
    "status": 200,
    "body": {
      "sources": [
        {
          "id": "sample",
          "connectorId": "sample",
          "sourceType": "url",
          "title": "sample",
          "sourceUri": "sample",
          "canonicalUri": "sample",
          "summary": "sample",
          "description": "sample",
          "tags": [
            "sample"
          ],
          "folderPath": "sample",
          "status": "sample",
          "artifactId": "sample",
          "contentHash": "sample",
          "lastCrawledAt": 0,
          "crawlError": "sample",
          "sessionId": "sample",
          "metadata": {},
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "knowledge.status": {
    "methodId": "knowledge.status",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/status"
    },
    "status": 200,
    "body": {
      "ready": false,
      "storagePath": "sample",
      "sourceCount": 0,
      "nodeCount": 0,
      "edgeCount": 0,
      "issueCount": 0,
      "extractionCount": 0,
      "jobRunCount": 0,
      "refinementTaskCount": 0,
      "usageCount": 0,
      "candidateCount": 0,
      "reportCount": 0,
      "scheduleCount": 0
    }
  },
  "knowledge.usage.list": {
    "methodId": "knowledge.usage.list",
    "http": {
      "method": "GET",
      "path": "/api/knowledge/usage"
    },
    "status": 200,
    "body": {
      "usage": [
        {
          "id": "sample",
          "targetKind": "sample",
          "targetId": "sample",
          "usageKind": "sample",
          "task": "sample",
          "sessionId": "sample",
          "score": 0,
          "metadata": {},
          "createdAt": 0
        }
      ]
    }
  },
  "projectPlanning.decisions.list": {
    "methodId": "projectPlanning.decisions.list",
    "http": {
      "method": "GET",
      "path": "/api/projects/planning/decisions"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "decisions": [
        {
          "id": "sample",
          "title": "sample",
          "context": "sample",
          "decision": "sample",
          "alternatives": [
            "sample"
          ],
          "reasoning": "sample",
          "consequences": [
            "sample"
          ],
          "status": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "projectPlanning.decisions.record": {
    "methodId": "projectPlanning.decisions.record",
    "http": {
      "method": "POST",
      "path": "/api/projects/planning/decisions"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "decision": {
        "id": "sample",
        "title": "sample",
        "context": "sample",
        "decision": "sample",
        "alternatives": [
          "sample"
        ],
        "reasoning": "sample",
        "consequences": [
          "sample"
        ],
        "status": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.evaluate": {
    "methodId": "projectPlanning.evaluate",
    "http": {
      "method": "POST",
      "path": "/api/projects/planning/evaluate"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "readiness": "sample",
      "gaps": [
        {
          "id": "sample",
          "kind": "sample",
          "severity": "sample",
          "message": "sample",
          "question": {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          },
          "relatedTaskIds": [
            "sample"
          ],
          "metadata": {}
        }
      ],
      "nextQuestion": {
        "id": "sample",
        "prompt": "sample",
        "whyItMatters": "sample",
        "recommendedAnswer": "sample",
        "consequence": "sample",
        "status": "sample",
        "answer": "sample",
        "answeredAt": 0,
        "metadata": {}
      },
      "state": {
        "id": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "goal": "sample",
        "scope": "sample",
        "knownContext": [
          "sample"
        ],
        "openQuestions": [
          {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          }
        ],
        "answeredQuestions": [
          {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          }
        ],
        "decisions": [
          {
            "id": "sample",
            "title": "sample",
            "context": "sample",
            "decision": "sample",
            "alternatives": [
              "sample"
            ],
            "reasoning": "sample",
            "consequences": [
              "sample"
            ],
            "status": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          }
        ],
        "assumptions": [
          "sample"
        ],
        "constraints": [
          "sample"
        ],
        "risks": [
          "sample"
        ],
        "tasks": [
          {
            "id": "sample",
            "title": "sample",
            "why": "sample",
            "status": "sample",
            "dependencies": [
              "sample"
            ],
            "likelyFiles": [
              "sample"
            ],
            "verification": [
              "sample"
            ],
            "canRunConcurrently": false,
            "needsReview": false,
            "blockedOnUserInput": false,
            "recommendedAgent": "sample",
            "metadata": {}
          }
        ],
        "dependencies": [
          "sample"
        ],
        "verificationGates": [
          "sample"
        ],
        "agentAssignments": [
          "sample"
        ],
        "readiness": "sample",
        "executionApproved": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      }
    }
  },
  "projectPlanning.language.get": {
    "methodId": "projectPlanning.language.get",
    "http": {
      "method": "GET",
      "path": "/api/projects/planning/language"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "language": {
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "terms": [
          "sample"
        ],
        "ambiguities": [
          "sample"
        ],
        "examples": [
          "sample"
        ],
        "updatedAt": 0,
        "metadata": {}
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.language.upsert": {
    "methodId": "projectPlanning.language.upsert",
    "http": {
      "method": "POST",
      "path": "/api/projects/planning/language"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "language": {
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "terms": [
          "sample"
        ],
        "ambiguities": [
          "sample"
        ],
        "examples": [
          "sample"
        ],
        "updatedAt": 0,
        "metadata": {}
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.state.get": {
    "methodId": "projectPlanning.state.get",
    "http": {
      "method": "GET",
      "path": "/api/projects/planning/state"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "state": {
        "id": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "goal": "sample",
        "scope": "sample",
        "knownContext": [
          "sample"
        ],
        "openQuestions": [
          {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          }
        ],
        "answeredQuestions": [
          {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          }
        ],
        "decisions": [
          {
            "id": "sample",
            "title": "sample",
            "context": "sample",
            "decision": "sample",
            "alternatives": [
              "sample"
            ],
            "reasoning": "sample",
            "consequences": [
              "sample"
            ],
            "status": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          }
        ],
        "assumptions": [
          "sample"
        ],
        "constraints": [
          "sample"
        ],
        "risks": [
          "sample"
        ],
        "tasks": [
          {
            "id": "sample",
            "title": "sample",
            "why": "sample",
            "status": "sample",
            "dependencies": [
              "sample"
            ],
            "likelyFiles": [
              "sample"
            ],
            "verification": [
              "sample"
            ],
            "canRunConcurrently": false,
            "needsReview": false,
            "blockedOnUserInput": false,
            "recommendedAgent": "sample",
            "metadata": {}
          }
        ],
        "dependencies": [
          "sample"
        ],
        "verificationGates": [
          "sample"
        ],
        "agentAssignments": [
          "sample"
        ],
        "readiness": "sample",
        "executionApproved": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.state.upsert": {
    "methodId": "projectPlanning.state.upsert",
    "http": {
      "method": "POST",
      "path": "/api/projects/planning/state"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "state": {
        "id": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "goal": "sample",
        "scope": "sample",
        "knownContext": [
          "sample"
        ],
        "openQuestions": [
          {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          }
        ],
        "answeredQuestions": [
          {
            "id": "sample",
            "prompt": "sample",
            "whyItMatters": "sample",
            "recommendedAnswer": "sample",
            "consequence": "sample",
            "status": "sample",
            "answer": "sample",
            "answeredAt": 0,
            "metadata": {}
          }
        ],
        "decisions": [
          {
            "id": "sample",
            "title": "sample",
            "context": "sample",
            "decision": "sample",
            "alternatives": [
              "sample"
            ],
            "reasoning": "sample",
            "consequences": [
              "sample"
            ],
            "status": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          }
        ],
        "assumptions": [
          "sample"
        ],
        "constraints": [
          "sample"
        ],
        "risks": [
          "sample"
        ],
        "tasks": [
          {
            "id": "sample",
            "title": "sample",
            "why": "sample",
            "status": "sample",
            "dependencies": [
              "sample"
            ],
            "likelyFiles": [
              "sample"
            ],
            "verification": [
              "sample"
            ],
            "canRunConcurrently": false,
            "needsReview": false,
            "blockedOnUserInput": false,
            "recommendedAgent": "sample",
            "metadata": {}
          }
        ],
        "dependencies": [
          "sample"
        ],
        "verificationGates": [
          "sample"
        ],
        "agentAssignments": [
          "sample"
        ],
        "readiness": "sample",
        "executionApproved": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "source": {
        "id": "sample",
        "connectorId": "sample",
        "sourceType": "url",
        "title": "sample",
        "sourceUri": "sample",
        "canonicalUri": "sample",
        "summary": "sample",
        "description": "sample",
        "tags": [
          "sample"
        ],
        "folderPath": "sample",
        "status": "sample",
        "artifactId": "sample",
        "contentHash": "sample",
        "lastCrawledAt": 0,
        "crawlError": "sample",
        "sessionId": "sample",
        "metadata": {},
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.status": {
    "methodId": "projectPlanning.status",
    "http": {
      "method": "GET",
      "path": "/api/projects/planning/status"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "passiveOnly": false,
      "counts": {},
      "capabilities": [
        "sample"
      ]
    }
  },
  "projectPlanning.workPlan.clearCompleted": {
    "methodId": "projectPlanning.workPlan.clearCompleted",
    "http": {
      "method": "POST",
      "path": "/api/projects/planning/work-plan/clear-completed"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "previousTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "deletedTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "clearedTaskIds": [
        "sample"
      ],
      "snapshot": {
        "ok": false,
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "workPlanId": "sample",
        "tasks": [
          {
            "taskId": "sample",
            "projectId": "sample",
            "knowledgeSpaceId": "sample",
            "title": "sample",
            "notes": "sample",
            "owner": "sample",
            "status": "sample",
            "priority": 0,
            "order": 0,
            "source": "sample",
            "tags": [
              "sample"
            ],
            "parentTaskId": "sample",
            "chainId": "sample",
            "phaseId": "sample",
            "agentId": "sample",
            "turnId": "sample",
            "decisionId": "sample",
            "sourceMessageId": "sample",
            "linkedArtifactIds": [
              "sample"
            ],
            "linkedSourceIds": [
              "sample"
            ],
            "linkedNodeIds": [
              "sample"
            ],
            "originSurface": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "completedAt": 0,
            "metadata": {}
          }
        ],
        "counts": {
          "total": 0,
          "pending": 0,
          "in_progress": 0,
          "blocked": 0,
          "done": 0,
          "failed": 0,
          "cancelled": 0
        },
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.workPlan.snapshot": {
    "methodId": "projectPlanning.workPlan.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/projects/planning/work-plan"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "tasks": [
        {
          "taskId": "sample",
          "projectId": "sample",
          "knowledgeSpaceId": "sample",
          "title": "sample",
          "notes": "sample",
          "owner": "sample",
          "status": "sample",
          "priority": 0,
          "order": 0,
          "source": "sample",
          "tags": [
            "sample"
          ],
          "parentTaskId": "sample",
          "chainId": "sample",
          "phaseId": "sample",
          "agentId": "sample",
          "turnId": "sample",
          "decisionId": "sample",
          "sourceMessageId": "sample",
          "linkedArtifactIds": [
            "sample"
          ],
          "linkedSourceIds": [
            "sample"
          ],
          "linkedNodeIds": [
            "sample"
          ],
          "originSurface": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "completedAt": 0,
          "metadata": {}
        }
      ],
      "counts": {
        "total": 0,
        "pending": 0,
        "in_progress": 0,
        "blocked": 0,
        "done": 0,
        "failed": 0,
        "cancelled": 0
      },
      "updatedAt": 0
    }
  },
  "projectPlanning.workPlan.task.create": {
    "methodId": "projectPlanning.workPlan.task.create",
    "http": {
      "method": "POST",
      "path": "/api/projects/planning/work-plan/tasks"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "previousTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "deletedTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "clearedTaskIds": [
        "sample"
      ],
      "snapshot": {
        "ok": false,
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "workPlanId": "sample",
        "tasks": [
          {
            "taskId": "sample",
            "projectId": "sample",
            "knowledgeSpaceId": "sample",
            "title": "sample",
            "notes": "sample",
            "owner": "sample",
            "status": "sample",
            "priority": 0,
            "order": 0,
            "source": "sample",
            "tags": [
              "sample"
            ],
            "parentTaskId": "sample",
            "chainId": "sample",
            "phaseId": "sample",
            "agentId": "sample",
            "turnId": "sample",
            "decisionId": "sample",
            "sourceMessageId": "sample",
            "linkedArtifactIds": [
              "sample"
            ],
            "linkedSourceIds": [
              "sample"
            ],
            "linkedNodeIds": [
              "sample"
            ],
            "originSurface": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "completedAt": 0,
            "metadata": {}
          }
        ],
        "counts": {
          "total": 0,
          "pending": 0,
          "in_progress": 0,
          "blocked": 0,
          "done": 0,
          "failed": 0,
          "cancelled": 0
        },
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.workPlan.task.delete": {
    "methodId": "projectPlanning.workPlan.task.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/projects/planning/work-plan/tasks/{taskId}"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "previousTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "deletedTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "clearedTaskIds": [
        "sample"
      ],
      "snapshot": {
        "ok": false,
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "workPlanId": "sample",
        "tasks": [
          {
            "taskId": "sample",
            "projectId": "sample",
            "knowledgeSpaceId": "sample",
            "title": "sample",
            "notes": "sample",
            "owner": "sample",
            "status": "sample",
            "priority": 0,
            "order": 0,
            "source": "sample",
            "tags": [
              "sample"
            ],
            "parentTaskId": "sample",
            "chainId": "sample",
            "phaseId": "sample",
            "agentId": "sample",
            "turnId": "sample",
            "decisionId": "sample",
            "sourceMessageId": "sample",
            "linkedArtifactIds": [
              "sample"
            ],
            "linkedSourceIds": [
              "sample"
            ],
            "linkedNodeIds": [
              "sample"
            ],
            "originSurface": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "completedAt": 0,
            "metadata": {}
          }
        ],
        "counts": {
          "total": 0,
          "pending": 0,
          "in_progress": 0,
          "blocked": 0,
          "done": 0,
          "failed": 0,
          "cancelled": 0
        },
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.workPlan.task.get": {
    "methodId": "projectPlanning.workPlan.task.get",
    "http": {
      "method": "GET",
      "path": "/api/projects/planning/work-plan/tasks/{taskId}"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "snapshot": {
        "ok": false,
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "workPlanId": "sample",
        "tasks": [
          {
            "taskId": "sample",
            "projectId": "sample",
            "knowledgeSpaceId": "sample",
            "title": "sample",
            "notes": "sample",
            "owner": "sample",
            "status": "sample",
            "priority": 0,
            "order": 0,
            "source": "sample",
            "tags": [
              "sample"
            ],
            "parentTaskId": "sample",
            "chainId": "sample",
            "phaseId": "sample",
            "agentId": "sample",
            "turnId": "sample",
            "decisionId": "sample",
            "sourceMessageId": "sample",
            "linkedArtifactIds": [
              "sample"
            ],
            "linkedSourceIds": [
              "sample"
            ],
            "linkedNodeIds": [
              "sample"
            ],
            "originSurface": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "completedAt": 0,
            "metadata": {}
          }
        ],
        "counts": {
          "total": 0,
          "pending": 0,
          "in_progress": 0,
          "blocked": 0,
          "done": 0,
          "failed": 0,
          "cancelled": 0
        },
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.workPlan.task.status": {
    "methodId": "projectPlanning.workPlan.task.status",
    "http": {
      "method": "POST",
      "path": "/api/projects/planning/work-plan/tasks/{taskId}/status"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "previousTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "deletedTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "clearedTaskIds": [
        "sample"
      ],
      "snapshot": {
        "ok": false,
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "workPlanId": "sample",
        "tasks": [
          {
            "taskId": "sample",
            "projectId": "sample",
            "knowledgeSpaceId": "sample",
            "title": "sample",
            "notes": "sample",
            "owner": "sample",
            "status": "sample",
            "priority": 0,
            "order": 0,
            "source": "sample",
            "tags": [
              "sample"
            ],
            "parentTaskId": "sample",
            "chainId": "sample",
            "phaseId": "sample",
            "agentId": "sample",
            "turnId": "sample",
            "decisionId": "sample",
            "sourceMessageId": "sample",
            "linkedArtifactIds": [
              "sample"
            ],
            "linkedSourceIds": [
              "sample"
            ],
            "linkedNodeIds": [
              "sample"
            ],
            "originSurface": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "completedAt": 0,
            "metadata": {}
          }
        ],
        "counts": {
          "total": 0,
          "pending": 0,
          "in_progress": 0,
          "blocked": 0,
          "done": 0,
          "failed": 0,
          "cancelled": 0
        },
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.workPlan.task.update": {
    "methodId": "projectPlanning.workPlan.task.update",
    "http": {
      "method": "PATCH",
      "path": "/api/projects/planning/work-plan/tasks/{taskId}"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "task": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "previousTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "deletedTask": {
        "taskId": "sample",
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "title": "sample",
        "notes": "sample",
        "owner": "sample",
        "status": "sample",
        "priority": 0,
        "order": 0,
        "source": "sample",
        "tags": [
          "sample"
        ],
        "parentTaskId": "sample",
        "chainId": "sample",
        "phaseId": "sample",
        "agentId": "sample",
        "turnId": "sample",
        "decisionId": "sample",
        "sourceMessageId": "sample",
        "linkedArtifactIds": [
          "sample"
        ],
        "linkedSourceIds": [
          "sample"
        ],
        "linkedNodeIds": [
          "sample"
        ],
        "originSurface": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "completedAt": 0,
        "metadata": {}
      },
      "clearedTaskIds": [
        "sample"
      ],
      "snapshot": {
        "ok": false,
        "projectId": "sample",
        "knowledgeSpaceId": "sample",
        "workPlanId": "sample",
        "tasks": [
          {
            "taskId": "sample",
            "projectId": "sample",
            "knowledgeSpaceId": "sample",
            "title": "sample",
            "notes": "sample",
            "owner": "sample",
            "status": "sample",
            "priority": 0,
            "order": 0,
            "source": "sample",
            "tags": [
              "sample"
            ],
            "parentTaskId": "sample",
            "chainId": "sample",
            "phaseId": "sample",
            "agentId": "sample",
            "turnId": "sample",
            "decisionId": "sample",
            "sourceMessageId": "sample",
            "linkedArtifactIds": [
              "sample"
            ],
            "linkedSourceIds": [
              "sample"
            ],
            "linkedNodeIds": [
              "sample"
            ],
            "originSurface": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "completedAt": 0,
            "metadata": {}
          }
        ],
        "counts": {
          "total": 0,
          "pending": 0,
          "in_progress": 0,
          "blocked": 0,
          "done": 0,
          "failed": 0,
          "cancelled": 0
        },
        "updatedAt": 0
      }
    }
  },
  "projectPlanning.workPlan.tasks.list": {
    "methodId": "projectPlanning.workPlan.tasks.list",
    "http": {
      "method": "GET",
      "path": "/api/projects/planning/work-plan/tasks"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "tasks": [
        {
          "taskId": "sample",
          "projectId": "sample",
          "knowledgeSpaceId": "sample",
          "title": "sample",
          "notes": "sample",
          "owner": "sample",
          "status": "sample",
          "priority": 0,
          "order": 0,
          "source": "sample",
          "tags": [
            "sample"
          ],
          "parentTaskId": "sample",
          "chainId": "sample",
          "phaseId": "sample",
          "agentId": "sample",
          "turnId": "sample",
          "decisionId": "sample",
          "sourceMessageId": "sample",
          "linkedArtifactIds": [
            "sample"
          ],
          "linkedSourceIds": [
            "sample"
          ],
          "linkedNodeIds": [
            "sample"
          ],
          "originSurface": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "completedAt": 0,
          "metadata": {}
        }
      ],
      "counts": {
        "total": 0,
        "pending": 0,
        "in_progress": 0,
        "blocked": 0,
        "done": 0,
        "failed": 0,
        "cancelled": 0
      },
      "updatedAt": 0
    }
  },
  "projectPlanning.workPlan.tasks.reorder": {
    "methodId": "projectPlanning.workPlan.tasks.reorder",
    "http": {
      "method": "POST",
      "path": "/api/projects/planning/work-plan/tasks/reorder"
    },
    "status": 200,
    "body": {
      "ok": false,
      "projectId": "sample",
      "knowledgeSpaceId": "sample",
      "workPlanId": "sample",
      "tasks": [
        {
          "taskId": "sample",
          "projectId": "sample",
          "knowledgeSpaceId": "sample",
          "title": "sample",
          "notes": "sample",
          "owner": "sample",
          "status": "sample",
          "priority": 0,
          "order": 0,
          "source": "sample",
          "tags": [
            "sample"
          ],
          "parentTaskId": "sample",
          "chainId": "sample",
          "phaseId": "sample",
          "agentId": "sample",
          "turnId": "sample",
          "decisionId": "sample",
          "sourceMessageId": "sample",
          "linkedArtifactIds": [
            "sample"
          ],
          "linkedSourceIds": [
            "sample"
          ],
          "linkedNodeIds": [
            "sample"
          ],
          "originSurface": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "completedAt": 0,
          "metadata": {}
        }
      ],
      "counts": {
        "total": 0,
        "pending": 0,
        "in_progress": 0,
        "blocked": 0,
        "done": 0,
        "failed": 0,
        "cancelled": 0
      },
      "updatedAt": 0
    }
  },
  "mcp.config.get": {
    "methodId": "mcp.config.get",
    "http": {
      "method": "GET",
      "path": "/api/mcp/config"
    },
    "status": 200,
    "body": {
      "locations": [
        {
          "scope": "sample",
          "kind": "sample",
          "path": "sample",
          "writable": false
        }
      ],
      "servers": [
        {
          "name": "sample",
          "command": "sample",
          "args": [
            "sample"
          ],
          "envKeys": [
            "sample"
          ],
          "role": "sample",
          "trustMode": "sample",
          "allowedPaths": [
            "sample"
          ],
          "allowedHosts": [
            "sample"
          ],
          "source": {
            "scope": "sample",
            "kind": "sample",
            "path": "sample",
            "writable": false
          }
        }
      ]
    }
  },
  "mcp.config.reload": {
    "methodId": "mcp.config.reload",
    "http": {
      "method": "POST",
      "path": "/api/mcp/reload"
    },
    "status": 200,
    "body": {
      "reload": {
        "added": 0,
        "changed": 0,
        "removed": 0,
        "unchanged": 0,
        "servers": [
          {
            "name": "sample",
            "action": "added",
            "connected": false
          }
        ]
      },
      "config": {
        "locations": [
          {
            "scope": "sample",
            "kind": "sample",
            "path": "sample",
            "writable": false
          }
        ],
        "servers": [
          {
            "name": "sample",
            "command": "sample",
            "args": [
              "sample"
            ],
            "envKeys": [
              "sample"
            ],
            "role": "sample",
            "trustMode": "sample",
            "allowedPaths": [
              "sample"
            ],
            "allowedHosts": [
              "sample"
            ],
            "source": {
              "scope": "sample",
              "kind": "sample",
              "path": "sample",
              "writable": false
            }
          }
        ]
      }
    }
  },
  "mcp.servers.list": {
    "methodId": "mcp.servers.list",
    "http": {
      "method": "GET",
      "path": "/api/mcp/servers"
    },
    "status": 200,
    "body": {
      "servers": [
        {
          "name": "sample",
          "connected": false
        }
      ],
      "security": [
        {}
      ],
      "sandboxBindings": [
        {}
      ]
    }
  },
  "mcp.servers.remove": {
    "methodId": "mcp.servers.remove",
    "http": {
      "method": "DELETE",
      "path": "/api/mcp/config/servers/{serverName}"
    },
    "status": 200,
    "body": {
      "scope": "project",
      "path": "sample",
      "removed": false,
      "reload": {
        "added": 0,
        "changed": 0,
        "removed": 0,
        "unchanged": 0,
        "servers": [
          {
            "name": "sample",
            "action": "added",
            "connected": false
          }
        ]
      },
      "config": {
        "locations": [
          {
            "scope": "sample",
            "kind": "sample",
            "path": "sample",
            "writable": false
          }
        ],
        "servers": [
          {
            "name": "sample",
            "command": "sample",
            "args": [
              "sample"
            ],
            "envKeys": [
              "sample"
            ],
            "role": "sample",
            "trustMode": "sample",
            "allowedPaths": [
              "sample"
            ],
            "allowedHosts": [
              "sample"
            ],
            "source": {
              "scope": "sample",
              "kind": "sample",
              "path": "sample",
              "writable": false
            }
          }
        ]
      }
    }
  },
  "mcp.servers.upsert": {
    "methodId": "mcp.servers.upsert",
    "http": {
      "method": "POST",
      "path": "/api/mcp/config/servers"
    },
    "status": 200,
    "body": {
      "scope": "project",
      "path": "sample",
      "removed": false,
      "reload": {
        "added": 0,
        "changed": 0,
        "removed": 0,
        "unchanged": 0,
        "servers": [
          {
            "name": "sample",
            "action": "added",
            "connected": false
          }
        ]
      },
      "config": {
        "locations": [
          {
            "scope": "sample",
            "kind": "sample",
            "path": "sample",
            "writable": false
          }
        ],
        "servers": [
          {
            "name": "sample",
            "command": "sample",
            "args": [
              "sample"
            ],
            "envKeys": [
              "sample"
            ],
            "role": "sample",
            "trustMode": "sample",
            "allowedPaths": [
              "sample"
            ],
            "allowedHosts": [
              "sample"
            ],
            "source": {
              "scope": "sample",
              "kind": "sample",
              "path": "sample",
              "writable": false
            }
          }
        ]
      }
    }
  },
  "mcp.tools.list": {
    "methodId": "mcp.tools.list",
    "http": {
      "method": "GET",
      "path": "/api/mcp/tools"
    },
    "status": 200,
    "body": {
      "tools": [
        {
          "qualifiedName": "sample",
          "serverName": "sample",
          "toolName": "sample",
          "description": "sample"
        }
      ]
    }
  },
  "media.analyze": {
    "methodId": "media.analyze",
    "http": {
      "method": "POST",
      "path": "/api/media/analyze"
    },
    "status": 200,
    "body": {
      "providerId": "sample",
      "description": "sample",
      "labels": [
        "sample"
      ],
      "text": "sample",
      "metadata": {}
    }
  },
  "media.generate": {
    "methodId": "media.generate",
    "http": {
      "method": "POST",
      "path": "/api/media/generate"
    },
    "status": 200,
    "body": {
      "providerId": "sample",
      "artifacts": [
        {
          "id": "sample",
          "artifactId": "sample",
          "mimeType": "sample",
          "dataBase64": "sample",
          "uri": "sample",
          "filename": "sample",
          "sizeBytes": 0,
          "sha256": "sample",
          "acquisitionMode": "inline-data",
          "fetchMode": "not-applicable",
          "metadata": {}
        }
      ],
      "metadata": {}
    }
  },
  "media.providers.list": {
    "methodId": "media.providers.list",
    "http": {
      "method": "GET",
      "path": "/api/media/providers"
    },
    "status": 200,
    "body": {
      "providers": [
        {
          "id": "sample",
          "label": "sample",
          "capabilities": [
            "sample"
          ]
        }
      ]
    }
  },
  "media.transform": {
    "methodId": "media.transform",
    "http": {
      "method": "POST",
      "path": "/api/media/transform"
    },
    "status": 200,
    "body": {
      "providerId": "sample",
      "artifact": {
        "id": "sample",
        "artifactId": "sample",
        "mimeType": "sample",
        "dataBase64": "sample",
        "uri": "sample",
        "filename": "sample",
        "sizeBytes": 0,
        "sha256": "sample",
        "acquisitionMode": "inline-data",
        "fetchMode": "not-applicable",
        "metadata": {}
      },
      "metadata": {}
    }
  },
  "multimodal.analyze": {
    "methodId": "multimodal.analyze",
    "http": {
      "method": "POST",
      "path": "/api/multimodal/analyze"
    },
    "status": 200,
    "body": {
      "analysis": {
        "id": "sample",
        "kind": "sample",
        "artifact": {
          "id": "sample",
          "kind": "sample",
          "mimeType": "sample",
          "filename": "sample",
          "sizeBytes": 0,
          "sha256": "sample",
          "createdAt": 0,
          "expiresAt": 0,
          "sourceUri": "sample",
          "acquisitionMode": "sample",
          "fetchMode": "sample",
          "metadata": {}
        },
        "providerIds": [
          "sample"
        ],
        "summary": "sample",
        "text": "sample",
        "labels": [
          "sample"
        ],
        "entities": [
          "sample"
        ],
        "segments": [
          {
            "kind": "sample",
            "title": "sample",
            "text": "sample",
            "startMs": 0,
            "endMs": 0,
            "confidence": 0,
            "metadata": {}
          }
        ],
        "metadata": {}
      },
      "packet": {
        "detail": "sample",
        "budgetLimit": 0,
        "estimatedTokens": 0,
        "rendered": "sample",
        "highlights": [
          "sample"
        ]
      },
      "writeback": {
        "analysisArtifact": {
          "id": "sample",
          "kind": "sample",
          "mimeType": "sample",
          "filename": "sample",
          "sizeBytes": 0,
          "sha256": "sample",
          "createdAt": 0,
          "expiresAt": 0,
          "sourceUri": "sample",
          "acquisitionMode": "sample",
          "fetchMode": "sample",
          "metadata": {}
        },
        "knowledgeSourceId": "sample",
        "metadata": {}
      }
    }
  },
  "multimodal.packet": {
    "methodId": "multimodal.packet",
    "http": {
      "method": "POST",
      "path": "/api/multimodal/packet"
    },
    "status": 200,
    "body": {
      "packet": {
        "detail": "sample",
        "budgetLimit": 0,
        "estimatedTokens": 0,
        "rendered": "sample",
        "highlights": [
          "sample"
        ]
      }
    }
  },
  "multimodal.providers.list": {
    "methodId": "multimodal.providers.list",
    "http": {
      "method": "GET",
      "path": "/api/multimodal/providers"
    },
    "status": 200,
    "body": {
      "providers": [
        {
          "id": "sample",
          "label": "sample",
          "transport": "sample",
          "capabilities": [
            "sample"
          ],
          "configured": false,
          "metadata": {}
        }
      ]
    }
  },
  "multimodal.status": {
    "methodId": "multimodal.status",
    "http": {
      "method": "GET",
      "path": "/api/multimodal"
    },
    "status": 200,
    "body": {
      "enabled": false,
      "providerCount": 0,
      "providers": [
        {
          "id": "sample",
          "label": "sample",
          "transport": "sample",
          "capabilities": [
            "sample"
          ],
          "configured": false,
          "metadata": {}
        }
      ],
      "note": "sample"
    }
  },
  "multimodal.writeback": {
    "methodId": "multimodal.writeback",
    "http": {
      "method": "POST",
      "path": "/api/multimodal/writeback"
    },
    "status": 200,
    "body": {
      "writeback": {
        "analysisArtifact": {
          "id": "sample",
          "kind": "sample",
          "mimeType": "sample",
          "filename": "sample",
          "sizeBytes": 0,
          "sha256": "sample",
          "createdAt": 0,
          "expiresAt": 0,
          "sourceUri": "sample",
          "acquisitionMode": "sample",
          "fetchMode": "sample",
          "metadata": {}
        },
        "knowledgeSourceId": "sample",
        "metadata": {}
      }
    }
  },
  "memory.doctor": {
    "methodId": "memory.doctor",
    "http": {
      "method": "GET",
      "path": "/api/memory/doctor"
    },
    "status": 200,
    "body": {
      "vector": {
        "backend": "sqlite-vec",
        "enabled": false,
        "available": false,
        "path": "sample",
        "dimensions": 0,
        "indexedRecords": 0,
        "embeddingProviderId": "sample",
        "embeddingProviderLabel": "sample",
        "error": "sample",
        "platformLimitReason": "sample"
      },
      "embeddings": {
        "activeProviderId": "sample",
        "providers": [
          {
            "id": "sample",
            "label": "sample",
            "state": "healthy",
            "dimensions": 0,
            "configured": false,
            "deterministic": false,
            "detail": "sample",
            "metadata": {}
          }
        ],
        "asyncProviders": [
          "sample"
        ],
        "syncProviders": [
          "sample"
        ],
        "warnings": [
          "sample"
        ]
      },
      "checkedAt": 0
    }
  },
  "memory.embeddings.default.set": {
    "methodId": "memory.embeddings.default.set",
    "http": {
      "method": "POST",
      "path": "/api/memory/embeddings/default"
    },
    "status": 200,
    "body": {
      "vector": {
        "backend": "sqlite-vec",
        "enabled": false,
        "available": false,
        "path": "sample",
        "dimensions": 0,
        "indexedRecords": 0,
        "embeddingProviderId": "sample",
        "embeddingProviderLabel": "sample",
        "error": "sample",
        "platformLimitReason": "sample"
      },
      "embeddings": {
        "activeProviderId": "sample",
        "providers": [
          {
            "id": "sample",
            "label": "sample",
            "state": "healthy",
            "dimensions": 0,
            "configured": false,
            "deterministic": false,
            "detail": "sample",
            "metadata": {}
          }
        ],
        "asyncProviders": [
          "sample"
        ],
        "syncProviders": [
          "sample"
        ],
        "warnings": [
          "sample"
        ]
      },
      "checkedAt": 0
    }
  },
  "memory.projections.get": {
    "methodId": "memory.projections.get",
    "http": {
      "method": "GET",
      "path": "/api/memory/projections/{id}"
    },
    "status": 200,
    "body": {
      "projection": {
        "id": "sample",
        "filename": "sample",
        "scope": "session",
        "cls": "decision",
        "summary": "sample",
        "tags": [
          "sample"
        ],
        "confidence": 0,
        "reviewState": "fresh",
        "validFrom": 0,
        "validUntil": 0,
        "status": "active"
      },
      "markdown": "sample"
    }
  },
  "memory.projections.list": {
    "methodId": "memory.projections.list",
    "http": {
      "method": "GET",
      "path": "/api/memory/projections"
    },
    "status": 200,
    "body": {
      "projections": [
        {
          "id": "sample",
          "filename": "sample",
          "scope": "session",
          "cls": "decision",
          "summary": "sample",
          "tags": [
            "sample"
          ],
          "confidence": 0,
          "reviewState": "fresh",
          "validFrom": 0,
          "validUntil": 0,
          "status": "active"
        }
      ]
    }
  },
  "memory.records.add": {
    "methodId": "memory.records.add",
    "http": {
      "method": "POST",
      "path": "/api/memory/records"
    },
    "status": 200,
    "body": {
      "record": {
        "id": "sample",
        "scope": "session",
        "cls": "decision",
        "summary": "sample",
        "detail": "sample",
        "tags": [
          "sample"
        ],
        "provenance": [
          {
            "kind": "session",
            "ref": "sample",
            "label": "sample"
          }
        ],
        "reviewState": "fresh",
        "confidence": 0,
        "reviewedAt": 0,
        "reviewedBy": "sample",
        "staleReason": "sample",
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "memory.records.delete": {
    "methodId": "memory.records.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/memory/records/{id}"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "deleted": false
    }
  },
  "memory.records.export": {
    "methodId": "memory.records.export",
    "http": {
      "method": "POST",
      "path": "/api/memory/records/export"
    },
    "status": 200,
    "body": {
      "bundle": {
        "schemaVersion": "v1",
        "exportedAt": 0,
        "scope": "session",
        "recordCount": 0,
        "linkCount": 0,
        "records": [
          {
            "id": "sample",
            "scope": "session",
            "cls": "decision",
            "summary": "sample",
            "detail": "sample",
            "tags": [
              "sample"
            ],
            "provenance": [
              {
                "kind": "session",
                "ref": "sample",
                "label": "sample"
              }
            ],
            "reviewState": "fresh",
            "confidence": 0,
            "reviewedAt": 0,
            "reviewedBy": "sample",
            "staleReason": "sample",
            "createdAt": 0,
            "updatedAt": 0
          }
        ],
        "links": [
          {
            "fromId": "sample",
            "toId": "sample",
            "relation": "sample",
            "createdAt": 0
          }
        ]
      }
    }
  },
  "memory.records.get": {
    "methodId": "memory.records.get",
    "http": {
      "method": "GET",
      "path": "/api/memory/records/{id}"
    },
    "status": 200,
    "body": {
      "record": {
        "id": "sample",
        "scope": "session",
        "cls": "decision",
        "summary": "sample",
        "detail": "sample",
        "tags": [
          "sample"
        ],
        "provenance": [
          {
            "kind": "session",
            "ref": "sample",
            "label": "sample"
          }
        ],
        "reviewState": "fresh",
        "confidence": 0,
        "reviewedAt": 0,
        "reviewedBy": "sample",
        "staleReason": "sample",
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "memory.records.import": {
    "methodId": "memory.records.import",
    "http": {
      "method": "POST",
      "path": "/api/memory/records/import"
    },
    "status": 200,
    "body": {
      "result": {
        "importedRecords": 0,
        "skippedRecords": 0,
        "importedLinks": 0
      }
    }
  },
  "memory.records.links.add": {
    "methodId": "memory.records.links.add",
    "http": {
      "method": "POST",
      "path": "/api/memory/records/{id}/links"
    },
    "status": 200,
    "body": {
      "link": {
        "fromId": "sample",
        "toId": "sample",
        "relation": "sample",
        "createdAt": 0
      }
    }
  },
  "memory.records.links.list": {
    "methodId": "memory.records.links.list",
    "http": {
      "method": "GET",
      "path": "/api/memory/records/{id}/links"
    },
    "status": 200,
    "body": {
      "links": [
        {
          "fromId": "sample",
          "toId": "sample",
          "relation": "sample",
          "createdAt": 0
        }
      ]
    }
  },
  "memory.records.list": {
    "methodId": "memory.records.list",
    "http": {
      "method": "POST",
      "path": "/api/memory/records/list"
    },
    "status": 200,
    "body": {
      "records": [
        {
          "id": "sample",
          "scope": "session",
          "cls": "decision",
          "summary": "sample",
          "detail": "sample",
          "tags": [
            "sample"
          ],
          "provenance": [
            {
              "kind": "session",
              "ref": "sample",
              "label": "sample"
            }
          ],
          "reviewState": "fresh",
          "confidence": 0,
          "reviewedAt": 0,
          "reviewedBy": "sample",
          "staleReason": "sample",
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  },
  "memory.records.search": {
    "methodId": "memory.records.search",
    "http": {
      "method": "POST",
      "path": "/api/memory/records/search"
    },
    "status": 200,
    "body": {
      "records": [
        {
          "id": "sample",
          "scope": "session",
          "cls": "decision",
          "summary": "sample",
          "detail": "sample",
          "tags": [
            "sample"
          ],
          "provenance": [
            {
              "kind": "session",
              "ref": "sample",
              "label": "sample"
            }
          ],
          "reviewState": "fresh",
          "confidence": 0,
          "reviewedAt": 0,
          "reviewedBy": "sample",
          "staleReason": "sample",
          "createdAt": 0,
          "updatedAt": 0
        }
      ],
      "mode": "literal",
      "requestedSemantic": false,
      "indexUnavailableReason": "sample",
      "caveat": "sample",
      "recallFiltered": false,
      "excludedFlaggedCount": 0,
      "excludedBelowFloorCount": 0,
      "totalBeforeRecallFilter": 0,
      "recallFloor": 0
    }
  },
  "memory.records.search-semantic": {
    "methodId": "memory.records.search-semantic",
    "http": {
      "method": "POST",
      "path": "/api/memory/records/search-semantic"
    },
    "status": 200,
    "body": {
      "results": [
        {
          "record": {
            "id": "sample",
            "scope": "session",
            "cls": "decision",
            "summary": "sample",
            "detail": "sample",
            "tags": [
              "sample"
            ],
            "provenance": [
              {
                "kind": "session",
                "ref": "sample",
                "label": "sample"
              }
            ],
            "reviewState": "fresh",
            "confidence": 0,
            "reviewedAt": 0,
            "reviewedBy": "sample",
            "staleReason": "sample",
            "createdAt": 0,
            "updatedAt": 0
          },
          "distance": 0,
          "similarity": 0,
          "score": 0
        }
      ]
    }
  },
  "memory.records.update": {
    "methodId": "memory.records.update",
    "http": {
      "method": "POST",
      "path": "/api/memory/records/{id}/update"
    },
    "status": 200,
    "body": {
      "record": {
        "id": "sample",
        "scope": "session",
        "cls": "decision",
        "summary": "sample",
        "detail": "sample",
        "tags": [
          "sample"
        ],
        "provenance": [
          {
            "kind": "session",
            "ref": "sample",
            "label": "sample"
          }
        ],
        "reviewState": "fresh",
        "confidence": 0,
        "reviewedAt": 0,
        "reviewedBy": "sample",
        "staleReason": "sample",
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "memory.records.update-review": {
    "methodId": "memory.records.update-review",
    "http": {
      "method": "POST",
      "path": "/api/memory/records/{id}/review"
    },
    "status": 200,
    "body": {
      "record": {
        "id": "sample",
        "scope": "session",
        "cls": "decision",
        "summary": "sample",
        "detail": "sample",
        "tags": [
          "sample"
        ],
        "provenance": [
          {
            "kind": "session",
            "ref": "sample",
            "label": "sample"
          }
        ],
        "reviewState": "fresh",
        "confidence": 0,
        "reviewedAt": 0,
        "reviewedBy": "sample",
        "staleReason": "sample",
        "createdAt": 0,
        "updatedAt": 0
      }
    }
  },
  "memory.review-queue": {
    "methodId": "memory.review-queue",
    "http": {
      "method": "GET",
      "path": "/api/memory/review-queue"
    },
    "status": 200,
    "body": {
      "records": [
        {}
      ]
    }
  },
  "memory.vector.rebuild": {
    "methodId": "memory.vector.rebuild",
    "http": {
      "method": "POST",
      "path": "/api/memory/vector/rebuild"
    },
    "status": 200,
    "body": {
      "vector": {
        "backend": "sqlite-vec",
        "enabled": false,
        "available": false,
        "path": "sample",
        "dimensions": 0,
        "indexedRecords": 0,
        "embeddingProviderId": "sample",
        "embeddingProviderLabel": "sample",
        "error": "sample",
        "platformLimitReason": "sample"
      }
    }
  },
  "memory.vector.stats": {
    "methodId": "memory.vector.stats",
    "http": {
      "method": "GET",
      "path": "/api/memory/vector"
    },
    "status": 200,
    "body": {
      "vector": {
        "backend": "sqlite-vec",
        "enabled": false,
        "available": false,
        "path": "sample",
        "dimensions": 0,
        "indexedRecords": 0,
        "embeddingProviderId": "sample",
        "embeddingProviderLabel": "sample",
        "error": "sample",
        "platformLimitReason": "sample"
      }
    }
  },
  "panels.list": {
    "methodId": "panels.list",
    "http": {
      "method": "GET",
      "path": "/api/panels"
    },
    "status": 200,
    "body": {
      "panels": [
        {
          "id": "sample",
          "name": "sample",
          "category": "sample",
          "description": "sample",
          "open": false
        }
      ]
    }
  },
  "panels.open": {
    "methodId": "panels.open",
    "http": {
      "method": "POST",
      "path": "/api/panels/open"
    },
    "status": 200,
    "body": {
      "opened": false,
      "id": "sample",
      "pane": "top"
    }
  },
  "principals.create": {
    "methodId": "principals.create",
    "http": {
      "method": "POST",
      "path": "/api/principals"
    },
    "status": 200,
    "body": {
      "principal": {
        "id": "sample",
        "name": "sample",
        "kind": "user",
        "identities": [
          {
            "channel": "sample",
            "value": "sample"
          }
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      }
    }
  },
  "principals.delete": {
    "methodId": "principals.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/principals/{principalId}"
    },
    "status": 200,
    "body": {
      "principalId": "sample",
      "deleted": false
    }
  },
  "principals.get": {
    "methodId": "principals.get",
    "http": {
      "method": "GET",
      "path": "/api/principals/{principalId}"
    },
    "status": 200,
    "body": {
      "principal": {
        "id": "sample",
        "name": "sample",
        "kind": "user",
        "identities": [
          {
            "channel": "sample",
            "value": "sample"
          }
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      }
    }
  },
  "principals.list": {
    "methodId": "principals.list",
    "http": {
      "method": "GET",
      "path": "/api/principals"
    },
    "status": 200,
    "body": {
      "principals": [
        {
          "id": "sample",
          "name": "sample",
          "kind": "user",
          "identities": [
            {
              "channel": "sample",
              "value": "sample"
            }
          ],
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "principals.resolve": {
    "methodId": "principals.resolve",
    "http": {
      "method": "POST",
      "path": "/api/principals/resolve"
    },
    "status": 200,
    "body": {
      "principal": {
        "id": "sample",
        "name": "sample",
        "kind": "user",
        "identities": [
          {
            "channel": "sample",
            "value": "sample"
          }
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "known": false
    }
  },
  "principals.update": {
    "methodId": "principals.update",
    "http": {
      "method": "POST",
      "path": "/api/principals/{principalId}/update"
    },
    "status": 200,
    "body": {
      "principal": {
        "id": "sample",
        "name": "sample",
        "kind": "user",
        "identities": [
          {
            "channel": "sample",
            "value": "sample"
          }
        ],
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      }
    }
  },
  "providers.get": {
    "methodId": "providers.get",
    "http": {
      "method": "GET",
      "path": "/api/providers/{providerId}"
    },
    "status": 200,
    "body": {
      "providerId": "sample",
      "active": false,
      "modelCount": 0,
      "runtime": {
        "auth": {
          "mode": "api-key",
          "configured": false,
          "detail": "sample",
          "envVars": [
            "sample"
          ],
          "routes": [
            {
              "route": "sample",
              "label": "sample",
              "configured": false,
              "usable": false,
              "freshness": "sample",
              "detail": "sample",
              "envVars": [
                "sample"
              ],
              "secretKeys": [
                "sample"
              ],
              "serviceNames": [
                "sample"
              ],
              "providerId": "sample",
              "repairHints": [
                "sample"
              ]
            }
          ]
        },
        "models": {
          "defaultModel": "sample",
          "models": [
            "sample"
          ],
          "embeddingModel": "sample",
          "embeddingDimensions": 0,
          "aliases": [
            "sample"
          ],
          "suppressedModelRegistryKeys": [
            "sample"
          ]
        },
        "usage": {
          "streaming": false,
          "toolCalling": false,
          "parallelTools": false,
          "promptCaching": false,
          "cost": {
            "source": "catalog",
            "currency": "sample",
            "inputPerMillionTokens": 0,
            "outputPerMillionTokens": 0,
            "detail": "sample"
          },
          "notes": [
            "sample"
          ]
        },
        "policy": {
          "local": false,
          "dataRetention": "sample",
          "streamProtocol": "sample",
          "reasoningMode": "sample",
          "supportedReasoningEfforts": [
            "sample"
          ],
          "cacheStrategy": "sample",
          "notes": [
            "sample"
          ]
        },
        "notes": [
          "sample"
        ]
      },
      "models": [
        {
          "id": "sample",
          "registryKey": "sample",
          "displayName": "sample",
          "selectable": false,
          "contextWindow": 0,
          "tier": "sample",
          "pricing": {
            "inputPerMillionTokens": 0,
            "outputPerMillionTokens": 0,
            "currency": "USD"
          }
        }
      ]
    }
  },
  "providers.list": {
    "methodId": "providers.list",
    "http": {
      "method": "GET",
      "path": "/api/providers"
    },
    "status": 200,
    "body": {
      "providers": [
        {
          "providerId": "sample",
          "active": false,
          "modelCount": 0,
          "runtime": {
            "auth": {
              "mode": "api-key",
              "configured": false,
              "detail": "sample",
              "envVars": [
                "sample"
              ],
              "routes": [
                {
                  "route": "sample",
                  "label": "sample",
                  "configured": false,
                  "usable": false,
                  "freshness": "sample",
                  "detail": "sample",
                  "envVars": [
                    "sample"
                  ],
                  "secretKeys": [
                    "sample"
                  ],
                  "serviceNames": [
                    "sample"
                  ],
                  "providerId": "sample",
                  "repairHints": [
                    "sample"
                  ]
                }
              ]
            },
            "models": {
              "defaultModel": "sample",
              "models": [
                "sample"
              ],
              "embeddingModel": "sample",
              "embeddingDimensions": 0,
              "aliases": [
                "sample"
              ],
              "suppressedModelRegistryKeys": [
                "sample"
              ]
            },
            "usage": {
              "streaming": false,
              "toolCalling": false,
              "parallelTools": false,
              "promptCaching": false,
              "cost": {
                "source": "catalog",
                "currency": "sample",
                "inputPerMillionTokens": 0,
                "outputPerMillionTokens": 0,
                "detail": "sample"
              },
              "notes": [
                "sample"
              ]
            },
            "policy": {
              "local": false,
              "dataRetention": "sample",
              "streamProtocol": "sample",
              "reasoningMode": "sample",
              "supportedReasoningEfforts": [
                "sample"
              ],
              "cacheStrategy": "sample",
              "notes": [
                "sample"
              ]
            },
            "notes": [
              "sample"
            ]
          },
          "models": [
            {
              "id": "sample",
              "registryKey": "sample",
              "displayName": "sample",
              "selectable": false,
              "contextWindow": 0,
              "tier": "sample",
              "pricing": {
                "inputPerMillionTokens": 0,
                "outputPerMillionTokens": 0,
                "currency": "USD"
              }
            }
          ]
        }
      ]
    }
  },
  "providers.usage.get": {
    "methodId": "providers.usage.get",
    "http": {
      "method": "GET",
      "path": "/api/providers/{providerId}/usage"
    },
    "status": 200,
    "body": {
      "providerId": "sample",
      "active": false,
      "currentModelRegistryKey": "sample",
      "pricingSource": "catalog",
      "models": [
        {
          "id": "sample",
          "registryKey": "sample",
          "displayName": "sample",
          "selectable": false,
          "contextWindow": 0,
          "tier": "sample",
          "pricing": {
            "inputPerMillionTokens": 0,
            "outputPerMillionTokens": 0,
            "currency": "USD"
          }
        }
      ],
      "usage": {
        "streaming": false,
        "toolCalling": false,
        "parallelTools": false,
        "promptCaching": false,
        "cost": {
          "source": "catalog",
          "currency": "sample",
          "inputPerMillionTokens": 0,
          "outputPerMillionTokens": 0,
          "detail": "sample"
        },
        "notes": [
          "sample"
        ]
      }
    }
  },
  "push.subscriptions.create": {
    "methodId": "push.subscriptions.create",
    "http": null,
    "status": 200,
    "body": {
      "subscription": {
        "id": "sample",
        "principalId": "sample",
        "endpointOrigin": "sample",
        "endpointHash": "sample",
        "createdAt": 0,
        "lastDeliveryAt": 0,
        "lastOutcome": "sample"
      }
    }
  },
  "push.subscriptions.delete": {
    "methodId": "push.subscriptions.delete",
    "http": null,
    "status": 200,
    "body": {
      "subscriptionId": "sample",
      "deleted": false
    }
  },
  "push.subscriptions.list": {
    "methodId": "push.subscriptions.list",
    "http": null,
    "status": 200,
    "body": {
      "subscriptions": [
        {
          "id": "sample",
          "principalId": "sample",
          "endpointOrigin": "sample",
          "endpointHash": "sample",
          "createdAt": 0,
          "lastDeliveryAt": 0,
          "lastOutcome": "sample"
        }
      ]
    }
  },
  "push.subscriptions.verify": {
    "methodId": "push.subscriptions.verify",
    "http": null,
    "status": 200,
    "body": {
      "receipt": {
        "subscriptionId": "sample",
        "endpointOrigin": "sample",
        "outcome": "sample",
        "httpStatus": 0,
        "detail": "sample"
      }
    }
  },
  "push.vapid.get": {
    "methodId": "push.vapid.get",
    "http": null,
    "status": 200,
    "body": {
      "publicKey": "sample"
    }
  },
  "quota.fanout.get": {
    "methodId": "quota.fanout.get",
    "http": null,
    "status": 200,
    "body": {
      "provider": "sample",
      "verdict": "likely-exhausts",
      "reason": "sample",
      "evidence": {
        "recentRateLimitCount": 0,
        "activeCooldownMs": 0,
        "observedRemaining": 0,
        "observedLimit": 0,
        "requestedAgents": 0
      }
    }
  },
  "quota.snapshot.get": {
    "methodId": "quota.snapshot.get",
    "http": null,
    "status": 200,
    "body": {
      "provider": "sample",
      "hasSignal": false,
      "observedAt": 0,
      "remaining": 0,
      "limit": 0,
      "resetAt": 0,
      "activeCooldownMs": 0,
      "recentRateLimitCount": 0
    }
  },
  "stepup.challenge.mint": {
    "methodId": "stepup.challenge.mint",
    "http": {
      "method": "POST",
      "path": "/api/stepup/challenge"
    },
    "status": 200,
    "body": {
      "challengeId": "sample",
      "challenge": "sample",
      "expiresAt": 0
    }
  },
  "stepup.credentials.register": {
    "methodId": "stepup.credentials.register",
    "http": {
      "method": "POST",
      "path": "/api/stepup/credentials"
    },
    "status": 200,
    "body": {
      "credential": {
        "credentialId": "sample",
        "label": "sample",
        "createdAt": 0,
        "signCount": 0
      }
    }
  },
  "remote.node_host.contract": {
    "methodId": "remote.node_host.contract",
    "http": {
      "method": "GET",
      "path": "/api/remote/node-host/contract"
    },
    "status": 200,
    "body": {
      "contract": {
        "schemaVersion": 0,
        "transport": "sample",
        "basePath": "sample",
        "peerKinds": [
          "node"
        ],
        "workTypes": [
          "invoke"
        ],
        "scopes": [
          "sample"
        ],
        "recommendedHeartbeatMs": 0,
        "recommendedWorkPullMs": 0,
        "endpoints": [
          {
            "id": "sample",
            "method": "GET",
            "path": "sample",
            "auth": "none",
            "description": "sample",
            "requiredScope": "sample",
            "inputSchema": {},
            "outputSchema": {}
          }
        ],
        "workCompletionStatuses": [
          "queued"
        ],
        "metadata": {}
      }
    }
  },
  "remote.pair.requests.approve": {
    "methodId": "remote.pair.requests.approve",
    "http": {
      "method": "POST",
      "path": "/api/remote/pair/requests/{requestId}/approve"
    },
    "status": 200,
    "body": {
      "request": {
        "id": "sample",
        "peerKind": "node",
        "requestedId": "sample",
        "label": "sample",
        "platform": "sample",
        "deviceFamily": "sample",
        "version": "sample",
        "clientMode": "sample",
        "capabilities": [
          "sample"
        ],
        "commands": [
          "sample"
        ],
        "requestedBy": "remote",
        "status": "pending",
        "challengePreview": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "approvedAt": 0,
        "verifiedAt": 0,
        "rejectedAt": 0,
        "expiresAt": 0,
        "peerId": "sample",
        "remoteAddress": "sample",
        "metadata": {}
      },
      "peer": {
        "id": "sample",
        "kind": "node",
        "label": "sample",
        "requestedId": "sample",
        "platform": "sample",
        "deviceFamily": "sample",
        "version": "sample",
        "clientMode": "sample",
        "capabilities": [
          "sample"
        ],
        "commands": [
          "sample"
        ],
        "permissions": {},
        "status": "paired",
        "pairedAt": 0,
        "verifiedAt": 0,
        "lastSeenAt": 0,
        "lastConnectedAt": 0,
        "lastDisconnectedAt": 0,
        "lastRemoteAddress": "sample",
        "activeTokenId": "sample",
        "tokens": [
          {
            "id": "sample",
            "label": "sample",
            "scopes": [
              "sample"
            ],
            "issuedAt": 0,
            "lastUsedAt": 0,
            "rotatedAt": 0,
            "revokedAt": 0,
            "fingerprint": "sample"
          }
        ],
        "metadata": {}
      }
    }
  },
  "remote.pair.requests.list": {
    "methodId": "remote.pair.requests.list",
    "http": {
      "method": "GET",
      "path": "/api/remote/pair/requests"
    },
    "status": 200,
    "body": {
      "requests": [
        {
          "id": "sample",
          "peerKind": "node",
          "requestedId": "sample",
          "label": "sample",
          "platform": "sample",
          "deviceFamily": "sample",
          "version": "sample",
          "clientMode": "sample",
          "capabilities": [
            "sample"
          ],
          "commands": [
            "sample"
          ],
          "requestedBy": "remote",
          "status": "pending",
          "challengePreview": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "approvedAt": 0,
          "verifiedAt": 0,
          "rejectedAt": 0,
          "expiresAt": 0,
          "peerId": "sample",
          "remoteAddress": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "remote.pair.requests.reject": {
    "methodId": "remote.pair.requests.reject",
    "http": {
      "method": "POST",
      "path": "/api/remote/pair/requests/{requestId}/reject"
    },
    "status": 200,
    "body": {
      "request": {
        "id": "sample",
        "peerKind": "node",
        "requestedId": "sample",
        "label": "sample",
        "platform": "sample",
        "deviceFamily": "sample",
        "version": "sample",
        "clientMode": "sample",
        "capabilities": [
          "sample"
        ],
        "commands": [
          "sample"
        ],
        "requestedBy": "remote",
        "status": "pending",
        "challengePreview": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "approvedAt": 0,
        "verifiedAt": 0,
        "rejectedAt": 0,
        "expiresAt": 0,
        "peerId": "sample",
        "remoteAddress": "sample",
        "metadata": {}
      }
    }
  },
  "remote.peers.disconnect": {
    "methodId": "remote.peers.disconnect",
    "http": {
      "method": "POST",
      "path": "/api/remote/peers/{peerId}/disconnect"
    },
    "status": 200,
    "body": {
      "peer": {
        "id": "sample",
        "kind": "node",
        "label": "sample",
        "requestedId": "sample",
        "platform": "sample",
        "deviceFamily": "sample",
        "version": "sample",
        "clientMode": "sample",
        "capabilities": [
          "sample"
        ],
        "commands": [
          "sample"
        ],
        "permissions": {},
        "status": "paired",
        "pairedAt": 0,
        "verifiedAt": 0,
        "lastSeenAt": 0,
        "lastConnectedAt": 0,
        "lastDisconnectedAt": 0,
        "lastRemoteAddress": "sample",
        "activeTokenId": "sample",
        "tokens": [
          {
            "id": "sample",
            "label": "sample",
            "scopes": [
              "sample"
            ],
            "issuedAt": 0,
            "lastUsedAt": 0,
            "rotatedAt": 0,
            "revokedAt": 0,
            "fingerprint": "sample"
          }
        ],
        "metadata": {}
      }
    }
  },
  "remote.peers.invoke": {
    "methodId": "remote.peers.invoke",
    "http": {
      "method": "POST",
      "path": "/api/remote/peers/{peerId}/invoke"
    },
    "status": 200,
    "body": {
      "work": {
        "id": "sample",
        "peerId": "sample",
        "peerKind": "node",
        "type": "invoke",
        "command": "sample",
        "priority": "default",
        "status": "queued",
        "payload": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "queuedBy": "sample",
        "claimedAt": 0,
        "claimTokenId": "sample",
        "leaseExpiresAt": 0,
        "completedAt": 0,
        "timeoutMs": 0,
        "sessionId": "sample",
        "routeId": "sample",
        "automationRunId": "sample",
        "automationJobId": "sample",
        "approvalId": "sample",
        "result": "sample",
        "error": "sample",
        "telemetry": {
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0
          },
          "llmCallCount": 0,
          "toolCallCount": 0,
          "turnCount": 0,
          "modelId": "sample",
          "providerId": "sample",
          "reasoningSummaryPresent": false,
          "source": "local-agent"
        },
        "metadata": {}
      },
      "completed": false
    }
  },
  "remote.peers.list": {
    "methodId": "remote.peers.list",
    "http": {
      "method": "GET",
      "path": "/api/remote/peers"
    },
    "status": 200,
    "body": {
      "peers": [
        {
          "id": "sample",
          "kind": "node",
          "label": "sample",
          "requestedId": "sample",
          "platform": "sample",
          "deviceFamily": "sample",
          "version": "sample",
          "clientMode": "sample",
          "capabilities": [
            "sample"
          ],
          "commands": [
            "sample"
          ],
          "permissions": {},
          "status": "paired",
          "pairedAt": 0,
          "verifiedAt": 0,
          "lastSeenAt": 0,
          "lastConnectedAt": 0,
          "lastDisconnectedAt": 0,
          "lastRemoteAddress": "sample",
          "activeTokenId": "sample",
          "tokens": [
            {
              "id": "sample",
              "label": "sample",
              "scopes": [
                "sample"
              ],
              "issuedAt": 0,
              "lastUsedAt": 0,
              "rotatedAt": 0,
              "revokedAt": 0,
              "fingerprint": "sample"
            }
          ],
          "metadata": {}
        }
      ]
    }
  },
  "remote.peers.token.revoke": {
    "methodId": "remote.peers.token.revoke",
    "http": {
      "method": "POST",
      "path": "/api/remote/peers/{peerId}/token/revoke"
    },
    "status": 200,
    "body": {
      "peer": {
        "id": "sample",
        "kind": "node",
        "label": "sample",
        "requestedId": "sample",
        "platform": "sample",
        "deviceFamily": "sample",
        "version": "sample",
        "clientMode": "sample",
        "capabilities": [
          "sample"
        ],
        "commands": [
          "sample"
        ],
        "permissions": {},
        "status": "paired",
        "pairedAt": 0,
        "verifiedAt": 0,
        "lastSeenAt": 0,
        "lastConnectedAt": 0,
        "lastDisconnectedAt": 0,
        "lastRemoteAddress": "sample",
        "activeTokenId": "sample",
        "tokens": [
          {
            "id": "sample",
            "label": "sample",
            "scopes": [
              "sample"
            ],
            "issuedAt": 0,
            "lastUsedAt": 0,
            "rotatedAt": 0,
            "revokedAt": 0,
            "fingerprint": "sample"
          }
        ],
        "metadata": {}
      }
    }
  },
  "remote.peers.token.rotate": {
    "methodId": "remote.peers.token.rotate",
    "http": {
      "method": "POST",
      "path": "/api/remote/peers/{peerId}/token/rotate"
    },
    "status": 200,
    "body": {
      "peer": {
        "id": "sample",
        "kind": "node",
        "label": "sample",
        "requestedId": "sample",
        "platform": "sample",
        "deviceFamily": "sample",
        "version": "sample",
        "clientMode": "sample",
        "capabilities": [
          "sample"
        ],
        "commands": [
          "sample"
        ],
        "permissions": {},
        "status": "paired",
        "pairedAt": 0,
        "verifiedAt": 0,
        "lastSeenAt": 0,
        "lastConnectedAt": 0,
        "lastDisconnectedAt": 0,
        "lastRemoteAddress": "sample",
        "activeTokenId": "sample",
        "tokens": [
          {
            "id": "sample",
            "label": "sample",
            "scopes": [
              "sample"
            ],
            "issuedAt": 0,
            "lastUsedAt": 0,
            "rotatedAt": 0,
            "revokedAt": 0,
            "fingerprint": "sample"
          }
        ],
        "metadata": {}
      },
      "token": {
        "id": "sample",
        "label": "sample",
        "scopes": [
          "sample"
        ],
        "issuedAt": 0,
        "lastUsedAt": 0,
        "rotatedAt": 0,
        "revokedAt": 0,
        "fingerprint": "sample",
        "value": "sample"
      }
    }
  },
  "remote.snapshot": {
    "methodId": "remote.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/remote"
    },
    "status": 200,
    "body": {
      "daemon": {
        "transportState": "sample",
        "isRunning": false,
        "reconnectAttempts": 0,
        "runningJobCount": 0,
        "lastError": "sample"
      },
      "acp": {
        "transportState": "sample",
        "activeConnectionIds": [
          "sample"
        ],
        "totalSpawned": 0,
        "totalFailed": 0,
        "lastError": "sample"
      },
      "registry": {
        "pools": 0,
        "contracts": 0,
        "artifacts": 0,
        "poolEntries": [
          {
            "id": "sample",
            "label": "sample",
            "trustClass": "sample",
            "preferredTemplate": "sample",
            "maxRunners": 0,
            "runnerIds": [
              "sample"
            ]
          }
        ],
        "contractEntries": [
          {
            "id": "sample",
            "runnerId": "sample",
            "label": "sample",
            "template": "sample",
            "poolId": "sample",
            "taskId": "sample",
            "sourceTransport": "sample",
            "trustClass": "sample",
            "executionProtocol": "sample",
            "reviewMode": "sample",
            "communicationLane": "sample",
            "transportState": "sample",
            "lastError": "sample"
          }
        ],
        "artifactEntries": [
          {
            "id": "sample",
            "runnerId": "sample",
            "createdAt": 0,
            "status": "sample",
            "summary": "sample",
            "error": "sample"
          }
        ]
      },
      "supervisor": {
        "sessions": 0,
        "degraded": 0,
        "capturedAt": 0,
        "entries": [
          {
            "runnerId": "sample",
            "label": "sample",
            "transportState": "sample",
            "heartbeat": "sample",
            "taskId": "sample"
          }
        ]
      },
      "distributed": {
        "pairRequests": [
          {
            "id": "sample",
            "peerKind": "node",
            "requestedId": "sample",
            "label": "sample",
            "platform": "sample",
            "deviceFamily": "sample",
            "version": "sample",
            "clientMode": "sample",
            "capabilities": [
              "sample"
            ],
            "commands": [
              "sample"
            ],
            "requestedBy": "remote",
            "status": "pending",
            "challengePreview": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "approvedAt": 0,
            "verifiedAt": 0,
            "rejectedAt": 0,
            "expiresAt": 0,
            "peerId": "sample",
            "remoteAddress": "sample",
            "metadata": {}
          }
        ],
        "peers": [
          {
            "id": "sample",
            "kind": "node",
            "label": "sample",
            "requestedId": "sample",
            "platform": "sample",
            "deviceFamily": "sample",
            "version": "sample",
            "clientMode": "sample",
            "capabilities": [
              "sample"
            ],
            "commands": [
              "sample"
            ],
            "permissions": {},
            "status": "paired",
            "pairedAt": 0,
            "verifiedAt": 0,
            "lastSeenAt": 0,
            "lastConnectedAt": 0,
            "lastDisconnectedAt": 0,
            "lastRemoteAddress": "sample",
            "activeTokenId": "sample",
            "tokens": [
              {
                "id": "sample",
                "label": "sample",
                "scopes": [
                  "sample"
                ],
                "issuedAt": 0,
                "lastUsedAt": 0,
                "rotatedAt": 0,
                "revokedAt": 0,
                "fingerprint": "sample"
              }
            ],
            "metadata": {}
          }
        ],
        "work": [
          {
            "id": "sample",
            "peerId": "sample",
            "peerKind": "node",
            "type": "invoke",
            "command": "sample",
            "priority": "default",
            "status": "queued",
            "payload": "sample",
            "createdAt": 0,
            "updatedAt": 0,
            "queuedBy": "sample",
            "claimedAt": 0,
            "claimTokenId": "sample",
            "leaseExpiresAt": 0,
            "completedAt": 0,
            "timeoutMs": 0,
            "sessionId": "sample",
            "routeId": "sample",
            "automationRunId": "sample",
            "automationJobId": "sample",
            "approvalId": "sample",
            "result": "sample",
            "error": "sample",
            "telemetry": {
              "usage": {
                "inputTokens": 0,
                "outputTokens": 0,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "reasoningTokens": 0
              },
              "llmCallCount": 0,
              "toolCallCount": 0,
              "turnCount": 0,
              "modelId": "sample",
              "providerId": "sample",
              "reasoningSummaryPresent": false,
              "source": "local-agent"
            },
            "metadata": {}
          }
        ],
        "audit": [
          {
            "id": "sample",
            "action": "pair-requested",
            "actor": "sample",
            "peerId": "sample",
            "requestId": "sample",
            "workId": "sample",
            "createdAt": 0,
            "note": "sample",
            "metadata": {}
          }
        ]
      }
    }
  },
  "remote.work.cancel": {
    "methodId": "remote.work.cancel",
    "http": {
      "method": "POST",
      "path": "/api/remote/work/{workId}/cancel"
    },
    "status": 200,
    "body": {
      "work": {
        "id": "sample",
        "peerId": "sample",
        "peerKind": "node",
        "type": "invoke",
        "command": "sample",
        "priority": "default",
        "status": "queued",
        "payload": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "queuedBy": "sample",
        "claimedAt": 0,
        "claimTokenId": "sample",
        "leaseExpiresAt": 0,
        "completedAt": 0,
        "timeoutMs": 0,
        "sessionId": "sample",
        "routeId": "sample",
        "automationRunId": "sample",
        "automationJobId": "sample",
        "approvalId": "sample",
        "result": "sample",
        "error": "sample",
        "telemetry": {
          "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0
          },
          "llmCallCount": 0,
          "toolCallCount": 0,
          "turnCount": 0,
          "modelId": "sample",
          "providerId": "sample",
          "reasoningSummaryPresent": false,
          "source": "local-agent"
        },
        "metadata": {}
      }
    }
  },
  "remote.work.list": {
    "methodId": "remote.work.list",
    "http": {
      "method": "GET",
      "path": "/api/remote/work"
    },
    "status": 200,
    "body": {
      "work": [
        {
          "id": "sample",
          "peerId": "sample",
          "peerKind": "node",
          "type": "invoke",
          "command": "sample",
          "priority": "default",
          "status": "queued",
          "payload": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "queuedBy": "sample",
          "claimedAt": 0,
          "claimTokenId": "sample",
          "leaseExpiresAt": 0,
          "completedAt": 0,
          "timeoutMs": 0,
          "sessionId": "sample",
          "routeId": "sample",
          "automationRunId": "sample",
          "automationJobId": "sample",
          "approvalId": "sample",
          "result": "sample",
          "error": "sample",
          "telemetry": {
            "usage": {
              "inputTokens": 0,
              "outputTokens": 0,
              "cacheReadTokens": 0,
              "cacheWriteTokens": 0,
              "reasoningTokens": 0
            },
            "llmCallCount": 0,
            "toolCallCount": 0,
            "turnCount": 0,
            "modelId": "sample",
            "providerId": "sample",
            "reasoningSummaryPresent": false,
            "source": "local-agent"
          },
          "metadata": {}
        }
      ]
    }
  },
  "review.snapshot": {
    "methodId": "review.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/review"
    },
    "status": 200,
    "body": {
      "apiFamilies": [
        "sample"
      ],
      "routes": [
        "sample"
      ],
      "sessions": 0,
      "tasks": 0,
      "pendingApprovals": 0,
      "remoteContracts": 0,
      "panels": 0
    }
  },
  "rewind.apply": {
    "methodId": "rewind.apply",
    "http": null,
    "status": 200,
    "body": {
      "receipt": {
        "sessionId": "sample",
        "turnId": "sample",
        "scope": "files",
        "appliedAt": 0,
        "files": {
          "restored": false,
          "checkpointId": "sample",
          "safetyCheckpointId": "sample",
          "restoredFileCount": 0,
          "removedFileCount": 0
        },
        "conversation": {
          "rewound": false,
          "droppedMessages": 0,
          "undoSnapshotId": "sample"
        },
        "undo": {
          "files": {
            "restoreCheckpointId": "sample"
          },
          "conversation": {
            "undoSnapshotId": "sample"
          }
        },
        "warnings": [
          "sample"
        ]
      },
      "refused": false,
      "refusal": {
        "reason": "sample",
        "confirmField": "sample",
        "planMethod": "sample",
        "options": [
          "sample"
        ]
      }
    }
  },
  "rewind.plan": {
    "methodId": "rewind.plan",
    "http": null,
    "status": 200,
    "body": {
      "sessionId": "sample",
      "turnId": "sample",
      "scope": "files",
      "token": "sample",
      "expiresAt": 0,
      "files": {
        "available": false,
        "checkpointId": "sample",
        "checkpointLabel": "sample",
        "affectedFileCount": 0
      },
      "conversation": {
        "available": false,
        "messagesToDrop": 0,
        "messagesRemaining": 0
      },
      "warnings": [
        "sample"
      ]
    }
  },
  "routes.bindings.create": {
    "methodId": "routes.bindings.create",
    "http": {
      "method": "POST",
      "path": "/api/routes/bindings"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "kind": "session",
      "surfaceKind": "tui",
      "surfaceId": "sample",
      "externalId": "sample",
      "sessionPolicy": "create-or-bind",
      "threadPolicy": "preserve",
      "deliveryGuarantee": "best-effort",
      "threadId": "sample",
      "channelId": "sample",
      "sessionId": "sample",
      "jobId": "sample",
      "runId": "sample",
      "title": "sample",
      "lastSeenAt": 0,
      "createdAt": 0,
      "updatedAt": 0,
      "metadata": {}
    }
  },
  "routes.bindings.delete": {
    "methodId": "routes.bindings.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/routes/bindings/{bindingId}"
    },
    "status": 200,
    "body": {
      "removed": false,
      "id": "sample"
    }
  },
  "routes.bindings.list": {
    "methodId": "routes.bindings.list",
    "http": {
      "method": "GET",
      "path": "/api/routes/bindings"
    },
    "status": 200,
    "body": {
      "bindings": [
        {
          "id": "sample",
          "kind": "session",
          "surfaceKind": "tui",
          "surfaceId": "sample",
          "externalId": "sample",
          "sessionPolicy": "create-or-bind",
          "threadPolicy": "preserve",
          "deliveryGuarantee": "best-effort",
          "threadId": "sample",
          "channelId": "sample",
          "sessionId": "sample",
          "jobId": "sample",
          "runId": "sample",
          "title": "sample",
          "lastSeenAt": 0,
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "routes.bindings.update": {
    "methodId": "routes.bindings.update",
    "http": {
      "method": "PATCH",
      "path": "/api/routes/bindings/{bindingId}"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "kind": "session",
      "surfaceKind": "tui",
      "surfaceId": "sample",
      "externalId": "sample",
      "sessionPolicy": "create-or-bind",
      "threadPolicy": "preserve",
      "deliveryGuarantee": "best-effort",
      "threadId": "sample",
      "channelId": "sample",
      "sessionId": "sample",
      "jobId": "sample",
      "runId": "sample",
      "title": "sample",
      "lastSeenAt": 0,
      "createdAt": 0,
      "updatedAt": 0,
      "metadata": {}
    }
  },
  "routes.snapshot": {
    "methodId": "routes.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/routes"
    },
    "status": 200,
    "body": {
      "totalBindings": 0,
      "activeBindings": 0,
      "recentBindings": 0,
      "bindings": [
        {
          "id": "sample",
          "kind": "session",
          "surfaceKind": "tui",
          "surfaceId": "sample",
          "externalId": "sample",
          "sessionPolicy": "create-or-bind",
          "threadPolicy": "preserve",
          "deliveryGuarantee": "best-effort",
          "threadId": "sample",
          "channelId": "sample",
          "sessionId": "sample",
          "jobId": "sample",
          "runId": "sample",
          "title": "sample",
          "lastSeenAt": 0,
          "createdAt": 0,
          "updatedAt": 0,
          "metadata": {}
        }
      ]
    }
  },
  "surfaces.list": {
    "methodId": "surfaces.list",
    "http": {
      "method": "GET",
      "path": "/api/surfaces"
    },
    "status": 200,
    "body": {
      "surfaces": [
        {
          "id": "sample",
          "kind": "sample",
          "label": "sample",
          "enabled": false,
          "state": "sample",
          "configuredAt": 0,
          "lastSeenAt": 0,
          "defaultRouteId": "sample",
          "accountId": "sample",
          "capabilities": [
            "sample"
          ],
          "metadata": {}
        }
      ]
    }
  },
  "runtime.metrics.get": {
    "methodId": "runtime.metrics.get",
    "http": {
      "method": "GET",
      "path": "/api/runtime/metrics"
    },
    "status": 200,
    "body": {
      "counters": {},
      "gauges": {},
      "histograms": {},
      "toolFormat": {
        "byModel": {},
        "byClass": {}
      }
    }
  },
  "scheduler.capacity": {
    "methodId": "scheduler.capacity",
    "http": {
      "method": "GET",
      "path": "/api/runtime/scheduler"
    },
    "status": 200,
    "body": {
      "slotsTotal": 0,
      "slotsInUse": 0,
      "queueDepth": 0,
      "oldestQueuedAgeMs": 0
    }
  },
  "services.install": {
    "methodId": "services.install",
    "http": {
      "method": "POST",
      "path": "/api/service/install"
    },
    "status": 200,
    "body": {
      "platform": "sample",
      "serviceName": "sample",
      "path": "sample",
      "installed": false,
      "autostart": false,
      "running": false,
      "pid": 0,
      "logPath": "sample",
      "commandPreview": "sample",
      "contents": "sample",
      "suggestedCommands": [
        "sample"
      ],
      "lastAction": "sample",
      "actionError": "sample",
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "services.restart": {
    "methodId": "services.restart",
    "http": {
      "method": "POST",
      "path": "/api/service/restart"
    },
    "status": 200,
    "body": {
      "platform": "sample",
      "serviceName": "sample",
      "path": "sample",
      "installed": false,
      "autostart": false,
      "running": false,
      "pid": 0,
      "logPath": "sample",
      "commandPreview": "sample",
      "contents": "sample",
      "suggestedCommands": [
        "sample"
      ],
      "lastAction": "sample",
      "actionError": "sample",
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "services.start": {
    "methodId": "services.start",
    "http": {
      "method": "POST",
      "path": "/api/service/start"
    },
    "status": 200,
    "body": {
      "platform": "sample",
      "serviceName": "sample",
      "path": "sample",
      "installed": false,
      "autostart": false,
      "running": false,
      "pid": 0,
      "logPath": "sample",
      "commandPreview": "sample",
      "contents": "sample",
      "suggestedCommands": [
        "sample"
      ],
      "lastAction": "sample",
      "actionError": "sample",
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "services.status": {
    "methodId": "services.status",
    "http": {
      "method": "GET",
      "path": "/api/service/status"
    },
    "status": 200,
    "body": {
      "platform": "sample",
      "serviceName": "sample",
      "path": "sample",
      "installed": false,
      "autostart": false,
      "running": false,
      "pid": 0,
      "logPath": "sample",
      "commandPreview": "sample",
      "contents": "sample",
      "suggestedCommands": [
        "sample"
      ],
      "lastAction": "sample",
      "actionError": "sample",
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "services.stop": {
    "methodId": "services.stop",
    "http": {
      "method": "POST",
      "path": "/api/service/stop"
    },
    "status": 200,
    "body": {
      "platform": "sample",
      "serviceName": "sample",
      "path": "sample",
      "installed": false,
      "autostart": false,
      "running": false,
      "pid": 0,
      "logPath": "sample",
      "commandPreview": "sample",
      "contents": "sample",
      "suggestedCommands": [
        "sample"
      ],
      "lastAction": "sample",
      "actionError": "sample",
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "services.uninstall": {
    "methodId": "services.uninstall",
    "http": {
      "method": "POST",
      "path": "/api/service/uninstall"
    },
    "status": 200,
    "body": {
      "platform": "sample",
      "serviceName": "sample",
      "path": "sample",
      "installed": false,
      "autostart": false,
      "running": false,
      "pid": 0,
      "logPath": "sample",
      "commandPreview": "sample",
      "contents": "sample",
      "suggestedCommands": [
        "sample"
      ],
      "lastAction": "sample",
      "actionError": "sample",
      "network": {
        "controlPlane": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "httpListener": {
          "surface": "controlPlane",
          "host": "sample",
          "port": 0,
          "mode": "off",
          "scheme": "http",
          "trustProxy": false,
          "certFile": "sample",
          "keyFile": "sample",
          "usingDefaultPaths": false,
          "ready": false,
          "errors": [
            "sample"
          ],
          "keyPermissions": {
            "available": false,
            "safe": false,
            "mode": "sample"
          }
        },
        "outbound": {
          "mode": "bundled",
          "allowInsecureLocalhost": false,
          "customCaFile": "sample",
          "customCaDir": "sample",
          "customCaEntryCount": 0,
          "effectiveCaStrategy": "bun-default",
          "errors": [
            "sample"
          ]
        }
      }
    }
  },
  "sessions.changes.get": {
    "methodId": "sessions.changes.get",
    "http": null,
    "status": 200,
    "body": {
      "sessionId": "sample",
      "checkpointCount": 0,
      "checkpointIds": [
        "sample"
      ],
      "from": "sample",
      "to": "sample",
      "files": [
        "sample"
      ],
      "unifiedDiff": "sample",
      "stat": "sample"
    }
  },
  "sessions.close": {
    "methodId": "sessions.close",
    "http": {
      "method": "POST",
      "path": "/api/sessions/{sessionId}/close"
    },
    "status": 200,
    "body": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      }
    }
  },
  "sessions.contextUsage.get": {
    "methodId": "sessions.contextUsage.get",
    "http": {
      "method": "GET",
      "path": "/api/sessions/{sessionId}/context-usage"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "estimatedContextTokens": 0,
      "contextWindow": 0,
      "contextUsagePct": 0,
      "contextRemainingTokens": 0,
      "estimated": false
    }
  },
  "sessions.create": {
    "methodId": "sessions.create",
    "http": {
      "method": "POST",
      "path": "/api/sessions"
    },
    "status": 200,
    "body": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      }
    }
  },
  "sessions.delete": {
    "methodId": "sessions.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/sessions/{sessionId}"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "deleted": false
    }
  },
  "sessions.detach": {
    "methodId": "sessions.detach",
    "http": {
      "method": "POST",
      "path": "/api/sessions/{sessionId}/detach"
    },
    "status": 200,
    "body": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      }
    }
  },
  "sessions.followUp": {
    "methodId": "sessions.followUp",
    "http": {
      "method": "POST",
      "path": "/api/sessions/{sessionId}/follow-up"
    },
    "status": 200,
    "body": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      },
      "message": {
        "id": "sample",
        "sessionId": "sample",
        "role": "user",
        "body": "sample",
        "createdAt": 0,
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "routeId": "sample",
        "agentId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "metadata": {}
      },
      "input": {
        "id": "sample",
        "sessionId": "sample",
        "intent": "submit",
        "state": "queued",
        "correlationId": "sample",
        "causationId": "sample",
        "body": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "routeId": "sample",
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "externalId": "sample",
        "threadId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "activeAgentId": "sample",
        "metadata": {},
        "routing": {
          "providerId": "sample",
          "modelId": "sample",
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ],
          "helperModel": {
            "providerId": "sample",
            "modelId": "sample"
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "tools": [
            "sample"
          ],
          "reasoningEffort": "instant"
        },
        "error": "sample"
      },
      "mode": "spawn",
      "agentId": "sample"
    }
  },
  "sessions.get": {
    "methodId": "sessions.get",
    "http": {
      "method": "GET",
      "path": "/api/sessions/{sessionId}"
    },
    "status": 200,
    "body": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      },
      "messages": [
        {
          "id": "sample",
          "sessionId": "sample",
          "role": "user",
          "body": "sample",
          "createdAt": 0,
          "surfaceKind": "sample",
          "surfaceId": "sample",
          "routeId": "sample",
          "agentId": "sample",
          "userId": "sample",
          "displayName": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "sessions.inputs.cancel": {
    "methodId": "sessions.inputs.cancel",
    "http": {
      "method": "POST",
      "path": "/api/sessions/{sessionId}/inputs/{inputId}/cancel"
    },
    "status": 200,
    "body": {
      "input": {
        "id": "sample",
        "sessionId": "sample",
        "intent": "submit",
        "state": "queued",
        "correlationId": "sample",
        "causationId": "sample",
        "body": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "routeId": "sample",
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "externalId": "sample",
        "threadId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "activeAgentId": "sample",
        "metadata": {},
        "routing": {
          "providerId": "sample",
          "modelId": "sample",
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ],
          "helperModel": {
            "providerId": "sample",
            "modelId": "sample"
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "tools": [
            "sample"
          ],
          "reasoningEffort": "instant"
        },
        "error": "sample"
      }
    }
  },
  "sessions.inputs.deliver": {
    "methodId": "sessions.inputs.deliver",
    "http": {
      "method": "POST",
      "path": "/api/sessions/{sessionId}/inputs/{inputId}/deliver"
    },
    "status": 200,
    "body": {
      "input": {
        "id": "sample",
        "sessionId": "sample",
        "intent": "submit",
        "state": "queued",
        "correlationId": "sample",
        "causationId": "sample",
        "body": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "routeId": "sample",
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "externalId": "sample",
        "threadId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "activeAgentId": "sample",
        "metadata": {},
        "routing": {
          "providerId": "sample",
          "modelId": "sample",
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ],
          "helperModel": {
            "providerId": "sample",
            "modelId": "sample"
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "tools": [
            "sample"
          ],
          "reasoningEffort": "instant"
        },
        "error": "sample"
      }
    }
  },
  "sessions.inputs.list": {
    "methodId": "sessions.inputs.list",
    "http": {
      "method": "GET",
      "path": "/api/sessions/{sessionId}/inputs"
    },
    "status": 200,
    "body": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      },
      "inputs": [
        {
          "id": "sample",
          "sessionId": "sample",
          "intent": "submit",
          "state": "queued",
          "correlationId": "sample",
          "causationId": "sample",
          "body": "sample",
          "createdAt": 0,
          "updatedAt": 0,
          "routeId": "sample",
          "surfaceKind": "sample",
          "surfaceId": "sample",
          "externalId": "sample",
          "threadId": "sample",
          "userId": "sample",
          "displayName": "sample",
          "activeAgentId": "sample",
          "metadata": {},
          "routing": {
            "providerId": "sample",
            "modelId": "sample",
            "providerSelection": "inherit-current",
            "providerFailurePolicy": "ordered-fallbacks",
            "fallbackModels": [
              "sample"
            ],
            "helperModel": {
              "providerId": "sample",
              "modelId": "sample"
            },
            "executionIntent": {
              "riskClass": "safe",
              "requiresApproval": false,
              "networkPolicy": "inherit",
              "filesystemPolicy": "inherit"
            },
            "tools": [
              "sample"
            ],
            "reasoningEffort": "instant"
          },
          "error": "sample"
        }
      ]
    }
  },
  "sessions.integration.snapshot": {
    "methodId": "sessions.integration.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/session"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "title": "sample",
      "status": "sample",
      "recoveryState": "sample",
      "projectRoot": "sample",
      "isResumed": false,
      "resumedFromId": "sample",
      "compactionState": "sample",
      "lastCompactedAt": 0,
      "lineage": [
        "sample"
      ]
    }
  },
  "sessions.list": {
    "methodId": "sessions.list",
    "http": {
      "method": "GET",
      "path": "/api/sessions"
    },
    "status": 200,
    "body": {
      "totals": {
        "sessions": 0,
        "active": 0,
        "closed": 0
      },
      "sessions": [
        {
          "id": "sample",
          "kind": "sample",
          "project": "sample",
          "title": "sample",
          "status": "active",
          "createdAt": 0,
          "updatedAt": 0,
          "lastMessageAt": 0,
          "closedAt": 0,
          "lastActivityAt": 0,
          "messageCount": 0,
          "retainedMessageCount": 0,
          "pendingInputCount": 0,
          "routeIds": [
            "sample"
          ],
          "surfaceKinds": [
            "sample"
          ],
          "participants": [
            {
              "surfaceKind": "sample",
              "surfaceId": "sample",
              "externalId": "sample",
              "userId": "sample",
              "displayName": "sample",
              "routeId": "sample",
              "lastSeenAt": 0
            }
          ],
          "activeAgentId": "sample",
          "lastAgentId": "sample",
          "lastError": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "sessions.messages.create": {
    "methodId": "sessions.messages.create",
    "http": {
      "method": "POST",
      "path": "/api/sessions/{sessionId}/messages"
    },
    "status": 200,
    "body": {
      "messageId": "sample",
      "routedTo": "sample",
      "sessionId": "sample"
    }
  },
  "sessions.messages.list": {
    "methodId": "sessions.messages.list",
    "http": {
      "method": "GET",
      "path": "/api/sessions/{sessionId}/messages"
    },
    "status": 200,
    "body": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      },
      "messages": [
        {
          "id": "sample",
          "sessionId": "sample",
          "role": "user",
          "body": "sample",
          "createdAt": 0,
          "surfaceKind": "sample",
          "surfaceId": "sample",
          "routeId": "sample",
          "agentId": "sample",
          "userId": "sample",
          "displayName": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "sessions.permissionMode.get": {
    "methodId": "sessions.permissionMode.get",
    "http": {
      "method": "GET",
      "path": "/api/sessions/{sessionId}/permission-mode"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "mode": "plan"
    }
  },
  "sessions.permissionMode.set": {
    "methodId": "sessions.permissionMode.set",
    "http": {
      "method": "POST",
      "path": "/api/sessions/{sessionId}/permission-mode"
    },
    "status": 200,
    "body": {
      "sessionId": "sample",
      "mode": "plan",
      "previousMode": "plan"
    }
  },
  "sessions.register": {
    "methodId": "sessions.register",
    "http": {
      "method": "POST",
      "path": "/api/sessions/register"
    },
    "status": 200,
    "body": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      },
      "reopened": false,
      "conflict": {
        "status": "closed"
      }
    }
  },
  "sessions.reopen": {
    "methodId": "sessions.reopen",
    "http": {
      "method": "POST",
      "path": "/api/sessions/{sessionId}/reopen"
    },
    "status": 200,
    "body": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      }
    }
  },
  "sessions.search": {
    "methodId": "sessions.search",
    "http": null,
    "status": 200,
    "body": {
      "sessions": [
        {
          "id": "sample",
          "kind": "sample",
          "project": "sample",
          "title": "sample",
          "status": "active",
          "createdAt": 0,
          "updatedAt": 0,
          "lastMessageAt": 0,
          "closedAt": 0,
          "lastActivityAt": 0,
          "messageCount": 0,
          "retainedMessageCount": 0,
          "pendingInputCount": 0,
          "routeIds": [
            "sample"
          ],
          "surfaceKinds": [
            "sample"
          ],
          "participants": [
            {
              "surfaceKind": "sample",
              "surfaceId": "sample",
              "externalId": "sample",
              "userId": "sample",
              "displayName": "sample",
              "routeId": "sample",
              "lastSeenAt": 0
            }
          ],
          "activeAgentId": "sample",
          "lastAgentId": "sample",
          "lastError": "sample",
          "metadata": {}
        }
      ],
      "nextCursor": "sample",
      "hasMore": false
    }
  },
  "sessions.steer": {
    "methodId": "sessions.steer",
    "http": {
      "method": "POST",
      "path": "/api/sessions/{sessionId}/steer"
    },
    "status": 200,
    "body": {
      "session": {
        "id": "sample",
        "kind": "sample",
        "project": "sample",
        "title": "sample",
        "status": "active",
        "createdAt": 0,
        "updatedAt": 0,
        "lastMessageAt": 0,
        "closedAt": 0,
        "lastActivityAt": 0,
        "messageCount": 0,
        "retainedMessageCount": 0,
        "pendingInputCount": 0,
        "routeIds": [
          "sample"
        ],
        "surfaceKinds": [
          "sample"
        ],
        "participants": [
          {
            "surfaceKind": "sample",
            "surfaceId": "sample",
            "externalId": "sample",
            "userId": "sample",
            "displayName": "sample",
            "routeId": "sample",
            "lastSeenAt": 0
          }
        ],
        "activeAgentId": "sample",
        "lastAgentId": "sample",
        "lastError": "sample",
        "metadata": {}
      },
      "message": {
        "id": "sample",
        "sessionId": "sample",
        "role": "user",
        "body": "sample",
        "createdAt": 0,
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "routeId": "sample",
        "agentId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "metadata": {}
      },
      "input": {
        "id": "sample",
        "sessionId": "sample",
        "intent": "submit",
        "state": "queued",
        "correlationId": "sample",
        "causationId": "sample",
        "body": "sample",
        "createdAt": 0,
        "updatedAt": 0,
        "routeId": "sample",
        "surfaceKind": "sample",
        "surfaceId": "sample",
        "externalId": "sample",
        "threadId": "sample",
        "userId": "sample",
        "displayName": "sample",
        "activeAgentId": "sample",
        "metadata": {},
        "routing": {
          "providerId": "sample",
          "modelId": "sample",
          "providerSelection": "inherit-current",
          "providerFailurePolicy": "ordered-fallbacks",
          "fallbackModels": [
            "sample"
          ],
          "helperModel": {
            "providerId": "sample",
            "modelId": "sample"
          },
          "executionIntent": {
            "riskClass": "safe",
            "requiresApproval": false,
            "networkPolicy": "inherit",
            "filesystemPolicy": "inherit"
          },
          "tools": [
            "sample"
          ],
          "reasoningEffort": "instant"
        },
        "error": "sample"
      },
      "mode": "spawn",
      "agentId": "sample"
    }
  },
  "security.settings": {
    "methodId": "security.settings",
    "http": {
      "method": "GET",
      "path": "/api/security-settings"
    },
    "status": 200,
    "body": {
      "settings": [
        {
          "key": "sample",
          "type": "feature-flag",
          "defaultState": "sample",
          "currentState": "sample",
          "securityRelevant": false,
          "summary": "sample",
          "insecureWhen": "sample",
          "enablementEffect": "sample",
          "enablementRequirements": [
            "sample"
          ],
          "operationalNotes": [
            "sample"
          ]
        }
      ]
    }
  },
  "settings.snapshot": {
    "methodId": "settings.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/settings"
    },
    "status": 200,
    "body": {
      "available": false,
      "reason": "sample"
    }
  },
  "skills.create": {
    "methodId": "skills.create",
    "http": {
      "method": "POST",
      "path": "/api/skills"
    },
    "status": 200,
    "body": {
      "skill": {
        "name": "sample",
        "description": "sample",
        "metadata": {},
        "updatedAt": 0,
        "body": "sample"
      }
    }
  },
  "skills.delete": {
    "methodId": "skills.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/skills/{name}"
    },
    "status": 200,
    "body": {
      "name": "sample",
      "deleted": false
    }
  },
  "skills.get": {
    "methodId": "skills.get",
    "http": {
      "method": "GET",
      "path": "/api/skills/{name}"
    },
    "status": 200,
    "body": {
      "skill": {
        "name": "sample",
        "description": "sample",
        "metadata": {},
        "updatedAt": 0,
        "body": "sample"
      }
    }
  },
  "skills.list": {
    "methodId": "skills.list",
    "http": {
      "method": "GET",
      "path": "/api/skills"
    },
    "status": 200,
    "body": {
      "skills": [
        {
          "name": "sample",
          "description": "sample",
          "metadata": {},
          "updatedAt": 0
        }
      ]
    }
  },
  "skills.update": {
    "methodId": "skills.update",
    "http": {
      "method": "POST",
      "path": "/api/skills/{name}/update"
    },
    "status": 200,
    "body": {
      "skill": {
        "name": "sample",
        "description": "sample",
        "metadata": {},
        "updatedAt": 0,
        "body": "sample"
      }
    }
  },
  "tasks.cancel": {
    "methodId": "tasks.cancel",
    "http": {
      "method": "POST",
      "path": "/api/tasks/{taskId}/cancel"
    },
    "status": 200,
    "body": {
      "retried": false,
      "task": {
        "id": "sample",
        "kind": "exec",
        "title": "sample",
        "description": "sample",
        "status": "queued",
        "owner": "sample",
        "cancellable": false,
        "parentTaskId": "sample",
        "childTaskIds": [
          "sample"
        ],
        "queuedAt": 0,
        "startedAt": 0,
        "endedAt": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "currentAttempt": 0,
          "delayMs": 0,
          "backoff": "fixed",
          "retryOn": [
            "network"
          ]
        },
        "retryDelayMs": 0,
        "retryAt": 0,
        "exitCode": 0,
        "error": "sample",
        "result": "sample",
        "correlationId": "sample",
        "turnId": "sample"
      },
      "agentId": "sample"
    }
  },
  "tasks.create": {
    "methodId": "tasks.create",
    "http": {
      "method": "POST",
      "path": "/task"
    },
    "status": 200,
    "body": {
      "acknowledged": false,
      "mode": "sample",
      "sessionId": "sample",
      "agentId": "sample",
      "status": "sample",
      "task": "sample",
      "model": "sample",
      "tools": [
        "sample"
      ]
    }
  },
  "tasks.get": {
    "methodId": "tasks.get",
    "http": {
      "method": "GET",
      "path": "/api/tasks/{taskId}"
    },
    "status": 200,
    "body": {
      "task": {
        "id": "sample",
        "kind": "exec",
        "title": "sample",
        "description": "sample",
        "status": "queued",
        "owner": "sample",
        "cancellable": false,
        "parentTaskId": "sample",
        "childTaskIds": [
          "sample"
        ],
        "queuedAt": 0,
        "startedAt": 0,
        "endedAt": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "currentAttempt": 0,
          "delayMs": 0,
          "backoff": "fixed",
          "retryOn": [
            "network"
          ]
        },
        "retryDelayMs": 0,
        "retryAt": 0,
        "exitCode": 0,
        "error": "sample",
        "result": "sample",
        "correlationId": "sample",
        "turnId": "sample"
      }
    }
  },
  "tasks.list": {
    "methodId": "tasks.list",
    "http": {
      "method": "GET",
      "path": "/api/tasks"
    },
    "status": 200,
    "body": {
      "queued": 0,
      "running": 0,
      "blocked": 0,
      "totals": {
        "created": 0,
        "completed": 0,
        "failed": 0,
        "cancelled": 0
      },
      "tasks": [
        {
          "id": "sample",
          "kind": "exec",
          "title": "sample",
          "status": "queued",
          "owner": "sample",
          "parentTaskId": "sample",
          "queuedAt": 0,
          "startedAt": 0,
          "endedAt": 0,
          "error": "sample"
        }
      ]
    }
  },
  "tasks.retry": {
    "methodId": "tasks.retry",
    "http": {
      "method": "POST",
      "path": "/api/tasks/{taskId}/retry"
    },
    "status": 200,
    "body": {
      "retried": false,
      "task": {
        "id": "sample",
        "kind": "exec",
        "title": "sample",
        "description": "sample",
        "status": "queued",
        "owner": "sample",
        "cancellable": false,
        "parentTaskId": "sample",
        "childTaskIds": [
          "sample"
        ],
        "queuedAt": 0,
        "startedAt": 0,
        "endedAt": 0,
        "retryPolicy": {
          "maxAttempts": 0,
          "currentAttempt": 0,
          "delayMs": 0,
          "backoff": "fixed",
          "retryOn": [
            "network"
          ]
        },
        "retryDelayMs": 0,
        "retryAt": 0,
        "exitCode": 0,
        "error": "sample",
        "result": "sample",
        "correlationId": "sample",
        "turnId": "sample"
      },
      "agentId": "sample"
    }
  },
  "tasks.status": {
    "methodId": "tasks.status",
    "http": {
      "method": "GET",
      "path": "/task/{agentId}"
    },
    "status": 200,
    "body": {
      "agentId": "sample",
      "task": "sample",
      "status": "sample",
      "model": "sample",
      "tools": [
        "sample"
      ],
      "durationMs": 0,
      "toolCallCount": 0,
      "progress": "sample",
      "error": "sample"
    }
  },
  "telemetry.errors.list": {
    "methodId": "telemetry.errors.list",
    "http": {
      "method": "GET",
      "path": "/api/v1/telemetry/errors"
    },
    "status": 200,
    "body": {
      "version": 0,
      "view": "safe",
      "rawAccessible": false,
      "items": [
        {
          "id": "sample",
          "domain": "sample",
          "type": "sample",
          "timestamp": 0,
          "severity": "debug",
          "traceId": "sample",
          "sessionId": "sample",
          "turnId": "sample",
          "agentId": "sample",
          "taskId": "sample",
          "source": "sample",
          "message": "sample",
          "payload": "sample",
          "attributes": {},
          "error": {
            "name": "sample",
            "message": "sample",
            "summary": "sample",
            "hint": "sample",
            "code": "sample",
            "category": "authentication",
            "source": "provider",
            "recoverable": false,
            "statusCode": 0,
            "provider": "sample",
            "operation": "sample",
            "phase": "sample",
            "requestId": "sample",
            "providerCode": "sample",
            "providerType": "sample",
            "retryAfterMs": 0
          }
        }
      ],
      "pageInfo": {
        "limit": 0,
        "returned": 0,
        "hasMore": false,
        "cursor": "sample",
        "nextCursor": "sample"
      }
    }
  },
  "telemetry.events.list": {
    "methodId": "telemetry.events.list",
    "http": {
      "method": "GET",
      "path": "/api/v1/telemetry/events"
    },
    "status": 200,
    "body": {
      "version": 0,
      "view": "safe",
      "rawAccessible": false,
      "items": [
        {
          "id": "sample",
          "domain": "sample",
          "type": "sample",
          "timestamp": 0,
          "severity": "debug",
          "traceId": "sample",
          "sessionId": "sample",
          "turnId": "sample",
          "agentId": "sample",
          "taskId": "sample",
          "source": "sample",
          "message": "sample",
          "payload": "sample",
          "attributes": {},
          "error": {
            "name": "sample",
            "message": "sample",
            "summary": "sample",
            "hint": "sample",
            "code": "sample",
            "category": "authentication",
            "source": "provider",
            "recoverable": false,
            "statusCode": 0,
            "provider": "sample",
            "operation": "sample",
            "phase": "sample",
            "requestId": "sample",
            "providerCode": "sample",
            "providerType": "sample",
            "retryAfterMs": 0
          }
        }
      ],
      "pageInfo": {
        "limit": 0,
        "returned": 0,
        "hasMore": false,
        "cursor": "sample",
        "nextCursor": "sample"
      }
    }
  },
  "telemetry.metrics.get": {
    "methodId": "telemetry.metrics.get",
    "http": {
      "method": "GET",
      "path": "/api/v1/telemetry/metrics"
    },
    "status": 200,
    "body": {
      "version": 0,
      "view": "safe",
      "rawAccessible": false,
      "generatedAt": 0,
      "runtime": {
        "sessionId": "sample",
        "sessionStatus": "sample",
        "traceContext": {
          "traceId": "sample",
          "rootSpanId": "sample",
          "exportActive": false,
          "endpoint": "sample"
        },
        "sessionCorrelationId": "sample",
        "currentTurnCorrelationId": "sample",
        "dbAvailable": false,
        "dbPath": "sample",
        "tasks": {
          "total": 0,
          "queued": 0,
          "running": 0,
          "blocked": 0
        },
        "agents": {
          "total": 0,
          "active": 0
        },
        "approvals": {
          "pending": 0
        }
      },
      "sessionMetrics": {
        "turns": 0,
        "toolCalls": 0,
        "toolErrors": 0,
        "agentsSpawned": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "permissionPrompts": 0,
        "permissionDenials": 0,
        "errors": 0,
        "warnings": 0
      },
      "aggregates": {
        "totalEvents": 0,
        "totalErrors": 0,
        "totalWarnings": 0,
        "totalSpans": 0,
        "byDomain": {},
        "byEventType": {},
        "errorsByCategory": {}
      }
    }
  },
  "telemetry.otlp.logs": {
    "methodId": "telemetry.otlp.logs",
    "http": {
      "method": "GET",
      "path": "/api/v1/telemetry/otlp/v1/logs"
    },
    "status": 200,
    "body": {
      "resourceLogs": [
        {}
      ]
    }
  },
  "telemetry.otlp.metrics": {
    "methodId": "telemetry.otlp.metrics",
    "http": {
      "method": "GET",
      "path": "/api/v1/telemetry/otlp/v1/metrics"
    },
    "status": 200,
    "body": {
      "resourceMetrics": [
        {}
      ]
    }
  },
  "telemetry.otlp.traces": {
    "methodId": "telemetry.otlp.traces",
    "http": {
      "method": "GET",
      "path": "/api/v1/telemetry/otlp/v1/traces"
    },
    "status": 200,
    "body": {
      "resourceSpans": [
        {}
      ]
    }
  },
  "telemetry.snapshot": {
    "methodId": "telemetry.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/v1/telemetry"
    },
    "status": 200,
    "body": {
      "version": 0,
      "view": "safe",
      "rawAccessible": false,
      "generatedAt": 0,
      "service": {
        "name": "sample",
        "version": "sample"
      },
      "capabilities": {
        "signals": {
          "events": false,
          "errors": false,
          "metrics": false,
          "traces": false
        },
        "encodings": {
          "json": false,
          "sse": false,
          "otlpJson": {
            "traces": false,
            "metrics": false,
            "logs": false
          }
        }
      },
      "runtime": {
        "sessionId": "sample",
        "sessionStatus": "sample",
        "traceContext": {
          "traceId": "sample",
          "rootSpanId": "sample",
          "exportActive": false,
          "endpoint": "sample"
        },
        "sessionCorrelationId": "sample",
        "currentTurnCorrelationId": "sample",
        "dbAvailable": false,
        "dbPath": "sample",
        "tasks": {
          "total": 0,
          "queued": 0,
          "running": 0,
          "blocked": 0
        },
        "agents": {
          "total": 0,
          "active": 0
        },
        "approvals": {
          "pending": 0
        }
      },
      "sessionMetrics": {
        "turns": 0,
        "toolCalls": 0,
        "toolErrors": 0,
        "agentsSpawned": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "permissionPrompts": 0,
        "permissionDenials": 0,
        "errors": 0,
        "warnings": 0
      },
      "aggregates": {
        "totalEvents": 0,
        "totalErrors": 0,
        "totalWarnings": 0,
        "totalSpans": 0,
        "byDomain": {},
        "byEventType": {},
        "errorsByCategory": {}
      },
      "recent": {
        "events": {
          "version": 0,
          "view": "safe",
          "rawAccessible": false,
          "items": [
            {
              "id": "sample",
              "domain": "sample",
              "type": "sample",
              "timestamp": 0,
              "severity": "debug",
              "traceId": "sample",
              "sessionId": "sample",
              "turnId": "sample",
              "agentId": "sample",
              "taskId": "sample",
              "source": "sample",
              "message": "sample",
              "payload": "sample",
              "attributes": {},
              "error": {
                "name": "sample",
                "message": "sample",
                "summary": "sample",
                "hint": "sample",
                "code": "sample",
                "category": "authentication",
                "source": "provider",
                "recoverable": false,
                "statusCode": 0,
                "provider": "sample",
                "operation": "sample",
                "phase": "sample",
                "requestId": "sample",
                "providerCode": "sample",
                "providerType": "sample",
                "retryAfterMs": 0
              }
            }
          ],
          "pageInfo": {
            "limit": 0,
            "returned": 0,
            "hasMore": false,
            "cursor": "sample",
            "nextCursor": "sample"
          }
        },
        "errors": {
          "version": 0,
          "view": "safe",
          "rawAccessible": false,
          "items": [
            {
              "id": "sample",
              "domain": "sample",
              "type": "sample",
              "timestamp": 0,
              "severity": "debug",
              "traceId": "sample",
              "sessionId": "sample",
              "turnId": "sample",
              "agentId": "sample",
              "taskId": "sample",
              "source": "sample",
              "message": "sample",
              "payload": "sample",
              "attributes": {},
              "error": {
                "name": "sample",
                "message": "sample",
                "summary": "sample",
                "hint": "sample",
                "code": "sample",
                "category": "authentication",
                "source": "provider",
                "recoverable": false,
                "statusCode": 0,
                "provider": "sample",
                "operation": "sample",
                "phase": "sample",
                "requestId": "sample",
                "providerCode": "sample",
                "providerType": "sample",
                "retryAfterMs": 0
              }
            }
          ],
          "pageInfo": {
            "limit": 0,
            "returned": 0,
            "hasMore": false,
            "cursor": "sample",
            "nextCursor": "sample"
          }
        },
        "spans": {
          "version": 0,
          "view": "safe",
          "rawAccessible": false,
          "items": [
            {
              "name": "sample",
              "kind": 0,
              "spanContext": {
                "traceId": "sample",
                "spanId": "sample",
                "isValid": false
              },
              "parentSpanId": "sample",
              "startTimeMs": 0,
              "endTimeMs": 0,
              "durationMs": 0,
              "attributes": {},
              "events": [
                {
                  "name": "sample",
                  "timestamp": 0,
                  "attributes": {}
                }
              ],
              "status": {
                "code": 0,
                "message": "sample"
              },
              "instrumentationScope": "sample"
            }
          ],
          "pageInfo": {
            "limit": 0,
            "returned": 0,
            "hasMore": false,
            "cursor": "sample",
            "nextCursor": "sample"
          }
        }
      }
    }
  },
  "telemetry.stream": {
    "methodId": "telemetry.stream",
    "http": {
      "method": "GET",
      "path": "/api/v1/telemetry/stream"
    },
    "status": 200,
    "body": {
      "version": 0,
      "capabilities": {
        "signals": {
          "events": false,
          "errors": false,
          "metrics": false,
          "traces": false
        },
        "encodings": {
          "json": false,
          "sse": false,
          "otlpJson": {
            "traces": false,
            "metrics": false,
            "logs": false
          }
        }
      },
      "view": "safe",
      "rawAccessible": false,
      "resumedFrom": "sample"
    }
  },
  "telemetry.traces.list": {
    "methodId": "telemetry.traces.list",
    "http": {
      "method": "GET",
      "path": "/api/v1/telemetry/traces"
    },
    "status": 200,
    "body": {
      "version": 0,
      "view": "safe",
      "rawAccessible": false,
      "items": [
        {
          "name": "sample",
          "kind": 0,
          "spanContext": {
            "traceId": "sample",
            "spanId": "sample",
            "isValid": false
          },
          "parentSpanId": "sample",
          "startTimeMs": 0,
          "endTimeMs": 0,
          "durationMs": 0,
          "attributes": {},
          "events": [
            {
              "name": "sample",
              "timestamp": 0,
              "attributes": {}
            }
          ],
          "status": {
            "code": 0,
            "message": "sample"
          },
          "instrumentationScope": "sample"
        }
      ],
      "pageInfo": {
        "limit": 0,
        "returned": 0,
        "hasMore": false,
        "cursor": "sample",
        "nextCursor": "sample"
      }
    }
  },
  "voice.providers.list": {
    "methodId": "voice.providers.list",
    "http": {
      "method": "GET",
      "path": "/api/voice/providers"
    },
    "status": 200,
    "body": {
      "providers": [
        {
          "id": "sample",
          "label": "sample",
          "capabilities": [
            "sample"
          ]
        }
      ]
    }
  },
  "voice.realtime.session": {
    "methodId": "voice.realtime.session",
    "http": {
      "method": "POST",
      "path": "/api/voice/realtime/session"
    },
    "status": 200,
    "body": {
      "providerId": "sample",
      "sessionId": "sample",
      "transport": "sample",
      "url": "sample",
      "expiresAt": 0,
      "headers": {},
      "metadata": {}
    }
  },
  "voice.status": {
    "methodId": "voice.status",
    "http": {
      "method": "GET",
      "path": "/api/voice"
    },
    "status": 200,
    "body": {
      "enabled": false,
      "providerCount": 0,
      "providers": [
        {
          "id": "sample",
          "label": "sample",
          "state": "sample",
          "capabilities": [
            "sample"
          ],
          "configured": false,
          "detail": "sample",
          "metadata": {}
        }
      ],
      "note": "sample"
    }
  },
  "voice.stt": {
    "methodId": "voice.stt",
    "http": {
      "method": "POST",
      "path": "/api/voice/stt"
    },
    "status": 200,
    "body": {
      "providerId": "sample",
      "text": "sample",
      "language": "sample",
      "segments": [
        {
          "text": "sample",
          "startMs": 0,
          "endMs": 0,
          "confidence": 0
        }
      ],
      "metadata": {}
    }
  },
  "voice.tts": {
    "methodId": "voice.tts",
    "http": {
      "method": "POST",
      "path": "/api/voice/tts"
    },
    "status": 200,
    "body": {
      "providerId": "sample",
      "audio": {
        "mimeType": "sample",
        "format": "sample",
        "dataBase64": "sample",
        "uri": "sample",
        "sampleRateHz": 0,
        "durationMs": 0,
        "metadata": {}
      },
      "metadata": {}
    }
  },
  "voice.tts.stream": {
    "methodId": "voice.tts.stream",
    "http": {
      "method": "POST",
      "path": "/api/voice/tts/stream"
    },
    "status": 200,
    "body": {
      "contentType": "sample",
      "providerId": "sample",
      "format": "sample"
    }
  },
  "voice.voices.list": {
    "methodId": "voice.voices.list",
    "http": {
      "method": "GET",
      "path": "/api/voice/voices"
    },
    "status": 200,
    "body": {
      "voices": [
        {
          "id": "sample",
          "label": "sample",
          "locale": "sample",
          "gender": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "watchers.create": {
    "methodId": "watchers.create",
    "http": {
      "method": "POST",
      "path": "/api/watchers"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "kind": "sample",
      "label": "sample",
      "state": "sample",
      "source": {
        "id": "sample",
        "kind": "sample",
        "label": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "intervalMs": 0,
      "lastHeartbeatAt": 0,
      "sourceLagMs": 0,
      "sourceStatus": "sample",
      "degradedReason": "sample",
      "lastCheckpoint": "sample",
      "lastError": "sample",
      "metadata": {}
    }
  },
  "watchers.delete": {
    "methodId": "watchers.delete",
    "http": {
      "method": "DELETE",
      "path": "/api/watchers/{watcherId}"
    },
    "status": 200,
    "body": {
      "removed": false,
      "id": "sample"
    }
  },
  "watchers.list": {
    "methodId": "watchers.list",
    "http": {
      "method": "GET",
      "path": "/api/watchers"
    },
    "status": 200,
    "body": {
      "watchers": [
        {
          "id": "sample",
          "kind": "sample",
          "label": "sample",
          "state": "sample",
          "source": {
            "id": "sample",
            "kind": "sample",
            "label": "sample",
            "enabled": false,
            "createdAt": 0,
            "updatedAt": 0,
            "metadata": {}
          },
          "intervalMs": 0,
          "lastHeartbeatAt": 0,
          "sourceLagMs": 0,
          "sourceStatus": "sample",
          "degradedReason": "sample",
          "lastCheckpoint": "sample",
          "lastError": "sample",
          "metadata": {}
        }
      ]
    }
  },
  "watchers.run": {
    "methodId": "watchers.run",
    "http": {
      "method": "POST",
      "path": "/api/watchers/{watcherId}/run"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "kind": "sample",
      "label": "sample",
      "state": "sample",
      "source": {
        "id": "sample",
        "kind": "sample",
        "label": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "intervalMs": 0,
      "lastHeartbeatAt": 0,
      "sourceLagMs": 0,
      "sourceStatus": "sample",
      "degradedReason": "sample",
      "lastCheckpoint": "sample",
      "lastError": "sample",
      "metadata": {}
    }
  },
  "watchers.start": {
    "methodId": "watchers.start",
    "http": {
      "method": "POST",
      "path": "/api/watchers/{watcherId}/start"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "kind": "sample",
      "label": "sample",
      "state": "sample",
      "source": {
        "id": "sample",
        "kind": "sample",
        "label": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "intervalMs": 0,
      "lastHeartbeatAt": 0,
      "sourceLagMs": 0,
      "sourceStatus": "sample",
      "degradedReason": "sample",
      "lastCheckpoint": "sample",
      "lastError": "sample",
      "metadata": {}
    }
  },
  "watchers.stop": {
    "methodId": "watchers.stop",
    "http": {
      "method": "POST",
      "path": "/api/watchers/{watcherId}/stop"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "kind": "sample",
      "label": "sample",
      "state": "sample",
      "source": {
        "id": "sample",
        "kind": "sample",
        "label": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "intervalMs": 0,
      "lastHeartbeatAt": 0,
      "sourceLagMs": 0,
      "sourceStatus": "sample",
      "degradedReason": "sample",
      "lastCheckpoint": "sample",
      "lastError": "sample",
      "metadata": {}
    }
  },
  "watchers.update": {
    "methodId": "watchers.update",
    "http": {
      "method": "PATCH",
      "path": "/api/watchers/{watcherId}"
    },
    "status": 200,
    "body": {
      "id": "sample",
      "kind": "sample",
      "label": "sample",
      "state": "sample",
      "source": {
        "id": "sample",
        "kind": "sample",
        "label": "sample",
        "enabled": false,
        "createdAt": 0,
        "updatedAt": 0,
        "metadata": {}
      },
      "intervalMs": 0,
      "lastHeartbeatAt": 0,
      "sourceLagMs": 0,
      "sourceStatus": "sample",
      "degradedReason": "sample",
      "lastCheckpoint": "sample",
      "lastError": "sample",
      "metadata": {}
    }
  },
  "web_search.providers.list": {
    "methodId": "web_search.providers.list",
    "http": {
      "method": "GET",
      "path": "/api/web-search/providers"
    },
    "status": 200,
    "body": {
      "providers": [
        {
          "id": "sample",
          "label": "sample",
          "capabilities": [
            "sample"
          ],
          "requiresAuth": false,
          "configured": false,
          "note": "sample"
        }
      ]
    }
  },
  "web_search.query": {
    "methodId": "web_search.query",
    "http": {
      "method": "POST",
      "path": "/api/web-search/query"
    },
    "status": 200,
    "body": {
      "providerId": "sample",
      "providerLabel": "sample",
      "query": "sample",
      "verbosity": "sample",
      "results": [
        {
          "rank": 0,
          "url": "sample",
          "title": "sample",
          "snippet": "sample",
          "displayUrl": "sample",
          "domain": "sample",
          "type": "sample",
          "providerId": "sample",
          "metadata": {},
          "evidence": [
            {
              "url": "sample",
              "extract": "sample",
              "content": "sample",
              "tokensUsed": 0,
              "status": 0,
              "contentType": "sample",
              "truncated": false,
              "metadata": {}
            }
          ]
        }
      ],
      "instantAnswer": {
        "heading": "sample",
        "answer": "sample",
        "abstract": "sample",
        "source": "sample",
        "url": "sample",
        "image": "sample",
        "type": "sample",
        "related": [
          {
            "text": "sample",
            "url": "sample"
          }
        ],
        "metadata": {}
      },
      "metadata": {}
    }
  },
  "workspaces.registrations.add": {
    "methodId": "workspaces.registrations.add",
    "http": {
      "method": "POST",
      "path": "/api/workspaces/registrations"
    },
    "status": 200,
    "body": {
      "workspace": {
        "root": "sample",
        "registeredAt": "sample",
        "label": "sample"
      },
      "alreadyRegistered": false
    }
  },
  "workspaces.registrations.list": {
    "methodId": "workspaces.registrations.list",
    "http": {
      "method": "GET",
      "path": "/api/workspaces/registrations"
    },
    "status": 200,
    "body": {
      "workspaces": [
        {
          "root": "sample",
          "registeredAt": "sample",
          "label": "sample"
        }
      ],
      "declines": [
        {
          "root": "sample",
          "declinedAt": "sample"
        }
      ]
    }
  },
  "workspaces.registrations.remove": {
    "methodId": "workspaces.registrations.remove",
    "http": {
      "method": "DELETE",
      "path": "/api/workspaces/registrations"
    },
    "status": 200,
    "body": {
      "root": "sample",
      "removed": false
    }
  },
  "workspaces.resolve": {
    "methodId": "workspaces.resolve",
    "http": {
      "method": "POST",
      "path": "/api/workspaces/resolve"
    },
    "status": 200,
    "body": {
      "path": "sample",
      "status": "covered",
      "coveredBy": "sample",
      "declinedRoot": "sample",
      "viaWorktreeLink": false,
      "reason": "sample"
    }
  },
  "worktrees.setup.run": {
    "methodId": "worktrees.setup.run",
    "http": null,
    "status": 200,
    "body": {
      "path": "sample",
      "setup": {
        "state": "skipped",
        "startedAt": 0,
        "completedAt": 0,
        "steps": [
          {
            "kind": "command",
            "label": "sample",
            "ok": false,
            "exitCode": 0,
            "output": "sample"
          }
        ],
        "error": "sample"
      }
    }
  },
  "worktrees.snapshot": {
    "methodId": "worktrees.snapshot",
    "http": {
      "method": "GET",
      "path": "/api/worktrees"
    },
    "status": 200,
    "body": {
      "summary": {
        "total": 0,
        "active": 0,
        "paused": 0,
        "kept": 0,
        "discard": 0,
        "pendingCleanup": 0,
        "sessionAttached": 0,
        "taskAttached": 0,
        "agentOwned": 0,
        "orchestratorOwned": 0,
        "manualOwned": 0
      },
      "records": [
        {
          "path": "sample",
          "kind": "agent",
          "state": "active",
          "ownerId": "sample",
          "sessionId": "sample",
          "taskId": "sample",
          "setup": {
            "state": "skipped",
            "startedAt": 0,
            "completedAt": 0,
            "steps": [
              {
                "kind": "command",
                "label": "sample",
                "ok": false,
                "exitCode": 0,
                "output": "sample"
              }
            ],
            "error": "sample"
          },
          "updatedAt": 0
        }
      ]
    }
  }
};
