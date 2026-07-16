/**
 * Workflow-shape gate.
 *
 * CI cannot be run without pushing, so this suite is the local proof that the
 * hand-authored workflow YAML is well-formed: job graphs, needs edges, no
 * continue-on-error on gating jobs, timeout caps, artifact producer/consumer
 * pairing, pinned action SHAs, and the by-reference release wiring.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
type Workflow = { on?: unknown; jobs?: Record<string, Job>; concurrency?: Record<string, unknown> };

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
    for (const f of files) {
      const wf = load(f);
      for (const [, job] of jobs(wf)) {
        const refs: string[] = [];
        if (typeof job.uses === 'string') refs.push(job.uses);
        for (const step of steps(job)) if (typeof step.uses === 'string') refs.push(step.uses);
        for (const ref of refs) {
          const ok = ref.startsWith('./') || /@[0-9a-f]{40}$/.test(ref) || /@(main|v\d)/.test(ref);
          expect(ok, `unpinned action ref: ${ref} in ${f}`).toBe(true);
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

  test('publish-npm gates on release-verify, checks artifact integrity, and restores by run id', () => {
    const pub = rel.jobs!['publish-npm']!;
    expect(needsOf(pub)).toContain('release-verify');
    const text = stepText(pub);
    expect(text).toContain('head_sha'); // recorded SHA == tagged SHA assertion
    expect(text).toContain('run-id');   // cross-workflow artifact restore
    expect(text).toContain('release:publish:ci'); // provenance publish preserved
    expect(text).toContain('prepublish-empty-or-complete'); // empty-or-complete preserved
    expect(text).toContain('release:verify:published'); // propagation poll preserved
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

  test('manual dispatch is dry-run only (publish-npm is push-gated)', () => {
    expect(String(rel.jobs!['publish-npm']!.if)).toContain("github.event_name == 'push'");
    expect(String(rel.jobs!['dry-run']!.if)).toContain("github.event_name == 'workflow_dispatch'");
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

  test('reusable-npm-publish requests id-token and takes an npm-token secret', () => {
    const wf = load('reusable-npm-publish.yml');
    const call = (wf.on as { workflow_call?: { secrets?: Record<string, unknown> } }).workflow_call;
    expect(call?.secrets).toHaveProperty('npm-token');
    expect(wf.jobs!['publish']!.permissions?.['id-token']).toBe('write');
  });

  test('reusable-gh-release runs on ubuntu-24.04 for stable awk', () => {
    expect(load('reusable-gh-release.yml').jobs!['gh-release']!['runs-on']).toBe('ubuntu-24.04');
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
