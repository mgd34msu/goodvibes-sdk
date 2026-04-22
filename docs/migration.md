# Migration Guide

Since 0.19.0, per-release migration guidance lives directly in `CHANGELOG.md` under each version's `### Migration` subsection. This is the canonical source; consumers upgrading from any pre-0.21.x version should read the relevant `## [X.Y.Z]` entries in order.

## Upgrading to 0.23.0

**Additive — no consumer action required.**

0.23.0 adds WRFC constraint propagation. Every schema addition is optional or defaulted; the parser tolerates absence and malformed entries. Pre-0.23 consumers compile unchanged.

- New `WORKFLOW_CONSTRAINTS_ENUMERATED` runtime event on the `workflows` domain. Consumers that filter by event type will see this new type. Consumers with catch-all `workflows` handlers receive it automatically.
- `WORKFLOW_REVIEW_COMPLETED` gains three optional fields (`constraintsSatisfied`, `constraintsTotal`, `unsatisfiedConstraintIds`). These are absent when the chain has no constraints — pre-0.23 payload shape is unchanged on unconstrained chains.
- `WORKFLOW_FIX_ATTEMPTED` gains one optional field (`targetConstraintIds`). Absent when the chain has no constraints.
- `EngineerReport.constraints` is an optional `Constraint[]` (defaults to `[]` via `applyConstraintDefaults` normalizer).
- `ReviewerReport.constraintFindings` is an optional `ConstraintFinding[]` (defaults to `[]`).

For the full feature description, see [WRFC Constraint Propagation](./wrfc-constraint-propagation.md).

---

## Upgrading from 0.18.x to 0.19.x

0.19.x introduced several breaking changes. In order:

- **0.19.0** — `_internal/platform/*` paths closed; consumers must import via `./platform/*` public barrels. `./react-native`, `./browser`, `./web`, `./expo` entry points are companion-safe. See [Runtime Surfaces](./surfaces.md).
- **0.19.3** — Error types are now typed `GoodVibesSdkError` with an `SDKErrorKind` discriminant. See [Error kinds](./error-kinds.md). Raw `throw new Error` in consumer-reachable SDK source is now gated by the CI `throw-guard`.
- **0.19.5** — `SDKObserver` interface introduced. Opt-in; no consumer action needed for existing code. See [Observability](./observability.md).
- **0.19.6** — `./node` and `./oauth` exports entries removed; `engines.node` replaced with `engines.bun`. `createNodeGoodVibesSdk` / `NodeGoodVibesSdkOptions` removed from root. Migrate to `createGoodVibesSdk` or the runtime-specific factory (`createReactNativeGoodVibesSdk`, `createBrowserGoodVibesSdk`). OAuth flows should now be handled server-side.

## Upgrading through 0.20.x — 0.21.x

Consumers moving past 0.19.x should read `CHANGELOG.md` front-to-back; the highlights that most commonly require consumer action are:

- **0.21.28** — Companion/operator token storage consolidated to a single global location: `<daemonHomeDir>/operator-tokens.json` (default `~/.goodvibes/daemon/operator-tokens.json`). Workspace-scoped `.goodvibes/<surface>/companion-token.json` files from earlier releases are ignored. TUI and embedded-daemon hosts should supply `daemonHomeDir` explicitly to `getOrCreateCompanionToken(surface, { daemonHomeDir })`.
- **0.21.31 — OBS-05** — `TOOL_SUCCEEDED` / `TOOL_FAILED` runtime events carry a `ToolResultSummary` (`{ kind, byteSize, preview? }`) instead of the raw tool result object. Consumers that inspect `.result` on these events must migrate to the summary shape.
- **0.21.31 — OBS-06** — `LLM_RESPONSE_RECEIVED` renames `content` to `contentSummary` (`{ length, sha256, first100chars }` unless telemetry opts into raw prompts). Update handlers that read the old `content` field.
- **0.21.32 — OBS-14** — `RuntimeEventBus.emit(...)` dispatches listeners via `queueMicrotask`. Tests or code paths that assumed synchronous dispatch must `await` a microtask drain before asserting on subscriber-populated state.
- **0.21.33 — QA-05** — `scheduler-capacity.ts` wire format is camelCase (`slotsTotal`, `slotsInUse`, `queueDepth`, `oldestQueuedAgeMs`). 0.21.36 completes the migration at the `/api/runtime/scheduler` HTTP boundary.
- **0.21.33 — QA-14** — Typed error subclasses declare `readonly code: '<LITERAL>'` and pass `code:` through `super()` options. Consumers constructing these error classes directly should include the `code` discriminant.
- **0.21.35 — PERF-08** — `ControlPlaneGateway.createEventStream` and `IntegrationHelpers.createEventStream` now pass `CountQueuingStrategy({ highWaterMark: 256 })` to `ReadableStream`; fixes a backpressure bug where startup `ready` + replay events could be dropped before the consumer pulled the first chunk.
- **0.21.36 — F3/F20/F21/F22/F-PROV-009** — See `CHANGELOG.md` for full detail. Key items: `POST /api/sessions/:id/inputs` restored as an intent-dispatching alias; `GET /api/companion/chat/sessions/:id/messages` restored and all companion-chat routes registered in the method catalog; `/api/runtime/scheduler` now emits camelCase at the HTTP surface; `secretsResolutionSkipped` is always present (required boolean) on `GET /api/providers`; new `pruneStaleOperatorTokens` export.

For each release's full migration text, run:

```bash
git log --grep "^release: SDK 0.2" -p CHANGELOG.md
```

or open `CHANGELOG.md` directly and find the `## [X.Y.Z]` section of interest.

## Archive

Pre-0.19 per-release detail is in `docs/archive/releases/0.18.x/`. This directory is historical reference only — treat `CHANGELOG.md` as the current source.
