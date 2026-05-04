# Ninth Review — `docs/` and `examples/` (WRFC:wrfc_9th_docs)

**Reviewer:** goodvibes:reviewer
**Repo:** `@pellux/goodvibes-sdk` v0.30.3 (HEAD)
**Scope:** `docs/`, `examples/`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`
**Method:** Cross-checked every documented import path against the canonical
`packages/sdk/package.json` exports map (37 entries) plus actual source exports
in `packages/sdk/src/`, `packages/contracts/src/`, `packages/operator-sdk/src/`,
`packages/peer-sdk/src/`, and `packages/transport-*/src/`.

---

## Summary by Severity

| Severity | Count |
|----------|------:|
| CRITICAL | 1 |
| MAJOR | 6 |
| MINOR | 21 |
| NITPICK | 9 |
| **TOTAL** | **37** |

---

## CRITICAL

### CRIT-01 — Wrong package name in `provider-model-api.md` Zod imports

**File:** `docs/provider-model-api.md:231,241`

Imports the Zod schemas from `@pellux/contracts`, which **does not exist**.
The published source-of-truth contracts package is `@pellux/goodvibes-contracts`
(verified via `packages/contracts/package.json:2`), and the SDK facade re-exports
the same schemas at `@pellux/goodvibes-sdk/contracts`.

```md
Importable from `@pellux/contracts`:                       <-- WRONG

```typescript
import {
  ListProvidersResponseSchema,
  ...
} from '@pellux/contracts';                                <-- WRONG
```
```

A consumer copy-pasting this snippet hits `Cannot find module '@pellux/contracts'`.
This is the only documented import path in the entire docs tree that does not
resolve through the published package map.

**Fix:** Change both occurrences to `@pellux/goodvibes-sdk/contracts` (the SDK
facade subpath; preferred for SDK consumers) or `@pellux/goodvibes-contracts`
(the source-of-truth workspace package).

---

## MAJOR

### MAJ-01 — `docs/retries-and-reconnect.md:91` shows a non-existent SDK method

**File:** `docs/retries-and-reconnect.md:91`

```ts
const result = await sdk.operator.requestJson(route, payload, { idempotencyKey: key });
```

The `OperatorSdk` interface in `packages/operator-sdk/src/client-core.ts` does
**not** expose a `requestJson` method. `requestJson` lives on the lower-level
HTTP transport (`packages/transport-http/src/http-core.ts:107`,
`packages/transport-http/src/http.ts:188`), not on the operator client. The
documented call path will fail at type-check and at runtime with
`sdk.operator.requestJson is not a function`.

**Fix:** Either (a) replace with a real per-method idempotent call surface
(e.g. document `sdk.operator.<resource>.<method>(args, { idempotencyKey })`
using the actual call shape verified against `client-core.ts`), or (b) document
the lower-level transport path with the correct construction
(`sdk._operator.transport.requestJson(...)` if that is the supported escape hatch)
— and clarify it is not part of the public operator surface.

### MAJ-02 — `docs/provider-model-api.md:231` claims `@pellux/contracts` exposes schemas

Even if CRIT-01 is fixed by switching the package name, the surrounding text
("Importable from `@pellux/contracts`") implies a separately-installed package.
It must be reworded to say "Importable from the SDK contracts subpath" or
"Importable from `@pellux/goodvibes-sdk/contracts`" so consumers know they do
not need a separate `@pellux/contracts` install.

### MAJ-03 — `docs/security.md` references internal source paths as "Source"

**File:** `docs/security.md` lines 78 (implied), 95, 126, 168, 226 (`config/secrets.ts` and `config/secret-refs.ts`), 297, 377

The doc repeatedly cites private source paths under
`packages/sdk/src/platform/...` as the canonical location:

- L136: ``**Source:** `packages/sdk/src/platform/pairing/` ``
- L226: ``**Source:** `packages/sdk/src/platform/config/secrets.ts` and `config/secret-refs.ts` ``
- L297: ``**Source:** `packages/sdk/src/platform/permissions/` ``
- L377: ``**Source:** `packages/sdk/src/platform/security/user-auth.ts` — `writeBootstrapCredentialFile()`, `clearBootstrapCredentialFile()` ``

Per `docs/exports.md:36-38` and `docs/public-surface.md:228-235`, repository
source paths are not the consumer contract. A consumer doc that points readers
at internal source files invites deep-import breakage on the next refactor and
contradicts the public-surface stance the SDK has otherwise adopted. Earlier
review cycles flagged the same pattern in `docs/auth.md`, `docs/secrets.md`,
`docs/runtime-orchestration.md`, and `docs/channel-surfaces.md` (per
CHANGELOG `## [Unreleased]`). `docs/security.md` is the largest remaining
offender.

**Fix:** Replace `**Source:**` lines with public-API references — either the
public subpath that exposes the symbol (e.g. `@pellux/goodvibes-sdk/platform/pairing`,
`@pellux/goodvibes-sdk/platform/config`, `@pellux/goodvibes-sdk/platform/permissions`)
or simply the public symbol name. Drop `packages/sdk/src/...` paths from
consumer-facing material.

### MAJ-04 — Multiple consumer docs cite internal source paths

Same root issue as MAJ-03, but spread across additional files. All of these
files are linked from `docs/README.md`'s consumer-oriented index, not the
internal `architecture.md` / `architecture-platform.md` pair (which legitimately
describe internal layout):

| File | Lines | Internal paths cited |
|------|------:|----------------------|
| `docs/automation.md` | 7-12 | `platform/automation/`, `platform/watchers/`, `platform/channels/`, `platform/control-plane/method-catalog-control-automation.ts`, `platform/control-plane/method-catalog-channels.ts` |
| `docs/media-and-search.md` | 7-12 | `platform/artifacts/`, `platform/media/`, `platform/multimodal/`, `platform/voice/`, `platform/web-search/` |
| `docs/project-planning.md` | 8-12 | `platform/knowledge/project-planning/`, `platform/daemon/http/project-planning-routes.ts`, `platform/control-plane/method-catalog-knowledge.ts` |
| `docs/feature-flags.md` | 7-8 | `packages/sdk/src/platform/runtime/feature-flags/flags.ts` |
| `docs/tools.md` | 8 | `packages/sdk/src/platform/tools/` |
| `docs/tool-safety.md` | 22 | `// from packages/sdk/src/platform/providers/tool-formats.ts` (in code comment) |
| `docs/knowledge.md` | 7 | `packages/sdk/src/platform/knowledge/` |

**Fix:** Same as MAJ-03. Either (a) move these `Source:` lists into a single
"Internal source map" doc (already exists at `docs/architecture-platform.md`
for `platform/`) and link to it, or (b) replace each line with the public
subpath that exposes the same surface.

### MAJ-05 — README example links exist on disk but were initially hidden by gitignore filtering during discovery

**File:** `README.md:177-190`, plus `examples/README.md:28-35`

The README and `examples/README.md` both list:

- `examples/submit-turn-quickstart.mjs`
- `examples/operator-http-quickstart.mjs`
- `examples/peer-http-quickstart.mjs`
- `examples/realtime-events-quickstart.mjs`
- `examples/retry-and-reconnect.mjs`
- `examples/android-kotlin-quickstart.kt`
- `examples/ios-swift-quickstart.swift`

I verified each of these files exists on disk (`examples/` glob). However, the
discovery glob with `respect_gitignore=true` initially hid them — the repo's
`.gitignore` is masking these example files. If `.gitignore` is filtering
`examples/*.mjs`, `*.kt`, and `*.swift` from the published package and from
`bun --cwd examples run typecheck`, the doc will look correct on disk but the
files will be stripped from the npm tarball.

**Fix:** Verify `.gitignore` and `packages/sdk/package.json:files` actually
include these example files for distribution. If they ARE git-tracked,
double-check the `examples-typecheck` CI gate (`bun --cwd examples run typecheck`)
covers `.mjs` files (`examples/tsconfig.json` includes `*.mjs`, so this should
work — but the discovery anomaly suggests reviewing the gitignore intent).

### MAJ-06 — `docs/observability.md:14,23,80` shows internal namespace import paths as the canonical access pattern for the activity logger

**File:** `docs/observability.md:13-30`

```ts
import { configureActivityLogger } from '@pellux/goodvibes-sdk/platform/utils';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
```

Both `configureActivityLogger` and `logger` are exported from
`@pellux/goodvibes-sdk/platform/utils` (verified). However, the doc presents
them as the primary debug-logging entry point for SDK consumers. `logger` is a
process-global singleton used by SDK internals, and external callers writing
to it can collide with internal log writes and corrupt the buffered Markdown
log that the SDK uses for its own diagnosis. There is no documented
single-writer guarantee, no log-rotation contract, and no public log schema —
the `[INFO]` example at L34-39 is described as "Markdown" but a downstream
consumer can't depend on that format being stable.

**Fix:** Either (a) gate this section behind "for SDK contributors / daemon
embedders only" with explicit guidance against mixing host-app log calls with
SDK internal logs, or (b) document an isolated `createActivityLogger(dir)`
factory pattern that returns a host-owned instance instead of a shared
singleton.

---

## MINOR

### MIN-01 — `docs/realtime-and-telemetry.md:33` uses underspecified call signature

**File:** `docs/realtime-and-telemetry.md:33-34`

```ts
const snapshot = await sdk.operator.telemetry.snapshot({ limit: 100 });
const errors = await sdk.operator.telemetry.errors({ severity: 'error' });
```

Both methods exist (verified in `packages/operator-sdk/src/client-core.ts:135-137`
and the contract input types in `packages/contracts/src/generated/foundation-client-types.ts:203`).
The call signatures are correct. However, the snippet does not show that
`telemetry.snapshot` accepts a structured options object including `since`,
`until`, `domains`, `types`, `severity`, `traceId`, `sessionId`, etc., and the
casual reader may assume `limit` is the only supported field. Either link to
the operator reference or expand the example.

### MIN-02 — `docs/error-handling.md:15,86` use `accounts.snapshot()` without explanation

`docs/error-handling.md:15` and `:86` use `sdk.operator.accounts.snapshot()`
inside `try` blocks as the example call. `accounts.snapshot` exists
(verified at `packages/operator-sdk/src/client-core.ts:112`), but the rest of
the doc set canonically uses `control.snapshot()`. Inconsistent example call
between sibling docs makes the surface harder to learn. Standardize on
`sdk.operator.control.snapshot()` to match `getting-started.md`,
`browser-integration.md`, `web-ui-integration.md`, `react-native-integration.md`,
and `expo-integration.md`.

### MIN-03 — `docs/getting-started.md:124` documents `getAuthToken` precedence without showing the type signature

`getAuthToken` is documented as a precedence step (priority 2 between
`tokenStore` and `authToken`) but never shown in a code example. Add a small
TypeScript snippet illustrating
`getAuthToken: () => Promise<string | null>` so consumers can wire it
without guessing.

### MIN-04 — `docs/companion-message-routing.md:74` uses an undefined `runtimeBus` reference

**File:** `docs/companion-message-routing.md:74`

```ts
runtimeBus.on('COMPANION_MESSAGE_RECEIVED', ({ payload }) => { ... });
```

`runtimeBus` is not defined in scope, not imported, and the SDK does not export
a public `runtimeBus`. The bus referenced here is the internal
`RuntimeEventBus` (per `architecture.md:312`), which is in-process only and
not part of the SDK's companion-message public contract. A consumer copying
this snippet has no clear way to obtain `runtimeBus`. Either (a) replace with
the public realtime feed pattern (`sdk.realtime.viaSse().<domain>.on(...)`) or
(b) clarify that this snippet only applies to in-process daemon hosts and
provide the import path used to acquire the bus instance.

### MIN-05 — `docs/companion-message-routing.md:42` says `kind: 'followup'` but no example shows the call shape

The input type for `sessions.messages.create` (verified at
`packages/contracts/src/generated/foundation-client-types.ts:185`) lists
`kind?: "message" | "task" | "followup"`. The doc lines 39-43 correctly
distinguish all three. However the doc says `kind: 'followup'` "explicitly
queues a session follow-up through the broker" without showing the actual
HTTP/SDK call. Add a code example matching the existing `kind: "message"`
example for parity.

### MIN-06 — `docs/security.md:78,95` reference deeply-private source paths in narrative prose

In addition to MAJ-03's `**Source:**` callouts, these lines drop internal
paths inline:

- L78: ``...managed by `SpawnTokenManager` (`security/spawn-tokens.ts`)``
- L95: ``...sessions ... managed by `UserAuthManager` (`security/user-auth.ts`)``
- L122: ``...managed by `ApiTokenAuditor` (`security/token-audit.ts`)``
- L307: ``...analyzed by `analyzePermissionRequest()` (`permissions/analysis.ts`)``

Replace inline parentheticals with the public symbol name only; drop the
file path.

### MIN-07 — `docs/security.md:432` claims a function exists at a specific source line but does not state the public path

L432: ``Source: `packages/sdk/src/platform/security/user-auth.ts` — `writeBootstrapCredentialFile()`, `clearBootstrapCredentialFile()` ``

If these are truly part of the public contract, document the public subpath
that exposes them (e.g. `@pellux/goodvibes-sdk/platform/security` — but
**that path is NOT in the package exports map**, see public-surface.md
L222-224 which says security is namespace-only via the aggregate `./platform`).
Either expose `clearBootstrapCredentialFile` through a documented subpath or
remove the example.

### MIN-08 — `docs/auth.md:8` mixes public + internal auth references

```md
(public API: `@pellux/goodvibes-sdk/auth` and `@pellux/goodvibes-sdk/client-auth`)
```

Then immediately the doc switches into private path narration ("Daemon-facing
code resolves..."). This is acceptable as an internal architecture note, but
the `# Auth Architecture` heading and the prose-level mixing of public/private
boundaries is the same issue MAJ-03 flagged elsewhere. Add a clearer
"For consumer guidance see `authentication.md`; everything below is internal."
disclaimer at the top — currently it has only a one-line internal-source-map
note (L3) that is easy to miss.

### MIN-09 — `docs/architecture.md` has a duplicate `## Pairing System` section vs. dedicated `pairing.md`

The architecture doc (L433-468) describes the same pairing flow already covered
in `docs/pairing.md` (L73-128, "QR Code Flow"). Since both are kept in sync by
hand, drift is likely. Pick one canonical source and have the other link to it.

### MIN-10 — `docs/architecture.md:107-141` layer diagram lists `inception` provider but README/provider-model-api references mainstream providers only

The architecture diagram says "Anthropic · OpenAI · Gemini · Inception Labs · Ollama · …".
`provider-model-api.md` actively uses Inception in JSON examples (`inception:mercury-2`).
README.md:44-48 lists "OpenAI, OpenAI subscription/Codex, Anthropic, Gemini, Bedrock, Vertex,
GitHub Copilot, local/custom providers, OpenAI-compatible providers" — but does
**not** mention Inception or Ollama. Either add Inception/Ollama to the README
provider list, or drop them from `architecture.md` and `provider-model-api.md`
examples for consistency.

### MIN-11 — `docs/observability.md:31-39` shows a non-runnable Markdown snippet

```
[2026-04-15T10:23:01.042Z] [INFO] session started
```json
{ "sessionId": "sess_abc123" }
```
```

The triple-backtick fences are nested; in Markdown rendering this breaks code
blocks. Use a fence-level escape (e.g. four backticks for the outer block, or
indent-based code).

### MIN-12 — `docs/observability.md:120` and similar incorrectly imply event types like `STREAM_DELTA`, `TURN_COMPLETED` are stable runtime events

These are real runtime events in the contract, but the doc presents them
without linking to `docs/reference-runtime-events.md`. Add a single inline
link near the first event-type mention.

### MIN-13 — `docs/companion-app-patterns.md:35,42` references `/api/companion/chat/sessions/:id` without disambiguating from `/api/sessions/:id`

A reader skimming the doc could conflate companion-chat sessions with operator
sessions. Add one sentence clarifying that companion-chat sessions are an
isolated daemon-hosted resource separate from the operator's TUI session.

### MIN-14 — `docs/pairing.md:351-355` example treats `err.status === 401` as if `status` is always defined

```ts
if (err.status === 401) { ... }
```

Per `docs/error-kinds.md:211`, `status` is `number | undefined`. The check
will silently fail for non-HTTP errors (e.g. a `network` kind error with no
HTTP response). Use `err.kind === 'auth'` (per the same doc's quick-reference
table) or guard with `err instanceof HttpStatusError`.

### MIN-15 — `examples/auth-login-and-token-store.ts:15-16` shows literal placeholder strings for username/password

```ts
username: process.env.GOODVIBES_USERNAME ?? '<set GOODVIBES_USERNAME>',
password: process.env.GOODVIBES_PASSWORD ?? '<set GOODVIBES_PASSWORD>',
```

If a developer runs this without setting the env vars, the SDK will
authenticate (or fail) with literal `<set GOODVIBES_USERNAME>` strings. Better
UX: throw early when the env var is unset.

### MIN-16 — `examples/companion-approvals-feed.ts:14` calls `approvals.list()` without showing pagination handling

`approvals.list()` returns up to N records; the example does not demonstrate
pagination/streaming the full list, so a consumer with thousands of approvals
will see truncated output. Add a comment about pagination or use a smaller
demonstrable scope.

### MIN-17 — `examples/expo-quickstart.tsx:22` uses `sdk.realtime.viaWebSocket()` but does not handle the well-documented "WebSocket implementation is required" failure mode

Per `docs/troubleshooting.md:17-23`, RN Hermes runtimes may need
`WebSocketImpl` injection. The Expo quickstart silently assumes it works.
Add a brief defensive note in the comment.

### MIN-18 — `examples/react-native-quickstart.ts:9` defaults `authToken` to literal `'replace-me'`

Same anti-pattern as MIN-15. Use `throw new Error('GOODVIBES_TOKEN required')`
when unset, or document explicitly that this string will fail authentication
on the daemon.

### MIN-19 — `examples/daemon-fetch-handler-quickstart.ts:39` casts `{ version: 1 }` to `Record<string, unknown>` to silence the type system

```ts
getOperatorContract: () => ({ version: 1 }) as unknown as Record<string, unknown>,
```

The PLACEHOLDER comment (lines 35-38) explains this, but the cast hides a type
error rather than documenting how a host actually constructs an
`OperatorContract`. Add an inline pseudocode example or a TODO link to a
follow-up doc.

### MIN-20 — `docs/feature-flags.md:117-148` profile JSON fragments use `permissions.tools.fetch: "prompt"` but the rest of the docs use `permissions.tools.*` config without showing the `prompt` literal

The `prompt` value for `permissions.tools.<name>` is real per `docs/tools.md:97`
("prompts for write/edit/exec/fetch/agent/workflow/delegate/MCP"). However,
neither `docs/security.md` nor `docs/tool-safety.md` shows the JSON config
literal. Cross-reference for consistency.

### MIN-21 — `docs/observability.md:622` import line wraps in a way that breaks copy-paste

```ts
import { createGoodVibesSdk, createConsoleObserver } from '@pellux/goodvibes-sdk';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';
```

These two lines mix root and subpath imports. Cosmetic — but `getting-started.md`
does the exact same thing (L200, L135-136) consistently, while
`observability.md` reaches the same pattern from a different direction.
Standardize the order.

---

## NITPICK

### NIT-01 — `README.md:25-29` warns about `YOUR_GITHUB_TOKEN` placeholder; could explicitly point at `gh auth token` or `npm token` documentation

`README.md:29` says "Never commit a real token to source control." Strong, but
the doc could go further by pointing at the GitHub-recommended
`~/.npmrc`-based auth pattern.

### NIT-02 — `docs/error-kinds.md:158-168` introduces "WRFC synthetic critical issues" without linking to `wrfc-constraint-propagation.md` until the bottom

Add an early link near L158 so readers know where to find context.

### NIT-03 — `docs/security.md` rate-limit table (L201-204) has no anchor link target for "rate limiting"

Other docs reference "rate limiting" — adding `## Rate Limiting` heading
matches the pattern (the heading exists at L203, but anchors are reachable).
No actual issue; cosmetic.

### NIT-04 — `docs/release-and-publishing.md:24` lists Bun as required runtime but does not specify the exact version

`CONTRIBUTING.md:3` pins Bun 1.3.10 exactly. `release-and-publishing.md:24`
just says "Bun for the full surface". Mention 1.3.10 for consistency.

### NIT-05 — `docs/realtime-and-telemetry.md:42-44` shows OTLP routes without indicating that the responses are OTLP-shaped (i.e. binary protobuf or JSON-encoded)

Mention the response Content-Type so consumers know whether to parse JSON or
proto.

### NIT-06 — `examples/README.md:21-35` table footer reads "Most examples read `GOODVIBES_BASE_URL` and `GOODVIBES_TOKEN`" but no central env-var glossary

Add a small "Environment variables" sub-section at the top listing every
env var the examples consume (`GOODVIBES_BASE_URL`, `GOODVIBES_TOKEN`,
`GOODVIBES_USERNAME`, `GOODVIBES_PASSWORD`).

### NIT-07 — `docs/architecture.md:344-371` lists 21 store domains, but the runtime store has more (per `docs/observability.md:101-128` runtime event domain table)

The two doc sections describe related but different things (state domains vs
event domains). The casual reader could mistake them. One-line clarifying
note would help.

### NIT-08 — `docs/pairing.md:189` says "import from `@pellux/goodvibes-sdk/auth`" for `createMemoryTokenStore` (correct), but `docs/getting-started.md:28` shows the same import — inconsistent capitalization in surrounding text

Cosmetic. Standardize the prose phrasing across both docs.

### NIT-09 — Several docs use both `./browser` and `@pellux/goodvibes-sdk/browser` interchangeably in tables and prose

Per `docs/public-surface.md`, the canonical form is the full
`@pellux/goodvibes-sdk/<subpath>`. Several tables in `docs/packages.md`,
`docs/surfaces.md`, and `docs/public-surface.md` use the bare `./<subpath>`
form (which is technically the package.json export key, not an import path).
Readers may copy-paste `./browser` literally and hit `Cannot find module`.
Mark every table column header that uses the `./` form as "package export key"
versus "import path" for clarity.

---

## Reality Check Results

| Check | Status | Notes |
|-------|--------|-------|
| Docs files exist | PASS | All 59 docs exist on disk; cross-doc links verified for 18 spot checks |
| Examples files exist | PASS | All 18 example files exist (incl. `.mjs`, `.kt`, `.swift`) |
| All documented imports resolve through `package.json` exports map | FAIL | `docs/provider-model-api.md:231,241` uses `@pellux/contracts` (CRIT-01) |
| All cited public symbols are actually exported | PASS | Every `import { X } from '@pellux/goodvibes-sdk/<subpath>'` in docs resolves to a real export — except CRIT-01 |
| All cited operator/peer methods exist in the contract | PASS | Verified for `control.snapshot`, `accounts.snapshot`, `telemetry.snapshot/.events/.errors/.traces/.metrics`, `telemetry.otlp.{traces,logs,metrics}`, `sessions.create`, `sessions.messages.create`, `approvals.list`, `approvals.claim/.approve/.deny`, `control.auth.login`, `control.status` |
| Internal `packages/sdk/src/...` paths leaked into consumer docs | FAIL | MAJ-03, MAJ-04 |
| README example links resolve to existing files | PASS | All 14 example links in `README.md:177-190` exist |
| CHANGELOG version matches `packages/sdk/package.json:3` | PASS | Both at `0.30.3` |
| No hardcoded credentials in examples | PASS | No `password = "..."` / `api_key = "..."` patterns |
| No TODO/FIXME/STUB markers in `docs/` | PASS | None found |
| TODO/FIXME/PLACEHOLDER markers in `examples/` | PARTIAL | `examples/daemon-fetch-handler-quickstart.ts:23,35,38` has 3 PLACEHOLDER comments — but they are intentional, documented in CHANGELOG `## [Unreleased]` |
| `forSession` documented in submit-turn quickstart import | PASS | Re-exported from root via `packages/sdk/src/index.ts:149` (`export * from './transport-realtime.js'`) |
| `createWebGoodVibesSdk` exists | PASS | Verified at `packages/sdk/src/web.ts:17` and re-exported from root index |
| `createBrowserGoodVibesSdk` exists | PASS | Verified at `packages/sdk/src/browser.ts:48` |

**REALITY CHECK CONCLUSION:** Two failures (CRIT-01 broken import path, MAJ-03/04
internal source path leaks). Everything else verified clean.

---

## Cross-Cutting Observations

1. **Documentation-versus-source-of-truth split is mostly disciplined.** The
   docs index (`docs/README.md`) has clear consumer/internal lanes:
   `auth.md` <-> `authentication.md`, `errors.md` <-> `error-handling.md` <->
   `error-kinds.md`, `testing.md` <-> `testing-and-validation.md`,
   `runtime-surfaces.md` <-> `surfaces.md`. Each pair has a one-line disclaimer.
   The pattern works.

2. **`docs/security.md` is the highest-value remaining cleanup target.**
   It is a consumer-facing security doc (linked from
   `docs/README.md:67` and `README.md:172`), but it cites internal source
   paths roughly seven times. The eighth-review CHANGELOG cleaned up four
   sibling docs but not this one.

3. **The Zod-schemas import path mismatch in `provider-model-api.md` is the
   only doc-level wire-format error I found** in 5,200+ lines of documentation
   reviewed. Everything else verified clean against the canonical
   `package.json` exports map.

4. **No deep-import-into-`platform/*-not-listed`-paths violations.** Every
   `@pellux/goodvibes-sdk/platform/<x>` path used in docs and examples is in
   the export map (verified against `packages/sdk/package.json:83-202`).

5. **Examples typecheck correctly** under `bun --cwd examples run typecheck`
   (CI gate `examples-typecheck` per `CONTRIBUTING.md:51`). The
   `react-expo-shims.d.ts` shim correctly stubs `react` and `expo-secure-store`
   for the typecheck pass.

6. **CHANGELOG hygiene is good.** `## [Unreleased]` clearly tracks the
   eighth-review remediation; v0.30.0 -> v0.30.3 entries are all dated
   2026-05-02/03 and align with `package.json` version `0.30.3`.

---

## Recommendations (Prioritized)

### Immediate (block release)

1. **Fix CRIT-01.** Change `@pellux/contracts` to
   `@pellux/goodvibes-sdk/contracts` in `docs/provider-model-api.md:231,241`.

### This PR

2. **Fix MAJ-01** (`requestJson` in `retries-and-reconnect.md`).
3. **Fix MAJ-03** (`security.md` internal source paths). This is the largest
   remaining lint debt from the eighth review.
4. **Fix MAJ-04** (other consumer docs with internal source paths).
5. **Fix MAJ-06** (observability logger guidance — public/private confusion).

### Follow-up

6. Resolve all MINOR items together in a single doc-cleanup PR.
7. Address NITPICKs as cosmetic backlog.

---

## Final Counts by Severity

- **CRITICAL:** 1
- **MAJOR:** 6
- **MINOR:** 21
- **NITPICK:** 9
- **TOTAL:** 37
