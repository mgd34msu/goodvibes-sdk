/**
 * Coverage-gap smoke test — platform/templates
 * Verifies that the templates manager module loads correctly.
 * Closes coverage gap: platform/templates (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { TemplateManager, parseTemplateArgs } from '../packages/sdk/src/platform/templates/manager.js';

describe('platform/templates — module load smoke', () => {
  test('TemplateManager is a constructor', () => {
    expect(typeof TemplateManager).toBe('function');
  });

  test('parseTemplateArgs is a function', () => {
    expect(typeof parseTemplateArgs).toBe('function');
  });

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
    expect(typeof mgr.save).toBe('function');
    expect(typeof mgr.load).toBe('function');
    expect(typeof mgr.list).toBe('function');
    expect(typeof mgr.delete).toBe('function');
  });
});
