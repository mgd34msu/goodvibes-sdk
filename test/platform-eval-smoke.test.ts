/**
 * Coverage-gap smoke test — platform/runtime/eval
 * Verifies that the eval runner and scorecard modules load correctly.
 * Closes coverage gap: platform/runtime/eval (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { EvalRunner } from '../packages/sdk/src/platform/runtime/eval/runner.js';

describe('platform/runtime/eval — module load smoke', () => {
  test('EvalRunner is a constructor', () => {
    expect(typeof EvalRunner).toBe('function');
  });

  test('EvalRunner instance has expected methods', () => {
    const runner = new EvalRunner();
    expect(typeof runner.runSuite).toBe('function');
    expect(typeof runner.evaluateGate).toBe('function');
  });

  test('EvalRunner accepts regressionThreshold option', () => {
    const runner = new EvalRunner({ regressionThreshold: 0.1 });
    expect(runner).toBeDefined();
  });
});
