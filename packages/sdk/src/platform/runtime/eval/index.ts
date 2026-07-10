/**
 * Evaluation Harness — barrel export.
 *
 * Provides the eval runner, scorecard scorer, built-in suites,
 * and baseline persistence utilities.
 *
 * @example
 * ```ts
 * import { EvalRunner, BUILTIN_SUITES, captureBaseline, loadBaseline } from './eval/index.js';
 *
 * const runner = new EvalRunner();
 * const result = await runner.runSuite('core-performance', BUILTIN_SUITES['core-performance']);
 * const gate = runner.evaluateGate(result, await loadBaseline('.goodvibes/eval/baseline.json'));
 * if (!gate.passed) process.exit(1);
 * ```
 */

export type {
  EvalScenario,
  EvalRawResult,
  EvalResult,
  EvalSuiteResult,
  EvalScorecard,
  EvalBaseline,
  EvalGateResult,
  EvalDimension,
  DimensionScore,
  RegressionEntry,
  FloorFailureEntry,
  UnbaselinedScenario,
  BaselineSuiteSummary,
} from './types.js';

export { EvalRunner } from './runner.js';
export type { EvalRunnerOptions } from './runner.js';

export { scoreScenario, formatScorecard, DIMENSION_FLOOR } from './scorecard.js';

export { BUILTIN_SUITES, ALL_SCENARIOS } from './suites.js';

export { GATE_SUITES } from './gate-suites.js';

export {
  captureBaseline,
  serialiseBaseline,
  deserialiseBaseline,
  writeBaseline,
  loadBaseline,
  formatBaselineComparison,
} from './baseline.js';

export { formatSuiteResult, formatGateResult } from './format.js';

export {
  runTaskSuite,
  discoverTasks,
  loadTaskDefinition,
  defaultShellVerifier,
  formatTaskSuiteResult,
} from './task-suite.js';
export type {
  TaskDefinition,
  DiscoveredTask,
  TaskExecutionContext,
  TaskSessionOutcome,
  TaskSessionExecutor,
  TaskVerifyContext,
  TaskVerifyResult,
  TaskVerifier,
  TaskResult,
  TaskSuiteResult,
  RunTaskSuiteOptions,
} from './task-suite.js';
