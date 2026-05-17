# Project Planning

Project Planning is the SDK support layer for the TUI's conversational planning
loop. It stores project-scoped planning artifacts in the knowledge system and
can evaluate whether a plan is ready to execute, but it does not start,
resume, or drive planning conversations.

Accessible via `@pellux/goodvibes-sdk/platform/knowledge` (daemon embedders). Consumer apps interact through operator methods documented below.

## Boundary

The TUI owns the active planning experience:

- natural-language planning intent detection
- repo, docs, settings, and knowledge inspection
- the relentless interview loop
- one-question-at-a-time user interaction
- the passive planning panel
- execution approval
- agent assignment UX

The SDK owns passive infrastructure:

- shared TypeScript types and operator contracts
- project-scoped durable planning artifacts
- project-language and ambiguity records
- decision records
- task, dependency, verification, and agent-assignment metadata
- readiness evaluation with gap and next-question hints
- knowledge/wiki storage helpers

The daemon never initiates planning. It exposes storage/evaluation routes only.
Home Assistant, companion apps, ntfy, Slack, webhooks, and other programmatic
surfaces are not routed into planning loops by this feature.

## Work Plans

Project work plans are the shared durable task model for TUI, WebUI, APK,
daemon planning, and WRFC correlation. They replace surface-local task lists
when a client needs project-scoped work tracking that survives process restarts
and is visible across surfaces.

Work-plan task records include a stable task id, title, notes, owner, status,
priority/order, timestamps, source, tags, optional parent task id, and
correlation fields for WRFC/planning/agent integration such as `chainId`,
`phaseId`, `agentId`, `turnId`, `decisionId`, `sourceMessageId`, linked
artifact/source/node ids, and origin surface.

The SDK validates the status vocabulary:

- `pending`
- `in_progress`
- `blocked`
- `done`
- `failed`
- `cancelled`

Operator methods are exposed under `projectPlanning.workPlan.*` and daemon
routes under `/api/projects/planning/work-plan`. Clients should use those
routes instead of reading TUI-local files. TUI-local work-plan storage can be
used as a migration/fallback cache, but the SDK store is the shared product
model.

Task changes emit planner-domain events so clients can refresh snapshots or
apply deltas instead of polling:

- `WORK_PLAN_TASK_CREATED`
- `WORK_PLAN_TASK_UPDATED`
- `WORK_PLAN_TASK_STATUS_CHANGED`
- `WORK_PLAN_TASK_DELETED`
- `WORK_PLAN_SNAPSHOT_INVALIDATED`

WRFC and planning integrations should link visible tasks to owner chains and
phase children through the correlation fields rather than presenting child
agents as unrelated work.

## Knowledge Spaces

Planning artifacts live in project knowledge spaces:

```text
project:<projectId>
```

Routes accept either `projectId` or a full `knowledgeSpaceId`. If neither is
provided, the daemon uses a stable project id derived from its working
directory. TUI clients should still pass their own stable project id so
workspace-specific planning, language, decisions, and future wiki pages do not
bleed across unrelated projects.

Project spaces are isolated by default. Related projects can link records
explicitly later, but reads and writes for this feature default to the current
project space only.

## Artifacts

Planning records are stored as `KnowledgeSourceRecord` rows with:

- `connectorId: "goodvibes-project-planning"`
- `sourceType: "dataset"`
- `metadata.projectPlanning: true`
- `metadata.planningArtifactKind`
- `metadata.knowledgeSpaceId`
- `metadata.value`

Artifact kinds:

| Kind | Purpose |
|---|---|
| `state` | Live planning state for the current project conversation |
| `decision` | Durable decision record for meaningful choices |
| `language` | Canonical project vocabulary and resolved ambiguities |

This keeps planning integrated with the knowledge/wiki store without adding a
separate persistence system.

## Planning State

The planning state shape is designed for the TUI planning panel and execution
handoff:

```ts
{
  id: string;
  projectId: string;
  knowledgeSpaceId: string;
  goal: string;
  scope?: string;
  knownContext: string[];
  openQuestions: ProjectPlanningQuestion[];
  answeredQuestions: ProjectPlanningQuestion[];
  decisions: ProjectPlanningDecision[];
  assumptions: string[];
  constraints: string[];
  risks: string[];
  tasks: ProjectPlanningTask[];
  dependencies: ProjectPlanningDependency[];
  verificationGates: ProjectPlanningVerificationGate[];
  agentAssignments: ProjectPlanningAgentAssignment[];
  readiness: "not-ready" | "needs-user-input" | "executable";
  executionApproved: boolean;
}
```

The SDK does not decide what the TUI should ask next by itself. It returns gaps
and a suggested `nextQuestion` so the TUI can keep the conversation disciplined
while preserving conversational control.

## Readiness Evaluation

`ProjectPlanningService.evaluate()` and
`POST /api/projects/planning/evaluate` are pure evaluators. They do not persist
state unless the caller separately upserts state.

The evaluator checks for:

- missing goal
- missing scope or constraints
- unresolved questions
- ambiguous language such as `better`, `improve`, or `agent channel`
- missing task decomposition
- missing dependency graph for multi-task plans
- missing verification gates
- missing user approval before execution

The output contains:

- `readiness`
- `gaps`
- `nextQuestion` when a gap has a concrete question
- the normalized state with the evaluated readiness

## Decision Records

Decision records should be used for meaningful project choices, not every small
implementation detail. A decision belongs here when reversal would be expensive,
when maintainers need context beyond the code, or when real alternatives and
tradeoffs existed.

Stored fields include:

- title
- context
- chosen decision
- rejected alternatives
- reasoning
- consequences
- status

## Project Language

Project language records prevent future TUI turns and agents from re-litigating
terminology. They can store:

- canonical terms
- terms to avoid because they are ambiguous
- aliases
- relationships between concepts
- example scenarios
- resolved ambiguity records

Example:

```json
{
  "terms": [
    {
      "term": "Surface",
      "definition": "A user-facing channel where GoodVibes can receive or send interaction.",
      "avoid": ["client", "integration"]
    }
  ],
  "ambiguities": [
    {
      "phrase": "agent channel",
      "resolution": "Use ntfy chat channel for normal chat and ntfy agent channel for background agent work."
    }
  ]
}
```

## Routes

| Route | Method | Admin | Purpose |
|---|---|---:|---|
| `/api/projects/planning/status` | `GET` | no | Return artifact counts and passive capabilities |
| `/api/projects/planning/state` | `GET` | no | Read the current planning state |
| `/api/projects/planning/state` | `POST` | yes | Persist planning state and evaluated readiness |
| `/api/projects/planning/evaluate` | `POST` | no | Evaluate inline or stored state without mutating |
| `/api/projects/planning/decisions` | `GET` | no | List project decisions |
| `/api/projects/planning/decisions` | `POST` | yes | Record a project decision |
| `/api/projects/planning/language` | `GET` | no | Read project vocabulary and ambiguity records |
| `/api/projects/planning/language` | `POST` | yes | Update project vocabulary and ambiguity records |

Operator method ids:

- `projectPlanning.status`
- `projectPlanning.state.get`
- `projectPlanning.state.upsert`
- `projectPlanning.evaluate`
- `projectPlanning.decisions.list`
- `projectPlanning.decisions.record`
- `projectPlanning.language.get`
- `projectPlanning.language.upsert`

## TUI Integration Shape

The TUI should use this feature as a passive backing store:

1. Detect planning intent in a normal conversation.
2. Inspect code, docs, settings, and existing project knowledge before asking.
3. Upsert planning state as context is discovered.
4. Call `projectPlanning.evaluate` for readiness gaps.
5. Ask one precise question at a time in the normal conversation.
6. Update project language and decision records as answers resolve ambiguity.
7. Decompose tasks, dependencies, verification gates, and agent assignments.
8. Request user approval before execution.
9. Execute locally or delegate agents only after approval.

The planning panel can render the same state returned by the SDK. The daemon
does not own panel state or conversational transitions.
