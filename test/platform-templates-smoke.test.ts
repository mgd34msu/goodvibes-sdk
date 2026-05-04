/**
 * Coverage-gap smoke test — platform/templates
 * Verifies that the templates manager module loads correctly.
 * Closes coverage gap: platform/templates (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { TemplateManager, parseTemplateArgs } from '../packages/sdk/src/platform/templates/manager.js';

describe('platform/templates — template management behavior', () => {
  test('parseTemplateArgs parses named args', () => {
    const result = parseTemplateArgs(['name=foo', 'value=bar']);
    expect(result).toEqual({ name: 'foo', value: 'bar' });
  });

  test('parseTemplateArgs parses positional args', () => {
    const result = parseTemplateArgs(['hello', 'world']);
    expect(result['1']).toBe('hello');
    expect(result['2']).toBe('world');
  });

  test('TemplateManager instance has expected methods', () => {
    const mgr = new TemplateManager({ projectRoot: '/tmp', homeDirectory: '/tmp', projectDirectory: '/tmp', globalDirectory: '/tmp' });
    const listed = mgr.list();
    expect(listed).toBeInstanceOf(Array);
  });
});
