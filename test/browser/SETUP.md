# Wave 2 Browser Harness — Orchestrator Setup Guide

This document tells the orchestrator exactly what to add to the repository to
make `test/browser/` runnable. The harness code is complete; only the
dependency installations and CI wiring described below are missing.

---

## 1. Root `package.json` — devDependencies to add

Add the following entries to the `devDependencies` block in the **root**
`package.json` (not the published `packages/sdk/package.json`):

```json
"@vitest/browser": "^2.2.0",
"vitest": "^2.2.0",
"playwright": "^1.50.0",
"msw": "^2.7.0"
```

Reasoning:
- `@vitest/browser` — the Vitest browser mode plugin. Must match `vitest` version.
- `vitest` — test runner used by the browser harness (separate from `bun test`).
- `playwright` — Chromium/Firefox/WebKit browser binaries used by `@vitest/browser`.
- `msw` v2 — Mock Service Worker; `msw/browser` provides `setupWorker()` for
  browser contexts, intercepting native fetch without needing Node.js http.

---

## 2. Root `package.json` — scripts to add

Add the following scripts to the `scripts` block:

```json
"test:browser": "bun run build && npx vitest run --config vitest.browser.config.ts",
"test:browser:dev": "bun run build && npx vitest --config vitest.browser.config.ts"
```

`test:browser` performs a build first to ensure `packages/sdk/dist/browser.js`
exists, then runs the Vitest browser suite in headless Chromium. The `:dev`
variant runs in watch mode for local development.

---

## 3. MSW Service Worker file

MSW v2 browser mode requires a service worker script at a static path served by
the test host. Generate it **once** before running the suite:

```sh
npx msw init public/
```

This creates `public/mockServiceWorker.js`. Commit this file to the repository
so CI does not need to regenerate it on every run.

If the `public/` directory does not yet exist, create it first:

```sh
mkdir -p public
npx msw init public/
```

**Why this is needed:** `setupWorker()` (from `msw/browser`) installs the
service worker in the Chromium page context. Without the worker file present at
the expected path, MSW cannot intercept fetch requests and all tests will fail
with unhandled request errors.

---

## 4. Playwright browser download

After installing devDependencies, download the Playwright Chromium binary:

```sh
bun x playwright install chromium
```

This is required once per machine/CI runner. In CI this step must be added to
the workflow before the `test:browser` command (see section 5).

Optionally install all browsers for broader coverage:
```sh
bun x playwright install --with-deps
```

---

## 5. `.github/workflows/ci.yml` — proposed platform-matrix addition

Add a `browser` entry to the `platform` matrix under the existing
`platform-matrix` job. The complete updated `platform-matrix` job YAML is:

```yaml
platform-matrix:
  name: Platform matrix (${{ matrix.platform }})
  runs-on: ubuntu-latest
  timeout-minutes: 15
  strategy:
    fail-fast: false
    matrix:
      platform:
        - bun
        - rn-bundle
        - browser
      include:
        - platform: bun
          node-version: "22"
          test-cmd: bun run build && bun test test
        - platform: rn-bundle
          node-version: "22"
          test-cmd: bun run build && bun run test:rn
        - platform: browser
          node-version: "22"
          test-cmd: bun run test:browser
```

The `browser` dimension needs Playwright's Chromium binary installed. Add the
following step immediately before the "Run test suite" step in the matrix job:

```yaml
      - name: Install Playwright browsers (browser matrix only)
        if: matrix.platform == 'browser'
        run: bun x playwright install chromium --with-deps
```

Full proposed job with the extra step included:

```yaml
platform-matrix:
  name: Platform matrix (${{ matrix.platform }})
  runs-on: ubuntu-latest
  timeout-minutes: 15
  strategy:
    fail-fast: false
    matrix:
      platform:
        - bun
        - rn-bundle
        - browser
      include:
        - platform: bun
          node-version: "22"
          test-cmd: bun run build && bun test test
        - platform: rn-bundle
          node-version: "22"
          test-cmd: bun run build && bun run test:rn
        - platform: browser
          node-version: "22"
          test-cmd: bun run test:browser
    steps:
      - name: Checkout
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - name: Setup Node
        uses: actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f
        with:
          node-version: ${{ matrix.node-version }}
      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
        with:
          bun-version: "1.3.10"
      - name: Install dependencies
        run: bun install
      - name: Install Playwright browsers (browser matrix only)
        if: matrix.platform == 'browser'
        run: bun x playwright install chromium --with-deps
      - name: Run test suite (${{ matrix.platform }})
        run: ${{ matrix.test-cmd }}
```

---

## 6. Validation commands

Once the orchestrator has added the devDependencies, scripts, and service worker
file, validate the harness with:

```sh
# Install all deps (including the new browser devDeps)
bun install

# Build the SDK dist first
bun run build

# Generate MSW service worker (one-time setup, commit the result)
npx msw init public/

# Download Chromium
bun x playwright install chromium

# Run the browser suite
bun run test:browser
```

Expected output: all tests in `test/browser/` pass in headless Chromium.

---

## 7. Architecture notes

### Why vitest, not bun test?

Bun's native test runner is a Node/Bun process — it does not run code in a
browser V8 context. `@vitest/browser` + Playwright launches a real headless
Chromium process and executes test code inside it, which is the only way to
prove the browser bundle works in a real browser engine.

### How the alias works

`vitest.browser.config.ts` maps `@pellux/goodvibes-sdk/browser` to
`packages/sdk/dist/browser.js`. This means the tests exercise the compiled
bundle, not TypeScript source. A build step is therefore mandatory before
running the suite.

### MSW in browser mode

MSW v2 uses a Service Worker to intercept fetch in real browsers. In Playwright
headless mode, MSW's `setupWorker()` (from `msw/browser`) installs the worker
in the Chromium page context. No Node.js http server is needed.

Key differences from `msw/node`:
- Use `setupWorker()` not `setupServer()`
- Export as `worker` not `server`
- Lifecycle: `worker.start()`, `worker.stop()`, `worker.resetHandlers()`
- `worker.start()` is async and must be awaited in `beforeAll()`
- `onUnhandledRequest: 'error'` — any unmocked URL fails the test immediately,
  preventing silent-pass on mis-mapped routes

### Route mapping

All MSW handler URLs in this harness are verified against the real SDK method
catalog sources:

| SDK method | HTTP method | Route |
|---|---|---|
| `sdk.auth.login()` | POST | `/login` |
| `sdk.auth.current()` | GET | `/api/control-plane/auth` |
| `sdk.operator.accounts.snapshot()` | GET | `/api/accounts` |
| `sdk.realtime.viaSse()` (per domain) | GET | `/api/control-plane/events?domains={domain}` |
| `sdk.realtime.viaWebSocket()` (per domain) | WS | `/api/control-plane/ws?clientKind=web&domains={domain}` |

Notes:
- There is NO `/auth/logout` endpoint. Token clearing is local-only via `sdk.auth.clearToken()`.
- `sdk.auth.logout` does not exist. The correct method is `sdk.auth.clearToken()`.

### SDKErrorKind values

Verified against `packages/errors/src/index.ts`:

```
'auth' | 'config' | 'contract' | 'network' | 'not-found' | 'rate-limit' | 'server' | 'validation' | 'unknown'
```

Note: `'server-error'` is NOT a valid kind — use `'server'` for HTTP 5xx errors.

### forSession() API

Verified against the SDK transport-realtime compatibility shim:

```ts
forSession<TDomain, TEvent>(
  events: DomainEvents<TDomain, TEvent>,  // First arg: DomainEvents from viaSse()/viaWebSocket()
  sessionId: string,
): DomainEvents<TDomain, TEvent>
```

The first argument is a `DomainEvents` instance obtained from
`sdk.realtime.viaSse()` or `sdk.realtime.viaWebSocket()`, NOT the SDK object
itself.

### Domain feed API

Each domain feed (e.g. `events.turn`, `events.agents`) exposes:
- `.on(type, payloadCallback)` — fires with the event payload only
- `.onEnvelope(type, envelopeCallback)` — fires with the full event envelope

There is NO `.subscribe()` method on domain feeds.

### WebSocket testing approach

The realtime WebSocket test uses a deterministic in-process stub class
(`MockWebSocket` in `transport-realtime.test.ts`) that extends `EventTarget`.
This is injected via `createBrowserGoodVibesSdk({ WebSocketImpl: MockWebSocket })`
or `sdk.realtime.viaWebSocket(MockWebSocket)`. It does not require a running
WebSocket server and proves the connector wiring in a real browser V8 environment.

### Optional: Firefox and WebKit coverage

To add Firefox and WebKit, extend the CI matrix or run locally with:

```sh
bun x playwright install firefox webkit
```

Chromium is the required baseline per Wave 2 scope; Firefox/WebKit are
nice-to-have.
