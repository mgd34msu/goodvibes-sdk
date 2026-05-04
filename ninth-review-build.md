# Ninth Build / CI / Config Review

**Scope:** scripts/, .github/workflows/, .github/actions/setup/, package.json (root + workspace), tsconfig*.json, bundle-budgets.json, api-extractor.json, .gitignore, .npmignore, .nvmrc, .github/dependabot.yml, vendor/.
**HEAD:** `2b9b925` (`fix: complete build review#2 cleanup ...`)
**WRFC:** `wrfc_9th_build`
**Date:** 2026-05-04

---

## Executive Summary

Gate runs at HEAD:

| Gate                  | Result | Notes                                       |
|-----------------------|--------|---------------------------------------------|
| `bun run validate`    | exit 0 | ~101s, all 14 stages PASS                   |
| `bun run bundle:check`| exit 0 | All entries within budget; healthy headroom |
| `bun audit --audit-level high` | exit 0 | `No vulnerabilities found`         |

The build/CI/config surface is in strong shape. SHA pins are valid, workflow injection vectors are absent, engines are consistent, workspace deps are pinned to `workspace:*`, and the validate pipeline genuinely exits 0. The remaining findings are MAJOR-leaning hygiene items, MINOR consistency drift, and NITPICKs — no CRITICAL issues.

### Reality Check

| Check                  | Status   | Notes |
|------------------------|----------|-------|
| Files exist            | PASS     | All 34 scripts, 3 workflows, 16 tsconfigs found |
| Test files referenced  | PASS     | `test/rn-bundle-node-imports.test.ts`, `test/workers/workers.test.ts`, `test/workers-wrangler/wrangler.test.ts` all present |
| SHA pin annotations    | PASS     | 8/8 verified ≥3 (see CRIT-VERIFY-SHAS below) |
| `bun.lock` present     | PASS     | 287906 bytes, gitignore correctly excludes nothing |
| `validate` exit 0      | PASS     | exit_code=0, duration_ms=101588 |
| `bundle:check` exit 0  | PASS     | exit_code=0, all entries in budget |
| `bun audit` clean      | PASS     | 0 high+ vulns |
| Workspace dep pinning  | PASS     | All internal deps use `workspace:*` |
| Engines consistency    | PASS     | bun=1.3.10 + node>=22.0.0 in all 10 manifests (vendor/bash-language-server intentionally has node>=16) |

---

## SHA-Pin Verification (≥3 required, 8 verified)

Live GitHub `git/refs/tags` lookups confirmed every pinned action SHA matches its commented tag:

| Action                           | SHA pinned in YAML                       | API confirmed SHA                        | Tag    | OK |
|----------------------------------|------------------------------------------|------------------------------------------|--------|----|
| `actions/checkout`               | `11bd71901bbe5b1630ceea73d27597364c9af683` | `11bd71901bbe5b1630ceea73d27597364c9af683` | v4.2.2 | YES |
| `actions/upload-artifact`        | `ea165f8d65b6e75b540449e92b4886f43607fa02` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | v4.6.2 | YES |
| `actions/download-artifact`      | `d3f86a106a0bac45b974a628896c90dbdf5c8093` | `d3f86a106a0bac45b974a628896c90dbdf5c8093` | v4.3.0 | YES |
| `actions/setup-node`             | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` | v6.4.0 | YES |
| `oven-sh/setup-bun`              | `0c5077e51419868618aeaa5fe8019c62421857d6` | `0c5077e51419868618aeaa5fe8019c62421857d6` | v2.2.0 | YES |
| `actions/cache`                  | `5a3ec84eff668545956fd18022155c47e93e2684` | `5a3ec84eff668545956fd18022155c47e93e2684` | v4.2.3 | YES |
| `gitleaks/gitleaks-action`       | `ff98106e4c7b2bc287b24eaf42907196329070c7` | `ff98106e4c7b2bc287b24eaf42907196329070c7` | v2.3.9 | YES |
| `softprops/action-gh-release`    | `b4309332981a82ec1c5618f44dd2e27cc8bfbfda` | `b4309332981a82ec1c5618f44dd2e27cc8bfbfda` | v3.0.0 | YES |

No non-pinned `uses:` references found (regex `uses:\s+\S+@v[0-9]` and `uses:\s+\S+@(main|master|develop|HEAD|latest)` — zero hits).

---

## Findings by Severity

### CRITICAL

*(none)*

---

### MAJOR

#### MAJ-001 — Top-level `permissions:` not declared in `ci.yml` or `release.yml`

**File:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`
**Severity:** Major (Security — least privilege)

Neither workflow declares a top-level `permissions:` block. GitHub falls back to the **repository default** (typically `contents: read` + `metadata: read` for forked repos, but `write-all` is still possible if the org/repo has the legacy default). `release.yml` does scope per-job (`contents: read` for publish jobs, `contents: write` only for `github-release`), and `ci.yml` only uses `secrets.GITHUB_TOKEN` for gitleaks — but the absence of an explicit top-level cap means a future job added without `permissions:` inherits whatever is set on the repo, which can drift.

Add a top-level least-privilege default to both workflows so any new job inherits it:

```yaml
# At the top of ci.yml and release.yml, before `jobs:`
permissions:
  contents: read
```

This still allows the existing job-level `permissions: { contents: write, packages: write, id-token: write }` blocks in `release.yml` to elevate where needed (job-level always overrides workflow-level).

#### MAJ-002 — `actions/cache` uses deprecated `save-always: true`

**File:** `.github/actions/setup/action.yml:19`

```yaml
      uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684 # v4.2.3
      with:
        path: ~/.bun/install/cache
        key: ${{ runner.os }}-bun-${{ hashFiles('**/bun.lock') }}
        restore-keys: |
          ${{ runner.os }}-bun-
        save-always: true
```

`save-always` was deprecated in `actions/cache` v4.2.0 and slated for removal in v5. The replacement is to use `actions/cache/restore@v4` for the restore phase plus a separate `actions/cache/save@v4` step in `if: always()` for the save phase. Today this prints a warning but still works; once `actions/cache` v5 is pulled by Dependabot, it will hard-fail.

Replace with a two-step pattern:

```yaml
    - name: Restore Bun install cache
      id: bun-cache-restore
      uses: actions/cache/restore@<v4-sha> # v4.2.3
      with:
        path: ~/.bun/install/cache
        key: ${{ runner.os }}-bun-${{ hashFiles('**/bun.lock') }}
        restore-keys: |
          ${{ runner.os }}-bun-
    # ... bun install step ...
    - name: Save Bun install cache
      if: always() && steps.bun-cache-restore.outputs.cache-hit != 'true'
      uses: actions/cache/save@<v4-sha> # v4.2.3
      with:
        path: ~/.bun/install/cache
        key: ${{ runner.os }}-bun-${{ hashFiles('**/bun.lock') }}
```

#### MAJ-003 — `production` GitHub environment relies on UI for manual-approval gating

**File:** `.github/workflows/release.yml:105–107` and `:154–156`

```yaml
    environment:
      name: production
      url: https://www.npmjs.com/package/@pellux/goodvibes-sdk
```

The YAML correctly references the `production` environment, which is the right shape for both deployment-protection-rules-style approvals and OIDC-scoped tokens. **However**, the YAML alone cannot enforce manual approval — that requires the `production` environment to be configured in GitHub repo settings with **required reviewers** and **deployment branches: tags only** rules. There is no committed evidence (e.g., `docs/release-and-publishing.md` referencing the configuration) that those rules exist.

**Action:** Either (a) add a comment in `release.yml` documenting the expected GitHub UI environment configuration so future maintainers understand the gate, or (b) add a script `scripts/verify-release-environment.ts` that uses the GitHub API (with a token in CI) to assert the `production` environment has required reviewers configured. Option (a) is the lighter touch.

---

### MINOR

#### MIN-001 — Workspace `tsconfig.json` files use `lib: ES2023` but base is `ES2024`

**Files:**
- `packages/daemon-sdk/tsconfig.json:7` — `"ES2023", "DOM"`
- `packages/transport-core/tsconfig.json:7` — `"ES2023", "DOM"`
- `packages/transport-http/tsconfig.json:7` — `"ES2023", "DOM"`
- `packages/transport-realtime/tsconfig.json:7` — `"ES2023", "DOM"`
- `test/workers/tsconfig.json:6` — `"ES2023"`
- `test/workers-wrangler/tsconfig.json:6` — `"ES2023"`

`tsconfig.base.json` declares `lib: ["ES2024", "ESNext.Disposable"]` and `target: ES2024`. The above six configs override `lib` to `ES2023` (or `ES2023 + DOM`). Because `lib` is **replaced** (not merged) by child configs, these packages lose `ESNext.Disposable` (Symbol.dispose / Symbol.asyncDispose typings) and lose ES2024 lib types (e.g., `groupBy`, `well-known symbol changes`). `target` remains `ES2024` from the base, so emit is unaffected, but type-checking against ES2023 lib creates a quiet skew.

Grep confirms no current usage of `Symbol.dispose`, `Symbol.asyncDispose`, or `using` declarations in those four packages, so the practical risk is zero today. Still:

- Either bump these to `"lib": ["ES2024", "DOM", "ESNext.Disposable"]` to match base (preferred), or remove the `lib` override entirely and let them inherit (also fine — base already has `ES2024 + ESNext.Disposable`, and `DOM` is the only addition needed for transport packages).
- The `test/workers*` configs only need `"ES2023"` because the workerd runtime doesn't expose ES2024-only globals at runtime, but the type check itself happens in Node — it would be safer to use `"ES2024"` and rely on `@cloudflare/workers-types` to constrain the runtime API.

#### MIN-002 — Root `tsconfig.json` declares `composite: true` with `files: []` (functional but odd)

**File:** `tsconfig.json:7–10`

```json
  "compilerOptions": {
    "composite": true,
    "incremental": true,
    "tsBuildInfoFile": "node_modules/.cache/tsc/tsconfig.tsbuildinfo",
    "types": []
  },
```

The inline comment correctly notes `composite: true` is required to satisfy the project-references checker, but the `tsBuildInfoFile` outside the workspace itself is unusual — `node_modules/.cache/tsc/` is git-ignored but the path is brittle (some npm clients delete `node_modules/.cache/` on `npm install --no-audit`). Consider either committing to `.tsbuildinfo` adjacent to the config and adding it to `.gitignore` (already there: line 6 `*.tsbuildinfo`) or moving to `.tmp/tsbuildinfo/` (the `.tmp/` is already ignored).

#### MIN-003 — `examples/package.json` pins TypeScript with `^6.0.3` while root pins `6.0.3` exactly

**Files:** `package.json:101`, `examples/package.json:16`

```
root:     "typescript": "6.0.3"
examples: "typescript": "^6.0.3"
```

The examples package can drift to a newer 6.x patch. Because `examples` is a separate workspace package with its own dev install, `bun install --frozen-lockfile` covers this — but the `^` is gratuitous given the root pins exact. Pin the same exact version (`"6.0.3"`) in `examples/package.json` to eliminate any chance of `bun run --cwd examples typecheck` running against a different `tsc` than `bun run validate` does.

#### MIN-004 — `package.json` script `api:check` swallows api-extractor stderr with `2>/dev/null || true`

**File:** `package.json:46`

```
"api:check": "bunx api-extractor run --local 2>/dev/null || true ; git diff --quiet -- etc/goodvibes-sdk.api.md"
```

The pipeline silences the api-extractor exit code and merges stderr to /dev/null, then relies on `git diff --quiet` against `etc/goodvibes-sdk.api.md` to detect drift. This is brittle in two ways:

1. If api-extractor crashes for an unrelated reason (e.g., transient `temp/` dir lock), the diff still passes if the existing `.api.md` happens to match — silent success.
2. The `;` between commands means `git diff` runs even when api-extractor fails to produce output. A cleaner shape:

```bash
"api:check": "bunx api-extractor run --local && git diff --quiet -- etc/goodvibes-sdk.api.md"
```

If the rationale for `2>/dev/null || true` is that api-extractor emits warnings on stderr that are noise, fix them at the api-extractor.json `messages.*` level (the file already has `TS1259/TS2305/TS2307/TS2344/TS2694/TS2707` set to `none`).

#### MIN-005 — Validate runs api:check / api-extractor twice per validate (once via `validate.ts` line 26, once via `api-extractor` invoked by other gates) — minor wall-clock cost

**File:** `scripts/validate.ts:26`

`validate` calls `api:check` (which itself runs api-extractor twice — once with --local, once via the diff). On a hot dist tree this is ~3s × 2 = 6s wasted. Low priority because the entire `validate` is 101s — api-extractor is not the bottleneck — but worth caching on the dist hash if optimization passes are ever pursued.

#### MIN-006 — `release-shared.ts` `run()` inherits `process.env` unfiltered

**File:** `scripts/release-shared.ts:286–303`

The inline comment at lines 286–289 explicitly acknowledges that `process.env` is inherited unfiltered and that `NODE_OPTIONS`, `NODE_PATH`, `npm_config_*`, or `PATH` from a poisoned parent environment will flow into `npm publish` / `tar` / `node`. The acknowledgement is correct, but the mitigation is left to "developer-facing release tooling — not a public API." When this is invoked from CI's `publish-github-packages` and `publish-npm` jobs, the parent env is whatever GitHub Actions chose to set, which is an attacker surface if a forked PR ever hits a `pull_request_target`-style flow (it doesn't today; release.yml is `workflow_dispatch` + `push:tags`).

Not a fix demand — but if hardening is ever pursued, the right shape is `env: pickEnv(['PATH','HOME','USER','NODE_AUTH_TOKEN','NPM_CONFIG_USERCONFIG','GITHUB_PACKAGES_TOKEN'])` rather than `{ ...process.env, ...options.env }`.

#### MIN-007 — `flake-detect.ts` reports flake but exits non-zero only on flake — does not log a deterministic-fail run's output to a CI artifact

**File:** `scripts/flake-detect.ts:140–148`

When `allFail` is true (deterministic failure), `flake-detect` dumps the **last 4000 chars of stdout from run 1** to console.error. CI captures this in the job log, but if the failure was test-id-specific output emitted earlier, it's truncated away. Consider writing the full stdout/stderr of run 1 to `flake-output.log` and uploading it as an artifact via `actions/upload-artifact`. Today the nightly `flake-check` job (`ci.yml:47–60`) does not upload any artifact, so a flake on the nightly run is only visible as a job log line.

---

### NITPICK

#### NIT-001 — `bundle-budgets.json` rationale references the wrong delta direction in some entries

**File:** `bundle-budgets.json` various entries (e.g., `./client-auth` line 28, `./contracts/node` line 36)

For `./client-auth`: rationale claims `max(ceil(163*1.2)=196, 163+50=213)=213`. Both the 196 and 213 are correct, and `max(196, 213) = 213` — but in many tiny entries the +50 floor is what wins and the *1.2 calc is irrelevant. The methodology comment at the top is clear; this is just a doc-formatting nit. Could be tightened by listing only the winning value (e.g. `"rationale": "public facade; +50B floor (measured 163B)"`).

#### NIT-002 — `.gitignore` line 6 `*.tsbuildinfo` is correct, but some project ref builds emit to `*.tsbuildinfo.json`

**File:** `.gitignore:6`

Future-proof: TS 6.x emits `*.tsbuildinfo` (no `.json`), but TS 7.x roadmap mentions the format may change. Pattern matches today; just note for a year-from-now grep.

#### NIT-003 — `vendor/uuid-cjs/package.json` declares `name: "uuid"` (intentional shim) — relying on npm-overrides redirection

**File:** `vendor/uuid-cjs/package.json:2`

Documented as a Verdaccio CJS uuid v4 shim for `@cypress/request`. The shape is correct and the override is wired through `package.json` line 122 (`"uuid": "file:vendor/uuid-cjs"`). No action; just confirming the shim is intentional.

#### NIT-004 — `.github/dependabot.yml` does not set `versioning-strategy`

**File:** `.github/dependabot.yml`

No `versioning-strategy:` is set, which means Dependabot defaults to `auto` — for `npm` that is `widen` for libraries and `lockfile-only` for `private: true` apps. This repo is `private: true` so behavior is `lockfile-only`, which is correct for an SDK-monorepo (only updates the lockfile, not the manifest). Consider making it explicit:

```yaml
    versioning-strategy: lockfile-only
```

#### NIT-005 — `.npmignore` does not exist; `.gitignore` is the fallback

Not an issue today because `package.json` has `"files": ["dist", "README.md", "LICENSE"]` and the `pack-check.ts` gate verifies tarball contents. But future contributors expecting `.npmignore` semantics may be surprised. Either add a one-line `.npmignore` referencing the `files:` field, or add a comment in the root README.

#### NIT-006 — `release-shared.ts` line 348 `escapeRegExp` has a tiny regex class inefficiency

```ts
return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
```

The `[\]\\]` segment is correct but easier to read as `\\]\\\\]`. Pure style.

#### NIT-007 — `validate.ts` does not include a `--check` flag for partial validation

The entire validate runs in 101s on a warm cache. Adding `validate --skip=examples,docs` (or `validate --only=build`) would speed local iteration. Pure ergonomics.

#### NIT-008 — `print-test-coverage.ts` only iterates root-level `test/*.test.ts` and lists `test/integration/` separately in the header — but the output shows only root tests (no integration table)

**File:** `scripts/print-test-coverage.ts:35–44`

The header text mentions integration tests are listed separately, but the script never enumerates `test/integration/`. Either drop the line from the header or add the second table.

#### NIT-009 — `concurrency.cancel-in-progress: false` only on `release.yml`; `ci.yml` has no concurrency block

**File:** `.github/workflows/ci.yml`

A fast-forward push to `main` while CI is mid-run will spawn a duplicate run, and on `pull_request` rapid-fire pushes also duplicate. Neither is fatal (both eventually complete), but adding:

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

would cancel superseded PR runs while preserving every push-to-main run.

#### NIT-010 — `bunfig.toml` does not exist; relying on Bun's defaults

Not a problem — every Bun-specific knob is acceptable at default. Note for future hardening if reproducibility becomes a concern (e.g., to pin `[install] registry = "https://registry.npmjs.org"` defensively).

---

## Cross-Cutting Verification

### Engines consistency (PASS)

All 10 published manifests declare:
```
"engines": { "bun": "1.3.10", "node": ">=22.0.0" }
```

plus root `"packageManager": "bun@1.3.10"`. The vendored `vendor/bash-language-server/package.json` has `"node": ">=16"` — intentional, because the vendored bash-language-server upstream supports Node 16+ and we should not artificially restrict it.

### Workspace dep pinning (PASS)

Every internal `@pellux/goodvibes-*` dependency uses `workspace:*`. `release-shared.ts` `normalizeDependencyGroup()` (lines 119–130) correctly rewrites these to the resolved `rootVersion` at stage time, so published tarballs contain real semver ranges, not `workspace:*` literals — this is verified by `pack-check.ts:21–33` (`assertNoWorkspaceRanges`).

### Workflow injection vectors (PASS)

- No `pull_request_target` triggers used.
- No untrusted `github.event.{issue,pull_request,comment,review}.{title,body,head.ref}` interpolations.
- No `bash -c '${{ ... }}'` patterns.
- The only user-supplied input is `github.event.inputs.ref` (workflow_dispatch), used as `ref:` for `actions/checkout` — that action treats `ref` as a git ref string, not as shell, so injection is contained.
- `${GITHUB_REF_NAME#v}` (release.yml:226) is a tag name, only set on `push: tags: ['v*']`, and `verify-tag-version.ts` proves the tag matches `package.json` version before any subsequent job runs.
- `release.yml` correctly gates publish steps on `if: github.event_name == 'push'` — manual `workflow_dispatch` runs only the dry-run path.

### Destructive git ops (PASS)

No `git reset --hard`, `git push --force`, `git clean -fd`, `git checkout --`, or `git branch -D` appear in `scripts/**/*.ts`. `create-release-tag.ts` uses only `git status --porcelain`, `git tag -l`, `git tag -a`, and `git push origin <tag>` — all safe.

### Secret handling (PASS)

- No hard-coded credentials in any workflow or script.
- `gitleaks-action` runs in CI on every push/PR.
- `release-shared.ts` writes a temp `.npmrc` containing `_authToken=...` to a `mkdtemp`-created directory inside `.tmp/` (gitignored) and unconditionally cleans it up via `cleanupAuthEnv` in finally blocks.
- `install-smoke-check.ts` writes `.npmrc` only when `--registry` mode is set; the registry mode is gated to release flow.

### Bundle budget methodology (PASS)

`bundle-budgets.json` `_comment` block documents the methodology `gzip_bytes = max(ceil(actual_gzipped_bytes * 1.2), actual_gzipped_bytes + 50)`. Spot-checked five entries — all formulas resolve correctly. `bundle-budget.ts:194` correctly catches **stale** budget entries (entries in JSON but not in the package.json exports map) and exits non-zero. Healthy.

### TS strict flags (PASS)

`tsconfig.base.json:15–20` enables:
```
"strict": true,
"noUncheckedIndexedAccess": true,
"exactOptionalPropertyTypes": true,
"noImplicitOverride": true,
```

`bun run validate` exits 0 with these enabled — the build does not break under strict.

### CI job triggers (PASS)

| Workflow / Job             | Triggers                                       | Guards                          |
|----------------------------|------------------------------------------------|---------------------------------|
| `ci.validate`              | push to main, PR to main                       | `if: github.event_name != 'schedule'` |
| `ci.security-audit`        | push to main, PR to main                       | `if: github.event_name != 'schedule'` |
| `ci.flake-check`           | nightly cron (`0 6 * * *`)                     | `if: github.event_name == 'schedule'` |
| `ci.build`                 | push to main, PR to main                       | `if: github.event_name != 'schedule'` |
| `ci.platform-matrix`       | push to main, PR to main                       | `if: github.event_name != 'schedule'` |
| `ci.types-resolution-check`| build artifact (needs: [build])                | `if: github.event_name != 'schedule'` |
| `ci.publint-check`         | build artifact (needs: [build])                | `if: github.event_name != 'schedule'` |
| `ci.sbom-check`            | build artifact (needs: [build])                | `if: github.event_name != 'schedule'` |
| `release.verify-tag-version`| push tag                                      | `if: github.event_name == 'push'` |
| `release.generate-sbom`    | always (after verify-tag-version)              | dry-run safe                    |
| `release.validate-release` | always (after verify+sbom)                     | dry-run safe                    |
| `release.publish-npm`      | push tag (publish step gated `if: == 'push'`)  | dispatch=dry-run only           |
| `release.publish-github-packages` | push tag (publish step gated)           | dispatch=dry-run only           |
| `release.github-release`   | push tag, only on success                      | `needs: [publish-npm, ...]`     |

Guards are correct and exhaustive.

### Release workflow gates (PASS, with one MAJ note)

- `verify-tag-version` is the sole gate that enforces tag-name-matches-package-version. It is correctly required by `validate-release` (which `publish-npm` depends on).
- `production` GitHub environment is referenced — see MAJ-003 above.
- `id-token: write` permission is correctly scoped only to `publish-npm` and `publish-github-packages`.

---

## Counts by Severity

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| MAJOR    | 3 |
| MINOR    | 7 |
| NITPICK  | 10 |
| **Total**| **20** |

---

## Verdict

**Score: 9.5 / 10**

The build/CI/config surface is in production-grade shape. All gates exit 0 at HEAD, SHA pins are valid, no injection vectors exist, and the release pipeline has appropriate `needs:` chaining, environment gating, and OIDC scoping. The three MAJOR findings (no top-level `permissions:`, deprecated `save-always`, undocumented `production` environment requirements) are hygiene-tier — none block release. The MINOR and NITPICK items are polish opportunities.

No CRITICAL findings. Recommend addressing MAJ-001 (top-level permissions) and MAJ-002 (save-always migration) in the next maintenance pass; MAJ-003 can be closed by a one-line comment if the GitHub UI configuration is already set.
