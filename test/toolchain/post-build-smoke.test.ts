import { describe, expect, test } from 'bun:test';
import { evaluateSmokeOutput, runPostBuildSmoke, captureLogger } from '@pellux/goodvibes-toolchain';
import { scriptedExec } from './_helpers.ts';

const config = { bannerPrefix: 'goodvibes-agent ', forbiddenStrings: ['sqlite-vec', '$bunfs/root'], binaryDefault: 'dist/goodvibes-agent' };

describe('post-build-smoke', () => {
  test('passes on a correct banner', () => {
    expect(evaluateSmokeOutput({ status: 0, stdout: 'goodvibes-agent 1.12.0\n', stderr: '' }, config).ok).toBe(true);
  });
  test('fails on a non-zero exit', () => {
    expect(evaluateSmokeOutput({ status: 1, stdout: '', stderr: 'boom' }, config).ok).toBe(false);
  });
  test('fails on a packaging sentinel', () => {
    const r = evaluateSmokeOutput({ status: 0, stdout: 'goodvibes-agent 1.0.0', stderr: 'cannot find sqlite-vec' }, config);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('sqlite-vec');
  });
  test('fails on a wrong banner prefix', () => {
    expect(evaluateSmokeOutput({ status: 0, stdout: 'v1.0.0', stderr: '' }, config).ok).toBe(false);
  });
  test('runPostBuildSmoke wires exec + banner check', () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: 'goodvibes-agent 1.12.0\n' }));
    expect(runPostBuildSmoke({ binary: 'dist/goodvibes-agent', config, exec, logger: captureLogger() }).ok).toBe(true);
  });
});
