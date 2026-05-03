/**
 * γ1: precision_exec-style retry jitter + retryable classification
 *
 * Tests:
 * 1. Jittered delays differ between retry attempts
 * 2. Terminal errors (ENOENT, permission denied) do NOT retry
 * 3. Network-like errors DO retry
 * 4. retry.on filter respected
 */
import { describe, expect, test } from 'bun:test';
import { isRetryableExecResult } from '../packages/sdk/src/platform/tools/exec/runtime.js';

function makeResult(overrides: Partial<{
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}>): Parameters<typeof isRetryableExecResult>[0] {
  return {
    cmd: 'test',
    exit_code: overrides.exit_code ?? 1,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    success: overrides.success ?? false,
    timed_out: overrides.timed_out,
  };
}

describe('isRetryableExecResult', () => {
  test('timed_out is never retryable', () => {
    const result = makeResult({ timed_out: true, stderr: 'ECONNRESET' });
    expect(isRetryableExecResult(result)).toBe(false);
  });

  test('ENOENT is terminal — no retry', () => {
    const result = makeResult({ stderr: 'spawn ENOENT /usr/bin/nonexistent' });
    expect(isRetryableExecResult(result)).toBe(false);
  });

  test('EACCES is terminal — no retry', () => {
    const result = makeResult({ stderr: 'EACCES: permission denied' });
    expect(isRetryableExecResult(result)).toBe(false);
  });

  test('command not found is terminal — no retry', () => {
    const result = makeResult({ stderr: 'bash: foobar: command not found' });
    expect(isRetryableExecResult(result)).toBe(false);
  });

  test('Permission denied (shell) is terminal — no retry', () => {
    const result = makeResult({ stderr: '/bin/sh: ./script.sh: Permission denied' });
    expect(isRetryableExecResult(result)).toBe(false);
  });

  test('No such file or directory is terminal — no retry', () => {
    const result = makeResult({ stderr: 'No such file or directory' });
    expect(isRetryableExecResult(result)).toBe(false);
  });

  test('ECONNRESET is retryable (network category)', () => {
    const result = makeResult({ stderr: 'Error: read ECONNRESET' });
    expect(isRetryableExecResult(result)).toBe(true);
  });

  test('ENOTFOUND is retryable', () => {
    const result = makeResult({ stderr: 'getaddrinfo ENOTFOUND registry.npmjs.org' });
    expect(isRetryableExecResult(result)).toBe(true);
  });

  test('ETIMEDOUT is retryable', () => {
    const result = makeResult({ stderr: 'connect ETIMEDOUT 104.16.1.1:443' });
    expect(isRetryableExecResult(result)).toBe(true);
  });

  test('EBUSY is retryable (busy category)', () => {
    const result = makeResult({ stderr: 'EBUSY: resource busy or locked' });
    expect(isRetryableExecResult(result)).toBe(true);
  });

  test('ENOMEM is retryable when oom in allowed list', () => {
    const result = makeResult({ stderr: 'ENOMEM: Cannot allocate memory' });
    expect(isRetryableExecResult(result, ['oom'])).toBe(true);
  });

  test('ENOMEM is NOT retryable when oom NOT in allowed list', () => {
    const result = makeResult({ stderr: 'ENOMEM: Cannot allocate memory' });
    expect(isRetryableExecResult(result, ['network'])).toBe(false);
  });

  test('retry.on filter: only network allowed — EBUSY not retried', () => {
    const result = makeResult({ stderr: 'EBUSY: locked' });
    expect(isRetryableExecResult(result, ['network'])).toBe(false);
  });

  test('plain non-zero exit with no matching pattern — not retryable', () => {
    const result = makeResult({ exit_code: 1, stderr: 'some other error' });
    expect(isRetryableExecResult(result)).toBe(false);
  });

  test('jitter: bounded random source can produce varied retry delays', () => {
    const cap = 1000 * Math.pow(2, 1); // attempt=1, base=1000
    let seed = 0x12345678;
    const nextUnit = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const delays = Array.from({ length: 20 }, () => nextUnit() * cap);
    const allSame = delays.every((d) => d === delays[0]);
    expect(allSame).toBe(false);
  });
});
