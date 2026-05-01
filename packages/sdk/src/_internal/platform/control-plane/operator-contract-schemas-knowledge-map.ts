import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.js';
import {
  METADATA_SCHEMA,
  recordSchema,
} from './operator-contract-schemas-shared.js';

const KNOWLEDGE_MAP_NODE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  recordKind: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  title: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  x: NUMBER_SCHEMA,
  y: NUMBER_SCHEMA,
  radius: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'recordKind', 'kind', 'title', 'x', 'y', 'radius', 'metadata'], { additionalProperties: true });

const KNOWLEDGE_MAP_EDGE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  fromId: STRING_SCHEMA,
  toId: STRING_SCHEMA,
  source: STRING_SCHEMA,
  target: STRING_SCHEMA,
  fromTitle: STRING_SCHEMA,
  toTitle: STRING_SCHEMA,
  sourceTitle: STRING_SCHEMA,
  targetTitle: STRING_SCHEMA,
  relation: STRING_SCHEMA,
  weight: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'fromId', 'toId', 'relation', 'weight', 'metadata'], { additionalProperties: true });

const KNOWLEDGE_MAP_FACET_VALUE_SCHEMA = objectSchema({
  value: STRING_SCHEMA,
  count: NUMBER_SCHEMA,
  label: STRING_SCHEMA,
}, ['value', 'count'], { additionalProperties: true });

const KNOWLEDGE_MAP_FACETS_SCHEMA = objectSchema({
  recordKinds: arraySchema(KNOWLEDGE_MAP_FACET_VALUE_SCHEMA),
  nodeKinds: arraySchema(KNOWLEDGE_MAP_FACET_VALUE_SCHEMA),
  sourceTypes: arraySchema(KNOWLEDGE_MAP_FACET_VALUE_SCHEMA),
  sourceStatuses: arraySchema(KNOWLEDGE_MAP_FACET_VALUE_SCHEMA),
  nodeStatuses: arraySchema(KNOWLEDGE_MAP_FACET_VALUE_SCHEMA),
  issueCodes: arraySchema(KNOWLEDGE_MAP_FACET_VALUE_SCHEMA),
  issueStatuses: arraySchema(KNOWLEDGE_MAP_FACET_VALUE_SCHEMA),
  issueSeverities: arraySchema(KNOWLEDGE_MAP_FACET_VALUE_SCHEMA),
  edgeRelations: arraySchema(KNOWLEDGE_MAP_FACET_VALUE_SCHEMA),
  tags: arraySchema(KNOWLEDGE_MAP_FACET_VALUE_SCHEMA),
  homeAssistant: recordSchema(arraySchema(KNOWLEDGE_MAP_FACET_VALUE_SCHEMA)),
}, [], { additionalProperties: true });

export const KNOWLEDGE_MAP_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  title: STRING_SCHEMA,
  generatedAt: NUMBER_SCHEMA,
  width: NUMBER_SCHEMA,
  height: NUMBER_SCHEMA,
  nodeCount: NUMBER_SCHEMA,
  edgeCount: NUMBER_SCHEMA,
  totalNodeCount: NUMBER_SCHEMA,
  totalEdgeCount: NUMBER_SCHEMA,
  facets: KNOWLEDGE_MAP_FACETS_SCHEMA,
  nodes: arraySchema(KNOWLEDGE_MAP_NODE_SCHEMA),
  edges: arraySchema(KNOWLEDGE_MAP_EDGE_SCHEMA),
  svg: STRING_SCHEMA,
}, ['ok', 'title', 'generatedAt', 'width', 'height', 'nodeCount', 'edgeCount', 'nodes', 'edges', 'svg'], { additionalProperties: true });
