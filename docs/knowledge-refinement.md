# Knowledge Refinement

Knowledge refinement is a base knowledge capability. Home Graph uses it through
an extension; it is not a separate refinement system.

## Lifecycle

1. Source ingestion or an Ask detects a gap.
2. The base knowledge service classifies whether the gap is intrinsic to the
   subject and safe to repair.
3. A durable refinement task records the gap, subject, trigger, budget, trace,
   accepted and rejected sources, and retry state.
4. Search and source evaluation prefer official/vendor and high-confidence
   sources, including already-indexed accepted sources.
5. Extraction promotes only useful subject-linked facts.
6. Answer synthesis and generated pages read promoted facts and fact-source
   edges.
7. The task closes only after usable evidence was applied, or it defers with a
   retryable reason and `nextRepairAttemptAt`.

## Ask Behavior

Ask may wait for bounded repair when the subject is concrete and the gap is
high-value. If bounded repair cannot complete, the answer must show refinement
metadata instead of presenting a complete zero-fact answer.

Returned refinement metadata can include status, repair status, task ids,
accepted source ids, promoted fact count, waited time, defer reason, next repair
attempt, and page refresh state.

## Quality Gates

Facts are rejected when they are raw snippets, URL/title-only fragments,
truncated table debris, affiliate/comparison boilerplate, contradicted by a
better source, or not linked to the subject they claim to describe.
