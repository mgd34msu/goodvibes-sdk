/**
 * Coverage-gap smoke test — platform/runtime/inspection/state-inspector
 * Verifies that createStateInspector constructs a working inspector and
 * its methods return correct observable shapes.
 * Closes coverage gap: platform/runtime/inspection/state-inspector (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { createStateInspector } from '../packages/sdk/src/platform/runtime/inspection/state-inspector.js';

describe('platform/runtime/inspection/state-inspector — behavior smoke', () => {
  test('getSnapshot returns an object with domains array and capturedAt timestamp', () => {
    const inspector = createStateInspector({ domains: [] });
    const snapshot = inspector.getSnapshot();
    expect(snapshot).toBeDefined();
    expect(typeof snapshot).toBe('object');
    expect(Array.isArray(snapshot.domains)).toBe(true);
    expect(typeof snapshot.capturedAt).toBe('number');
  });

  test('registeredDomainNames returns an empty array when no domains registered', () => {
    const inspector = createStateInspector({ domains: [] });
    const names = inspector.registeredDomainNames();
    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBe(0);
  });

  test('totalTransitions starts at 0', () => {
    const inspector = createStateInspector({ domains: [] });
    // totalTransitions is a getter property, not a method
    expect(inspector.totalTransitions).toBe(0);
  });

  test('subscribe returns an object with id and unsubscribe function', () => {
    const inspector = createStateInspector({ domains: [] });
    const sub = inspector.subscribe(() => {});
    expect(typeof sub.id).toBe('string');
    expect(typeof sub.unsubscribe).toBe('function');
    // Exercise unsubscribe without error
    sub.unsubscribe();
    // subscriptionCount is a getter property, not a method
    expect(inspector.subscriptionCount).toBe(0);
  });
});
