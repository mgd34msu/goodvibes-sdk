import { describe, expect, test } from 'bun:test';
import { detectReferencedMemoryIds } from '../packages/sdk/src/platform/state/index.js';

/**
 * Two-tier honest reference heuristic (hoisted from the agent surface).
 * 'referenced' requires two distinctive tokens, one long (>=6) distinctive
 * token, or a distinctive adjacent phrase; otherwise 'present'. Not ground truth.
 */
describe('detectReferencedMemoryIds', () => {
  test('distinctive token overlap marks referenced', () => {
    const result = detectReferencedMemoryIds('I ran the kubernetes rollout as configured.', [
      { id: 'm1', summary: 'Kubernetes rollout script' },
    ]);
    expect(result.referenced).toEqual(['m1']);
    expect(result.perId.get('m1')).toBe('referenced');
  });

  test('common words alone stay present', () => {
    const result = detectReferencedMemoryIds('the and for with that this from into your', [
      { id: 'm2', summary: 'the and for with' },
    ]);
    expect(result.present).toContain('m2');
    expect(result.referenced).toEqual([]);
  });

  test('single short (4-char) token is present; single long (>=6) token is referenced', () => {
    const short = detectReferencedMemoryIds('here are the tags', [{ id: 's', summary: 'tags' }]);
    expect(short.perId.get('s')).toBe('present');
    const long = detectReferencedMemoryIds('we added authentication today', [{ id: 'l', summary: 'authentication flow' }]);
    expect(long.perId.get('l')).toBe('referenced');
  });

  test('distinctive adjacent phrase in output marks referenced', () => {
    const result = detectReferencedMemoryIds('please follow the release checklist before shipping', [
      { id: 'm5', summary: 'shipping', detail: 'follow release checklist' },
    ]);
    expect(result.referenced).toContain('m5');
  });
});
