import {
  applyKnowledgeMapFilters,
  buildKnowledgeMapFacets,
} from './map-filters.js';
import {
  isGeneratedKnowledgeSource,
} from './generated-projections.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeIssueRecord,
  KnowledgeMapFilterInput,
  KnowledgeMapNode,
  KnowledgeMapResult,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from './types.js';

export interface KnowledgeMapRenderState {
  readonly title?: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly issues?: readonly KnowledgeIssueRecord[];
}

export interface KnowledgeMapRenderOptions {
  readonly limit?: number;
  readonly includeSources?: boolean;
  readonly includeIssues?: boolean;
  readonly includeGenerated?: boolean;
  readonly title?: string;
  readonly spaceId?: string;
  readonly filters?: KnowledgeMapFilterInput;
  readonly query?: string;
  readonly recordKinds?: readonly ('source' | 'node' | 'issue')[];
  readonly ids?: readonly string[];
  readonly linkedToIds?: readonly string[];
  readonly nodeKinds?: readonly string[];
  readonly sourceTypes?: readonly string[];
  readonly sourceStatuses?: readonly string[];
  readonly nodeStatuses?: readonly string[];
  readonly issueCodes?: readonly string[];
  readonly issueStatuses?: readonly string[];
  readonly issueSeverities?: readonly string[];
  readonly edgeRelations?: readonly string[];
  readonly tags?: readonly string[];
  readonly minConfidence?: number;
}

export function renderKnowledgeMap(
  state: KnowledgeMapRenderState,
  options: KnowledgeMapRenderOptions = {},
): KnowledgeMapResult {
  const limit = sanitizeMapLimit(options.limit);
  const filtered = applyKnowledgeMapFilters({
    sources: state.sources,
    nodes: state.nodes,
    edges: state.edges,
    issues: state.issues ?? [],
  }, options);
  const nodes = [...filtered.nodes]
    .sort(compareRecordTitle)
    .slice(0, limit);
  let remaining = Math.max(0, limit - nodes.length);
  const sources = options.includeSources === false
    ? []
    : [...filtered.sources]
        .sort(compareRecordTitle)
        .slice(0, remaining);
  remaining = Math.max(0, remaining - sources.length);
  const issues = options.includeIssues
    ? [...filtered.issues]
        .sort(compareIssue)
        .slice(0, remaining)
    : [];
  const mapNodes = layoutMapNodes([
    ...nodes.map((node): KnowledgeMapNode => ({
      id: node.id,
      recordKind: 'node',
      kind: node.kind,
      title: node.title,
      ...(node.summary ? { summary: node.summary } : {}),
      x: 0,
      y: 0,
      radius: radiusForNodeKind(node.kind),
      metadata: node.metadata,
    })),
    ...sources.map((source): KnowledgeMapNode => ({
      id: source.id,
      recordKind: 'source',
      kind: sourceKind(source),
      title: source.title ?? source.sourceUri ?? source.id,
      ...(source.summary ? { summary: source.summary } : {}),
      x: 0,
      y: 0,
      radius: 11,
      metadata: source.metadata,
    })),
    ...issues.map((issue): KnowledgeMapNode => ({
      id: issue.id,
      recordKind: 'issue',
      kind: issue.code,
      title: issue.message,
      x: 0,
      y: 0,
      radius: 10,
      metadata: issue.metadata,
    })),
  ]);
  const nodeIds = new Set(mapNodes.map((node) => node.id));
  const visibleEdges = filtered.edges
    .filter((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId))
    .map((edge) => ({
      id: edge.id,
      fromId: edge.fromId,
      toId: edge.toId,
      relation: edge.relation,
      weight: edge.weight,
      metadata: edge.metadata,
    }));
  const width = 1280;
  const height = 920;
  const title = options.title ?? state.title ?? 'Knowledge Map';
  return {
    ok: true,
    ...(options.spaceId ? { spaceId: options.spaceId } : {}),
    title,
    generatedAt: Date.now(),
    width,
    height,
    nodeCount: mapNodes.length,
    edgeCount: visibleEdges.length,
    totalNodeCount: filtered.sources.length + filtered.nodes.length + filtered.issues.length,
    totalEdgeCount: filtered.edges.length,
    facets: buildKnowledgeMapFacets({
      sources: state.sources,
      nodes: state.nodes,
      edges: state.edges,
      issues: state.issues ?? [],
    }),
    nodes: mapNodes,
    edges: visibleEdges,
    svg: renderMapSvg({ width, height, title, nodes: mapNodes, edges: visibleEdges }),
  };
}

function layoutMapNodes(nodes: readonly KnowledgeMapNode[]): readonly KnowledgeMapNode[] {
  const width = 1280;
  const height = 920;
  const centerX = width / 2;
  const centerY = height / 2;
  const groups = new Map<number, KnowledgeMapNode[]>();
  for (const node of nodes) {
    const ring = ringForKind(node.kind, node.recordKind);
    const group = groups.get(ring);
    if (group) {
      group.push(node);
    } else {
      groups.set(ring, [node]);
    }
  }
  const laidOut: KnowledgeMapNode[] = [];
  for (const [ring, group] of [...groups.entries()].sort((left, right) => left[0] - right[0])) {
    const radius = ring === 0 ? 0 : 110 + ring * 90;
    const offset = ring * 0.41;
    group.forEach((node, index) => {
      const angle = group.length === 1
        ? -Math.PI / 2 + offset
        : -Math.PI / 2 + offset + (Math.PI * 2 * index) / group.length;
      laidOut.push({
        ...node,
        x: Math.round(centerX + Math.cos(angle) * radius),
        y: Math.round(centerY + Math.sin(angle) * radius),
      });
    });
  }
  return laidOut;
}

function renderMapSvg(input: {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly nodes: readonly KnowledgeMapNode[];
  readonly edges: readonly { readonly fromId: string; readonly toId: string; readonly relation: string }[];
}): string {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const edgeLines = input.edges.map((edge) => {
    const from = byId.get(edge.fromId);
    const to = byId.get(edge.toId);
    if (!from || !to) return '';
    return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="rgba(57,74,97,0.35)" stroke-width="1.3"><title>${escapeXml(edge.relation)}</title></line>`;
  }).join('\n');
  const nodeShapes = input.nodes.map((node) => {
    const color = colorForKind(node.kind, node.recordKind);
    const label = truncateLabel(node.title, node.recordKind === 'source' ? 28 : 24);
    const shape = node.recordKind === 'source'
      ? `<rect x="${node.x - 58}" y="${node.y - 17}" width="116" height="34" rx="11" fill="${color.fill}" stroke="${color.stroke}" stroke-width="1.4" />`
      : `<circle cx="${node.x}" cy="${node.y}" r="${node.radius}" fill="${color.fill}" stroke="${color.stroke}" stroke-width="1.6" />`;
    const textY = node.recordKind === 'source' ? node.y + 4 : node.y + node.radius + 18;
    return `<g class="node">
  <title>${escapeXml(node.title)} (${escapeXml(node.kind)})</title>
  ${shape}
  <text x="${node.x}" y="${textY}" text-anchor="middle">${escapeXml(label)}</text>
</g>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}" role="img" aria-label="${escapeXml(input.title)}">
<defs>
  <radialGradient id="knowledgeMapBg" cx="50%" cy="46%" r="70%">
    <stop offset="0%" stop-color="#f7f4ec" />
    <stop offset="60%" stop-color="#e9eef0" />
    <stop offset="100%" stop-color="#dde6df" />
  </radialGradient>
  <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#27313a" flood-opacity="0.14"/>
  </filter>
</defs>
<style>
  text { font-family: "Avenir Next", "Trebuchet MS", sans-serif; font-size: 12px; fill: #263238; paint-order: stroke; stroke: rgba(247,244,236,0.76); stroke-width: 3px; stroke-linejoin: round; }
  .node { filter: url(#softShadow); }
</style>
<rect width="100%" height="100%" fill="url(#knowledgeMapBg)" />
<g>${edgeLines}</g>
<g>${nodeShapes}</g>
</svg>`;
}

function sourceKind(source: KnowledgeSourceRecord): string {
  if (isGeneratedKnowledgeSource(source)) {
    const projectionKind = typeof source.metadata.projectionKind === 'string'
      ? source.metadata.projectionKind
      : 'page';
    return `generated_${projectionKind.replace(/[^a-z0-9]+/gi, '_')}`;
  }
  return source.sourceType;
}

function ringForKind(kind: string, recordKind: KnowledgeMapNode['recordKind']): number {
  if (recordKind === 'issue') return 7;
  if (recordKind === 'source') return kind.startsWith('generated_') ? 5 : 6;
  if (kind === 'ha_home') return 0;
  if (kind === 'domain' || kind === 'topic' || kind === 'ha_area' || kind === 'ha_room') return 1;
  if (kind === 'ha_device' || kind === 'ha_device_passport') return 2;
  if (kind === 'ha_entity') return 3;
  return 4;
}

function radiusForNodeKind(kind: string): number {
  if (kind === 'ha_home' || kind === 'domain') return 30;
  if (kind === 'topic' || kind === 'ha_area' || kind === 'ha_room') return 23;
  if (kind === 'ha_device') return 18;
  if (kind === 'ha_entity') return 13;
  return 12;
}

function colorForKind(kind: string, recordKind: KnowledgeMapNode['recordKind']): { readonly fill: string; readonly stroke: string } {
  if (recordKind === 'issue') return { fill: '#f4c7c3', stroke: '#9f3f36' };
  if (recordKind === 'source') {
    if (kind.startsWith('generated_')) return { fill: '#fff1c7', stroke: '#b98920' };
    return { fill: '#dceef5', stroke: '#3f839c' };
  }
  if (kind === 'ha_home' || kind === 'domain') return { fill: '#284b63', stroke: '#102a3a' };
  if (kind === 'topic' || kind === 'ha_area' || kind === 'ha_room') return { fill: '#9ec5ab', stroke: '#49765a' };
  if (kind === 'ha_device') return { fill: '#f2b880', stroke: '#a86028' };
  if (kind === 'ha_entity') return { fill: '#b8c7e0', stroke: '#5d7092' };
  if (kind === 'ha_device_passport') return { fill: '#f6df90', stroke: '#9a7725' };
  return { fill: '#d7d0c2', stroke: '#70695e' };
}

function compareRecordTitle(left: { readonly title?: string; readonly id: string }, right: { readonly title?: string; readonly id: string }): number {
  return (left.title ?? left.id).localeCompare(right.title ?? right.id) || left.id.localeCompare(right.id);
}

function compareIssue(left: KnowledgeIssueRecord, right: KnowledgeIssueRecord): number {
  return left.code.localeCompare(right.code) || left.id.localeCompare(right.id);
}

function sanitizeMapLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 500;
  return Math.max(1, Math.min(1000, Math.trunc(value)));
}

function truncateLabel(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}...`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
