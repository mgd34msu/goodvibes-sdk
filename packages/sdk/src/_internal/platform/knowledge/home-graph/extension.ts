import type { KnowledgeExtensionDefinition } from '../extensions.js';

export const HOME_GRAPH_KNOWLEDGE_EXTENSION: KnowledgeExtensionDefinition = {
  id: 'home-graph',
  objectProfiles: [
    {
      id: 'homegraph-device',
      subjectKinds: ['ha_device'],
      intrinsicFactKinds: [
        'identity',
        'feature',
        'capability',
        'specification',
        'compatibility',
        'configuration',
        'troubleshooting',
      ],
      suppressedGapKinds: ['battery'],
      searchHints: [
        'manufacturer model specifications',
        'official product support',
        'manual datasheet features',
      ],
    },
    {
      id: 'homegraph-entity',
      subjectKinds: ['ha_entity'],
      intrinsicFactKinds: ['identity', 'capability', 'configuration'],
      searchHints: ['Home Assistant entity domain capabilities'],
    },
    {
      id: 'homegraph-integration',
      subjectKinds: ['ha_integration'],
      intrinsicFactKinds: ['identity', 'capability', 'configuration', 'troubleshooting'],
      searchHints: ['Home Assistant integration documentation', 'integration setup capabilities'],
    },
  ],
};
