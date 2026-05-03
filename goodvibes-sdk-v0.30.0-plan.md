# GoodVibes SDK v0.30.0 Refactor Plan

Status: implemented and in release validation for v0.30.0. The source-mirror
removal phases have been implemented: the SDK now re-exports sibling
source-of-truth packages through facade entrypoints, `_internal` mirror source
is gone, mirror-drift tooling was removed, and the stale
`packages/transport-direct` workspace package directory was deleted. The public
`@pellux/goodvibes-sdk/transport-direct` subpath remains as an SDK facade backed
by `@pellux/goodvibes-transport-core`; it is not a separate workspace package.

This plan is for the structural debt refactor leading toward `@pellux/goodvibes-sdk` v0.30.0.

The current workspace state was checkpointed locally before this plan:

- `4206b7b chore: checkpoint sdk debt repair state`

Constraints:

- Superseded release directive: after the implementation and review loops are
  clean, push and publish v0.30.0 to GitHub and npm.
- Keep the monorepo.
- Keep the sub-packages.
- Preserve all current capabilities.
- Improve architecture, boundaries, and selection surfaces instead of removing functionality.
- Make local commits after major implementation pieces so rollback remains easy.
- Run review/fix loops before release validation.
- Run validation only after implementation and review loops are clean.

## Architectural Goal

GoodVibes SDK has outgrown the architecture that was acceptable for a smaller package. The v0.30.0 goal is to make the system deliberate:

- Sub-packages are real source-of-truth packages, not code copied into the main SDK.
- The main SDK is a facade and capability hub.
- Public entrypoints are intentional.
- Internal folder layout is not accidental public API.
- Base knowledge/wiki owns the general self-improving knowledge system.
- Home Graph is an extension of base knowledge, not a parallel knowledge system.
- Runtime-heavy features remain available, but only through explicit surfaces so client-safe users can pick what they need.

## Dependency Graph Of The Plan

The major order is:

1. Use the checkpoint commit as rollback point.
2. Fix package source-of-truth architecture.
3. Redesign SDK public exports and platform organization.
4. Split oversized route/interface contracts.
5. Deduplicate client plumbing.
6. Move generic knowledge/refinement/page primitives to base knowledge.
7. Make generated pages graph-driven base functionality.
8. Harden global automatic refinement.
9. Rework dependency/runtime capability boundaries without removing capabilities.
10. Finish async/error/timer hygiene directly tied to review findings.
11. Add/refactor tests for the new architecture and behaviors.
12. Update docs/examples/contracts.
13. Run review/fix loops until clean.
14. Rewrite documentation for v0.30.0 from the new architecture.
15. Run validation only after clean review.

The second review produced concrete findings that are not simply docs/tests/examples polish. Those findings are integrated into the phases below. Items that are likely to be rewritten because of the v0.30.0 architecture change still remain as behavioral acceptance criteria where they protect the new design.

## 1. Use The Checkpoint Commit

Status: done.

The current state was committed as:

- `4206b7b chore: checkpoint sdk debt repair state`

No additional stabilization pass is required before starting the refactors. This item exists only as the rollback boundary.

Implementation rule:

- Do not spend time re-auditing unrelated files just to "stabilize" the tree.
- Start from the structural debt items below.

## 2. Remove SDK Source Mirrors While Keeping Monorepo Sub-Packages

Problem:

The SDK currently carries copied sibling package source under `old SDK copied-source tree`, including:

- `contracts`
- `errors`
- `daemon`
- `operator`
- `peer`
- `transport-core`
- `transport-direct` (historical copied package; the public SDK subpath remains as a facade)
- `transport-http`
- `transport-realtime`

That creates two copies of implementation code. Fixes must be made twice or synchronized by script. This is an antipattern.

Important product decision:

- Keep the monorepo.
- Keep the packages.
- Do not collapse everything into `packages/sdk`.
- Do not remove the sub-packages from the SDK ecosystem.

Correct architecture:

- `packages/contracts`: shared protocol, schemas, generated artifacts, public contract types.
- `packages/errors`: shared error model.
- `packages/transport-*`: reusable transports.
- `packages/daemon-sdk`: daemon API route/client helpers.
- `packages/operator-sdk`: operator client.
- `packages/peer-sdk`: peer client.
- `packages/sdk`: main facade package plus SDK-owned platform/runtime/knowledge implementation.

Target shape:

```ts
// @pellux/goodvibes-sdk/peer
export * from '@pellux/goodvibes-peer-sdk';
```

not:

```ts
export * from '/goodvibes-peer-sdk';
```

Work:

- Completed: inventoried copied sibling-package source imports.
- Completed: replaced copied implementation exports with facade modules that re-export real workspace packages.
- Completed: made `@pellux/goodvibes-sdk` depend on the sibling packages it re-exports.
- Completed: removed source-copy sync for implementation source.
- Completed: kept genuinely SDK-owned implementation under `packages/sdk/src/platform`.
- Completed: removed the copied-source tree and stale `packages/transport-direct` package directory.
- Completed: kept contract artifacts available through the contracts package and SDK facade exports.
- Completed: kept only intentional SDK subpath imports that fit the new public boundary.
- Completed: preserved the root workspace self-reference only for the monorepo build/release workflow.

Commit:

- `refactor: remove sdk copied package source`

## 3. Redesign SDK Organization And Public Export Plumbing

Problem:

`./platform/*` currently exports arbitrary platform files by folder layout:

```json
"./platform/*": {
  "types": "./dist/platform/*.d.ts",
  "import": "./dist/platform/*.js"
}
```

This makes every file under `dist/platform` potential public API. It also makes internal refactors risky because moving files becomes a breaking public API change.

Why the wildcard probably exists:

- It was a convenient escape hatch while the platform layer grew.
- It avoided listing many subpath exports.
- It allowed downstream code to import deep pieces before the public API was designed.

Why it is debt:

- Folder layout becomes public API.
- New files can accidentally become public.
- API review becomes impossible.
- Browser, React Native, Workers, Node/Bun, and daemon/runtime boundaries blur.
- Consumers can accidentally import Node-heavy or daemon-only pieces from client-safe contexts.

Target public layers:

- `public API`: stable user-facing entrypoints.
- `extension API`: stable hooks/extensions for things like Home Graph.
- `internal implementation`: private and movable.
- `runtime adapters`: Node/Bun/browser/React Native/Workers boundaries.
- `domain modules`: knowledge, providers, tools, runtime, integrations, media, config, auth.

Target exports:

```text
@pellux/goodvibes-sdk
@pellux/goodvibes-sdk/contracts
@pellux/goodvibes-sdk/errors
@pellux/goodvibes-sdk/daemon
@pellux/goodvibes-sdk/operator
@pellux/goodvibes-sdk/peer
@pellux/goodvibes-sdk/transport-core
@pellux/goodvibes-sdk/transport-direct   # facade over transport-core
@pellux/goodvibes-sdk/transport-http
@pellux/goodvibes-sdk/transport-realtime
@pellux/goodvibes-sdk/browser
@pellux/goodvibes-sdk/web
@pellux/goodvibes-sdk/workers
@pellux/goodvibes-sdk/react-native
@pellux/goodvibes-sdk/expo
@pellux/goodvibes-sdk/platform
@pellux/goodvibes-sdk/platform/runtime
@pellux/goodvibes-sdk/platform/knowledge
@pellux/goodvibes-sdk/platform/knowledge/extensions
@pellux/goodvibes-sdk/platform/knowledge/home-graph
@pellux/goodvibes-sdk/platform/providers
@pellux/goodvibes-sdk/platform/tools
@pellux/goodvibes-sdk/platform/integrations
@pellux/goodvibes-sdk/platform/node
```

Work:

- Inventory current docs/tests/examples and likely downstream imports that use `./platform/*`.
- Design explicit stable platform entrypoints.
- Add public barrel modules for intended stable entrypoints.
- Remove old aliases and expose only deliberate entrypoints.
- Remove `./platform/*`.
- Document that arbitrary deep platform imports are not public API.
- Remove reliance on broad API Extractor suppressions caused by accidental/deep internals where possible; document any remaining suppressions with a reason and owner.
- Revisit `tsconfig.base.json`'s global `DOM` lib so server packages do not accidentally compile against browser globals unless they explicitly opt in.

Commit:

- `refactor: replace platform wildcard export with explicit sdk entrypoints`

## 4. Split Oversized Route And Handler Interfaces

Problem:

The daemon API route handler contracts have grown into broad "god interfaces." They are hard to review, hard to extend safely, and do not clearly communicate domain ownership.

Target shape:

```ts
export interface DaemonApiRouteHandlers
  extends HealthRouteHandlers,
    AuthRouteHandlers,
    KnowledgeRouteHandlers,
    HomeGraphRouteHandlers,
    MediaRouteHandlers,
    TelemetryRouteHandlers,
    RemoteRuntimeRouteHandlers,
    ArtifactRouteHandlers,
    ChannelRouteHandlers {}
```

Work:

- Split route handler interfaces by domain.
- Split route option/context types where they have the same problem.
- Keep an aggregate handler type only as the canonical domain composition type.
- Keep route domain files close to their handlers and schema helpers.
- Bound telemetry query inputs such as `since` and `until`; reject or clamp negative, fractional, non-finite, and unrealistically large values.
- Remove or assert against duplicate route registrations such as duplicate `/api/remote` GET dispatch so route order cannot silently change behavior.
- Convert untrusted forwarding metadata such as `x-forwarded-for` into clearly audit-only fields before it reaches trust-sensitive pairing/session code.
- Centralize route parsing helpers such as bounded positive integer parsing and shared default/max list limits.

Commit:

- `refactor: split daemon route handler contracts by domain`

## 5. Deduplicate Peer, Operator, And Client Plumbing

Problem:

Peer/operator clients duplicate helper types and request plumbing. This is a symptom of architecture that grew organically and now needs more deliberate shared layers.

Target:

- Peer/operator clients remain distinct public clients.
- Shared request plumbing and helper types live in an appropriate lower layer.
- Contract-level helpers live in `contracts` only if they are truly protocol concepts.
- HTTP/client request helpers live in `transport-http` or a shared client plumbing module.

Work:

- Inventory duplicated helpers such as method arg splitting, key omission, request wrappers, and result normalization.
- Move shared helper logic to the lowest appropriate package.
- Keep peer/operator APIs stable.
- Remove duplicated definitions.
- Standardize vocabulary across peer/operator clients (`getEndpoint` vs `getMethod`).
- Standardize schema failure wrapping so peer/operator client validation failures have consistent error shapes.
- Centralize transport helper duplication where appropriate:
  - retryable status codes
  - transport-hint inference
  - header merging
  - disconnect detection
  - UUID fallback
- Fix fire-and-forget event stream error handling so expected disconnects are swallowed intentionally and unexpected errors are reported instead of re-thrown into an unhandled rejection.
- Improve browser/event diagnostics so non-`Error` events are reported with useful fields rather than `[object Event]`.
- Replace sync traceparent injection paths that no-op in pure ESM with async or dependency-injected trace propagation for HTTP, WS, and SSE consistently.

Commit:

- `refactor: share peer and operator client plumbing`

## 6. Make Base Knowledge The Core System And Home Graph An Extension

Problem:

Knowledge/wiki functionality must not become multiple separate systems. Home Graph is one use case, not a separate knowledge architecture.

Target ownership:

Base knowledge owns:

- semantic gaps
- repair tasks
- source search
- source trust/scoring
- source ingestion
- LLM extraction
- fact quality
- fact promotion
- answer synthesis
- generated wiki/page creation
- page source/fact persistence
- graph relationships
- background self-improvement loops

Home Graph extends base knowledge with:

- HA devices/entities/areas/integrations
- HA object profile policies
- HA graph object linking
- HA-specific map facets
- HA page templates
- HA-specific relationship projection

Work:

- Move generic semantic repair, source ranking, fact quality, source evaluation, answer synthesis, fact promotion, and page generation primitives into base knowledge modules.
- Make Home Graph call into base knowledge extension points instead of owning generic versions.
- Define extension interfaces for object profiles, page templates, relationship resolvers, and facet providers.
- Preserve current Home Graph behavior through the extension layer.
- Fix the PDF re-extraction predicate so unchanged PDFs are not re-extracted solely because their existing extraction is a PDF extraction.
- Refactor `compileKnowledgeSource` so entity, section, and link writes are batched or transaction-scoped where the store supports it.
- Keep binary detection thresholds and extraction decisions named, documented, and testable in the new base ingest layer.
- Move hardcoded English answer-quality fallback behavior behind a base synthesis policy so future localization or extension-specific wording is possible.

Commit:

- `refactor: move semantic repair primitives to base knowledge`

## 7. Make Generated Pages Automatic, Intelligent, And Graph-Driven

Problem:

Generated pages must not be Home Graph-only behavior. Pages are a base knowledge/wiki capability. A self-improving knowledge system should use LLM extraction and verified sources to build useful pages automatically.

Target:

- Pages are generated from verified graph facts, not raw snippets.
- Base knowledge decides when pages should be created/refreshed.
- Extension layers can provide templates and object profiles.
- Empty sections disappear.
- Stale open questions are suppressed when evidence exists.
- Page source lists come from fact-source edges.
- Page relationship/navigation metadata is first-class.

Required page metadata:

- subject id
- subject kind
- target id
- related generated page ids
- neighbor edges/titles
- source ids
- fact ids
- refresh state

Quality rules:

- Reject raw evidence lines.
- Reject title/url-only facts.
- Reject table debris.
- Reject affiliate/comparison/marketplace junk.
- Reject duplicate canonical facts.
- Preserve legitimate numeric specs such as speaker wattage, port counts, screen sizes, refresh rates, dimensions, and battery/capability specs when relevant.

Commit:

- `refactor: generate pages from verified graph facts`

## 8. Make Refinement Durable, Automatic, Global, And Tenacious

Problem:

Self-improvement cannot require manual user interaction. When gaps are noticed, the system should attempt to repair them automatically within policy and budget. This must be a base knowledge function, not Home Graph-only.

Target:

- Gap detection creates durable refinement tasks.
- Repair starts automatically when relevant objects/sources are added.
- Repair can also run on schedule.
- Initial sync/reindex aggressively queues useful repair work.
- The system understands whether a gap is intrinsic to the object type before searching.
- It does not search nonsense gaps such as battery facts for objects that do not have batteries.
- It uses high-quality targeted sources and increasingly specific searches.
- It can use already-indexed official/vendor/accepted sources as repair evidence.

Task contract:

- id
- space id
- subject
- subject type
- gap id
- state
- priority
- trigger
- budget
- attempt count
- blocked/deferred reason
- trace
- accepted/rejected source ids
- promoted fact count
- next attempt time
- created/updated timestamps

Ask behavior:

- If repair can complete within bounded time, answer with repaired facts.
- If repair cannot complete within bounded time, answer explicitly as incomplete/deferred with task ids and repair metadata.
- Do not present a complete zero-fact answer as if it is fully answered.

Commit:

- `refactor: harden knowledge refinement task lifecycle`

## 9. Preserve All Capabilities While Improving Dependency And Runtime Boundaries

Product constraint:

- Keep everything.
- Keep all capabilities available.
- Let users pick and choose what they want.
- Do not remove providers, tools, daemon functionality, runtime functionality, or platform capabilities.

Problem:

The SDK currently exposes and depends on many heavy/runtime-specific capabilities from a broad package surface. That makes lightweight/client-safe consumers inherit unrelated dependencies and risk importing unsuitable implementation.

"Node-only" here means code or dependencies that require server/runtime capabilities such as:

- native modules
- filesystem
- process management
- child processes
- local databases
- language servers
- local tool execution
- server SDK assumptions

This is not a plan to remove Node/Bun/server functionality. It is a plan to put it behind explicit surfaces.

Target surfaces:

```text
# lightweight/client-safe
@pellux/goodvibes-sdk
@pellux/goodvibes-sdk/browser
@pellux/goodvibes-sdk/web
@pellux/goodvibes-sdk/react-native
@pellux/goodvibes-sdk/expo
@pellux/goodvibes-sdk/workers

# explicit heavier/runtime surfaces
@pellux/goodvibes-sdk/platform/node
@pellux/goodvibes-sdk/platform/runtime
@pellux/goodvibes-sdk/platform/knowledge
@pellux/goodvibes-sdk/platform/providers
@pellux/goodvibes-sdk/platform/tools
@pellux/goodvibes-sdk/platform/integrations
```

Work:

- Categorize SDK dependencies as:
  - always needed runtime
  - client-safe
  - Node/Bun runtime
  - provider-specific
  - tool/language-server-specific
  - build/test/dev-only
- Keep all capabilities reachable through explicit entrypoints.
- Move dev/build/test-only dependencies out of SDK runtime dependencies.
- Use dynamic imports for optional heavy provider/tool/runtime dependencies where appropriate.
- Add environment guards so client-safe entrypoints do not accidentally import server-only code.
- Keep docs clear on what each surface is for.

Commit:

- `chore: reduce sdk runtime dependency surface`

## 10. Finish Async, Error, Timer, And Resource Hygiene

Problem:

The review identified swallowed errors, fire-and-forget promises, timers that keep processes alive, and unbounded async work.

Work:

- Re-scan for real findings:
  - empty catches
  - `.catch(() => {})`
  - fire-and-forget without logging
  - `setTimeout` without `unref` where appropriate
  - unbounded queues or fanout
  - fetch/process/resource leaks
- Fix real findings.
- Avoid churn from false positives.
- Keep errors observable.
- Make `runSyncSelfImprovementPump` bounded and interruptible with an `AbortSignal` or equivalent stop flag; avoid fixed multi-round sleep loops that continue after shutdown or budget expiry.
- Fix `HttpStatusError` category fallback so missing HTTP status does not silently become `unknown` when a better category is available from cause/context.
- Avoid page refresh churn by using content hashes or equivalent dirty checks instead of writing `refreshedAt: Date.now()` when generated content did not change.
- Avoid near-cap payload reserialization in remote JSON validation; validate size without an additional full `JSON.stringify` allocation when possible.

Commit:

- `chore: finish async and error hygiene cleanup`

## 11. Test Architecture And Coverage

Problem:

The test suite needs coverage for the new architecture and the failure modes that have been repeatedly observed.

Work:

- Add or refactor tests for:
  - base knowledge repair
  - Home Graph extension behavior
  - cold repair
  - warm repair
  - base knowledge/Home Graph parity
  - official/vendor source preference
  - response facts persisted into graph/page state
  - generated page propagation
  - source/fact dedupe
  - no raw snippet page output
  - map filters
  - reset artifact deletion
  - package export resolution
  - client-safe entrypoint imports
- Add coverage for the concrete second-review bugs that survive the architecture rewrite:
  - PDF re-extract predicate
  - compile/ingest write behavior
  - repair profile rules and non-vendor-specific behavior
  - page source weight scoring bounds
  - telemetry `since`/`until` bounds
  - duplicate route registration protection
  - traceparent propagation in ESM
  - event stream error reporting
- Replace timing sleeps with deterministic waits where possible.
- Split tests only when it improves failure localization and maintainability.

Commit:

- `test: add knowledge refinement and page propagation coverage`

## 12. Docs, Examples, And Contract Artifacts

Problem:

The public API and architecture changes must be documented clearly. Examples should not rely on private folder layout.

Work:

- Update docs for explicit SDK entrypoints.
- Document package boundaries.
- Document base knowledge vs extension architecture.
- Document Home Graph as an extension.
- Document refinement task lifecycle and answer refinement metadata.
- Update examples away from removed deep imports.
- Regenerate contract artifacts after API changes are stable.
- Rewrite docs/tests/examples around the v0.30.0 architecture instead of polishing the old architecture in place.
- Keep example code from teaching anti-patterns:
  - no root import drift when a subpath is the intended API
  - no unref-able timers left referenced in long-lived examples
  - no permanent stub handlers that copy-paste into broken integrations
  - no redundant polling when SSE/event subscriptions are the intended flow
- Align root and package engine policy (`node >=20` vs `node >=22`) deliberately and document the chosen runtime floor.
- Add GitHub Actions Dependabot updates for SHA-pinned actions.
- Add or document license compliance checking if it remains outside the normal validation path.
- Fix vendored package metadata such as fake `vendor/uuid-cjs` versioning.
- Re-baseline or remove stale dated bundle-budget commentary.
- Explain `.goodvibes/` ignore policy in `.gitignore`.

Commit:

- `docs: document sdk public boundaries and refinement model`

## 13. Full Review/Fix Loop

Problem:

The work is not complete just because implementation compiles or one bug is fixed. The review must cover the affected debt areas until no negative findings remain.

Review scope:

- Source copies removed.
- Public exports are explicit.
- No accidental deep platform API.
- God interfaces decomposed.
- Duplicated client helpers removed.
- Base knowledge owns generic knowledge/refinement/page behavior.
- Home Graph is an extension.
- Generated pages use verified graph facts.
- Refinement is durable, automatic, and observable.
- Capabilities are preserved behind intentional entrypoints.
- Runtime/client-safe boundaries are enforced.
- Errors/timers/resources are handled.
- Tests cover architecture and observed failure modes.
- Docs/examples match the architecture.

Loop:

1. Review changed architecture and code.
2. Record findings.
3. Fix findings.
4. Review again.
5. Repeat until the review returns zero negative findings.

Commit:

- Commit each meaningful fix set.
- If the final review produces cleanup-only changes, commit them separately.

## 14. Full Documentation Rewrite For v0.30.0

The v0.30.0 architecture changes are large enough that the existing documentation should not be treated as sacred. Patching old docs may preserve outdated mental models. If the cleanest path is deleting most or all existing documentation and rebuilding it around the new architecture, that is acceptable.

Goal:

- Documentation should teach the v0.30.0 architecture directly.
- It should not describe copied package source, accidental deep imports, or Home Graph as a separate knowledge system.
- It should make the package/sub-package relationship obvious.
- It should make the base knowledge system and extension model obvious.
- It should make runtime surfaces and pick-and-choose capability loading obvious.
- It should make release, validation, and integration expectations clear.

Rewrite strategy:

1. Inventory current docs only for facts that remain true.
2. Delete or quarantine docs that encode old architecture.
3. Create a fresh documentation outline for v0.30.0.
4. Rebuild docs from the new public entrypoints and extension model.
5. Update examples to match the new docs.
6. Ensure every documented import path is exported intentionally.
7. Ensure no docs rely on private folder layout.
8. Ensure no examples teach bad operational patterns.

Proposed v0.30.0 docs set:

- `README.md`: concise product overview, install, first working example, and docs map.
- `docs/architecture.md`: monorepo packages, SDK facade, runtime surfaces, base knowledge, extensions.
- `docs/packages.md`: purpose and dependency direction for each package.
- `docs/exports.md`: every public entrypoint and intended audience.
- `docs/runtime-surfaces.md`: browser, web, Workers, React Native, Expo, Node/Bun/runtime-heavy surfaces.
- `docs/knowledge.md`: base knowledge/wiki system, source ingestion, facts, gaps, repair, pages.
- `docs/knowledge-refinement.md`: task lifecycle, policies, budgets, automatic repair, observability.
- `docs/knowledge-pages.md`: generated pages, page metadata, graph relationships, source/fact persistence.
- `docs/home-graph.md`: Home Graph as a knowledge extension.
- `docs/providers.md`: provider setup and dynamic/heavy capability loading.
- `docs/tools.md`: tool/runtime surfaces and environment requirements.
- `docs/transports.md`: HTTP, realtime, direct transport boundaries.
- `docs/auth.md`: token stores, browser/RN/server auth behavior.
- `docs/errors.md`: error model and categories.
- `docs/testing.md`: testing strategy and route-style harness expectations.
- `docs/release-and-publishing.md`: release workflow after v0.30.0.
- `examples/README.md`: curated examples mapped to docs.

Acceptance criteria:

- A new user can identify which package/entrypoint to import without knowing repo internals.
- A client-safe user does not accidentally import runtime-heavy code.
- A runtime-heavy user can still access every capability intentionally.
- Knowledge/wiki docs describe a single extensible system.
- Home Graph docs describe extension behavior, not a second knowledge system.
- Every example is executable or clearly marked as illustrative.
- All old stale version references are gone.
- All old deep private import paths are gone.
- Documentation matches generated package exports and contract artifacts.

Commit:

- `docs: rewrite sdk documentation for v0.30.0`

## 15. Validation Only After Clean Review

Validation happens only after the review/fix loop is clean.

Validation should include:

- type checks
- test suite
- package metadata checks
- sync/drift checks, if sync remains
- export resolution checks
- browser/RN/Workers runtime checks where relevant
- package dry-run checks only when release preparation is explicitly allowed

No push or publish occurs as part of this plan unless explicitly requested later.
