/**
 * ARCH-03 Error Hierarchy Regression Test
 *
 * Verifies that every platform-layer error class:
 *   1. Passes instanceof GoodVibesSdkError (hierarchy is intact)
 *   2. Passes instanceof Error (transitively, always)
 *   3. Exposes populated .code, .category, .source, .recoverable fields
 *
 * This test guards against field-shadowing regressions (e.g. `public readonly`
 * parameter properties on derived classes that reset base-class fields to undefined).
 */

import { describe, it, expect } from 'bun:test';
import { GoodVibesSdkError } from '../packages/errors/src/index.js';
import {
  AppError,
} from '../packages/sdk/src/platform/types/errors.js';
import { ProviderNotFoundError } from '../packages/sdk/src/platform/providers/provider-not-found-error.js';
import { OpsIllegalActionError, OpsTargetNotFoundError } from '../packages/sdk/src/platform/runtime/ops/control-plane.js';
import { TaskTransitionError, TaskNotFoundError, TaskNotCancellableError } from '../packages/sdk/src/platform/runtime/tasks/manager.js';
import { VersionMismatchError } from '../packages/sdk/src/platform/runtime/remote/transport-contract.js';
import { DivergenceGateError } from '../packages/sdk/src/platform/runtime/permissions/divergence-dashboard.js';
import { SimulationEnforcementError } from '../packages/sdk/src/platform/runtime/permissions/simulation.js';
import { PolicySignatureError } from '../packages/sdk/src/platform/runtime/permissions/policy-loader.js';
import { DeliveryError } from '../packages/sdk/src/platform/integrations/delivery.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertHierarchy(err: unknown, label: string): void {
  expect(err instanceof GoodVibesSdkError, `${label}: instanceof GoodVibesSdkError`).toBe(true);
  expect(err instanceof Error, `${label}: instanceof Error`).toBe(true);
}

function assertFields(err: GoodVibesSdkError, label: string, expectCode = false): void {
  if (expectCode) {
    expect(err.code, `${label}: .code is populated`).toEqual(expect.any(String));
  } else {
    // code is optional on GoodVibesSdkError — just assert the field exists (string | undefined)
    expect('code' in err, `${label}: .code field exists`).toBe(true);
  }
  expect(err.category, `${label}: .category is populated`).toEqual(expect.any(String));
  expect(err.source, `${label}: .source is populated`).toEqual(expect.any(String));
  // recoverable is a boolean — check it is defined (not undefined)
  expect(typeof err.recoverable, `${label}: .recoverable is boolean`).toBe('boolean');
}

// ---------------------------------------------------------------------------
// AppError
// ---------------------------------------------------------------------------

describe('AppError hierarchy', () => {
  it('is instanceof GoodVibesSdkError and Error', () => {
    const err = new AppError('test message', 'TEST_CODE', false);
    assertHierarchy(err, 'AppError');
  });

  it('has populated .code, .category, .source, .recoverable fields', () => {
    const err = new AppError('test message', 'TEST_CODE', false, {
      category: 'internal',
      source: 'runtime',
    });
    assertFields(err, 'AppError', true);
    expect(err.code).toBe('TEST_CODE');
    expect(err.recoverable).toBe(false);
  });

  it('.code and .recoverable are owned by base (no field shadowing)', () => {
    const err = new AppError('msg', 'MY_CODE', true);
    // Verify the value is the one passed through super(), not undefined from a shadowed field
    expect(err.code).toBe('MY_CODE');
    expect(err.recoverable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ProviderNotFoundError
// ---------------------------------------------------------------------------

describe('ProviderNotFoundError hierarchy', () => {
  it('is instanceof GoodVibesSdkError and Error', () => {
    const err = new ProviderNotFoundError('anthropic', ['openai', 'gemini']);
    assertHierarchy(err, 'ProviderNotFoundError');
  });

  it('has populated .code, .category, .source, .recoverable fields', () => {
    const err = new ProviderNotFoundError('anthropic', ['openai']);
    assertFields(err, 'ProviderNotFoundError', true);
    expect(err.code).toBe('PROVIDER_NOT_FOUND');
    expect(err.category).toBe('not_found');
    expect(err.source).toBe('provider');
    expect(err.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OpsIllegalActionError
// ---------------------------------------------------------------------------

describe('OpsIllegalActionError hierarchy', () => {
  it('is instanceof GoodVibesSdkError and Error', () => {
    const err = new OpsIllegalActionError('task-1', 'cancel', 'completed');
    assertHierarchy(err, 'OpsIllegalActionError');
  });

  it('has populated .code, .category, .source, .recoverable fields', () => {
    const err = new OpsIllegalActionError('task-1', 'cancel', 'completed');
    assertFields(err, 'OpsIllegalActionError', true);
    expect(err.code).toBe('OPS_ILLEGAL_ACTION');
    expect(err.category).toBe('permission');
    expect(err.source).toBe('runtime');
    expect(err.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OpsTargetNotFoundError
// ---------------------------------------------------------------------------

describe('OpsTargetNotFoundError hierarchy', () => {
  it('is instanceof GoodVibesSdkError and Error', () => {
    const err = new OpsTargetNotFoundError('task-1', 'task');
    assertHierarchy(err, 'OpsTargetNotFoundError');
  });

  it('has populated .code, .category, .source, .recoverable fields', () => {
    const err = new OpsTargetNotFoundError('task-1', 'task');
    assertFields(err, 'OpsTargetNotFoundError', true);
    expect(err.code).toBe('OPS_TARGET_NOT_FOUND');
    expect(err.category).toBe('not_found');
    expect(err.source).toBe('runtime');
    expect(err.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TaskTransitionError
// ---------------------------------------------------------------------------

describe('TaskTransitionError hierarchy', () => {
  it('is instanceof GoodVibesSdkError and Error', () => {
    const err = new TaskTransitionError('task-1', 'completed', 'running');
    assertHierarchy(err, 'TaskTransitionError');
  });

  it('has populated .code, .category, .source, .recoverable fields', () => {
    const err = new TaskTransitionError('task-1', 'completed', 'running');
    assertFields(err, 'TaskTransitionError', true);
    expect(err.code).toBe('TASK_TRANSITION_ERROR');
    expect(err.category).toBe('internal');
    expect(err.source).toBe('runtime');
    expect(err.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TaskNotFoundError
// ---------------------------------------------------------------------------

describe('TaskNotFoundError hierarchy', () => {
  it('is instanceof GoodVibesSdkError and Error', () => {
    const err = new TaskNotFoundError('task-99');
    assertHierarchy(err, 'TaskNotFoundError');
  });

  it('has populated .code, .category, .source, .recoverable fields', () => {
    const err = new TaskNotFoundError('task-99');
    assertFields(err, 'TaskNotFoundError', true);
    expect(err.code).toBe('TASK_NOT_FOUND');
    expect(err.category).toBe('not_found');
    expect(err.source).toBe('runtime');
    expect(err.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TaskNotCancellableError
// ---------------------------------------------------------------------------

describe('TaskNotCancellableError hierarchy', () => {
  it('is instanceof GoodVibesSdkError and Error', () => {
    const err = new TaskNotCancellableError('task-99');
    assertHierarchy(err, 'TaskNotCancellableError');
  });

  it('has populated .code, .category, .source, .recoverable fields', () => {
    const err = new TaskNotCancellableError('task-99');
    assertFields(err, 'TaskNotCancellableError', true);
    expect(err.code).toBe('TASK_NOT_CANCELLABLE');
    expect(err.category).toBe('internal');
    expect(err.source).toBe('runtime');
    expect(err.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VersionMismatchError
// ---------------------------------------------------------------------------

describe('VersionMismatchError hierarchy', () => {
  const localVer = { major: 1, minor: 0, patch: 0 } as const;
  const peerVer = { major: 2, minor: 0, patch: 0 } as const;

  it('is instanceof GoodVibesSdkError and Error', () => {
    const err = new VersionMismatchError('major_version_mismatch', localVer, peerVer, 'Major version mismatch');
    assertHierarchy(err, 'VersionMismatchError');
  });

  it('has populated .code, .category, .source, .recoverable fields', () => {
    const err = new VersionMismatchError('major_version_mismatch', localVer, peerVer, 'Major version mismatch');
    assertFields(err, 'VersionMismatchError', true);
    expect(err.code).toBe('major_version_mismatch');
    expect(err.category).toBe('protocol');
    expect(err.source).toBe('transport');
    expect(err.recoverable).toBe(false);
    // mismatchCode is a typed alias for the inherited code field
    expect(err.mismatchCode).toBe(err.code);
  });
});

// ---------------------------------------------------------------------------
// DivergenceGateError
// ---------------------------------------------------------------------------

describe('DivergenceGateError hierarchy', () => {
  const gate = {
    status: 'blocked' as const,
    divergenceRate: 0.85,
    threshold: 0.5,
    totalEvaluations: 100,
    message: 'Divergence rate exceeds threshold',
  };

  it('is instanceof GoodVibesSdkError and Error', () => {
    const err = new DivergenceGateError('Gate blocked', gate);
    assertHierarchy(err, 'DivergenceGateError');
  });

  it('has populated .code, .category, .source, .recoverable fields', () => {
    const err = new DivergenceGateError('Gate blocked', gate);
    assertFields(err, 'DivergenceGateError', true);
    expect(err.code).toBe('DIVERGENCE_GATE_BLOCKED');
    expect(err.category).toBe('permission');
    expect(err.source).toBe('runtime');
    expect(err.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SimulationEnforcementError
// ---------------------------------------------------------------------------

describe('SimulationEnforcementError hierarchy', () => {
  it('is instanceof GoodVibesSdkError and Error', () => {
    const err = new SimulationEnforcementError('Enforcement failed', 0.9, 0.5);
    assertHierarchy(err, 'SimulationEnforcementError');
  });

  it('has populated .code, .category, .source, .recoverable fields', () => {
    const err = new SimulationEnforcementError('Enforcement failed', 0.9, 0.5);
    assertFields(err, 'SimulationEnforcementError', true);
    expect(err.code).toBe('SIMULATION_ENFORCEMENT_BLOCKED');
    expect(err.category).toBe('permission');
    expect(err.source).toBe('runtime');
    expect(err.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PolicySignatureError
// ---------------------------------------------------------------------------

describe('PolicySignatureError hierarchy', () => {
  it('is instanceof GoodVibesSdkError and Error', () => {
    const err = new PolicySignatureError('bundle-abc', 'invalid', 'Bundle signature invalid');
    assertHierarchy(err, 'PolicySignatureError');
  });

  it('has populated .code, .category, .source, .recoverable fields', () => {
    const err = new PolicySignatureError('bundle-abc', 'invalid', 'Bundle signature invalid');
    assertFields(err, 'PolicySignatureError', true);
    expect(err.code).toBe('POLICY_SIGNATURE_INVALID');
    expect(err.category).toBe('permission');
    expect(err.source).toBe('runtime');
    expect(err.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DeliveryError
// ---------------------------------------------------------------------------

describe('DeliveryError hierarchy', () => {
  it('is instanceof GoodVibesSdkError and Error', () => {
    const err = new DeliveryError('Delivery failed', 'terminal', 500);
    assertHierarchy(err, 'DeliveryError');
  });

  it('has populated .code, .category, .source, .recoverable fields', () => {
    const err = new DeliveryError('Delivery failed', 'terminal');
    assertFields(err, 'DeliveryError', true);
    expect(err.code).toBe('DELIVERY_ERROR');
    expect(err.category).toBe('internal');
    expect(err.source).toBe('runtime');
    expect(err.recoverable).toBe(false);
  });
});
