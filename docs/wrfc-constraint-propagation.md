# WRFC Constraint Propagation

Work-Review-Fix-Commit (WRFC) chains extract user-declared constraints from the task prompt, carry them through every state transition, and enforce them as independent pass/fail criteria. This document covers what constraints are, how they move through the chain, and how they interact with the review cycle.

See also: [Runtime events reference](./reference-runtime-events.md) for the `WORKFLOW_CONSTRAINTS_ENUMERATED` event, [Observability](./observability.md) for event subscription patterns.

---

## What constraints are

A **constraint** is an explicit user-declared requirement from the task prompt — one that specifies the *shape* of the work rather than the *what*. Examples: size limits ("under 200 lines"), feature inclusions or exclusions, style rules ("no `any` types"), performance targets, naming conventions, API shape requirements, or scope boundaries.

Constraints are not the task goal itself, not the engineer's own best practices, and not soft preferences or politeness. They are the conditions the user stated that the output must satisfy.

The type that represents a single constraint:

```ts
interface Constraint {
  id: string;                         // "c1", "c2", …
  text: string;                       // quoted or minimally paraphrased user phrasing
  source: 'prompt' | 'inherited';     // 'prompt' = engineer enumerated from this prompt
                                      // 'inherited' = from parent chain / gate-retry
}
```

A reviewer's finding about a single constraint:

```ts
interface ConstraintFinding {
  constraintId: string;
  satisfied: boolean;
  evidence: string;                   // file + line, diff observation, or test behavior
  severity?: 'critical' | 'major' | 'minor';  // only when !satisfied
}
```

Both types are exported from `@pellux/goodvibes-sdk` (_internal only — not part of the public companion surface).

---

## Engineer enumeration

The controller injects a constraint enumeration addendum into the engineer's system prompt before the agent runs. The addendum instructs the engineer to read the task prompt once and decide whether it is a build task with explicit constraints.

### Discernment rule

The engineer applies the following decision:

- **Non-build or unconstrained prompt** — questions, conversational exchanges, requests for explanation, exploratory research, or build requests that delegate all decisions to the engineer's judgment. Emit `"constraints": []`. Do not fabricate constraints from soft preferences or task-description paraphrasing.
- **Build task with explicit constraints** — any prompt that declares size limits, feature inclusions/exclusions, style rules, performance targets, naming conventions, API shape requirements, explicit scope boundaries, or stated behavioral requirements. Enumerate each as `{ id, text, source: "prompt" }` using the user's phrasing.

### Calibration examples

| Prompt | Correct enumeration |
|--------|--------------------|
| `"Write a function that adds two numbers"` | `constraints: []` — no shape declared beyond the task |
| `"Write a function that adds two numbers, must be pure, no external deps, under 20 lines"` | Three constraints: purity, no external deps, line limit |
| `"What does this code do?"` | `constraints: []` — not a build task |
| `"Refactor this file to use hooks, keep public exports identical"` | Two constraints: use hooks, preserve public exports |

### Hard cap

At most 16 constraints. Real prompts almost never produce more than 5–10. More than 16 indicates over-enumeration — consolidate.

### Constraints as acceptance criteria

Constraints become the chain's self-declared acceptance criteria. If the engineer cannot satisfy a constraint, it must record the conflict under `issues[]` with an explanation — silent omission is not permitted.

---

## Constraint enumeration event

Immediately after the initial engineer completes, the controller captures `report.constraints` and emits exactly one `WORKFLOW_CONSTRAINTS_ENUMERATED` event per chain:

```ts
// Domain: 'workflows'
// Event type: 'WORKFLOW_CONSTRAINTS_ENUMERATED'
{
  chainId: string;
  constraints: Constraint[];
}
```

This event fires once — on initial engineer completion only, not on fixer re-runs. Fixer runs do not re-emit this event even when they return a `constraints[]` array (the returned array is used only for continuity validation).

When the constraint list is empty (`constraints: []`), the event is still emitted to signal that the chain was evaluated and no constraints apply. The zero-constraint path is a clean no-op for all downstream processing.

---

## Reviewer verification

The reviewer's task payload includes the full constraint list. The reviewer runs constraint verification alongside the 10-dimension quality rubric — not instead of it.

### Per-constraint findings

For each constraint, the reviewer:

1. Judges whether the applied changes satisfy it (`satisfied: true` / `false`).
2. Cites concrete evidence — a file and line, a diff observation, or a test behavior. "Looks fine" is not evidence.
3. Emits a `ConstraintFinding` entry referencing `constraintId`.

### Severity taxonomy (unsatisfied constraints)

| Severity | When |
|----------|------|
| `critical` | Violated hard limit (size, performance target, explicitly forbidden API) |
| `major` | Violated explicit user rule (style rules, naming conventions, required feature) |
| `minor` | Ambiguous or partially satisfied constraint |

When a constraint's phrasing is ambiguous enough that verification is impossible, the reviewer emits `satisfied: false, severity: 'minor', evidence: 'constraint ambiguous, cannot verify'`. This surfaces the issue without failing the chain on a technicality.

### Constraint findings are independent of the rubric

A chain can score 10/10 on the 10-dimension rubric and still fail because a constraint is unsatisfied. Conversely, all constraints can be satisfied while the rubric flags quality issues. The two axes are evaluated independently and both must pass.

### Zero-constraint path

When the engineer emitted `constraints: []`, the reviewer emits `constraintFindings: []` and skips constraint verification entirely. The reviewer does not invent findings or penalize the score for "missing constraints".

---

## Pass/fail semantics

The controller computes pass/fail for each review cycle using:

```
passed = review.score >= threshold && !constraintFailure
```

where `constraintFailure = (unsatisfiedConstraints.length > 0)`.

Any unsatisfied constraint forces chain failure regardless of rubric score. Score-below-threshold still fails independently — constraint satisfaction never overrides a low score. Both conditions must be true (score passes AND all constraints satisfied) for the review to pass.

When constraints are present, `WORKFLOW_REVIEW_COMPLETED` carries the constraint summary:

```ts
// Additional fields on WORKFLOW_REVIEW_COMPLETED when chain.constraints.length > 0
{
  constraintsSatisfied: number;           // count of satisfied findings
  constraintsTotal: number;               // total evaluated
  unsatisfiedConstraintIds: string[];     // IDs of failed constraints
}
```

When there are no constraints, these fields are omitted entirely (the payload is byte-identical to pre-0.23).

---

## Fixer preservation

When the chain moves to `fixing`, the fixer task payload includes every constraint with per-id status markers resolved from the reviewer's findings:

- **`SATISFIED`** — reviewer confirmed satisfied; the fix must keep it satisfied.
- **`UNSATISFIED`** — reviewer found it violated; the fix must satisfy it.
- **`UNVERIFIED`** — reviewer produced no finding for this constraint; the fixer must verify and satisfy it.

### Conflict escalation

If a reviewer issue can only be resolved by regressing a satisfied constraint, the fixer must stop and record the conflict under `issues[]` with both the `constraintId` and the reviewer issue description. Silent regression is not permitted.

### Continuity validation

The fixer returns an `EngineerReport` containing the same `constraints[]` array — same ids, same text, same order. The controller validates this on fixer completion. Any missing or extra ids produce a **synthetic critical issue** pushed to `chain.syntheticIssues`:

```
Fixer regressed constraint continuity: missing=[c2] extra=[c3]
```

Synthetic critical issues are prepended to the next review task as a `[CRITICAL]` block, consumed once, and cleared. This ensures the reviewer flags the regression explicitly rather than letting it propagate silently.

The authoritative constraint list on `chain.constraints` is never overwritten by a fixer run — only the initial engineer's enumeration is canonical.

### `WORKFLOW_FIX_ATTEMPTED` extended field

When `targetConstraintIds` is present on `WORKFLOW_FIX_ATTEMPTED`, it lists the IDs of constraints the fixer was tasked with resolving in this iteration:

```ts
// Domain: 'workflows'
// Event type: 'WORKFLOW_FIX_ATTEMPTED'
{
  chainId: string;
  attempt: number;
  maxAttempts: number;
  targetConstraintIds?: string[];   // populated when chain has constraints
}
```

---

## Gate-failure retry inheritance

When a chain fails quality gates and spawns a retry child chain, the child inherits the parent's constraints as `source: 'inherited'`:

```ts
// Child constraint entries
{ id: 'c1', text: '...', source: 'inherited' }
```

The child chain starts with `constraintsEnumerated: true`, so the child engineer does not re-enumerate constraints from scratch. The inherited list is authoritative — the child engineer's returned `constraints[]` array is ignored for enumeration purposes (used only for continuity validation).

Inheritance works for both the immediate path (child chain registered before the parent completes) and the pending path (child chain not yet registered when the parent triggers the retry, via the `pendingParentConstraints` map).

Chains with zero constraints spawn zero-constraint retry children — the inheritance machinery runs but carries an empty list, which is a clean no-op.

---

## Chain fields

`WrfcChain` carries three constraint-related fields (internal — not part of the public companion surface):

| Field | Type | Description |
|-------|------|-------------|
| `constraints` | `Constraint[]` | Authoritative constraint list; set once on initial engineer completion, never overwritten |
| `constraintsEnumerated` | `boolean` | `true` once `WORKFLOW_CONSTRAINTS_ENUMERATED` has been emitted for this chain; prevents duplicate emission on fixer re-runs |
| `syntheticIssues` | `Array<{ severity: 'critical'; description: string }> \| undefined` | Controller-injected critical issues (e.g. continuity violations); prepended to the next review task, then cleared |

---

## Zero-constraint no-op guarantee

When the engineer emits `constraints: []` (non-build or unconstrained prompt):

- `WORKFLOW_CONSTRAINTS_ENUMERATED` fires with `constraints: []`.
- The reviewer emits `constraintFindings: []`.
- `WORKFLOW_REVIEW_COMPLETED` omits the constraint fields entirely.
- `WORKFLOW_FIX_ATTEMPTED` omits `targetConstraintIds`.
- Fixer receives no constraint addendum.
- Gate-retry children inherit an empty list.
- `passed` is computed as `review.score >= threshold` only — no constraint axis.

This path is byte-identical to pre-0.23 behavior in all downstream consumers. No new fields appear in events, no new task blocks appear in agent prompts.

---

## Related

- [Runtime events reference](./reference-runtime-events.md) — `WORKFLOW_CONSTRAINTS_ENUMERATED`, `WORKFLOW_REVIEW_COMPLETED`, `WORKFLOW_FIX_ATTEMPTED` event shapes
- [Observability](./observability.md) — event domain subscription
- [Migration guide](./migration.md) — 0.23.0 entry
