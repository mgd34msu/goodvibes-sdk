# Ninth Review — `packages/sdk/src/`

**Scope**: Full sweep of `packages/sdk/src/` at HEAD (1,232 .ts files, ~237,934 lines).
**Methodology**: Token-efficient discovery → targeted deep-dives on god-files (>600 lines) and security-critical paths (auth, adapters, exec, sandbox, HTTP listeners).
**Format**: Severity-prefixed IDs, file:line citations.

This review is intentionally honest. The SDK has clearly been hardened by prior review rounds — `as any` is gone, TODOs are gone, timing-safe primitives exist as helpers, secrets are scrypt-hashed, atomic-write file modes are 0600, the eval REPL is QEMU-sandboxed by default. **What remains is mostly inconsistent application of patterns the codebase already knows how to do correctly**, plus a handful of resource-management and DoS oversights.

---

## CRITICAL

### C-01 — Surface adapter token comparisons leak secrets via timing side channel

**Files**:
- `packages/sdk/src/platform/adapters/signal/index.ts:20`
- `packages/sdk/src/platform/adapters/telegram/index.ts:51`
- `packages/sdk/src/platform/adapters/imessage/index.ts:20`
- `packages/sdk/src/platform/adapters/mattermost/index.ts:54`
- `packages/sdk/src/platform/adapters/matrix/index.ts:25`
- `packages/sdk/src/platform/adapters/google-chat/index.ts:25`
- `packages/sdk/src/platform/adapters/ntfy/index.ts:22`
- `packages/sdk/src/platform/adapters/webhook/index.ts:30` (fallback secret path)

Every one of these adapters compares the configured webhook/bridge secret against the inbound header using JavaScript `!==`. JS string equality short-circuits on the first byte that differs — over enough requests an attacker can recover the secret byte-by-byte. The codebase already exports a correct primitive (`packages/sdk/src/platform/adapters/helpers.ts:8 constantTimeEquals`) and uses it in `homeassistant/index.ts:158` (`safeEqual`) and `webhook/index.ts:29` (signature path). Eight other adapters do not use it.

Replace each `if (providedToken !== configuredToken)` with `if (!constantTimeEquals(providedToken, configuredToken))`. The webhook adapter's fallback `providedSecret !== configuredSecret` (line 30) must also use `constantTimeEquals`.

### C-02 — Cloudflare Worker auth uses non-timing-safe comparison

**File**: `packages/sdk/src/workers.ts:224`

```ts
if (auth === `Bearer ${expected}`) return null;
```

Same timing-attack vector as C-01, on the public edge. Workers don't have `node:crypto.timingSafeEqual`, but a constant-time comparison is trivial via `crypto.subtle.timingSafeEqual` polyfill or a manual XOR-accumulator over equal-length encoded strings. Currently a remote attacker who can call any non-health endpoint can probe `GOODVIBES_WORKER_TOKEN` via response-time analysis.

### C-03 — `UserAuthManager` session map grows without bound

**File**: `packages/sdk/src/platform/security/user-auth.ts:280-289` (`createSession`)

```ts
createSession(username: string): AuthSession {
  this.pruneExpiredSessions();
  const token = randomBytes(32).toString('hex');
  const session: AuthSession = { token, username, expiresAt: Date.now() + this.sessionTtlMs };
  this.sessions.set(token, session);
  return session;
}
```

`pruneExpiredSessions()` only removes sessions whose TTL has elapsed. With a default 1-hour TTL, an attacker (or buggy client) that can reach `/login` once per second adds 3,600 live sessions/hour, each holding a 64-char token + record string. There is no cap (`MAX_SESSIONS`), no per-user quota, and no eviction by LRU. Process memory grows monotonically until OOM. This is a remote-DoS surface on every daemon that exposes `/login`.

Fix: cap total sessions (e.g. 10,000) and per-user (e.g. 100), evict oldest when exceeded; or compute a stable hash and reuse instead of storing full token plaintext server-side.

### C-04 — `service-manager.ts` leaks file descriptors on every service start

**File**: `packages/sdk/src/platform/daemon/service-manager.ts:402-403`

```ts
const stdoutFd = openSync(logPath, 'a');
const stderrFd = openSync(logPath, 'a');
```

Two FDs are opened on the same log file (waste — one is sufficient when stdout/stderr can share) and **neither is ever closed in this process** — they're handed to the spawned child, but the parent process retains its own copy of each FD until process exit. After N start/restart cycles, the daemon process itself accumulates 2N leaked FDs. This is also a correctness issue: when the child detaches and the parent later crashes/restarts, those FDs hold log-file write positions open even though the parent no longer needs them.

Fix: `closeSync(stdoutFd)` and `closeSync(stderrFd)` immediately after `spawn(...)` returns, and open `logPath` once instead of twice.

---

## MAJOR

### MAJ-01 — `client.ts` constructs a `getAuthToken` that lies about its return type

**File**: `packages/sdk/src/client.ts:329-331`

```ts
const getAuthToken = options.tokenStore
  ? () => options.tokenStore?.getToken()!
  : options.getAuthToken;
```

The `?.` returns `Promise<string | null> | undefined`; the `!` non-null asserts that to `Promise<string | null>`. But if `options.tokenStore` is reassigned to `undefined` after the SDK is constructed, the assertion lies and consumers receive `undefined` where `Promise<string | null>` was promised. The `?.` is also redundant here — by virtue of the surrounding ternary, `options.tokenStore` is provably defined on this branch. Replace with `() => options.tokenStore!.getToken()` (single assertion, narrows correctly) or capture `options.tokenStore` into a local `const` before constructing the closure.

### MAJ-02 — `ensureColumn` interpolates a table name directly into SQL

**File**: `packages/sdk/src/platform/state/memory-store-helpers.ts:50,60`

```ts
const rows = db.exec(`PRAGMA table_info(${table})`);
// ...
db.run(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
```

All callers in this file pass literal strings (`'memory_records'`), so this is currently safe. But `ensureColumn` is exported (line 43-44), the type signature accepts arbitrary strings, and SQLite's `?` parameter binding does not work for identifiers — meaning a future caller passing user-controlled input has no syntactic warning that this is unsafe. Either:
- Make the function file-private (drop `export`), or
- Whitelist `table` against an explicit `Set<string>` of known table names, or
- Validate `table` against `/^[a-z_][a-z0-9_]*$/i` and throw on mismatch.

### MAJ-03 — `createEventStream` is a 173-line god-method with nested closures and split teardown logic

**File**: `packages/sdk/src/platform/control-plane/gateway.ts:581-754`

The method:
- Allocates a client record (lines 597-614),
- Emits four runtime events with shared trace metadata (615-651),
- Constructs a ReadableStream whose `start` callback declares `send`, builds the per-domain unsubscribe array, registers the heartbeat, redefines `teardown`, and emits four more disconnect events (655-742),
- Returns the SSE Response (746-753).

`teardown` is declared at line 654 as `() => {}`, then reassigned at 712 inside `start`. This works but is fragile — if `start` ever throws before reaching the reassignment (e.g. `selectedDomains` is empty and `runtimeBus!.onDomain` throws synchronously), `cancel` will run the empty `teardown` and the heartbeat/subscriptions will leak.

Extract: `buildClientRecord`, `emitConnectionEvents`, `attachDomainSubscriptions`, `attachDisconnectTeardown`. Each becomes independently testable.

### MAJ-04 — `daemon/facade.ts` has a 102-line constructor and a 155-line `start()`

**File**: `packages/sdk/src/platform/daemon/facade.ts:142-244, 269-424`

The constructor wires ~20 collaborators; `start()` chains startup of HTTP listener, control plane, gateway, surface adapters, and runtime services. Both exceed the project's apparent function-length norm by a wide margin and obscure the actual startup graph. Extract a `DaemonComposition` builder (already partially present in `facade-composition.ts`) and have the constructor accept the composed object; split `start()` into `startTransport`, `startControlPlane`, `startSurfaces`, `startRuntime` with a top-level orchestrator that calls each in order.

### MAJ-05 — `discovery/scanner.ts` switch blocks 164 + 145 lines, with a `falls through` between cases

**File**: `packages/sdk/src/platform/discovery/scanner.ts:345-509, 531-676`

The explicit `// falls through to generic probe when LM Studio rich endpoint yields nothing` is a code smell that ESLint's `no-fallthrough` would normally flag. Fall-through is also conditional on `Object.keys(result).length > 0` — meaning `lm-studio` falls through when **empty** but breaks when populated. This is correct but extremely subtle; one inverted condition by a future contributor produces silent wrong-behavior.

Extract one helper per server type (`probeOllama`, `probeVllm`, `probeLlamaCpp`, …) and replace the switch with a dispatch table. The `lm-studio` fallback to the generic probe becomes an explicit composed call instead of a comment-marked fallthrough.

### MAJ-06 — `cloudflare/manager.ts:238-243` chains `!` non-null assertions on optional API surfaces

**File**: `packages/sdk/src/platform/cloudflare/manager.ts:238-243`

```ts
if (client.kv) kvNamespaces = await tryDiscover('kv-namespaces', warnings, async () => collectAsync(client.kv!.namespaces.list({ ... })));
```

The outer `if (client.kv)` narrows in the same statement, but the inner `client.kv!` is in an `async () =>` closure that captures `client`, not the narrowed value. If `client.kv` is reassigned to undefined between the check and the closure execution (e.g. by another async path that mutates `client`), `client.kv!` becomes `undefined.namespaces` — runtime TypeError. Same for `client.durableObjects!`, `client.secretsStore!`, `client.zeroTrust!.tunnels!`, `client.zeroTrust!.access!`. Cache the narrowed reference: `const kv = client.kv; if (kv) { … kv.namespaces.list(…) }`.

### MAJ-07 — `cloudflare/resources.ts` repeats `client.dns!` on five separate lines

**File**: `packages/sdk/src/platform/cloudflare/resources.ts:496, 508, 513, 519`, `593` (`client.secretsStore!`)

Same pattern as MAJ-06. Each `!` is technically correct (caller pre-checked) but the function does not reassert that contract; a refactor that splits these into separate functions has no compile-time guarantee that the `!` is still valid. Either accept `Required<Pick<CloudflareClient, 'dns'>>` typed parameter that proves the field exists, or introduce a `requireDns(client)` helper that throws once and returns the narrowed value.

### MAJ-08 — `precision-engine` writes to `auth-bootstrap.txt` keep the cleartext password on disk indefinitely

**File**: `packages/sdk/src/platform/security/user-auth.ts:135-146` (`writeBootstrapCredentialFile`), used at `162` and `385`.

The daemon writes the **cleartext** initial admin password to `auth-bootstrap.txt` at 0600 and never deletes it. `clearBootstrapCredentialFile` exists (line 391) but is opt-in — there is no automatic deletion after first successful login. An attacker with read access to the user's home directory (compromised editor extension, leaked backup, container snapshot) recovers the cleartext password months after it was provisioned. Comparable systems (PostgreSQL, MariaDB) print the bootstrap password once to stdout and never persist it.

Fix options (any one suffices): 
- Delete the file automatically after the first successful authentication. 
- Print the password to stdout once and never write it. 
- Encrypt the file with a machine-bound key (DPAPI on Windows, Keychain on macOS, Secret Service on Linux).

### MAJ-09 — `revokeSession` allows fingerprint-based revocation without timing-safe match

**File**: `packages/sdk/src/platform/security/user-auth.ts:300-311`

```ts
revokeSession(token: string): boolean {
  if (this.sessions.delete(token)) return true;
  for (const sessionToken of this.sessions.keys()) {
    if (fingerprintToken(sessionToken) === token) {
      this.sessions.delete(sessionToken);
      return true;
    }
  }
  return false;
}
```

The second branch (revoke by fingerprint) iterates all live tokens and compares each fingerprint against the input with `===`. Timing observations across many calls reveal which fingerprint is the longest match — narrowing the fingerprint search space. The fingerprint is a 16-char SHA-256 prefix of a 64-byte token, so it isn't directly the token, but combined with `listSessions()` (which exposes fingerprints publicly via `inspect()` at line 363) it gives an attacker who can call `revokeSession(arbitrary)` a way to confirm fingerprints exist in the set. Use `constantTimeEquals` (or a constant-time loop) and an early-return-after-full-loop pattern.

### MAJ-10 — `ts-ignore` directives in production code without justification

**Files**:
- `packages/sdk/src/platform/pairing/qr-generator.ts:10`
- `packages/sdk/src/platform/git/service.ts:205`

Vendor file `pairing/vendor/qrcodegen.ts:1` and the `wasm-files.d.ts:9` declaration are reasonable. The two production files are not vendor — each `@ts-ignore` should be:
1. `@ts-expect-error` with a reason comment (so it self-removes when the underlying type is fixed), or
2. Replaced with a typed shim if the suppressed error is structural.

---

## MINOR

### MIN-01 — `parseJsonRecord` swallows JSON errors and returns `{}` (workers.ts) inconsistently

**File**: `packages/sdk/src/workers.ts:255-263` (`optionalJson`) vs `packages/sdk/src/platform/adapters/helpers.ts:21-28` (`parseJsonRecord`).

`optionalJson` silently returns `{}` on malformed JSON; `parseJsonRecord` returns a 400 Response. A caller that switches between the two layers gets different error semantics for the same bad input. Pick one (preferably the explicit 400) and apply it consistently. The current asymmetry means external callers can't distinguish "empty body accepted" from "malformed JSON ignored" on the worker path.

### MIN-02 — `SnapshotPruner.delete` lacks a per-iteration timeout

**File**: `packages/sdk/src/platform/runtime/retention/pruner.ts` (`delete()`)

Each `fs.rm` is awaited sequentially with no timeout. A single hung NFS mount or SMB share blocks pruning of all subsequent candidates. Wrap each per-record delete in `Promise.race([fs.rm(...), timeoutAfter(5_000)])` and aggregate timeouts as failures.

### MIN-03 — `gateway.ts:660` `(controller.desiredSize ?? 1) <= 0` silently drops events under backpressure with no telemetry

**File**: `packages/sdk/src/platform/control-plane/gateway.ts:660`

Dropping under backpressure is correct behaviour to avoid OOM, but the dropped event is not counted, logged, or surfaced via metrics. Ops cannot tell whether a client is healthy-but-slow or whether the gateway is silently shedding load. Increment a per-client `droppedEvents` counter and expose via `inspect()` (line 230).

### MIN-04 — `wrfc-gates.ts:42` and `process-manager.ts:114` use `/bin/sh -c` for arbitrary commands

**Files**:
- `packages/sdk/src/platform/agents/wrfc-gates.ts:42`
- `packages/sdk/src/platform/tools/shared/process-manager.ts:114`
- `packages/sdk/src/platform/tools/exec/runtime.ts:199, 281, 396`
- `packages/sdk/src/platform/hooks/runners/command.ts:34`

All five use `Bun.spawn(['/bin/sh', '-c', command], …)`. This is intentional for hooks (the file's header documents shell injection as the trust boundary) and acceptable for WRFC gates where the command comes from `package.json`. But for `tools/exec/runtime.ts` and `process-manager.ts` the trust model isn't documented inline. Add a SECURITY MODEL comment block to each, mirroring the one in `hooks/runners/command.ts:1-14`.

### MIN-05 — `transport-contract.ts:546` uses `Math.random` for jitter

**File**: `packages/sdk/src/platform/runtime/remote/transport-contract.ts:546`

```ts
rng: () => number = Math.random,
```

For retry jitter this is fine (not security-relevant); but the parameter is named `rng` as if it might be used cryptographically. Rename to `jitterRng` or add a comment clarifying it's non-cryptographic.

### MIN-06 — `platform/security/user-auth.ts:74` `verifyPassword` accepts a malformed hash and returns `false` silently

**File**: `packages/sdk/src/platform/security/user-auth.ts:73-82`

```ts
function verifyPassword(password: string, passwordHash: string): boolean {
  const [saltEncoded, hashEncoded] = passwordHash.split(':');
  if (!saltEncoded || !hashEncoded) return false;
  // …
}
```

If the stored hash is corrupt (truncated, wrong format), `verifyPassword` returns `false` indistinguishably from "wrong password". An attacker brute-forcing passwords against a corrupted account therefore receives the same response as against a healthy one — fine for security, but the daemon log should warn about the corrupt-hash case so operators can re-bootstrap. Throw a typed `CorruptHashError` (or `logger.error`) before the `return false`.

### MIN-07 — `client.ts:330` `() => options.tokenStore?.getToken()!` is duplicated logic

**File**: `packages/sdk/src/client.ts:329-331, 373-375`

Lines 329-331 build `getAuthToken` for the per-client-options helper; lines 373-375 build a different `getAuthToken` for `tokenResolver`. Both implement the same precedence (`tokenStore.getToken()` → `options.getAuthToken`). Extract `resolveTokenGetter(options)` once and reuse.

### MIN-08 — `webhook/index.ts:23-24` falls back to `authorization: Bearer …` for the secret without rate limit

**File**: `packages/sdk/src/platform/adapters/webhook/index.ts:23-24`

When `x-goodvibes-webhook-secret` is missing the adapter falls back to `Authorization: Bearer <secret>`. This conflates two semantically distinct headers — a request meant to authenticate a *user* via Bearer token (which the operator API uses) gets matched against the *webhook secret*. A misconfigured client can leak its operator token to webhook ingress logs. Reject `Authorization` here unless the consumer has explicitly opted in via config.

### MIN-09 — `gateway.ts:683` `setInterval` heartbeat with `unref` cast

**File**: `packages/sdk/src/platform/control-plane/gateway.ts:683-688`

```ts
const heartbeat = setInterval(() => { send('heartbeat', { clientId, ts: Date.now() }); }, 15_000);
(heartbeat as unknown as { unref?: () => void }).unref?.();
```

The `as unknown as { unref?: () => void }` double cast hides that on Bun and Node `setInterval` returns a `Timeout` whose `.unref()` is well-typed when `@types/node` is in scope. This works at runtime but the cast suggests typings are missing or wrong. Either add an `import type { Timer } from 'node:timers';` or use `Bun.unref(heartbeat)` (typed).

### MIN-10 — `gateway-web-ui.ts:1` mis-imports `instrumentedFetch` for a server-rendered HTML helper

**File**: `packages/sdk/src/platform/control-plane/gateway-web-ui.ts:1`

```ts
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';
```

`renderControlPlaneGatewayWebUi` returns a static HTML `Response` with no fetch calls. The import is unused at module level (used only by the inline `<script>` payload as a string literal? — verify). Either drop the import or move the consumer that needs it.

### MIN-11 — `parseCookies` in `http-auth.ts:24-39` does not validate cookie names against RFC 6265 token rules

**File**: `packages/sdk/src/platform/security/http-auth.ts:24-39`

A malformed `Cookie:` header with embedded `\r\n` (after some upstream proxies strip CRLF less aggressively than Bun) could cause the resulting Map keys to contain whitespace. Practically Bun's HTTP parser already filters CRLF, so the risk is theoretical, but the parser silently produces wrong bindings instead of rejecting the header. Add a `/^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/` validity check on `name` before `cookies.set`.

---

## NITPICK

### NIT-01 — `auth.ts:239` JSDoc `@example` includes `console.log('logged in, token stored:', token.slice(0, 8) + '...');`

**File**: `packages/sdk/src/auth.ts:239`

It's an example, not real, but printing even an 8-char prefix of a real token is poor security hygiene to teach by example. Replace with a redacted form: `console.log('logged in (token redacted)');`.

### NIT-02 — `index.ts:47-57` collision-risk comment is the only place this constraint is enforced

**File**: `packages/sdk/src/index.ts:47-57`

> Collision risk: if two packages export the same name, TypeScript silently prefers the first binding. Keep all exported names unique across these modules.

The build does not enforce this. Add a pre-publish step that checks for duplicate identifiers across the re-exported modules — even a small `tsc --noEmit` on a probe file that imports `*` from index would surface the collision.

### NIT-03 — `client.ts:209` `((error: unknown) => void) | undefined | undefined` has duplicate `undefined`

**File**: `packages/sdk/src/client.ts:209`

```ts
readonly onError?: ((error: unknown) => void) | undefined | undefined;
```

Double `| undefined`. Likely a copy-paste artifact. Drop one.

### NIT-04 — `errors.ts` is a one-line re-export

**File**: `packages/sdk/src/errors.ts`

```ts
export * from '@pellux/goodvibes-errors';
```

Single-line `export *` from a sibling package is fine, but the file has no module-level JSDoc explaining why it exists (separation between the SDK's error surface and the underlying package). Add a header comment.

### NIT-05 — `react-native.ts:60` and friends use `console.log` inside JSDoc examples

**Files**: `packages/sdk/src/react-native.ts:60`, `packages/sdk/src/expo.ts` analogous.

Matches NIT-01 — fine because they're inside `@example`, but consistency: pick one logging style (`console.log` vs `logger.info`) for all JSDoc examples and stick to it. The codebase uses both interchangeably.

### NIT-06 — `iOS keychain / Expo / Android` token stores log to `console.warn` instead of using a configured logger

**Files**:
- `packages/sdk/src/client-auth/ios-keychain-token-store.ts:182, 186`
- `packages/sdk/src/client-auth/expo-secure-token-store.ts:171`
- `packages/sdk/src/client-auth/android-keystore-token-store.ts:211, 215, 226, 227`

These files run on devices where `console.warn` may go to platform-specific log buffers that survive crashes and ship to bug reporters with more PII visibility than the developer expects. Accept an optional `logger?: (msg: string, meta?: unknown) => void` in the store options; default to `console.warn` for back-compat.

### NIT-07 — `gateway.ts:148` `new Array(this._recentEventsCapacity)` allocates the ring as a sparse array

**File**: `packages/sdk/src/platform/control-plane/gateway.ts:148`

`new Array(N)` returns a sparse array. V8 deoptimises holey-array hot paths until the ring fills up. Use `Array.from({ length: this._recentEventsCapacity }, () => undefined)` or explicit `.fill(undefined)`. Negligible perf for 500 entries but it's the kind of micro-difference that flips compiler heuristics.

### NIT-08 — `gateway.ts:131` `this._recentEventsRing[idx]!` non-null asserts inside a defensive logger check

**File**: `packages/sdk/src/platform/control-plane/gateway.ts:131`

The loop checks `if (entry === undefined) { logger.error(...); continue; }`, but the assertion `[idx]!` runs **before** the check. If `idx` produces undefined, `entry!` is the asserted-but-undefined value, and the next line treats it as defined. Drop the `!` and let the type widen to `T | undefined` so the subsequent guard works as intended.

### NIT-09 — `repl/index.ts:172-173` builds a SQLite test fixture inline as a string literal inside an `eval`-runner

**File**: `packages/sdk/src/platform/tools/repl/index.ts:172-173`

```ts
db.exec("CREATE TABLE sandbox_eval (id INTEGER PRIMARY KEY, value TEXT);");
db.exec("INSERT INTO sandbox_eval (value) VALUES ('alpha'), ('beta');");
```

This is the *only* table and *only* data inside the QEMU sandbox SQL REPL. The hardcoded fixture is a feature, not a bug, but its presence is undocumented — a user evaluating SQL would be surprised to find a `sandbox_eval` table exists. Add a one-line `// Pre-seeded fixture so empty queries return something useful` comment.

### NIT-10 — `state/memory-store-helpers.ts:51` `if (rows[0]!) {` uses `!` then immediately `?.`

**File**: `packages/sdk/src/platform/state/memory-store-helpers.ts:51-56`

```ts
if (rows[0]!) {
  const nameIndex = rows[0]?.columns.indexOf('name') ?? -1;
  for (const value of (rows[0]?.values ?? [])) {
```

The `!` says "definitely defined" while the `?.` two lines later says "might not be". Pick one. Most idiomatic: `const first = rows[0]; if (first) { … first.columns.indexOf('name') … }`.

### NIT-11 — `discovery/scanner.ts` falls through `case 'lm-studio'` only when result is empty — comment is the only documentation

**File**: `packages/sdk/src/platform/discovery/scanner.ts:444-450`

Already called out in MAJ-05 from a maintainability angle; here the nit is that ESLint's `no-fallthrough` is presumably configured to allow comment-marked fallthrough. If the rule is disabled globally, future contributors will lose the safety net entirely.

### NIT-12 — `workers.ts:194` `body: init.body ?? null` assigns `null` to `RequestInit.body`

**File**: `packages/sdk/src/workers.ts:194`

The `RequestInit.body` type accepts `BodyInit | null`, but the prevailing convention in the file is to use `undefined` (compare line 110 — `body: toRecord(body)` is omitted when absent). Use `...(init.body !== undefined ? { body: init.body } : {})` for consistency.

---

## Count Summary by Severity

| Severity | Count |
|----------|-------|
| Critical | 4 |
| Major    | 10 |
| Minor    | 11 |
| Nitpick  | 12 |
| **Total** | **37** |

The SDK is in good shape — type safety, secret hygiene, atomic writes, and sandbox isolation are all clearly the result of prior review hardening. The remaining issues cluster around **inconsistent application of existing patterns** (8 adapters + 1 worker not using the timing-safe helper that already lives in `helpers.ts`) and **resource lifecycle** (unbounded sessions, leaked FDs, dropped events without telemetry). All Critical and Major items have low-cost, low-risk fixes that reuse helpers the codebase already exports.
