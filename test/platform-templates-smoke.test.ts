/**
 * Coverage-gap smoke test, platform/templates
 * Verifies that the templates manager module loads correctly.
 * Closes coverage gap: platform/templates
 */

import { describe, expect, test } from 'bun:test';
import { parseTemplateArgs } from '../packages/sdk/src/platform/templates/manager.js';

describe('platform/templates: template management behavior', () => {
  test('parseTemplateArgs parses named args', () => {
    const result = parseTemplateArgs(['name=foo', 'value=bar']);
    expect(result).toEqual({ name: 'foo', value: 'bar' });
  });

  test('parseTemplateArgs parses positional args', () => {
    const result = parseTemplateArgs(['hello', 'world']);
    expect(result['1']).toBe('hello');
    expect(result['2']).toBe('world');
  });
});
