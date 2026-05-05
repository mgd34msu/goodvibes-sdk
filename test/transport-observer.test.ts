import { describe, expect, test } from 'bun:test';
import { invokeTransportObserver } from '../packages/transport-core/src/observer.js';

describe('transport observer callback isolation', () => {
  test('reports observer callback errors through onObserverError', () => {
    const reported: Error[] = [];

    expect(() => invokeTransportObserver(() => {
      throw new Error('observer broke');
    }, (error) => {
      reported.push(error);
    })).not.toThrow();

    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain('Transport observer callback failed');
    expect(reported[0]?.message).toContain('observer broke');
  });

  test('does not propagate observer error reporter failures', () => {
    expect(() => invokeTransportObserver(() => {
      throw new Error('observer broke');
    }, () => {
      throw new Error('reporter broke');
    })).not.toThrow();
  });
});
