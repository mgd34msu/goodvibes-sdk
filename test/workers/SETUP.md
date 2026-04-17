# Workers Test Harness — Orchestrator Setup Guide

## Summary

This directory contains the Wave 4 Cloudflare Workers real-runtime test harness for `@pellux/goodvibes-sdk`. It proves the `./web` entry runs cleanly under the workerd V8 isolate via Miniflare's programmatic API.

**Result: `./web` entry is sufficient. No new `./workers` subpath is required.**

`dist/web.js` has zero `node:` imports and zero `Bun.*` API calls. It runs under Workers without adaptation.

---

## 1. DevDependencies to add

Add to root `package.json` `devDependencies` (or workspace root):

```json
"miniflare": "^4.20260415.0"
```

Install:

```bash
bun install
```

Miniflare 4 ships workerd binaries. On first install it downloads the platform binary. Expect ~50–100 MB added to `node_modules`.

---

## 2. Scripts entry to add

Add to root `package.json` `scripts`:

```json
"test:workers": "bun run build && bun test test/workers/workers.test.ts"
```

---

## 3. CI matrix dimension to add

Proposed diff for `.github/workflows/ci.yml` — add `workers` to the `platform-matrix` job:

```yaml
# Inside jobs.platform-matrix.strategy.matrix:
      platform:
        - bun
        - rn-bundle
        - workers   # <-- ADD THIS

# Inside jobs.platform-matrix.strategy.matrix.include:
        - platform: workers
          node-version: "22"
          test-cmd: bun run test:workers
```

Full proposed diff context:

```yaml
      matrix:
        platform:
          - bun
          - rn-bundle
          - workers
        include:
          - platform: bun
            node-version: "22"
            test-cmd: bun run build && bun test test
          - platform: rn-bundle
            node-version: "22"
            test-cmd: bun run build && bun run test:rn
          - platform: workers
            node-version: "22"
            test-cmd: bun run test:workers
```

**Note**: Miniflare downloads workerd binaries during `bun install`. CI needs internet access during the install step (already the case). No additional caching needed beyond `node_modules`.

---

## 4. New `./workers` subpath export — NOT required

**Decision: No new `./workers` subpath is needed.**

`dist/web.js` satisfies the Workers runtime constraint:
- Zero `node:` protocol imports (confirmed by grep)
- Zero `Bun.*` API calls (confirmed by grep)
- No client-side WebSocket construction (Workers-safe)
- No `EventSource` usage (Workers-safe)
- No `location.origin` dependency when `baseUrl` is supplied explicitly

A `./workers` entry would only be needed if:
- Workers requires Durable Object context wiring (not needed for SDK's use case)
- A Workers-specific realtime transport adapter is added (currently out of scope)
- Workers-specific request-scoped timer management is needed (current `setTimeout` usage is fine for request-scoped retry)

See `FINDINGS.md` for the full Workers runtime gap analysis.

---

## 5. Bundle guard extension — proposed diff

When/if a `./workers` entry is added in the future, extend `test/rn-bundle-node-imports.test.ts`:

```ts
// In COMPANION_ENTRIES array, add:
  'workers.js',
```

For now, `web.js` already covers the Workers use case and is already in `COMPANION_ENTRIES`.

---

## 6. Miniflare API notes

Miniflare 4 is programmatic-only. The CLI was removed in Miniflare 3.

Key constructor options used:
- `modules: true` — enable ES module Worker format (boolean, not array)
- `scriptPath` — path to the Worker entry `.mjs` file. **Must be inside `modulesRoot`** for static imports to resolve correctly. The test runner stages `worker.mjs` into `packages/sdk/dist/` at startup and removes it after.
- `modulesRoot` — base directory for module resolution (set to `packages/sdk/dist`). Static imports in the worker resolve relative to `scriptPath`, which must live under `modulesRoot`.
- `modulesRules` — **required** to treat `.js` files as ESModule. Without this, Miniflare defaults to CommonJS parsing for `.js` files, which fails on `import`/`export` syntax. Add: `[{ type: 'ESModule', include: ['**/*.js', '**/*.mjs'] }]`
- `compatibilityDate` — Workers runtime compatibility date

**Module staging pattern** (required due to Miniflare resolution):
```ts
// In beforeAll: copy worker.mjs into SDK_DIST
writeFileSync(WORKER_IN_DIST, readFileSync(WORKER_SOURCE, 'utf8'), 'utf8');
// In afterAll: clean up
unlinkSync(WORKER_IN_DIST);
```

Dispatching requests:
```ts
const res = await mf.dispatchFetch('http://workers.test/path');
```

Cleanup:
```ts
await mf.dispose();
```

**Miniflare simulation note**: Miniflare 4 injects `EventSource` in its local runtime (as of `4.20260415.0`). This is a Miniflare simulation artifact. The production Workers runtime does NOT expose `EventSource`. Tests account for this — see `FINDINGS.md` section 1.

---

## 7. Worker script: `worker.mjs`

The Worker script uses ES module format (`export default { async fetch() {} }`). It handles routes:

| Route | Purpose |
|-------|--------|
| `/smoke` | SDK import + factory call |
| `/auth` | Auth token storage round-trip |
| `/transport` | HTTP transport with mock fetch |
| `/errors` | Error taxonomy import + instantiation |
| `/crypto` | `crypto.subtle` + `crypto.randomUUID` |
| `/globals` | Audit of Workers global availability |

Each handler uses the statically-imported SDK (imported at module load time via `import { createWebGoodVibesSdk } from './web.js'`), exercises APIs, and returns a JSON response. The test runner (`workers.test.ts`) calls `mf.dispatchFetch()` and asserts response bodies.
