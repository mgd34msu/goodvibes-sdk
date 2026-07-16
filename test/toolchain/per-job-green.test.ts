import { describe, expect, test } from 'bun:test';
import { verifyPerJobGreen, resolvePerJobGreenConfig, captureLogger, type HttpResponse } from '@pellux/goodvibes-toolchain';

const config = resolvePerJobGreenConfig({ owner: 'mgd34msu', repo: 'goodvibes-sdk', pollIntervalMs: 1, deadlineMs: 1000 });

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

  test('falls back to check-suites on a 503 from the Actions API', async () => {
    const d = deps((url) => {
      if (url.includes('/actions/runs?')) return { status: 503, body: null };
      if (url.includes('/check-suites')) return { status: 200, body: { check_suites: [{ status: 'completed', conclusion: 'success' }] } };
      if (url.includes('/check-runs')) return { status: 200, body: { check_runs: [{ name: 'CI / build', conclusion: 'success' }] } };
      return { status: 404, body: null };
    });
    const result = await verifyPerJobGreen(d, config, 'abc');
    expect(result.ok).toBe(true);
    expect(result.source).toBe('check-suites');
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
});
