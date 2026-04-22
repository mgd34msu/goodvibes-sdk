/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * System-prompt addenda injected into WRFC agent spawns.
 *
 * Phase 2 wires `buildEngineerConstraintAddendum` into engineer spawns.
 * Reviewer (Phase 3) and fixer (Phase 4) addenda are declared here for
 * module-shape stability but throw at call time until their phase lands.
 */

/**
 * Addendum appended to the engineer system prompt in every WRFC chain.
 *
 * Instructs the engineer to enumerate explicit constraints from the task
 * prompt as self-declared acceptance criteria before beginning GATHER.
 *
 * Memoized — the string is static and built once per process.
 */
let _engineerAddendumCache: string | null = null;
export function buildEngineerConstraintAddendum(): string {
  if (_engineerAddendumCache !== null) return _engineerAddendumCache;
  _engineerAddendumCache = `## Constraint enumeration (pre-work step)

Before you begin GATHER, read the user's task prompt once and decide: **does this prompt contain explicit build instructions with constraints worth enumerating?**

A **build task with constraints** looks like: size limits ("under 200 lines"), feature inclusions/exclusions ("must support X but not Y"), style rules ("no \`any\` types", "prefer functional"), performance targets, naming conventions, API shape requirements, explicit scope boundaries, or any specific behavioral requirement the user stated.

A **non-build or unconstrained prompt** looks like: a question, a conversational exchange, a request for explanation, exploratory research, a one-shot utility, or a build request that delegates all decisions to your judgment ("make it nice", "fix the bug", "implement whatever makes sense").

**Decision:**
- If the prompt is non-build or unconstrained, emit \`"constraints": []\` in your EngineerReport. Do NOT fabricate constraints. Do NOT convert soft preferences, politeness, or task description into constraints. Proceed with normal GATHER/PLAN/APPLY.
- If the prompt contains explicit constraints, enumerate them as \`{ id, text, source: "prompt" }\`. Use the user's words, quoted or minimally paraphrased. Assign ids \`c1\`, \`c2\`, … in order of appearance. Do NOT add constraints that are merely your own best practices. Do NOT split a single requirement into multiple ids for bulk. Do NOT summarize the task goal itself as a constraint — constraints are the *shape* of the work, the task is the *what*.

**Calibration examples (follow the spirit, not the literal phrasing):**
- \`"Write a function that adds two numbers"\` → \`constraints: []\` (no shape declared beyond the task itself).
- \`"Write a function that adds two numbers, must be pure, no external deps, under 20 lines"\` → three constraints.
- \`"What does this code do?"\` → \`constraints: []\` (not a build task).
- \`"Refactor this file to use hooks, keep public exports identical"\` → two constraints.

**Hard cap: at most ~16 constraints.** If you find more, you are over-enumerating — consolidate. Real user prompts almost never produce more than 5-10.

These constraints become your self-declared acceptance criteria. The reviewer will verify each one independently. If you cannot satisfy a constraint, record it under \`issues[]\` with an explanation — do not silently drop it.`;
  return _engineerAddendumCache;
}

let _reviewerAddendumCache: string | null = null;
/**
 * Addendum appended to the reviewer system prompt in every WRFC chain.
 *
 * Instructs the reviewer to verify each enumerated constraint from the
 * engineer's report independently of the 10-dimension rubric.
 *
 * Memoized — the string is static and built once per process.
 */
export function buildReviewerConstraintAddendum(): string {
  if (_reviewerAddendumCache !== null) return _reviewerAddendumCache;
  _reviewerAddendumCache = `## Constraint verification (runs alongside the 10-dimension rubric, NOT instead of it)

The engineer's \`EngineerReport.constraints\` is the authoritative list of user-declared requirements for this task. In the review task payload you will receive this list explicitly — verify it against the applied changes.

**For each constraint:**
1. Judge whether the applied changes satisfy it (\`satisfied: true\` / \`false\`).
2. Cite concrete evidence — a file and line, a diff observation, or a test behavior. "Looks fine" is not evidence.
3. Emit a \`constraintFindings[]\` entry referencing \`constraintId\`.

**Severity rules for unsatisfied constraints**:
- A violated hard limit (size, perf target, explicitly forbidden API) → **critical**.
- A violated explicit user rule (style rules, naming conventions, required features) → **major**.
- An ambiguous or partially-satisfied constraint → **minor** with evidence explaining the partial satisfaction.
- If the constraint phrasing is ambiguous enough that verification is impossible, emit \`satisfied: false, severity: 'minor', evidence: 'constraint ambiguous, cannot verify'\` — surfaces the issue without failing the chain on a technicality.

**If the constraint list is empty** (non-build prompt → engineer emitted \`[]\`), emit \`constraintFindings: []\` and skip this section entirely. Do NOT invent findings. Do NOT penalize the score for "missing constraints".

**Constraint findings are INDEPENDENT of the rubric dimensions.** A run can score 10/10 on the rubric and still fail because a constraint is unsatisfied. Conversely, all constraints can be satisfied while the rubric flags quality issues elsewhere.`;
  return _reviewerAddendumCache;
}

/**
 * Addendum for fixer spawns — not yet implemented.
 * Will be wired in Phase 4.
 */
export function buildFixerConstraintAddendum(): string {
  throw new Error('buildFixerConstraintAddendum: not yet implemented — Phase 4');
}
