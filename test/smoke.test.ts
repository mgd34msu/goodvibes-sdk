import { describe, expect, test } from 'bun:test';
import {
  FOUNDATION_METADATA,
  createOperatorSdk,
  createPeerSdk,
  createRemoteRuntimeEvents,
  createTransportPaths,
} from '../packages/sdk/src/index.ts';
import {
  createDaemonControlRouteHandlers,
  createDaemonKnowledgeRouteHandlers,
} from '../packages/sdk/src/daemon.ts';

describe('sdk public facades', () => {
  test('root re-exports contracts, transport, operator, and peer clients', () => {
    const { productVersion } = FOUNDATION_METADATA;
    expect(productVersion).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    // Factory functions are verified by import — calling createTransportPaths
    // exercises the real public API surface.
    const paths = createTransportPaths('http://127.0.0.1:3210');
    expect(paths.tasksUrl).toBe('http://127.0.0.1:3210/api/tasks');
    expect(typeof paths.controlUrl).toBe('string'); // controlUrl is a string URL
    expect([createOperatorSdk, createPeerSdk, createRemoteRuntimeEvents].every(f => typeof f === 'function')).toBe(true);
  });

  test('daemon route handlers live on the explicit daemon facade', () => {
    expect([createDaemonControlRouteHandlers, createDaemonKnowledgeRouteHandlers].every(f => typeof f === 'function')).toBe(true);
  });
});
