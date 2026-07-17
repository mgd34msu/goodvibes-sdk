import { describe, expect, test } from 'bun:test';
import { verifyPerJobGreen, resolvePerJobGreenConfig, runIdFromDetailsUrl, captureLogger, type HttpResponse } from '@pellux/goodvibes-toolchain';

const config = resolvePerJobGreenConfig({ owner: 'mgd34msu', repo: 'goodvibes-sdk', pollIntervalMs: 1, deadlineMs: 1000, retryAttempts: 3, retryDelayMs: 1 });

function deps(responses: (url: string, call: number) => HttpResponse) {
  let call = 0;
  let clock = 0;
  return {
    http: async (url: string) => responses(url, call++),
    sleep: async () => { clock += 10; },
    logger: captureLogger(),
    now: () => clock,
    apiBase: 'https://api.github.com',
  };
}

const RUN = { id: 42, path: '.github/workflows/ci.yml', head_sha: 'abc', created_at: '2026-07-16T00:00:00Z' };

describe('per-job-green', () => {
  test('passes when the run is completed and every job is green', async () => {
    const d = deps((url) => {
      if (url.includes('/actions/runs?')) return { status: 200, body: { workflow_runs: [{ ...RUN, status: 'completed', conclusion: 'success' }] } };
      if (url.includes('/jobs')) return { status: 200, body: { jobs: [{ name: 'build', conclusion: 'success' }, { name: 'test', conclusion: 'success' }] } };
      return { status: 404, body: null };
    });
    const result = await verifyPerJobGreen(d, config, 'abc');
    expect(result.ok).toBe(true);
    expect(result.runId).toBe(42);
    expect(result.headSha).toBe('abc');
    expect(result.source).toBe('actions');
  });

  test('fails and names the non-green job', async () => {
    const d = deps((url) => {
      if (url.includes('/actions/runs?')) return { status: 200, body: { workflow_runs: [{ ...RUN, status: 'completed', conclusion: 'success' }] } };
      if (url.includes('/jobs')) return { status: 200, body: { jobs: [{ name: 'build', conclusion: 'success' }, { name: 'eval', conclusion: 'failure' }] } };
      return { status: 404, body: null };
    });
    const result = await verifyPerJobGreen(d, config, 'abc');
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('eval'))).toBe(true);
  });

  test('polls while the run is still in progress, then succeeds', async () => {
    const d = deps((url, call) => {
      if (url.includes('/actions/runs?')) {
        const status = call === 0 ? 'in_progress' : 'completed';
        return { status: 200, body: { workflow_runs: [{ ...RUN, status, conclusion: status === 'completed' ? 'success' : null }] } };
      }
      if (url.includes('/jobs')) return { status: 200, body: { jobs: [{ name: 'build', conclusion: 'success' }] } };
      return { status: 404, body: null };
    });
    const result = await verifyPerJobGreen(d, config, 'abc');
    expect(result.ok).toBe(true);
  });

  test('falls back to check-suites on a 503 from the Actions API and resolves the run id from check-run details', async () => {
    const d = deps((url) => {
      if (url.includes('/actions/runs?')) return { status: 503, body: null };
      if (url.includes('/check-suites')) return { status: 200, body: { check_suites: [{ status: 'completed', conclusion: 'success' }] } };
      if (url.includes('/check-runs')) {
        return {
          status: 200,
          body: {
            check_runs: [
              { name: 'gitleaks', conclusion: 'success', details_url: 'https://github.com/mgd34msu/goodvibes-sdk/security' },
              { name: 'CI / build', conclusion: 'success', details_url: 'https://github.com/mgd34msu/goodvibes-sdk/actions/runs/7331/job/9001' },
            ],
          },
        };
      }
      return { status: 404, body: null };
    });
    const result = await verifyPerJobGreen(d, config, 'abc');
    expect(result.ok).toBe(true);
    expect(result.source).toBe('check-suites');
    // The artifact-integrity handoff needs the run id even on the fallback path.
    expect(result.runId).toBe(7331);
  });

  test('check-suites fallback with no parseable details_url reports run id unresolved (null)', async () => {
    const d = deps((url) => {
      if (url.includes('/actions/runs?')) return { status: 503, body: null };
      if (url.includes('/check-suites')) return { status: 200, body: { check_suites: [{ status: 'completed', conclusion: 'success' }] } };
      if (url.includes('/check-runs')) return { status: 200, body: { check_runs: [{ name: 'external-scan', conclusion: 'success' }] } };
      return { status: 404, body: null };
    });
    const result = await verifyPerJobGreen(d, config, 'abc');
    expect(result.ok).toBe(true);
    expect(result.runId).toBeNull();
    expect(result.reason).toContain('UNRESOLVED');
  });

  test('runIdFromDetailsUrl parses Actions job urls and rejects everything else', () => {
    expect(runIdFromDetailsUrl('https://github.com/o/r/actions/runs/42/job/7')).toBe(42);
    expect(runIdFromDetailsUrl('https://github.com/o/r/actions/runs/42')).toBe(42);
    expect(runIdFromDetailsUrl('https://github.com/o/r/security/code-scanning')).toBeNull();
    expect(runIdFromDetailsUrl(undefined)).toBeNull();
  });

  test('check-suites fallback reports a failing check', async () => {
    const d = deps((url) => {
      if (url.includes('/actions/runs?')) return { status: 503, body: null };
      if (url.includes('/check-suites')) return { status: 200, body: { check_suites: [{ status: 'completed', conclusion: 'failure' }] } };
      if (url.includes('/check-runs')) return { status: 200, body: { check_runs: [{ name: 'CI / test', conclusion: 'failure' }] } };
      return { status: 404, body: null };
    });
    const result = await verifyPerJobGreen(d, config, 'abc');
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('test'))).toBe(true);
  });

  test('times out when no run ever appears', async () => {
    const d = deps(() => ({ status: 200, body: { workflow_runs: [] } }));
    const result = await verifyPerJobGreen(d, config, 'missing');
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('deadline-exceeded');
  });

  test('a transient 503 on the jobs endpoint is retried and the verify succeeds', async () => {
    let jobsCalls = 0;
    const d = deps((url) => {
      if (url.includes('/actions/runs?')) return { status: 200, body: { workflow_runs: [{ ...RUN, status: 'completed', conclusion: 'success' }] } };
      if (url.includes('/jobs')) {
        jobsCalls += 1;
        if (jobsCalls === 1) return { status: 503, body: null };
        return { status: 200, body: { jobs: [{ name: 'build', conclusion: 'success' }] } };
      }
      return { status: 404, body: null };
    });
    const result = await verifyPerJobGreen(d, config, 'abc');
    expect(result.ok).toBe(true);
    expect(jobsCalls).toBe(2);
    expect(result.source).toBe('actions');
  });

  test('a persistent 503 on the jobs endpoint exhausts retries into an honest failure naming the endpoint', async () => {
    let jobsCalls = 0;
    const d = deps((url) => {
      if (url.includes('/actions/runs?')) return { status: 200, body: { workflow_runs: [{ ...RUN, status: 'completed', conclusion: 'success' }] } };
      if (url.includes('/jobs')) {
        jobsCalls += 1;
        return { status: 503, body: null };
      }
      return { status: 404, body: null };
    });
    const result = await verifyPerJobGreen(d, config, 'abc');
    expect(result.ok).toBe(false);
    expect(jobsCalls).toBe(config.retryAttempts);
    expect(result.failures[0]).toContain('jobs endpoint returned 503');
    expect(result.failures[0]).toContain(`${config.retryAttempts} attempt(s)`);
  });

  test('a transient 503 on the runs listing is retried without reaching the fallback', async () => {
    let runsCalls = 0;
    const d = deps((url) => {
      if (url.includes('/actions/runs?')) {
        runsCalls += 1;
        if (runsCalls === 1) return { status: 503, body: null };
        return { status: 200, body: { workflow_runs: [{ ...RUN, status: 'completed', conclusion: 'success' }] } };
      }
      if (url.includes('/jobs')) return { status: 200, body: { jobs: [{ name: 'build', conclusion: 'success' }] } };
      return { status: 404, body: null };
    });
    const result = await verifyPerJobGreen(d, config, 'abc');
    expect(result.ok).toBe(true);
    expect(result.source).toBe('actions');
    expect(runsCalls).toBe(2);
  });

  test('a thrown transport error is retried like a transient status', async () => {
    let calls = 0;
    let clock = 0;
    const d = {
      http: async (url: string): Promise<HttpResponse> => {
        if (url.includes('/actions/runs?')) {
          calls += 1;
          if (calls === 1) throw new Error('socket hang up');
          return { status: 200, body: { workflow_runs: [{ ...RUN, status: 'completed', conclusion: 'success' }] } };
        }
        if (url.includes('/jobs')) return { status: 200, body: { jobs: [{ name: 'build', conclusion: 'success' }] } };
        return { status: 404, body: null };
      },
      sleep: async () => { clock += 10; },
      logger: captureLogger(),
      now: () => clock,
      apiBase: 'https://api.github.com',
    };
    const result = await verifyPerJobGreen(d, config, 'abc');
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });
});
