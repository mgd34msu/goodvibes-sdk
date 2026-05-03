import { describe, expect, test } from 'bun:test';
import { HOME_GRAPH_KNOWLEDGE_EXTENSION } from '../packages/sdk/src/platform/knowledge/home-graph/extension.js';

describe('Home Graph knowledge extension', () => {
  test('registers concrete Home Assistant object profiles on the base knowledge seam', () => {
    expect(HOME_GRAPH_KNOWLEDGE_EXTENSION.id).toBe('home-graph');
    expect(HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles.map((profile) => profile.id)).toEqual([
      'homegraph-device',
      'homegraph-entity',
      'homegraph-integration',
    ]);
    expect(HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles[0]?.subjectKinds).toContain('ha_device');
    expect(HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles[0]?.suppressedGapKinds).toContain('battery');
  });
});
