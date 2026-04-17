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
    expect(productVersion).toMatch(/^0\.\d+\.\d+$/);
    expect(typeof createDaemonControlRouteHandlers).toBe('function');
    expect(typeof createDaemonKnowledgeRouteHandlers).toBe('function');
    expect(typeof createOperatorSdk).toBe('function');
    expect(typeof createPeerSdk).toBe('function');
    expect(typeof createRemoteRuntimeEvents).toBe('function');
    expect(createTransportPaths('http://127.0.0.1:3210').tasksUrl).toBe('http://127.0.0.1:3210/api/tasks');
  });
});
