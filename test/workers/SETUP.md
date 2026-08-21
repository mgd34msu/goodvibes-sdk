# Workers Test Harness Setup Guide

## Summary

This directory contains the Cloudflare Workers runtime test harness for `@pellux/goodvibes-sdk`. It proves the `./web` entry runs cleanly under the workerd V8 isolate via Miniflare's programmatic API.

**Result: `./web` entry is sufficient for normal Worker-hosted operator HTTP clients. `./workers` now exists separately for the optional GoodVibes Worker bridge.**

**Maintained status:** This setup guide is retained with the Workers runtime
tests. Keep it aligned with `package.json` scripts and CI matrix changes.

`dist/web.js` has zero `node:` imports and zero `Bun.*` API calls. It runs under Workers without adaptation.

---

## 1. DevDependency

Declared in root `package.json` `devDependencies`:

```json
"miniflare": "^4.20260415.0"
```

Fresh install:

```bash
bun install
```

Miniflare 4 ships workerd binaries. On first install it downloads the platform binary. Expect ~50–100 MB added to `node_modules`.

**CI caching**: Cache the `node_modules` directory in CI (standard `actions/cache` step on `node_modules`). This caches the workerd binary alongside npm packages. No separate binary cache is needed, `node_modules` alone is sufficient.

---

## 2. Scripts entry

Defined in root `package.json` `scripts`:

```json
"test:workers": "bun scripts/test.ts test/workers/workers.test.ts"
```

`scripts/test.ts` is the repo's shared test-runner wrapper (temp-directory
containment, an owned child process, a per-run timeout ceiling). It does not
build the SDK itself, so a local run needs `bun run build` first; CI supplies
the dist bytes by restoring the shared `build` job's artifact instead of
rebuilding per leg.

---

## 3. CI matrix dimension

`.github/workflows/ci.yml` runs `workers` (and `workers-wrangler`) as two of
the four legs of the `platform-matrix` job:

```yaml
      matrix:
        platform:
          - bun
          - rn-bundle
          - workers
          - workers-wrangler
        include:
          - platform: bun
            node-version: "22"
            test-cmd: bun scripts/test.ts
          - platform: rn-bundle
            node-version: "22"
            test-cmd: bun run test:rn
          - platform: workers
            node-version: "22"
            test-cmd: bun run test:workers
          - platform: workers-wrangler
            node-version: "22"
            test-cmd: bun run test:workers:wrangler
```

Each leg downloads and restores the single `build` job's artifact rather than
rebuilding, so every platform leg tests the exact same `dist/` bytes.

**Note**: Miniflare downloads workerd binaries during `bun install`. CI needs internet access during the install step (already the case). Cache `node_modules` in CI, this is sufficient to avoid re-downloading the workerd binary on every run.

---

## 4. `./workers` subpath export

**Decision: `./workers` is required only for the optional Worker bridge.**

`dist/web.js` satisfies the Workers runtime constraint:
- Zero `node:` protocol imports (confirmed by grep)
- Zero `Bun.*` API calls (confirmed by grep)
- No client-side WebSocket construction (Workers-safe)
- No `EventSource` usage (Workers-safe)
- No `location.origin` dependency when `baseUrl` is supplied explicitly

`dist/workers.js` is a separate bridge entry for:
- Proxying `/batch/*` to daemon `/api/batch/*` routes
- Enqueueing small Cloudflare Queue tick signals
- Consuming queue messages and allowing retries/DLQ handling
- Running scheduled ticks against the daemon

See `NOTES.md` for the Workers runtime capability notes.

---

## 5. Bundle guard extension

The `./workers` entry is included in `test/rn-bundle-node-imports.test.ts`:

```ts
// In COMPANION_ENTRIES array:
  'workers.js',
```

`web.js` remains in `COMPANION_ENTRIES` and covers normal Worker-hosted SDK clients.

---

## 6. Miniflare API notes

Miniflare 4 is programmatic-only. The CLI was removed in Miniflare 3.

Key constructor options used:
- `modules: true`, enable ES module Worker format (boolean, not array)
- `scriptPath`, path to the Worker entry. **Must be inside `modulesRoot`** for static imports to resolve correctly. The test runner: (1) stages `worker.ts` as `_workers-test-entry.ts` into `packages/sdk/dist/` so esbuild can resolve relative imports against the built dist; (2) bundles the result via esbuild to `.test-tmp/workers-harness/_workers-test-bundled.mjs`; (3) removes the staged source from `dist/` so concurrent builds are not affected.
- `modulesRoot`, base directory for module resolution (set to `packages/sdk/dist`). Static imports in the worker resolve relative to `scriptPath`, which must live under `modulesRoot`.
- `modulesRules`, **required** to treat `.js` files as ESModule. Without this, Miniflare defaults to CommonJS parsing for `.js` files, which fails on `import`/`export` syntax. Add: `[{ type: 'ESModule', include: ['**/*.js', '**/*.mjs'] }]`
- `compatibilityDate`, Workers runtime compatibility date. **Policy**: bump quarterly; pick a date within the last calendar quarter (e.g. `'2026-04-01'` for Q1 2026).

**Module staging pattern** (required due to Miniflare resolution):

We write the worker entry to a tmp directory OUTSIDE `dist/` (e.g. `.test-tmp/workers-harness/`) and set `modulesRoot` to `packages/sdk/dist`. This eliminates the dist-race foot-gun, since concurrent builds that clean/rewrite `dist/` cannot clobber the staged file.

```ts
// In beforeAll: create tmp dir and stage worker entry
mkdirSync(TMP_DIR, { recursive: true });
writeFileSync(WORKER_IN_TMP, readFileSync(WORKER_SOURCE, 'utf8'), 'utf8');
// In afterAll: clean up tmp dir
rmSync(TMP_DIR, { recursive: true, force: true });
```

Dispatching requests:
```ts
const res = await mf.dispatchFetch('http://workers.test/path');
```

Cleanup:
```ts
await mf.dispose();
```

**Miniflare simulation note**: Miniflare 4 injects `EventSource` in its local runtime (as of `4.20260415.0`). This is a Miniflare simulation artifact. The production Workers runtime does NOT expose `EventSource`. Tests account for this; see `NOTES.md`.

---

## 7. Worker script: `worker.ts`

The Worker script uses ES module format (`export default { async fetch() {} }`). It handles routes:

| Route | Purpose |
|-------|--------|
| `/smoke` | SDK import + factory call |
| `/auth` | Auth token storage round-trip |
| `/transport-success` | HTTP transport, success path (mock returns real-shape JSON for `GET /api/sessions`) |
| `/transport-error` | HTTP transport, error path (mock returns 5xx, asserts typed `'service'` kind) |
| `/errors` | Error taxonomy import + instantiation |
| `/crypto` | `crypto.subtle` + `crypto.randomUUID` |
| `/globals` | Audit of Workers global availability |

Each handler uses the statically-imported SDK (imported at module load time via `import { createWebGoodVibesSdk } from './web.js'`), exercises APIs, and returns a JSON response. The test runner (`workers.test.ts`) calls `mf.dispatchFetch()` and asserts response bodies.
