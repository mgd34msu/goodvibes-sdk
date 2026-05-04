import { describe, expect, test } from 'bun:test';
import {
  FOUNDATION_METADATA,
  createDaemonKnowledgeRouteHandlers,
  createDaemonControlRouteHandlers,
  createOperatorSdk,
  createPeerSdk,
  createRemoteRuntimeEvents,
  createTransportPaths,
} from '../packages/sdk/src/index.ts';

describe('sdk umbrella package', () => {
  test('re-exports contracts, transport, and clients', () => {
    const { productVersion } = FOUNDATION_METADATA;
    expect(productVersion).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    // Factory functions are verified by import — calling createTransportPaths
    // exercises the real public API surface.
    const paths = createTransportPaths('http://127.0.0.1:3210');
    expect(paths.tasksUrl).toBe('http://127.0.0.1:3210/api/tasks');
    expect(typeof paths.controlUrl).toBe('string'); // controlUrl is a string URL
    // Confirm all factory exports resolve (import-time check is sufficient;
    // calling them requires runtime config that is not available in smoke tests).
    expect([createDaemonControlRouteHandlers, createDaemonKnowledgeRouteHandlers, createOperatorSdk, createPeerSdk, createRemoteRuntimeEvents].every(f => typeof f === 'function')).toBe(true);
  });
});
