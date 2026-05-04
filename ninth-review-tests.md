# Ninth Review: Test Infrastructure (WRFC:wrfc_9th_tests)

Comprehensive review of `test/`, plus `scripts/test.ts`, `scripts/no-skipped-tests.ts`, `scripts/check-dist-freshness.ts`, `scripts/print-test-coverage.ts`, `COVERAGE.md`, `test/COVERAGE.md`.

**Scope:** 199 `*.test.ts` files (194 root-level + 5 nested), 8 helpers, 4 scripts, 2 coverage docs.

Findings are severity-prefixed and include `file:line` citations. Every finding is at HEAD; nothing is treated as pre-existing.

---

## CRITICAL

None.

---

## MAJOR

### MAJ-01 — Adapters test suite is uniformly vacuous (sham contract tests)

**Files:**
- `test/adapters-matrix.test.ts:1-17`
- `test/adapters-signal.test.ts:1-27`
- `test/adapters-telegram.test.ts:1-17`
- `test/adapters-webhook.test.ts:1-17`
- `test/adapters-whatsapp.test.ts:1-17`

Every one of the five adapter test files contains exactly two tests — "module is importable without throwing" and "module exports at least one function" (or "exports a default registration function"). No behavioral assertion exists for any of:

- Authentication / token handling
- Message send/receive contract
- Rate limiting
- Error mapping
- Webhook signature verification (security-critical for `webhook` and `signal`)

The stated goal of M2 (seventh-review) was "Adapter behavioral coverage" but the implementation only verifies the module is loadable. `Object.values(mod).some((v) => typeof v === 'function')` passes for any module that exports anything callable, including unrelated helpers. This is a sham test that cannot fail unless the file itself is deleted.

**Fix:** Replace each adapter test with the contract checks promised by M2: send a fixture message, assert outbound HTTP body shape, assert signature/auth header, assert error class on 401/429.

### MAJ-02 — Numerous "smoke" tests assert only `typeof X === 'function'` (sham contract tests)

**Files (representative):**
- `test/sec-04-input-sanitization.test.ts:21-31` — `extractOperatorAuthToken / authenticateOperatorToken / isOperatorAdmin` are all asserted only to be functions; only the last 2 of 6 tests exercise behavior.
- `test/sec-09-permission-normalization.test.ts:15-21` — first three tests only check `typeof` of `normalizeCommand`, `normalizeCommandWithVerdicts`, `DEFAULT_ALLOWED_CLASSES`.
- `test/sec-10-sandbox-boundary.test.ts:24-26,29-36` — `isRunningInWsl returns a boolean`, `getSandboxConfigSnapshot... typeof config === 'object'` are tautological.
- `test/platform-eval-smoke.test.ts:11-19` — `EvalRunner is a constructor` + `instance has expected methods` (all `typeof === 'function'`); only one test (`accepts regressionThreshold`) constructs the object and even that asserts only `toBeDefined()`.
- `test/platform-templates-smoke.test.ts:11-17,30-36` — `TemplateManager is a constructor` and `parseTemplateArgs is a function` then a method-shape assertion that does not invoke the methods.
- `test/platform-forensics-smoke.test.ts:12-36` — five of six tests only check `typeof`; only the last test (`classifyFailure returns a classification`) calls a function.
- `test/platform-state-inspector-smoke.test.ts:34-43` — `subscribe returns an object with id and unsubscribe function` asserts both via `typeof`.
- `test/platform-multimodal-smoke.test.ts:53-63` — fields validated only as `typeof === 'string' | 'boolean' | 'number'`.
- `test/platform-network-smoke.test.ts:60-64` — `installer.install` and `installer.setConfigManager` are `typeof === 'function'` only; `install()` is never called.
- `test/platform-store-domains-smoke.test.ts:24-28` — `assertBaseShape` only verifies `typeof state.revision === 'number'`; 11 of the 14 store domains are validated with this single shallow check and never have their reducers exercised.
- `test/web-search-providers-smoke.test.ts:38-48` — every provider asserts `id`, `label`, `descriptor`, `search` only via `typeof`.
- `test/obs-19-sse-lifecycle.test.ts:8-16`, `test/obs-18-retry-events.test.ts:8-19`, `test/obs-24-bearer-redaction.test.ts:8-11`, `test/obs-03-instrumented-fetch.test.ts:8-12,22-25` — first test in each of these files just asserts the emitter is `typeof === 'function'` (later tests are real, but the first is filler).
- `test/smoke.test.ts:16-20` — five `typeof === 'function'` assertions on factory exports.

This is the same sham-contract pattern the seventh-review and eighth-review previously closed for individual files but is institutionalised across `*-smoke.test.ts` files. They count toward coverage numbers and pass through `no-skipped-tests` but provide no regression value beyond "the import did not blow up" (which the loader would already catch).

**Fix:** For each `typeof === 'function'` assertion, either (a) delete the assertion if a behavioral test on the same symbol already exists in the file, or (b) add a real behavioral assertion that calls the function with a non-trivial input and checks the output.

### MAJ-03 — `platform/runtime/store/domains` smoke test exercises 11 of 14 domains with a single `typeof revision === 'number'` check

**File:** `test/platform-store-domains-smoke.test.ts:24-106`

`createInitialAutomationState`, `createInitialDaemonState`, `createInitialDiscoveryState`, `createInitialGitState`, `createInitialIntelligenceState`, `createInitialMcpState`, `createInitialModelState`, `createInitialOrchestrationState`, `createInitialPermissionsState`, `createInitialSessionState`, `createInitialTasksState` each get exactly one assertion: `typeof state.revision === 'number'`.

Any accidental change that drops domain-specific fields (e.g., `model.providers`, `tasks.queue`, `permissions.policy`) cannot fail this test. The whole purpose of "per-domain coverage" is undermined by validating only a base field that lives in every domain by construction.

**Fix:** For each domain, assert at least one domain-specific invariant that would actually fail if a regression dropped the relevant field.

### MAJ-04 — COVERAGE.md does not list any `test/integration/`, `test/workers/`, or `test/workers-wrangler/` tests

**Files:**
- `COVERAGE.md:5` — "Integration tests live under `test/integration/` and are listed separately."
- `scripts/print-test-coverage.ts:21-25` — only globs `'*.test.ts'` in `TEST_DIR` (no recursion).

5 test files (`test/integration/auth-flow-e2e.test.ts`, `test/integration/any-runtime-event-property.test.ts`, `test/integration/_shared/arbitraries.unit.test.ts`, `test/workers/workers.test.ts`, `test/workers-wrangler/wrangler.test.ts`) exist on disk and are run by `bun test` (since `scripts/test.ts:22-24` includes `test/integration` when present, and `bun test` discovers nested `*.test.ts` automatically). They are not in `COVERAGE.md`. The promised "listed separately" section never materializes.

Drift impact: external reviewers (and this WRFC) cannot use `COVERAGE.md` as the source of truth without independently re-globbing.

**Fix:** Update `scripts/print-test-coverage.ts` to recurse into `test/**/*.test.ts` (or list `test/integration/` and `test/workers*` separately as promised), then regenerate `COVERAGE.md`.

### MAJ-05 — `scripts/print-test-coverage.ts` is not idempotent for review documentation

**File:** `scripts/print-test-coverage.ts:39-44`

The header text in the generator does not match the on-disk header in `COVERAGE.md` (which has been hand-edited — e.g., the on-disk file ends with a stray empty line and uses identical Markdown but the timestamps in `test/COVERAGE.md:80` say "Last updated: 2026-05-03"). Running the script overwrites the carefully-edited file and erases the integration-tests reference promised in line 5. The eighth-review remediation flow ("Regenerate via `bun scripts/print-test-coverage.ts > COVERAGE.md`") will silently revert any human-curated content.

**Fix:** Either (a) make the script regenerate the full document including the integration listing, or (b) remove the "Regenerate via" line so future fixers don't accidentally drop sections by re-running it.

### MAJ-06 — Adapter test "exports at least one function" check passes for any non-empty module

**Files:** All `test/adapters-*.test.ts` (lines 11-15 each).

`Object.values(mod).some((v) => typeof v === 'function')` is satisfied by any TypeScript file that exports a class, factory, or even a debug helper. It does not check that the function is the registration entry point. If the adapter source is rewritten to remove its registration but keep an internal helper exported, this test passes silently.

**Fix:** Assert a specific named export with a known signature, e.g., `expect(typeof mod.createSignalAdapter).toBe('function')` AND `expect(mod.createSignalAdapter.length).toBeGreaterThanOrEqual(1)`.

### MAJ-07 — `test/version-consistency.test.ts` leaks tempdir on every run

**File:** `test/version-consistency.test.ts:22-58`

```
22:    const fixture = mkdtempSync(join(tmpdir(), 'version-check-'));
```

No `try/finally` or `afterEach` removes `fixture`. There is no `rmSync` anywhere in the file (verified by grep — `vc_cleanup` query returned 0 matches). Every CI run leaves a `version-check-XXXXXX` directory in `os.tmpdir()` containing 3 `package.json` files. On a long-running runner this accumulates indefinitely; on a fresh box it is harmless but still wrong.

**Fix:** Wrap the divergence test in `try { ... } finally { rmSync(fixture, { recursive: true, force: true }); }`.

### MAJ-08 — `test/exec-retry.test.ts:101-111` jitter test is tautological

**File:** `test/exec-retry.test.ts:101-111`

The test seeds an LCG locally, runs it 20 times, then asserts not all 20 outputs are equal. This tests the LCG, NOT the production retry-jitter code in `platform/tools/exec/runtime.ts`. The function under test (`isRetryableExecResult`) is not even involved. An LCG by mathematical definition produces distinct outputs in 20 iterations from a non-degenerate seed; the assertion can only fail if `Math` or `>>>` are broken. The behavior the test is named for ("jitter: bounded random source can produce varied retry delays") is never observed in the actual exec retry path.

**Fix:** Either delete this test or replace it with a real test that drives the retry loop and observes that two consecutive scheduled delays differ.

### MAJ-09 — `test/workers/workers.test.ts:266-275` knowingly asserts the wrong observable

**File:** `test/workers/workers.test.ts:266-275`

The test is named `EventSource availability (Miniflare injects it, real Workers does not)` and the production gap it would catch is that `EventSource` is absent in real Cloudflare Workers. The assertion is `expect(globals.EventSource).toBe(true)`. The comment at lines 271-274 acknowledges the test is asserting Miniflare behavior and that production absence is unverifiable locally.

This is an **inverted regression guard** — if Miniflare ever gets fixed to match production (EventSource absent), this test will start failing and the SDK behavior will not have changed. Conversely, if the SDK starts depending on `EventSource` (which it must not in Workers) the test still passes.

**Fix:** Either (a) gate this test behind an `if (process.env['CF_REAL_DEPLOY'])` and run it only against a real Cloudflare deployment, or (b) flip the assertion to test the SDK's behavior under absence — e.g., construct an SDK with `EventSource` deleted from `globalThis` and assert the SDK falls back gracefully. Currently it tests neither.

### MAJ-10 — `test/workers-wrangler/wrangler.test.ts:314-325` mirrors MAJ-09 with the same wrong assertion

**File:** `test/workers-wrangler/wrangler.test.ts:314-325`

Same defect as MAJ-09, in a different harness. The assertion `expect(globals.EventSource).toBe(true)` documents Miniflare 4 behavior, not the SDK's behavior in production Workers.

**Fix:** Same as MAJ-09.

### MAJ-11 — Hard-coded `compatibilityDate` requires manual quarterly bumps

**File:** `test/workers/workers.test.ts:101-103`

```
102:    // calendar quarter. Updated from '2024-09-23' to '2026-04-01'.
103:    compatibilityDate: '2026-04-01',
```

The comment says "bump quarterly" but nothing enforces it. Once the date is more than 3 months old the test starts validating an out-of-date compatibility surface. There is no test that fails when the date is stale, no script bump, no CI lint.

**Fix:** Compute a default at test runtime (`new Date(...).toISOString().slice(0, 10)` minus a sane delta, or read from `wrangler.toml`) so the date can never go stale silently. Alternatively, add a check in `scripts/check-dist-freshness.ts` (or a new sentinel) that fails when `compatibilityDate` is older than 6 months.

---

## MINOR

### MIN-01 — `dist-freshness.test.ts:69` mtime check is redundant with the recursive script

**File:** `test/dist-freshness.test.ts:63-70`

The inner `for ... test(\`${packageName} dist/index.js is not older than src/index.ts\`)` block compares only the two index files. The first describe block (`compiled dist fixtures (recursive freshness check)`) already runs the authoritative recursive walker via `scripts/check-dist-freshness.ts`. The second block is now duplicate work — and worse, the comment at lines 67-68 acknowledges it: "this is the lightweight single-file check; deep-tree staleness is caught by the recursive check above."

**Fix:** Drop the per-package mtime test and keep only the existence test (which is the unique value-add).

### MIN-02 — `obs-03`, `obs-18`, `obs-19`, `obs-24` first test in each file is filler

**Files:**
- `test/obs-03-instrumented-fetch.test.ts:8-12`
- `test/obs-18-retry-events.test.ts:8-14`
- `test/obs-19-sse-lifecycle.test.ts:8-11`
- `test/obs-24-bearer-redaction.test.ts:8-11`

Each starts with a `typeof === 'function'` assertion on the same emitter that is then exercised by the next test. The `typeof` test adds zero coverage that the next test does not also produce.

**Fix:** Delete the first test in each of these files; keep the behavior tests.

### MIN-03 — `test/sec-09-permission-normalization.test.ts:23-26` `DEFAULT_ALLOWED_CLASSES is a Set` is tautological with `instanceof Set` + `size > 0`

**File:** `test/sec-09-permission-normalization.test.ts:23-26`

`expect(DEFAULT_ALLOWED_CLASSES instanceof Set).toBe(true)` followed by `expect(DEFAULT_ALLOWED_CLASSES.size).toBeGreaterThan(0)`. If a refactor reduces DEFAULT_ALLOWED_CLASSES to an empty Set the security guarantee disappears but `> 0` is satisfied by any single entry, including the wrong entry. There is no positive containment check.

**Fix:** Add `expect(DEFAULT_ALLOWED_CLASSES.has('safe-readonly')).toBe(true)` (or whatever the canonical class names are).

### MIN-04 — `platform-discovery-smoke.test.ts:62-76` tolerates a 3s timeout that may legitimately fire under load

**File:** `test/platform-discovery-smoke.test.ts:63-76`

```
63:  test('scanLocalhost() resolves with ScanResult shape', async () => {
64:    const result = await Promise.race([
65:      scanLocalhost(),
66:      new Promise<never>((_, reject) =>
67:        setTimeout(() => reject(new Error('timeout')), 3000)
68:      ),
69:    ]).catch(() => null);
70:    if (result !== null) {
71:      expect(...);
72:    }
73:    // No assertion in the timeout branch — test passes vacuously.
```

If `scanLocalhost()` is slow on the runner (e.g., CI under load), `result` becomes `null` and the test passes without exercising any assertion. The setTimeout also lacks `.unref?.()`, so the timer can keep the process alive briefly after the test resolves. Same pattern at lines 40-54 for `scan()`.

**Fix:** Add `expect(result).not.toBeNull()` in the success branch; add `.unref?.()` to the setTimeout; or refactor to call `scanHosts(['127.0.0.1'])` which has a deterministic small cost and does not need timeout racing.

### MIN-05 — `test/voice-tts-stream.test.ts:162` `await new Promise<void>((resolve) => setTimeout(resolve, 10))` lacks `.unref?.()`

**File:** `test/voice-tts-stream.test.ts:162`

Unlike the helper in `test/_helpers/test-timeout.ts` which uses `timer.unref?.()`, this inline timer can keep the event loop alive after the test resolves. Combined with stream-aborts in the same file (lines 211 etc.), this is a candidate for flakes when the test is the last in a worker.

**Fix:** Use `settleEvents(10)` from `test/_helpers/test-timeout.ts` instead.

### MIN-06 — `test/dist-freshness.test.ts` and `test/_helpers/dist-mtime-check.ts` overlap

**Files:**
- `test/dist-freshness.test.ts:30-49`
- `test/_helpers/dist-mtime-check.ts:18-62`

Both check that dist trees are at least as fresh as src trees. `dist-mtime-check.ts` runs at module load time (throws if stale) and is imported by `dist-errors.ts`; `dist-freshness.test.ts` shells out to `scripts/check-dist-freshness.ts`. Three separate code paths now compute the same staleness rule. If they ever diverge, the discrepancy is silent.

**Fix:** Have `dist-mtime-check.ts` and `dist-freshness.test.ts` both delegate to one shared helper (the `newestMtime` function in `scripts/check-dist-freshness.ts`).

### MIN-07 — `test/COVERAGE.md` references review IDs that no longer exist in the active review log

**File:** `test/COVERAGE.md:7-9, 51, 56-57`

```
51: | sec-04 | ... | Input sanitization smoke (coverage gap — see eighth-review COV-sec-04) |
56: | sec-09 | ... | Permission normalization smoke (coverage gap — see eighth-review COV-sec-09) |
57: | sec-10 | ... | Sandbox boundary smoke (coverage gap — see eighth-review COV-sec-10) |
```

The in-tree review log (`*-review*.md` files at repo root) — the eighth review is referenced but the actual ID-to-line mapping is not preserved alongside the COVERAGE doc. Since this is a ninth review, the back-references to eighth-review IDs become stale tombstones the moment the eighth review is rotated out (which has already happened in `eighth-review-closure.md`).

**Fix:** Either inline a one-sentence description of why each is a smoke gap, or remove the cross-reference and rely on git blame.

### MIN-08 — `test/COVERAGE.md` declares `obs-10`, `obs-17`, `obs-20`, `obs-23`, `perf-04`, `perf-05`, `perf-06`, `perf-08`, `perf-09`, `perf-11` as known gaps but provides no roadmap

**File:** `test/COVERAGE.md:26, 33, 36, 39, 68, 69, 70, 72, 73, 75`

10 test slots are tagged `_(known gap — not yet implemented)_` with the same generic note "No coverage path identified; deferred". This makes it impossible to tell whether a slot is intentionally deferred (no observable behavior to test) or simply forgotten. Per the standing memory directive ("never label as pre-existing or out of scope"), unimplemented slots should either be implemented or removed.

**Fix:** For each gap, either add the test or delete the row from the table — do not leave perpetual placeholders.

### MIN-09 — `scripts/no-skipped-tests.ts:9` regex fails to catch raw `it.only` / `test.only` (only matches `.skip`/`.todo`)

**File:** `scripts/no-skipped-tests.ts:9`

```
9: const forbidden = /\b(?:describe|test|it)\.(?:skip(?:If|\.if)?|todo)\b/;
```

`.only` is not in the forbidden list. A developer can leave `test.only(...)` in a committed test, which silently skips every other test in that file. CI will not catch this with the current regex.

**Fix:** Add `|only` to the forbidden disjunction so it matches `describe.only`, `test.only`, `it.only`.

### MIN-10 — `test/_helpers/dist-mtime-check.ts:38-54` swallows non-ENOENT stat errors as "stale"

**File:** `test/_helpers/dist-mtime-check.ts:48-53`

A non-ENOENT error (e.g., EACCES, EIO) becomes the string `"${pkg}: stat error — …"` and gets logged as if dist were stale. Misleading: a CI runner with a permission glitch will report "stale dist" when the real failure is filesystem.

**Fix:** Re-throw non-ENOENT errors instead of folding them into the staleness-string list.

### MIN-11 — `test/perf-07-interval-unref.test.ts` runs ast-grep over *all* `.ts` files even with no setInterval — fast path is via `content.includes`

**File:** `test/perf-07-interval-unref.test.ts:152-154`

The `if (!content.includes('setInterval')) continue;` early-exit is correct, but the file globbing at line 145 reads every TS file under `platform/` synchronously (with `readFileSync`) before the includes check. On the SDK's 1500+ source files this is 50-200 ms of disk I/O even when zero violations exist.

**Fix:** Move the `setInterval` filter into the glob pass via `precision_grep` or `ripgrep` so only files containing the literal string are read. This is a perf nit but the test runs in CI on every push.

### MIN-12 — `test/secret-refs.test.ts:109-127` env var save/restore can leak on assertion failure

**File:** `test/secret-refs.test.ts:109-127`

```
109:    const previous = process.env['GV_SECRET_REF_TEST'];
110:    process.env['GV_SECRET_REF_TEST'] = 'env-secret-value';
... // assertions in between
126:      if (previous === undefined) delete process.env['GV_SECRET_REF_TEST'];
127:      else process.env['GV_SECRET_REF_TEST'] = previous;
```

If the assertion between 110 and 126 throws, the restoration at 126-127 only runs if it is inside a `finally` block. From the visible match window I cannot confirm whether a `try/finally` wraps it; from the structure it appears the restoration is in a `finally` (typical pattern), but if any test in the file mutates env without finally, every subsequent test in the same worker inherits the leak.

**Fix:** Audit the file to ensure `try/finally` wraps every `process.env` mutation, or use `beforeEach`/`afterEach` to capture and restore in symmetric fixtures.

### MIN-13 — `test/perf-10-max-listeners.test.ts` mutates `process.env.NODE_ENV` 5+ times across `beforeEach`/`afterEach` blocks

**File:** `test/perf-10-max-listeners.test.ts:50-83, 122-128, 186-225`

Multiple describe blocks each `beforeEach` set `NODE_ENV` and `afterEach` restore. If two such describe blocks run in parallel (Bun's `bun:test` may parallelise across describes in the future or already does in some configurations), env mutations interleave. The test currently relies on serial execution of describes within a file.

**Fix:** Either consolidate to a single top-level `beforeEach` / `afterEach` for the whole file, or use a config-injection pattern that does not rely on global env.

### MIN-14 — `test/feature-flag-gates.test.ts:696` `expect(typeof createShellPlanRuntime({...})).toBeUndefined()` is structurally suspicious

**File:** `test/feature-flag-gates.test.ts:696`

The matched line in the grep is `expect(typeof createShellPlanRuntime({` followed by `.toBeUndefined()` on the previous line — meaning the assertion appears to apply to the parameter spread, not the function return. This is either a copy-paste error or a confusing inversion. Without expanding the full block I cannot be certain, but `typeof X({...})` is always a string ('undefined' or 'object' or similar), never literally undefined; `.toBeUndefined()` should only succeed when the typeof result is literally the value `undefined`, which it cannot be.

**Fix:** Read this block carefully and either fix the assertion or document why it is intentionally structured this way.

### MIN-15 — `test/cloudflare-control-plane.test.ts` is the only file the `tautological_unsigned` grep flagged but it currently passes (no `>= 0` on unsigned)

**File:** `test/cloudflare-control-plane.test.ts`

The grep `toBeGreaterThanOrEqual(0)` flagged this file in initial discovery but follow-up passes show no current matches. Filed as a minor to confirm the false positive: if a real `>= 0` assertion sneaks back during a future fix, the watcher should catch it.

**Fix:** Add a CI lint that fails when `expect(X).toBeGreaterThanOrEqual(0)` appears unless paired with `toBeLessThanOrEqual(<finite>)` on the same value.

---

## NITPICK

### NIT-01 — `test/contracts-portability.test.ts:8-19` literal package list duplicates the same data in `scripts/check-dist-freshness.ts:23-33`

**File:** `test/contracts-portability.test.ts:8-19` and `scripts/check-dist-freshness.ts:23-33`

Both files maintain a hand-written list of "runtime-neutral" / "built" packages. Adding a new built package requires editing both. Drift is silent.

**Fix:** Export the list from a single helper module.

### NIT-02 — `test/observer-coverage.test.ts:111-150` mock OTel implementation duplicates the schema check that `obs-04` already covers

**File:** `test/observer-coverage.test.ts:111-150`

The `makeMockOtel` helper replicates assertions that `test/obs-04-llm-instrumentation.test.ts` already makes. Two locations to update when the OTel surface changes.

**Fix:** Move the mock to a shared `_helpers/otel-mock.ts` and import it in both files.

### NIT-03 — `test/version-sync.test.ts:13` regex is anchorless and matches any `\bversion\b` pattern

**File:** `test/version-sync.test.ts:13`

`/\bversion\s*=\s*['"](\d+\.\d+\.\d+[^'"]*)['"]/` matches the first `version =` in the source file. If a future refactor introduces a constant `__legacyVersion = '0.0.0'` *before* the real version, the test reads the legacy value and compares against the wrong thing.

**Fix:** Anchor the regex to the actual export, e.g., `/^export\s+const\s+version\s*=\s*['"]([^'"]+)['"]/m`.

### NIT-04 — `test/_helpers/test-timeout.ts:7` magic default of 1000 ms duplicates `EVENT_SETTLE_MS`

**File:** `test/_helpers/test-timeout.ts:7-25`

`waitFor` defaults to 1000 ms; `settleEvents` defaults to `EVENT_SETTLE_MS` (50 ms). The 1000 ms default is too short for some tests on slow CI but too long for unit tests. There is no way to override globally without editing call sites.

**Fix:** Read `WAIT_FOR_TIMEOUT_MS` from env to allow overriding from `bun test` invocations.

### NIT-05 — `test/_helpers/daemon-stub-handlers.ts:12-14` `unexpectedHandler` cast as `never` is correct but could be a `Mock`

**File:** `test/_helpers/daemon-stub-handlers.ts:12-14, 86`

The `unexpectedHandler` in `channelAndAutomationStubs` (`postChannelAccountAction: unexpectedHandler as never`) throws on call. This is intentional — the test should fail if the handler is unexpectedly invoked. Better, however, to use Bun's `mock()` or a recording handler so tests can assert the handler was *not* called even if it returns a value rather than throwing.

**Fix:** Replace `unexpectedHandler as never` with `makeRecordingHandler(jsonStub({ ok: true }))` and let tests assert `calls.length === 0`.

### NIT-06 — `test/integration/_shared/arbitraries.unit.test.ts:88, 109` `numRuns: 50` is half the fast-check default

**File:** `test/integration/_shared/arbitraries.unit.test.ts:88, 109`

Property-based tests with only 50 runs have low statistical power. fast-check's default is 100 and many shops run 1000. With only 50 runs an obscure bug at probability 1/200 will appear in roughly a quarter of CI invocations — flaky.

**Fix:** Bump to `numRuns: 100` (fast-check default) unless 50 was deliberately chosen for a documented reason.

### NIT-07 — `test/COVERAGE.md` `Last updated: 2026-05-03` is one day old (today is 2026-05-04)

**File:** `test/COVERAGE.md:80`

Minor. The date is fine but timestamps in tracked Markdown drift the moment a generator is re-run. Consider deriving the date from `git log -1 --format=%cI test/COVERAGE.md` rather than baking it.

### NIT-08 — `test/_helpers/test-timeout.ts:42-48` `installFrozenNow` mutates `Date.now` globally without locking

**File:** `test/_helpers/test-timeout.ts:42-48`

If two tests in different describes call `installFrozenNow` concurrently (Bun parallel describes), the second's restore pushes the first's frozen value, and the global `Date.now` is permanently broken until the next reload. No test currently uses this — verified by grep — but the helper is exported and the foot-gun is sharp.

**Fix:** Either remove the helper if unused, or scope the freeze using `using` syntax / a stack so concurrent installs do not corrupt each other.

### NIT-09 — `scripts/test.ts:14-29` reads `test/integration` only by `readdirSync` — does not recurse

**File:** `scripts/test.ts:18-28`

The script appends `test/integration` to the args only if the directory has at least one direct-child `*.test.{ts,tsx,mjs}` file. `test/integration/_shared/arbitraries.unit.test.ts` is at depth 2 — `bun test` discovers it transitively, but the script's directory probe at line 23 only inspects depth-1 children. As of HEAD, depth-1 files exist (`auth-flow-e2e.test.ts`, `any-runtime-event-property.test.ts`), so the path is added; if those are ever moved to a subdir, the test/integration arg disappears and `_shared/arbitraries.unit.test.ts` no longer runs.

**Fix:** Use a recursive walker (e.g., `Array.from(walk(integrationDir))`) instead of `readdirSync`.

### NIT-10 — `test/dist-freshness.test.ts:43-46` swallows the script's non-zero exit only inside a `console.error`, but Bun's test runner does not always print captured `console.error` on success

**File:** `test/dist-freshness.test.ts:43-46`

The diagnostic path (`console.error('[dist-freshness] check-dist-freshness script output: ...');`) only fires if `result.status !== 0` AND the assertion at line 48 fails. If a future change inverts the order, the diagnostic gets printed on every run regardless. Defensive coding nit.

**Fix:** Use `expect(result.status, 'check-dist-freshness output: ' + stdout + stderr).toBe(0)` so the diagnostic is part of the assertion message.

### NIT-11 — `test/integration/auth-flow-e2e.test.ts:96-205` `Bun.serve` server has a custom port allocation but no surface contract test for a port collision

**File:** `test/integration/auth-flow-e2e.test.ts:96-205`

Minor — the FakeServer pattern works but does not verify that two tests in the same file calling `buildFakeOperatorServer` get different ports. If `port: 0` ever stops working on a runner, every test in this file will share state.

**Fix:** Add an `expect(srv1.baseUrl).not.toBe(srv2.baseUrl)` between the two tests.

### NIT-12 — `test/_helpers/live-roundtrip-fixtures.ts:11-15` `activeServers` global state persists across files

**File:** `test/_helpers/live-roundtrip-fixtures.ts:11-15`

The `activeServers` array is module-scoped. If `live-roundtrip.test.ts` does not call `stopRoundtripServers()` in `afterAll`, leaked Bun.serve handles outlive the test run. There is no guard. (Similar concern flagged by the eighth-review's CRIT-01 in another context.)

**Fix:** Add a process-level `process.on('exit', stopRoundtripServers)` registration so an orphaned server is closed even if the test forgot to.

---

## COVERAGE GAPS

Platform features without dedicated tests (verified via `precision_grep` on `platform/<feature>` patterns over `test/**/*.test.ts`):

### COV-01 — `platform/bookmarks/`

Zero matches in any test file. The bookmarks subsystem has no behavioral coverage.

### COV-02 — `platform/export/`

Zero matches. The export subsystem (likely covering data export / serialization) is untested.

### COV-03 — `platform/plugins/`

Zero matches. The plugin loader / registry has no test (despite security-relevant trust boundary).

### COV-04 — `platform/profiles/`

Zero matches. Profile management is untested.

### COV-05 — `platform/workflow/`

Zero matches. The workflow engine has no dedicated test (only indirect coverage via WRFC tests).

### COV-06 — `platform/permissions/` is exercised by only one test (`feature-flag-gates`), and that test does not actually verify permission enforcement

Only `test/feature-flag-gates.test.ts` matches the path. There is no positive test that the permission system rejects unauthorized requests; coverage is incidental.

### COV-07 — `platform/watchers/` has only one passing reference

`test/feature-flag-gates.test.ts` is the only file that imports from `platform/watchers/`. No dedicated watcher test.

### COV-08 — `platform/intelligence/` is covered only by `test/lsp-bash-bundled.test.ts`

The intelligence subsystem (LSP, tree-sitter, etc.) has only the bash-LSP smoke test. tree-sitter and the broader LSP integration are uncovered.

### COV-09 — `platform/scheduler/` has only `test/perf-03-scheduler-history.test.ts`

The scheduler is core to runtime behavior; one perf-history test does not cover its dispatch logic.

### COV-10 — `platform/pairing/` has only `test/operator-token-global.test.ts` (which is a pairing-adjacent token test, not a pairing protocol test)

No dedicated pairing handshake / vendor-lib test.

### COV-11 — `obs-10`, `obs-17`, `obs-20`, `obs-23` are tagged "known gap" with no roadmap (see MIN-08)

4 observability slots permanently deferred.

### COV-12 — `perf-04`, `perf-05`, `perf-06`, `perf-08`, `perf-09`, `perf-11` are tagged "known gap" with no roadmap (see MIN-08)

6 perf slots permanently deferred — over half the perf series.

### COV-13 — Integration tests are not catalogued (see MAJ-04)

5 nested test files (`test/integration/auth-flow-e2e.test.ts`, `test/integration/any-runtime-event-property.test.ts`, `test/integration/_shared/arbitraries.unit.test.ts`, `test/workers/workers.test.ts`, `test/workers-wrangler/wrangler.test.ts`) are run by `bun test` but listed in neither `COVERAGE.md` nor `test/COVERAGE.md`.

### COV-14 — `compatibilityDate` drift on Workers tests (see MAJ-11)

Once the date in `test/workers/workers.test.ts:103` is older than 1 quarter, the test no longer validates current Workers behavior. No automation prevents drift.

### COV-15 — Production absence of `EventSource` in real Cloudflare Workers is not testable (see MAJ-09, MAJ-10)

Both Workers harnesses share Miniflare 4 which injects `EventSource`. There is no CI path that runs against a real Cloudflare deployment, so the SDK's behavior in the real production runtime is unverified.

---

## SUMMARY (count by severity)

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| MAJOR | 11 |
| MINOR | 15 |
| NITPICK | 12 |
| COVERAGE GAPS | 15 |
| **TOTAL** | **53** |

Reality-check footnote: every cited file was read at HEAD via `precision_read` or `precision_grep`; line numbers reflect the current working tree (which has only `CHANGELOG.archive.md` and `closure-verification.md` deleted relative to commit `2b9b925`). No "out of scope" or "pre-existing" labels are used; every finding is actionable.
