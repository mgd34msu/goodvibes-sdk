import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  bodyEnvelopeSchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';
import {
  GENERIC_LIST_SCHEMA,
  JSON_RECORD_SCHEMA,
  METADATA_SCHEMA,
  STRING_LIST_SCHEMA,
} from './operator-contract-schemas-shared.js';
import {
  HOME_GRAPH_ASK_OUTPUT_SCHEMA,
  HOME_GRAPH_BROWSE_OUTPUT_SCHEMA,
  HOME_GRAPH_EXPORT_OUTPUT_SCHEMA,
  HOME_GRAPH_IMPORT_OUTPUT_SCHEMA,
  HOME_GRAPH_INGEST_OUTPUT_SCHEMA,
  HOME_GRAPH_ISSUES_OUTPUT_SCHEMA,
  HOME_GRAPH_LINK_OUTPUT_SCHEMA,
  HOME_GRAPH_PROJECTION_OUTPUT_SCHEMA,
  HOME_GRAPH_REVIEW_OUTPUT_SCHEMA,
  HOME_GRAPH_SOURCES_OUTPUT_SCHEMA,
  HOME_GRAPH_SPACE_INPUT_SCHEMA,
  HOME_GRAPH_STATUS_SCHEMA,
  HOME_GRAPH_SYNC_OUTPUT_SCHEMA,
} from './operator-contract-schemas-knowledge.js';

function homeGraphDescriptor(input: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly write?: boolean;
  readonly metadata?: Record<string, unknown>;
}): GatewayMethodDescriptor {
  return methodDescriptor({
    id: input.id,
    title: input.title,
    description: input.description,
    category: 'knowledge',
    scopes: [input.write ? 'write:knowledge' : 'read:knowledge'],
    ...(input.write ? { access: 'admin' as const } : {}),
    http: { method: input.method, path: input.path },
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

const SPACE_QUERY_PROPS = {
  installationId: STRING_SCHEMA,
  knowledgeSpaceId: STRING_SCHEMA,
  limit: NUMBER_SCHEMA,
};
const SPACE_QUERY_SCHEMA = objectSchema(SPACE_QUERY_PROPS, [], { additionalProperties: true });

export const builtinGatewayHomeGraphMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.status',
    title: 'Home Graph Status',
    description: 'Return Home Assistant Home Graph status for an isolated knowledge space.',
    method: 'GET',
    path: '/api/homeassistant/home-graph/status',
    inputSchema: HOME_GRAPH_SPACE_INPUT_SCHEMA,
    outputSchema: HOME_GRAPH_STATUS_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.syncHomeGraph',
    title: 'Sync Home Graph',
    description: 'Ingest a Home Assistant registry snapshot into an isolated Home Graph knowledge space.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/sync',
    write: true,
    inputSchema: bodyEnvelopeSchema({
      installationId: STRING_SCHEMA, knowledgeSpaceId: STRING_SCHEMA, homeId: STRING_SCHEMA, title: STRING_SCHEMA,
      capturedAt: NUMBER_SCHEMA, entities: GENERIC_LIST_SCHEMA, devices: GENERIC_LIST_SCHEMA, areas: GENERIC_LIST_SCHEMA,
      automations: GENERIC_LIST_SCHEMA, scripts: GENERIC_LIST_SCHEMA, scenes: GENERIC_LIST_SCHEMA,
      labels: GENERIC_LIST_SCHEMA, integrations: GENERIC_LIST_SCHEMA, helpers: GENERIC_LIST_SCHEMA, metadata: METADATA_SCHEMA,
    }),
    outputSchema: HOME_GRAPH_SYNC_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.ingestHomeGraphUrl',
    title: 'Ingest Home Graph URL',
    description: 'Fetch and index a URL as a Home Graph source without writing to the default knowledge space.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/ingest/url',
    write: true,
    inputSchema: bodyEnvelopeSchema({
      installationId: STRING_SCHEMA, knowledgeSpaceId: STRING_SCHEMA, url: STRING_SCHEMA, title: STRING_SCHEMA,
      tags: STRING_LIST_SCHEMA, target: JSON_RECORD_SCHEMA, allowPrivateHosts: BOOLEAN_SCHEMA, metadata: METADATA_SCHEMA,
    }, ['url']),
    outputSchema: HOME_GRAPH_INGEST_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.ingestHomeGraphNote',
    title: 'Ingest Home Graph Note',
    description: 'Store a Home Assistant note or remember-this fact as a Home Graph source.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/ingest/note',
    write: true,
    inputSchema: bodyEnvelopeSchema({
      installationId: STRING_SCHEMA, knowledgeSpaceId: STRING_SCHEMA, title: STRING_SCHEMA, body: STRING_SCHEMA,
      category: STRING_SCHEMA, tags: STRING_LIST_SCHEMA, target: JSON_RECORD_SCHEMA, metadata: METADATA_SCHEMA,
    }, ['body']),
    outputSchema: HOME_GRAPH_INGEST_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.ingestHomeGraphArtifact',
    title: 'Ingest Home Graph Artifact',
    description: 'Index an existing artifact reference, JSON path/URI reference, multipart file upload, or raw binary upload as a Home Graph document, receipt, warranty, manual, or photo.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/ingest/artifact',
    write: true,
    inputSchema: bodyEnvelopeSchema({
      installationId: STRING_SCHEMA, knowledgeSpaceId: STRING_SCHEMA, artifactId: STRING_SCHEMA, path: STRING_SCHEMA,
      uri: STRING_SCHEMA, title: STRING_SCHEMA, tags: STRING_LIST_SCHEMA, target: JSON_RECORD_SCHEMA,
      allowPrivateHosts: BOOLEAN_SCHEMA, metadata: METADATA_SCHEMA,
    }),
    outputSchema: HOME_GRAPH_INGEST_OUTPUT_SCHEMA,
    metadata: {
      uploadModes: ['json-artifact-reference', 'json-path-or-uri', 'multipart-file', 'raw-body'],
      largeUploadConfigKey: 'storage.artifacts.maxBytes',
    },
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.linkHomeGraphKnowledge',
    title: 'Link Home Graph Knowledge',
    description: 'Attach a Home Graph source or node to a Home Assistant object.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/link',
    write: true,
    inputSchema: linkBodySchema(),
    outputSchema: HOME_GRAPH_LINK_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.unlinkHomeGraphKnowledge',
    title: 'Unlink Home Graph Knowledge',
    description: 'Remove an active Home Graph source/object link without deleting source history.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/unlink',
    write: true,
    inputSchema: linkBodySchema(),
    outputSchema: HOME_GRAPH_LINK_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.askHomeGraph',
    title: 'Ask Home Graph',
    description: 'Search a Home Graph knowledge space and return a source-backed answer.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/ask',
    inputSchema: bodyEnvelopeSchema({
      installationId: STRING_SCHEMA, knowledgeSpaceId: STRING_SCHEMA, query: STRING_SCHEMA, limit: NUMBER_SCHEMA,
      mode: STRING_SCHEMA, includeSources: BOOLEAN_SCHEMA, includeConfidence: BOOLEAN_SCHEMA, includeLinkedObjects: BOOLEAN_SCHEMA,
    }, ['query']),
    outputSchema: HOME_GRAPH_ASK_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.refreshDevicePassport',
    title: 'Refresh Device Passport',
    description: 'Generate or refresh the living passport page for one Home Assistant device.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/device-passport',
    write: true,
    inputSchema: bodyEnvelopeSchema({ installationId: STRING_SCHEMA, knowledgeSpaceId: STRING_SCHEMA, deviceId: STRING_SCHEMA, metadata: METADATA_SCHEMA }, ['deviceId']),
    outputSchema: HOME_GRAPH_PROJECTION_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.generateRoomPage',
    title: 'Generate Room Page',
    description: 'Render a Home Graph room/area page and materialize it as markdown.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/room-page',
    write: true,
    inputSchema: bodyEnvelopeSchema({ installationId: STRING_SCHEMA, knowledgeSpaceId: STRING_SCHEMA, areaId: STRING_SCHEMA, roomId: STRING_SCHEMA, title: STRING_SCHEMA, metadata: METADATA_SCHEMA }),
    outputSchema: HOME_GRAPH_PROJECTION_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.generateHomeGraphPacket',
    title: 'Generate Home Graph Packet',
    description: 'Render a scoped Home Graph packet with SDK-owned inclusion/exclusion profile rules.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/packet',
    write: true,
    inputSchema: bodyEnvelopeSchema({
      installationId: STRING_SCHEMA, knowledgeSpaceId: STRING_SCHEMA, packetKind: STRING_SCHEMA, title: STRING_SCHEMA,
      sharingProfile: STRING_SCHEMA, includeFields: STRING_LIST_SCHEMA, excludeFields: STRING_LIST_SCHEMA, metadata: METADATA_SCHEMA,
    }),
    outputSchema: HOME_GRAPH_PROJECTION_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.listHomeGraphIssues',
    title: 'List Home Graph Issues',
    description: 'Return Home Graph data quality, review, and maintenance issues.',
    method: 'GET',
    path: '/api/homeassistant/home-graph/issues',
    inputSchema: objectSchema({ ...SPACE_QUERY_PROPS, status: STRING_SCHEMA, severity: STRING_SCHEMA, code: STRING_SCHEMA }),
    outputSchema: HOME_GRAPH_ISSUES_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.reviewHomeGraphFact',
    title: 'Review Home Graph Fact',
    description: 'Accept, reject, resolve, edit, or forget a Home Graph issue, source, or node.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/facts/review',
    write: true,
    inputSchema: bodyEnvelopeSchema({
      installationId: STRING_SCHEMA, knowledgeSpaceId: STRING_SCHEMA, issueId: STRING_SCHEMA, nodeId: STRING_SCHEMA,
      sourceId: STRING_SCHEMA, action: STRING_SCHEMA, value: JSON_RECORD_SCHEMA, reviewer: STRING_SCHEMA,
    }, ['action']),
    outputSchema: HOME_GRAPH_REVIEW_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.sources.list',
    title: 'List Home Graph Sources',
    description: 'Return source inventory for a Home Graph space.',
    method: 'GET',
    path: '/api/homeassistant/home-graph/sources',
    inputSchema: SPACE_QUERY_SCHEMA,
    outputSchema: HOME_GRAPH_SOURCES_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.browse',
    title: 'Browse Home Graph',
    description: 'Return namespace-filtered Home Graph sources, nodes, edges, and issues.',
    method: 'GET',
    path: '/api/homeassistant/home-graph/browse',
    inputSchema: SPACE_QUERY_SCHEMA,
    outputSchema: HOME_GRAPH_BROWSE_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.export',
    title: 'Export Home Graph Space',
    description: 'Export a complete Home Graph knowledge space.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/export',
    inputSchema: HOME_GRAPH_SPACE_INPUT_SCHEMA,
    outputSchema: HOME_GRAPH_EXPORT_OUTPUT_SCHEMA,
  }),
  homeGraphDescriptor({
    id: 'homeassistant.homeGraph.import',
    title: 'Import Home Graph Space',
    description: 'Restore a Home Graph knowledge space export into the current daemon knowledge store.',
    method: 'POST',
    path: '/api/homeassistant/home-graph/import',
    write: true,
    inputSchema: bodyEnvelopeSchema({ installationId: STRING_SCHEMA, knowledgeSpaceId: STRING_SCHEMA, data: JSON_RECORD_SCHEMA }, ['data']),
    outputSchema: HOME_GRAPH_IMPORT_OUTPUT_SCHEMA,
  }),
];

function linkBodySchema(): Record<string, unknown> {
  return bodyEnvelopeSchema({
    installationId: STRING_SCHEMA,
    knowledgeSpaceId: STRING_SCHEMA,
    sourceId: STRING_SCHEMA,
    nodeId: STRING_SCHEMA,
    target: JSON_RECORD_SCHEMA,
    relation: STRING_SCHEMA,
    metadata: METADATA_SCHEMA,
  }, ['target']);
}
