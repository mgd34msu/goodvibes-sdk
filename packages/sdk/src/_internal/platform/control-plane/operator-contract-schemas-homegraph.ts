import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.js';
import {
  GENERIC_LIST_SCHEMA,
  JSON_RECORD_SCHEMA,
  nullableSchema,
} from './operator-contract-schemas-shared.js';
import {
  KNOWLEDGE_EDGE_SCHEMA,
  KNOWLEDGE_EXTRACTION_SCHEMA,
  KNOWLEDGE_ISSUE_SCHEMA,
  KNOWLEDGE_MAP_OUTPUT_SCHEMA,
  KNOWLEDGE_NODE_SCHEMA,
  KNOWLEDGE_REFINEMENT_RUN_OUTPUT_SCHEMA,
  KNOWLEDGE_REFINEMENT_TASK_SCHEMA,
  KNOWLEDGE_SOURCE_SCHEMA,
} from './operator-contract-schemas-knowledge.js';

export const HOME_GRAPH_SPACE_INPUT_SCHEMA = objectSchema({
  installationId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
}, [], { additionalProperties: true });

export const HOME_GRAPH_STATUS_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  installationId: STRING_SCHEMA,
  sourceCount: NUMBER_SCHEMA,
  nodeCount: NUMBER_SCHEMA,
  edgeCount: NUMBER_SCHEMA,
  issueCount: NUMBER_SCHEMA,
  extractionCount: NUMBER_SCHEMA,
  lastSnapshotAt: NUMBER_SCHEMA,
  readiness: JSON_RECORD_SCHEMA,
  capabilities: arraySchema(STRING_SCHEMA),
}, ['ok', 'spaceId', 'installationId', 'sourceCount', 'nodeCount', 'edgeCount', 'issueCount', 'extractionCount', 'capabilities'], { additionalProperties: true });

export const HOME_GRAPH_SYNC_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  installationId: STRING_SCHEMA,
  source: KNOWLEDGE_SOURCE_SCHEMA,
  home: KNOWLEDGE_NODE_SCHEMA,
  created: JSON_RECORD_SCHEMA,
  generated: objectSchema({
    devicePassports: NUMBER_SCHEMA,
    roomPages: NUMBER_SCHEMA,
    artifacts: NUMBER_SCHEMA,
    sources: NUMBER_SCHEMA,
    errors: GENERIC_LIST_SCHEMA,
  }, ['devicePassports', 'roomPages', 'artifacts', 'sources', 'errors'], { additionalProperties: true }),
  counts: JSON_RECORD_SCHEMA,
}, ['ok', 'spaceId', 'installationId', 'source', 'home', 'created', 'generated', 'counts'], { additionalProperties: true });

export const HOME_GRAPH_INGEST_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  source: KNOWLEDGE_SOURCE_SCHEMA,
  artifactId: STRING_SCHEMA,
  extraction: KNOWLEDGE_EXTRACTION_SCHEMA,
  linked: KNOWLEDGE_EDGE_SCHEMA,
}, ['ok', 'spaceId', 'source'], { additionalProperties: true });

export const HOME_GRAPH_LINK_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  edge: KNOWLEDGE_EDGE_SCHEMA,
  target: JSON_RECORD_SCHEMA,
}, ['ok', 'spaceId', 'edge'], { additionalProperties: true });

export const HOME_GRAPH_ASK_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  query: STRING_SCHEMA,
  answer: JSON_RECORD_SCHEMA,
  results: GENERIC_LIST_SCHEMA,
}, ['ok', 'spaceId', 'query', 'answer', 'results'], { additionalProperties: true });

export const HOME_GRAPH_MAP_OUTPUT_SCHEMA = KNOWLEDGE_MAP_OUTPUT_SCHEMA;

export const HOME_GRAPH_REINDEX_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  scanned: NUMBER_SCHEMA,
  reparsed: NUMBER_SCHEMA,
  skipped: NUMBER_SCHEMA,
  failed: NUMBER_SCHEMA,
  changedSourceCount: NUMBER_SCHEMA,
  forcedSourceCount: NUMBER_SCHEMA,
  skippedGeneratedPageArtifactCount: NUMBER_SCHEMA,
  refreshedGeneratedPageCount: NUMBER_SCHEMA,
  generatedPagePolicyVersion: STRING_SCHEMA,
  truncated: BOOLEAN_SCHEMA,
  budgetExhausted: BOOLEAN_SCHEMA,
  sources: arraySchema(KNOWLEDGE_SOURCE_SCHEMA),
  failures: GENERIC_LIST_SCHEMA,
  linked: GENERIC_LIST_SCHEMA,
  semantic: JSON_RECORD_SCHEMA,
  generated: JSON_RECORD_SCHEMA,
}, ['ok', 'spaceId', 'scanned', 'reparsed', 'skipped', 'failed', 'sources', 'failures'], { additionalProperties: true });

export const HOME_GRAPH_PROJECTION_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  title: STRING_SCHEMA,
  markdown: STRING_SCHEMA,
  source: KNOWLEDGE_SOURCE_SCHEMA,
  linked: KNOWLEDGE_EDGE_SCHEMA,
  artifact: JSON_RECORD_SCHEMA,
}, ['ok', 'spaceId', 'title', 'markdown', 'artifact'], { additionalProperties: true });

export const HOME_GRAPH_ISSUES_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  issues: arraySchema(KNOWLEDGE_ISSUE_SCHEMA),
}, ['ok', 'spaceId', 'issues'], { additionalProperties: true });

export const HOME_GRAPH_SOURCES_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  sources: arraySchema(KNOWLEDGE_SOURCE_SCHEMA),
}, ['ok', 'spaceId', 'sources'], { additionalProperties: true });

export const HOME_GRAPH_PAGES_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  pages: GENERIC_LIST_SCHEMA,
}, ['ok', 'spaceId', 'pages'], { additionalProperties: true });

export const HOME_GRAPH_BROWSE_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  nodes: arraySchema(KNOWLEDGE_NODE_SCHEMA),
  edges: arraySchema(KNOWLEDGE_EDGE_SCHEMA),
  sources: arraySchema(KNOWLEDGE_SOURCE_SCHEMA),
  issues: arraySchema(KNOWLEDGE_ISSUE_SCHEMA),
}, ['ok', 'spaceId', 'nodes', 'edges', 'sources', 'issues'], { additionalProperties: true });

export const HOME_GRAPH_REVIEW_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  issue: KNOWLEDGE_ISSUE_SCHEMA,
  node: KNOWLEDGE_NODE_SCHEMA,
  source: KNOWLEDGE_SOURCE_SCHEMA,
}, ['ok', 'spaceId'], { additionalProperties: true });

export const HOME_GRAPH_REFINEMENT_TASKS_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  tasks: arraySchema(KNOWLEDGE_REFINEMENT_TASK_SCHEMA),
}, ['ok', 'spaceId', 'tasks'], { additionalProperties: true });

export const HOME_GRAPH_REFINEMENT_TASK_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  task: nullableSchema(KNOWLEDGE_REFINEMENT_TASK_SCHEMA),
}, ['ok', 'spaceId', 'task'], { additionalProperties: true });

export const HOME_GRAPH_REFINEMENT_RUN_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  result: KNOWLEDGE_REFINEMENT_RUN_OUTPUT_SCHEMA,
}, ['ok', 'spaceId', 'result'], { additionalProperties: true });

export const HOME_GRAPH_EXPORT_OUTPUT_SCHEMA = objectSchema({
  version: NUMBER_SCHEMA,
  exportedAt: NUMBER_SCHEMA,
  spaceId: STRING_SCHEMA,
  installationId: STRING_SCHEMA,
  sources: arraySchema(KNOWLEDGE_SOURCE_SCHEMA),
  nodes: arraySchema(KNOWLEDGE_NODE_SCHEMA),
  edges: arraySchema(KNOWLEDGE_EDGE_SCHEMA),
  issues: arraySchema(KNOWLEDGE_ISSUE_SCHEMA),
  extractions: arraySchema(KNOWLEDGE_EXTRACTION_SCHEMA),
}, ['version', 'exportedAt', 'spaceId', 'installationId', 'sources', 'nodes', 'edges', 'issues', 'extractions'], { additionalProperties: true });

export const HOME_GRAPH_IMPORT_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  spaceId: STRING_SCHEMA,
  imported: JSON_RECORD_SCHEMA,
}, ['ok', 'spaceId', 'imported'], { additionalProperties: true });
