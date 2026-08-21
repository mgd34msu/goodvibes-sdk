/**
 * Workflow-shape gate.
 *
 * CI cannot be run without pushing, so this suite is the local proof that the
 * hand-authored workflow YAML is well-formed: job graphs, needs edges, no
 * continue-on-error on gating jobs, timeout caps, artifact producer/consumer
 * pairing, pinned action SHAs, and the by-reference release wiring.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = resolve(ROOT, '.github/workflows');

type Job = Record<string, unknown> & {
  needs?: string | string[];
  'runs-on'?: string;
  'timeout-minutes'?: number;
  uses?: string;
  steps?: Array<Record<string, unknown>>;
  strategy?: { matrix?: Record<string, unknown> };
  permissions?: Record<string, string>;
  environment?: unknown;
};
type Workflow = { on?: unknown; jobs?: Record<string, Job>; concurrency?: Record<string, unknown>; permissions?: Record<string, string> };

function load(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(resolve(WF_DIR, name), 'utf8')) as Workflow;
}
function jobs(wf: Workflow): [string, Job][] {
  return Object.entries(wf.jobs ?? {});
}
function needsOf(job: Job): string[] {
  return Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
}
function steps(job: Job): Array<Record<string, unknown>> {
  return job.steps ?? [];
}
function stepText(job: Job): string {
  return JSON.stringify(steps(job));
}
/** Raw concatenated `run:` bodies of a job, unescaped (stepText is JSON-encoded). */
function runText(wf: Workflow, jobName: string): string {
  return steps(wf.jobs![jobName]!).map((s) => String(s.run ?? '')).join('\n');
}

describe('all workflows: baseline hygiene', () => {
  const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));

  test('workflow directory is non-empty and includes the new reusable set', () => {
    for (const f of ['reusable-release-verify.yml', 'reusable-npm-publish.yml', 'reusable-gh-release.yml', 'reusable-binary-matrix.yml']) {
      expect(files).toContain(f);
    }
  });

  test('no gating job uses continue-on-error: true (per-job-green is the only green)', () => {
    for (const f of files) {
      const wf = load(f);
      for (const [, job] of jobs(wf)) {
        expect(job['continue-on-error']).not.toBe(true);
        for (const step of steps(job)) {
          expect(step['continue-on-error']).not.toBe(true);
        }
      }
    }
  });

  test('every executing job declares a timeout (reusable-workflow callers are exempt)', () => {
    for (const f of files) {
      const wf = load(f);
      for (const [name, job] of jobs(wf)) {
        if (job.uses) continue; // a job that calls a reusable workflow has no runs-on/timeout
        expect(job['timeout-minutes'], `${f}:${name} needs timeout-minutes`).toBeGreaterThan(0);
      }
    }
  });

  test('all uses: references are SHA-pinned or local paths', () => {
    // A floating `@v4` used to satisfy this check, which is how
    // public-suffix-drift.yml kept actions/checkout@v4 and setup-bun@v2 while
    // every other workflow pinned the same two actions by SHA. Only a local
    // path or a 40-char commit is a pin.
    for (const f of files) {
      const wf = load(f);
      for (const [, job] of jobs(wf)) {
        const refs: string[] = [];
        if (typeof job.uses === 'string') refs.push(job.uses);
        for (const step of steps(job)) if (typeof step.uses === 'string') refs.push(step.uses);
        for (const ref of refs) {
          const ok = ref.startsWith('./') || /@[0-9a-f]{40}$/.test(ref);
          expect(ok, `unpinned action ref: ${ref} in ${f}`).toBe(true);
        }
      }
    }
  });

  test('a given action is pinned to ONE SHA across every workflow', () => {
    const byAction = new Map<string, Map<string, string[]>>();
    for (const f of files) {
      const wf = load(f);
      for (const [, job] of jobs(wf)) {
        const refs = [job.uses, ...steps(job).map((s) => s.uses)].filter((r): r is string => typeof r === 'string');
        for (const ref of refs) {
          const m = /^([^@]+)@([0-9a-f]{40})$/.exec(ref);
          if (!m) continue;
          const shas = byAction.get(m[1]!) ?? new Map<string, string[]>();
          shas.set(m[2]!, [...(shas.get(m[2]!) ?? []), f]);
          byAction.set(m[1]!, shas);
        }
      }
    }
    for (const [action, shas] of byAction) {
      const detail = [...shas].map(([sha, where]) => `${sha} (${where.join(', ')})`).join(' vs ');
      expect([...shas.keys()].length, `${action} is pinned to more than one SHA: ${detail}`).toBe(1);
    }
  });

  test('interpolated inputs are not spliced straight into run: blocks', () => {
    // `${{ inputs.x }}` inside a run: body is substituted before the shell sees
    // it, so the value becomes script text. Routing it through env: and reading
    // "$X" keeps it a value. github.* fields that cannot carry caller-supplied
    // text (repository, sha, ref_name, run_id, token) stay exempt.
    const EXEMPT = /^(github\.(repository|sha|ref|ref_name|run_id|run_number|workflow|token|event_name|actor|server_url|api_url)|secrets\.|steps\.|needs\.|matrix\.|env\.|job\.|runner\.)/;
    // reusable-npm-publish's publish-command IS a command, documented to carry
    // shell (its tarball example uses a $(ls …) substitution). Routing it
    // through env: would only move the same text into an eval.
    const COMMAND_INPUTS = new Set(['inputs.publish-command']);
    for (const f of files) {
      const wf = load(f);
      for (const [jobName, job] of jobs(wf)) {
        for (const step of steps(job)) {
          const body = typeof step.run === 'string' ? step.run : '';
          if (!body) continue;
          for (const m of body.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)) {
            const expr = m[1]!;
            if (COMMAND_INPUTS.has(expr)) continue;
            expect(
              EXEMPT.test(expr),
              `${f}:${jobName} step "${String(step.name ?? '')}" splices ${m[0]} into its run: body; route it through env:`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe('ci.yml: build once, restore everywhere', () => {
  const ci = load('ci.yml');

  test('has the expected job set', () => {
    const names = jobs(ci).map(([n]) => n);
    for (const n of ['validate', 'eval-gate', 'security-audit', 'build', 'platform-matrix', 'types-resolution-check', 'publint-check', 'sbom-check', 'artifact-lane']) {
      expect(names).toContain(n);
    }
  });

  test('the build job is the sole producer of workspace-build-output', () => {
    const producers = jobs(ci).filter(([, job]) =>
      steps(job).some((s) => s.uses?.toString().includes('upload-artifact') && (s.with as { name?: string })?.name === 'workspace-build-output'),
    );
    expect(producers.map(([n]) => n)).toEqual(['build']);
  });

  test('every job that restores the build artifact declares needs: [build]', () => {
    for (const [name, job] of jobs(ci)) {
      if (name === 'build') continue;
      const downloads = steps(job).some((s) => s.uses?.toString().includes('download-artifact')) && stepText(job).includes('workspace-build-output');
      if (downloads) {
        expect(needsOf(job), `${name} restores the artifact but is missing needs: [build]`).toContain('build');
      }
    }
  });

  test('eval-gate and platform-matrix restore the artifact instead of rebuilding', () => {
    for (const name of ['eval-gate', 'platform-matrix']) {
      const job = ci.jobs![name]!;
      expect(needsOf(job)).toContain('build');
      expect(stepText(job)).toContain('workspace-build-output');
      // No `bun run build` inside these legs anymore.
      expect(stepText(job)).not.toContain('bun run build');
    }
  });

  test('the bun matrix leg runs tests without triggering the pretest rebuild', () => {
    const matrix = ci.jobs!['platform-matrix']!;
    const include = (matrix.strategy?.matrix as { include?: Array<{ platform: string; 'test-cmd': string }> })?.include ?? [];
    const bun = include.find((r) => r.platform === 'bun');
    expect(bun?.['test-cmd']).toBe('bun scripts/test.ts');
    for (const row of include) expect(row['test-cmd']).not.toContain('bun run build');
  });
});

describe('ci.yml: zero-touch auto-release', () => {
  const ci = load('ci.yml');
  const gatingJobs = ['validate', 'eval-gate', 'security-audit', 'build', 'platform-matrix', 'types-resolution-check', 'publint-check', 'sbom-check', 'artifact-lane'];

  test('auto-release needs EVERY other ci.yml job (only runs when all are green)', () => {
    const auto = ci.jobs!['auto-release']!;
    const needs = needsOf(auto);
    for (const job of gatingJobs) {
      expect(needs, `auto-release must need ${job} so it only runs when that gate is green`).toContain(job);
    }
    // And its needs set is exactly the other jobs, no gate omitted, no self-need.
    const otherJobs = jobs(ci).map(([n]) => n).filter((n) => n !== 'auto-release');
    expect([...needs].sort()).toEqual([...otherJobs].sort());
  });

  test('auto-release is gated to pushes on main', () => {
    const cond = String(ci.jobs!['auto-release']!.if);
    expect(cond).toContain("github.ref == 'refs/heads/main'");
    expect(cond).toContain("github.event_name == 'push'");
  });

  test('auto-release grants contents:write and actions:write', () => {
    const perms = ci.jobs!['auto-release']!.permissions ?? {};
    expect(perms.contents).toBe('write');
    expect(perms.actions).toBe('write');
  });

  test('auto-release checks tag existence BEFORE creating the tag', () => {
    const text = stepText(ci.jobs!['auto-release']!);
    const existenceCheck = text.indexOf('git ls-remote --tags origin');
    const tagCreate = text.indexOf('git tag -a');
    expect(existenceCheck).toBeGreaterThanOrEqual(0);
    expect(tagCreate).toBeGreaterThanOrEqual(0);
    // The idempotent existence check must precede tag creation.
    expect(existenceCheck).toBeLessThan(tagCreate);
  });

  test('auto-release dispatches release.yml with mode=release, not a bare tag push', () => {
    const text = stepText(ci.jobs!['auto-release']!);
    expect(text).toContain('gh workflow run release.yml');
    expect(text).toContain('mode=release');
    // The dispatch uses the tag ref so github.ref/github.sha point at the tag.
    expect(text).toContain('--ref');
    expect(text).toContain('refs/tags/');
  });

  test('the dispatch passes the tag as the ref INPUT as well as the dispatch ref', () => {
    // --ref is what decides github.ref/github.sha for the release run. The
    // input is belt-and-braces: release.yml's readers of inputs.ref all
    // short-circuit on release mode today, so it is inert unless one of those
    // expressions is reordered, and then it stops the "main" default landing in
    // a release run.
    const text = stepText(ci.jobs!['auto-release']!);
    expect(text).toContain('-f ref=refs/tags/');
  });

  test('an existing tag is only a no-op once a release.yml run for it is confirmed', () => {
    // Exiting 0 on "tag exists" without that check reported success over a
    // release that was tagged and then never dispatched.
    const text = stepText(ci.jobs!['auto-release']!);
    expect(text).toContain('actions/workflows/release.yml/runs');
    expect(text).toContain('head_branch');
    // No release run for the tag re-dispatches rather than exiting green.
    expect(text).toContain('NO release.yml run does');
    // An unanswerable lookup fails loudly and names the manual command.
    expect(text).toContain('could not determine whether release.yml ever ran');
    expect(text).toContain('gh workflow run release.yml --repo');
  });

  test('the tag-exists exit never claims the release succeeded', () => {
    // A run record can be a FAILED run (counted deliberately: a failed run is
    // visible and a human re-runs it). The message must not read as
    // release-succeeded, and must say where to look. Judged on what the step
    // PRINTS, so a comment quoting the old wording is not a false failure.
    const printed = runText(ci, 'auto-release')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(printed).toContain('the release was started');
    expect(printed).toContain('NOT a statement that the release succeeded');
    expect(printed).toContain('actions/workflows/release.yml');
    expect(printed).not.toContain('nothing to do');
  });
});

describe('release.yml: by-reference release', () => {
  const rel = load('release.yml');

  test('the 45-minute validate-release re-run is gone', () => {
    expect(Object.keys(rel.jobs ?? {})).not.toContain('validate-release');
  });

  test('release-verify calls the reusable by-reference workflow', () => {
    const rv = rel.jobs!['release-verify']!;
    expect(rv.uses).toContain('reusable-release-verify.yml');
    expect(needsOf(rv)).toContain('verify-tag-version');
  });

  test('every caller job grants at least the permissions its called reusable workflow requests', () => {
    // GitHub validates this at workflow startup: a called workflow's job may
    // only use permissions the caller job grants. An under-granting caller is
    // rejected with startup_failure and jobs: [] before anything runs.
    const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
    for (const wfName of ['release.yml', 'ci.yml']) {
      const caller = load(wfName);
      for (const [jobName, job] of Object.entries(caller.jobs ?? {})) {
        const uses = String(job.uses ?? '');
        const m = uses.match(/(?:^\.\/)?\.github\/workflows\/(reusable-[a-z-]+\.yml)/);
        if (!m) continue;
        const callee = load(m[1]!);
        const requested: Record<string, string> = { ...(callee.permissions ?? {}) };
        for (const calleeJob of Object.values(callee.jobs ?? {})) {
          for (const [scope, level] of Object.entries(calleeJob.permissions ?? {})) {
            if ((RANK[level] ?? 0) > (RANK[requested[scope] ?? 'none'] ?? 0)) requested[scope] = level;
          }
        }
        const granted = job.permissions ?? caller.permissions ?? {};
        for (const [scope, level] of Object.entries(requested)) {
          const have = granted[scope] ?? 'none';
          expect(
            RANK[have] ?? 0,
            `${wfName} job "${jobName}" grants ${scope}: ${have} but ${m[1]} requests ${scope}: ${level}`,
          ).toBeGreaterThanOrEqual(RANK[level] ?? 0);
        }
      }
    }
  });

  test('publish-npm gates on release-verify, checks artifact integrity, and restores by run id', () => {
    const pub = rel.jobs!['publish-npm']!;
    expect(needsOf(pub)).toContain('release-verify');
    const text = stepText(pub);
    expect(text).toContain('head_sha'); // recorded SHA == tagged SHA assertion
    expect(text).toContain('run-id');   // cross-workflow artifact restore
    expect(text).toContain('release:publish:ci'); // provenance publish preserved
    expect(text).toContain('--prepublish-registry-state'); // registry-state precheck preserved
    expect(text).toContain('release:verify:published'); // propagation poll preserved
  });

  test('publish-npm hard-fails on an empty run_id BEFORE download-artifact can misdirect', () => {
    const pub = rel.jobs!['publish-npm']!;
    const stepList = steps(pub);
    const guardIdx = stepList.findIndex((s) => {
      const env = s.env as Record<string, string> | undefined;
      return env?.RUN_ID !== undefined && String(s.run ?? '').includes('exit 1');
    });
    const downloadIdx = stepList.findIndex(
      (s) => s.uses?.toString().includes('download-artifact') && (s.with as { name?: string })?.name === 'workspace-build-output',
    );
    expect(guardIdx, 'publish-npm must guard against an empty release-verify run_id').toBeGreaterThanOrEqual(0);
    expect(downloadIdx).toBeGreaterThanOrEqual(0);
    // The guard must run before the CI-build download; an empty run-id fed to
    // download-artifact silently stops targeting the CI run.
    expect(guardIdx).toBeLessThan(downloadIdx);
    const guard = stepList[guardIdx]!;
    expect(String((guard.env as Record<string, string>).RUN_ID)).toContain('release-verify.outputs.run_id');
    expect(String(guard.run)).toContain('-z');
  });

  test('publish-npm keeps provenance identity and the production environment', () => {
    const pub = rel.jobs!['publish-npm']!;
    expect(pub.permissions?.['id-token']).toBe('write');
    expect((pub.environment as { name?: string })?.name).toBe('production');
  });

  test('verify-tag-version and github-release constraints are preserved', () => {
    expect(stepText(rel.jobs!['verify-tag-version']!)).toContain('verify-release-tag-version.ts');
    expect(stepText(rel.jobs!['github-release']!)).toContain('action-gh-release');
    expect(rel.jobs!['github-release']!['runs-on']).toBe('ubuntu-24.04');
  });

  test('concurrency never cancels an in-progress release', () => {
    expect(rel.concurrency?.['cancel-in-progress']).toBe(false);
  });

  test('the concurrency group is keyed on the tag, so both release paths for one version serialize', () => {
    const group = String(rel.concurrency?.group ?? '');
    // The `ref` input defaults to "main", so keying on it put EVERY dispatched
    // release in one group (sdk-release-main) and put a tag push for the same
    // version in a different group from its dispatch, letting the two race.
    expect(group).not.toContain('inputs.ref');
    expect(group).toContain('github.ref_name');
    // Push and release-mode dispatch both run at refs/tags/vX, so both read
    // ref_name and land in the same group.
    expect(group).toContain("github.event_name == 'push'");
    expect(group).toContain("mode == 'release'");
    // A non-release dispatch writes nothing; run_id keeps dry-runs independent.
    expect(group).toContain('github.run_id');
  });

  test('dispatch is dry-run unless mode=release', () => {
    // A release-mode dispatch is now a first-class publish path (the zero-touch
    // auto-release job dispatches release.yml with mode=release), so publish-npm
    // runs on a push OR a release-mode dispatch, while the dry-run job is fenced
    // off to a NON-release dispatch so it can never publish.
    const pubIf = String(rel.jobs!['publish-npm']!.if);
    expect(pubIf).toContain("github.event_name == 'push'");
    expect(pubIf).toContain("github.event_name == 'workflow_dispatch'");
    expect(pubIf).toContain("inputs.mode == 'release'");

    const dryIf = String(rel.jobs!['dry-run']!.if);
    expect(dryIf).toContain("github.event_name == 'workflow_dispatch'");
    expect(dryIf).toContain("inputs.mode != 'release'");
  });

  test('workflow_dispatch exposes a mode input defaulting to dry-run', () => {
    const inputs = (rel.on as { workflow_dispatch?: { inputs?: Record<string, { default?: string; type?: string; options?: string[] }> } })
      .workflow_dispatch?.inputs ?? {};
    expect(inputs.mode).toBeTruthy();
    expect(inputs.mode?.default).toBe('dry-run');
    expect(inputs.mode?.type).toBe('choice');
    expect(inputs.mode?.options).toEqual(expect.arrayContaining(['dry-run', 'release']));
  });

  test('release.yml and reusable-gh-release.yml extract changelog sections with the SAME pattern', () => {
    // Two extractors that disagree about what a heading looks like give the
    // same version two different release bodies. release.yml matched only the
    // bracket form, so `## 1.2.3 - date` silently produced a one-line body.
    const headingPattern = /\$0 ~ "([^"]+)" version "([^"]+)"/;
    const relMatch = headingPattern.exec(runText(rel, 'github-release'));
    const reusableMatch = headingPattern.exec(runText(load('reusable-gh-release.yml'), 'gh-release'));
    expect(relMatch, 'release.yml has no recognizable changelog heading pattern').toBeTruthy();
    expect(reusableMatch, 'reusable-gh-release.yml has no recognizable changelog heading pattern').toBeTruthy();
    expect(relMatch![1]).toBe(reusableMatch![1]!);
    expect(relMatch![2]).toBe(reusableMatch![2]!);
  });

  test('the changelog fallback body is a warning, never silent', () => {
    const text = stepText(rel.jobs!['github-release']!);
    expect(text).toContain('::warning::');
    expect(text).toContain('Release ${VERSION}');
  });

  test('the shipped awk program extracts exactly one section, including next to a prerelease heading', () => {
    // Runs the awk program lifted out of the workflow itself, so the fixture
    // exercises what actually ships rather than a copy that can drift.
    const fixture = [
      '# Changelog',
      '',
      '## [2.0.1-rc.1] - 2026-01-02',
      'RC BODY',
      '',
      '## [2.0.1] - 2026-01-05',
      'FINAL BODY',
      '',
      '## 2.0.0 - 2026-01-01',
      'BARE BODY',
      '',
      '## [1.9.9]',
      'NODATE BODY',
      '',
    ].join('\n');
    const path = join(tmpdir(), `changelog-fixture-${process.pid}.md`);
    writeFileSync(path, fixture);
    try {
      for (const [wfName, jobName] of [['release.yml', 'github-release'], ['reusable-gh-release.yml', 'gh-release']] as const) {
        const program = /awk -v version="\$\w+" '([\s\S]*?)'\s/.exec(runText(load(wfName), jobName))?.[1];
        expect(program, `${wfName}: no awk program found`).toBeTruthy();
        const extract = (version: string): string => {
          const res = spawnSync('awk', ['-v', `version=${version}`, program!, path], { encoding: 'utf8', timeout: 30_000 });
          expect(res.status, `${wfName}: awk failed: ${res.stderr}`).toBe(0);
          return res.stdout.trim();
        };
        // The defect: a `-` terminator matched the RC heading first and the
        // body became RC BODY plus FINAL BODY concatenated.
        expect(extract('2.0.1'), `${wfName}: 2.0.1 must not absorb its RC section`).toBe('FINAL BODY');
        expect(extract('2.0.1-rc.1'), `${wfName}: an RC cut still finds its own section`).toBe('RC BODY');
        expect(extract('2.0.0'), `${wfName}: bare heading form`).toBe('BARE BODY');
        expect(extract('1.9.9'), `${wfName}: bracket heading with no date`).toBe('NODATE BODY');
        expect(extract('7.7.7'), `${wfName}: an absent version yields nothing (the warning path)`).toBe('');
      }
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('the tag-push publish path is preserved unchanged (manual redo)', () => {
    // Every release job that gates on a release-mode dispatch must still also
    // gate on a plain push, so pushing a v* tag by hand releases exactly as before.
    for (const name of ['verify-tag-version', 'release-verify', 'publish-npm', 'github-release']) {
      expect(String(rel.jobs![name]!.if)).toContain("github.event_name == 'push'");
    }
  });
});

describe('reusable workflows: workflow_call contracts', () => {
  test('each reusable workflow declares workflow_call', () => {
    for (const f of ['reusable-release-verify.yml', 'reusable-npm-publish.yml', 'reusable-gh-release.yml', 'reusable-binary-matrix.yml']) {
      const wf = load(f);
      expect(wf.on).toHaveProperty('workflow_call');
    }
  });

  test('reusable-release-verify exposes run_id + head_sha outputs', () => {
    const wf = load('reusable-release-verify.yml');
    const outputs = (wf.on as { workflow_call?: { outputs?: Record<string, unknown> } }).workflow_call?.outputs ?? {};
    expect(Object.keys(outputs)).toEqual(expect.arrayContaining(['run_id', 'head_sha', 'ok']));
  });

  test('reusable-release-verify fails when it verifies green but resolves no run_id', () => {
    // Consumers inherit the guard release.yml already had: an empty run_id fed
    // to download-artifact stops targeting the verified run and downloads from
    // the caller's own run instead.
    const verify = load('reusable-release-verify.yml').jobs!['verify']!;
    const guard = steps(verify).find((s) => (s.env as Record<string, string> | undefined)?.RUN_ID !== undefined);
    expect(guard, 'reusable-release-verify must guard an unresolved run_id').toBeTruthy();
    const runId = String((guard!.env as Record<string, string>).RUN_ID);
    expect(runId).toContain('pjg-workspace');
    expect(runId).toContain('pjg-registry');
    expect(String(guard!.run)).toContain('-z');
    expect(String(guard!.run)).toContain('exit 1');
    // Unconditioned, so it applies to both toolchain-source modes.
    expect(guard!.if).toBeUndefined();
  });

  test('reusable-release-verify supports both toolchain sources, defaulting to registry', () => {
    const wf = load('reusable-release-verify.yml');
    const inputs = (wf.on as { workflow_call?: { inputs?: Record<string, { default?: string }> } }).workflow_call?.inputs ?? {};
    expect(inputs['toolchain-source']?.default).toBe('registry');

    const verify = wf.jobs!['verify']!;
    const byIf = (mode: string) => steps(verify).filter((s) => String(s.if ?? '').includes(`toolchain-source == '${mode}'`));
    const workspaceSteps = byIf('workspace');
    const registrySteps = byIf('registry');

    // workspace mode self-hosts: checkout the verified commit, build the
    // workspace toolchain, run the local dist bin, never bunx-from-registry.
    expect(JSON.stringify(workspaceSteps)).toContain('actions/checkout');
    expect(JSON.stringify(workspaceSteps)).toContain('tsc -b packages/toolchain');
    expect(JSON.stringify(workspaceSteps)).toContain('packages/toolchain/dist/bin/per-job-green.js');
    expect(JSON.stringify(workspaceSteps)).not.toContain('bunx @pellux/goodvibes-toolchain');

    // registry mode bunx-es the published package and never assumes a checkout.
    expect(JSON.stringify(registrySteps)).toContain('goodvibes-per-job-green');
    expect(JSON.stringify(registrySteps)).not.toContain('actions/checkout');

    // Both mode steps carry ids feeding the coalesced job outputs.
    const outputsText = JSON.stringify(verify.outputs ?? {});
    expect(outputsText).toContain('pjg-workspace');
    expect(outputsText).toContain('pjg-registry');
  });

  test('the SDK release.yml self-hosts release-verify with the workspace toolchain', () => {
    const rel = load('release.yml');
    const rv = rel.jobs!['release-verify']! as Job & { with?: Record<string, unknown> };
    // The SDK cannot bunx-from-registry: its own release publishes the
    // toolchain (first-release bootstrap), and later releases must verify with
    // the commit under release, not the previously published version.
    expect(rv.with?.['toolchain-source']).toBe('workspace');
  });

  test('reusable-npm-publish requests id-token and takes an npm-token secret', () => {
    const wf = load('reusable-npm-publish.yml');
    const call = (wf.on as { workflow_call?: { secrets?: Record<string, unknown> } }).workflow_call;
    expect(call?.secrets).toHaveProperty('npm-token');
    expect(wf.jobs!['publish']!.permissions?.['id-token']).toBe('write');
  });

  test('reusable-npm-publish has a tarball-artifact input defaulting to "" with a conditioned download step', () => {
    const wf = load('reusable-npm-publish.yml');
    const inputs = (wf.on as { workflow_call?: { inputs?: Record<string, { default?: string }> } }).workflow_call?.inputs ?? {};
    // Optional input, empty default, the pack-and-publish-cwd default path is unchanged.
    expect(inputs['tarball-artifact']).toBeTruthy();
    expect(inputs['tarball-artifact']?.default).toBe('');

    const job = wf.jobs!['publish']!;
    const download = steps(job).find(
      (s) => s.uses?.toString().includes('download-artifact') && String(s.if ?? '').includes('inputs.tarball-artifact'),
    );
    expect(download, 'a download-artifact step must be conditioned on a non-empty tarball-artifact').toBeTruthy();
    // Conditioned on the input being non-empty, and it stages into ./release-tarball.
    expect(String(download!.if)).toContain("inputs.tarball-artifact != ''");
    expect((download!.with as { name?: string })?.name).toContain('inputs.tarball-artifact');
    expect((download!.with as { path?: string })?.path).toContain('release-tarball');

    // The download must run BEFORE the publish step.
    const stepList = steps(job);
    const downloadIdx = stepList.indexOf(download!);
    const publishIdx = stepList.findIndex((s) => String(s.name ?? '').includes('Publish'));
    expect(downloadIdx).toBeGreaterThanOrEqual(0);
    expect(publishIdx).toBeGreaterThanOrEqual(0);
    expect(downloadIdx).toBeLessThan(publishIdx);
  });

  test('reusable-gh-release runs on ubuntu-24.04 for stable awk', () => {
    expect(load('reusable-gh-release.yml').jobs!['gh-release']!['runs-on']).toBe('ubuntu-24.04');
  });

  test('reusable-gh-release: notes-file overrides the changelog excerpt, with the excerpt as fallback', () => {
    const wf = load('reusable-gh-release.yml');
    const inputs = (wf.on as { workflow_call?: { inputs?: Record<string, { default?: string; required?: boolean }> } }).workflow_call?.inputs ?? {};
    // Optional input, empty default, existing callers keep the excerpt behavior.
    expect(inputs['notes-file']).toBeTruthy();
    expect(inputs['notes-file']?.default).toBe('');
    expect(inputs['notes-file']?.required).not.toBe(true);

    const job = wf.jobs!['gh-release']!;
    const notesStep = steps(job).find((s) => s.id === 'changelog');
    expect(notesStep, 'the release-notes step must keep the `changelog` id feeding body_path').toBeTruthy();
    const run = String(notesStep!.run);
    const env = notesStep!.env as Record<string, string>;
    expect(env.NOTES_FILE).toContain('inputs.notes-file');

    // Precedence: the notes-file existence branch must come BEFORE the awk
    // changelog extraction (file wins; excerpt is the fallback), and the
    // {version} placeholder must expand.
    const fileBranch = run.indexOf('-f "$notes_path"');
    const excerptBranch = run.indexOf('awk -v version=');
    expect(fileBranch).toBeGreaterThanOrEqual(0);
    expect(excerptBranch).toBeGreaterThanOrEqual(0);
    expect(fileBranch).toBeLessThan(excerptBranch);
    expect(run).toContain('{version}');

    // The release step still consumes the resolved body path.
    const release = steps(job).find((s) => s.uses?.toString().includes('action-gh-release'));
    expect(JSON.stringify(release)).toContain('steps.changelog.outputs.body');
  });

  test('reusable-binary-matrix smokes each leg with ITS OWN binary, never a shared default', () => {
    const wf = load('reusable-binary-matrix.yml');
    const job = wf.jobs!['build']!;
    const smoke = steps(job).find((s) => String(s.name ?? '').includes('smoke'));
    expect(smoke, 'the smoke step must exist').toBeTruthy();
    expect(String(smoke!.if)).toContain('matrix.target.smoke');
    // The leg's own artifact comes from the same matrix include that drives the
    // build; a shared smoke.binaryDefault cannot serve heterogeneous legs.
    const env = smoke!.env as Record<string, string>;
    expect(env.LEG_BINARY).toContain('matrix.target.binary');
    const run = String(smoke!.run);
    expect(run).toContain('--binary "$LEG_BINARY"');
    // And an empty binary on a smoke leg fails fast instead of falling back.
    expect(run).toContain('-z "$LEG_BINARY"');
    expect(run).toContain('exit 1');
  });

  test('glob inputs are normalized to newlines before their newline-splitting sinks', () => {
    // actions/upload-artifact `path` and softprops `files` split on NEWLINES
    // only; both workflows must normalize whitespace-separated glob inputs so
    // the documented space-separated form actually works.
    const matrix = load('reusable-binary-matrix.yml');
    const buildJob = matrix.jobs!['build']!;
    const matrixNormalize = steps(buildJob).find((s) => s.id === 'globs');
    expect(matrixNormalize, 'binary-matrix must have a glob normalization step').toBeTruthy();
    expect(String(matrixNormalize!.run)).toContain("tr -s ' \\t' '\\n'");
    expect((matrixNormalize!.env as Record<string, string>).RAW_GLOBS).toContain('inputs.artifact-glob');
    const upload = steps(buildJob).find((s) => s.uses?.toString().includes('upload-artifact'))!;
    expect(String((upload.with as Record<string, unknown>).path)).toContain('steps.globs.outputs.paths');
    // The sink must consume the normalized value, not the raw input.
    expect(String((upload.with as Record<string, unknown>).path)).not.toContain('inputs.artifact-glob');

    const release = load('reusable-gh-release.yml');
    const relJob = release.jobs!['gh-release']!;
    const relNormalize = steps(relJob).find((s) => s.id === 'globs');
    expect(relNormalize, 'gh-release must have a glob normalization step').toBeTruthy();
    expect(String(relNormalize!.run)).toContain("tr -s ' \\t' '\\n'");
    expect((relNormalize!.env as Record<string, string>).RAW_GLOBS).toContain('inputs.assets-glob');
    const ghRelease = steps(relJob).find((s) => s.uses?.toString().includes('action-gh-release'))!;
    const files = String((ghRelease.with as Record<string, unknown>).files);
    expect(files).toContain('steps.globs.outputs.paths');
    expect(files).not.toContain('inputs.assets-glob');
  });

  test('per-job-green gets an explicit deadline sized UNDER the verify job cap in both modes', () => {
    const wf = load('reusable-release-verify.yml');
    const verify = wf.jobs!['verify']!;
    const capMinutes = verify['timeout-minutes']!;
    expect(capMinutes).toBeGreaterThan(0);
    for (const id of ['pjg-workspace', 'pjg-registry']) {
      const step = steps(verify).find((s) => s.id === id);
      expect(step, `verify step ${id} must exist`).toBeTruthy();
      const match = /--deadline-ms\s+"?(\d+)"?/.exec(String(step!.run ?? ''));
      // Without an explicit deadline under the cap, the tool's honest
      // deadline-exceeded verdict is unreachable, the job kill wins.
      expect(match, `${id} must pass --deadline-ms`).toBeTruthy();
      const deadlineMinutes = Number(match![1]) / 60_000;
      expect(deadlineMinutes).toBeLessThan(capMinutes);
    }
  });
});

describe('composite setup action: single Bun source', () => {
  test('exposes a bun-version input with a default', () => {
    const action = Bun.YAML.parse(readFileSync(resolve(ROOT, '.github/actions/setup/action.yml'), 'utf8')) as {
      inputs?: { 'bun-version'?: { default?: string } };
    };
    expect(action.inputs?.['bun-version']?.default).toBeTruthy();
  });
});
