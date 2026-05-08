import type { ArtifactStore } from '../artifacts/index.js';
import {
  generatedKnowledgeCanonicalUri,
  generatedKnowledgeSourceId,
  isGeneratedKnowledgeSource,
  materializeGeneratedKnowledgeProjection,
} from './generated-projections.js';
import {
  isInKnowledgeSpaceScope,
  resolveKnowledgeSpaceScope,
  type KnowledgeSpaceScopeInput,
} from './spaces.js';
import {
  type KnowledgeScopeLookup,
  knowledgeIssueMatchesScope,
  knowledgeNodeMatchesScope,
} from './scope-records.js';
import {
  buildBulletList,
  dedupe,
  formatDateTime,
  joinSections,
  materializedTargetReference,
  quote,
  slugify,
  sortByTitle,
} from './projection-utils.js';
import type { KnowledgeStore } from './store.js';
import type {
  KnowledgeConnector,
  KnowledgeIssueRecord,
  KnowledgeMaterializedProjection,
  KnowledgeNodeRecord,
  KnowledgeProjectionBundle,
  KnowledgeProjectionPage,
  KnowledgeProjectionTarget,
  KnowledgeProjectionTargetKind,
  KnowledgeSourceRecord,
} from './types.js';

export interface KnowledgeProjectionServiceOptions {
  readonly connectors?: (() => readonly KnowledgeConnector[]) | undefined;
}

export class KnowledgeProjectionService {
  private readonly getConnectors: () => readonly KnowledgeConnector[];

  constructor(
    private readonly store: KnowledgeStore,
    private readonly artifactStore: ArtifactStore,
    options: KnowledgeProjectionServiceOptions = {},
  ) {
    this.getConnectors = options.connectors ?? (() => []);
  }

  async listTargets(limit = 25, scope: KnowledgeSpaceScopeInput = {}): Promise<KnowledgeProjectionTarget[]> {
    await this.store.init();
    const max = Math.max(1, limit);
    const targets: KnowledgeProjectionTarget[] = [this.createPresetTarget('overview', scope), this.createPresetTarget('bundle', scope)];
    const remaining = Math.max(1, max - targets.length);
    const perKind = Math.max(1, Math.ceil(remaining / 4));
    const sources = this.scopedSources(scope, perKind).map((source) => this.createSourceTarget(source));
    const nodes = this.scopedNodes(scope, perKind).map((node) => this.createNodeTarget(node));
    const issues = this.scopedIssues(scope, perKind).map((issue) => this.createIssueTarget(issue));
    const rollups = this.scopedNodes(scope)
      .filter((node) => node.kind === 'domain' || node.kind === 'topic' || node.kind === 'bookmark_folder')
      .slice(0, Math.max(2, perKind))
      .map((node) => this.createRollupTarget(node));
    const dashboards = [this.createDashboardTarget('source-health'), this.createDashboardTarget('backlinks')];
    return [...targets, ...sources, ...nodes, ...issues, ...dashboards, ...rollups].slice(0, max);
  }

  async render(
    input: {
      readonly kind: KnowledgeProjectionTargetKind;
      readonly id?: string | undefined;
      readonly limit?: number | undefined;
      readonly knowledgeSpaceId?: string | undefined;
      readonly includeAllSpaces?: boolean | undefined;
    },
  ): Promise<KnowledgeProjectionBundle> {
    await this.store.init();
    const limit = Math.max(1, input.limit ?? 12);
    const scope = projectionScope(input);
    const target = this.resolveTarget(input.kind, input.id, scope);
    if (!target) {
      throw new Error(`Unknown knowledge projection target: ${input.kind}${input.id ? `/${input.id}` : ''}`);
    }

    switch (target.kind) {
      case 'overview':
        return this.bundleFromPages(target, [this.renderOverviewPage(target, limit, scope)], { preset: 'overview' }, scope);
      case 'bundle':
        return this.renderBundleTarget(target, limit, scope);
      case 'source':
        return this.bundleFromPages(target, [this.renderSourcePage(target.itemId!, scope)], {}, scope);
      case 'node':
        return this.bundleFromPages(target, [this.renderNodePage(target.itemId!, scope)], {}, scope);
      case 'issue':
        return this.bundleFromPages(target, [this.renderIssuePage(target.itemId!, scope)], {}, scope);
      case 'dashboard':
        return this.bundleFromPages(target, [this.renderDashboardPage(target, limit, scope)], { preset: 'dashboard' }, scope);
      case 'rollup':
        return this.bundleFromPages(target, [this.renderRollupPage(target.itemId!, target, scope)], { preset: 'rollup' }, scope);
      default:
        return this.bundleFromPages(target, [this.renderOverviewPage(this.createPresetTarget('overview', scope), limit, scope)], {}, scope);
    }
  }

  async materialize(
    input: {
      readonly kind: KnowledgeProjectionTargetKind;
      readonly id?: string | undefined;
      readonly limit?: number | undefined;
      readonly filename?: string | undefined;
      readonly knowledgeSpaceId?: string | undefined;
      readonly includeAllSpaces?: boolean | undefined;
    },
  ): Promise<KnowledgeMaterializedProjection> {
    const bundle = await this.render(input);
    const content = this.combineBundleMarkdown(bundle);
    const projectionKind = `knowledge-${bundle.target.kind}`;
    const sourceId = generatedKnowledgeSourceId(projectionKind, bundle.target.targetId);
    const canonicalUri = generatedKnowledgeCanonicalUri(projectionKind, bundle.target.targetId);
    const target = materializedTargetReference(bundle.target);
    const metadata = {
      projectionId: bundle.id,
      targetId: bundle.target.targetId,
      targetKind: bundle.target.kind,
      pageCount: bundle.pageCount,
      pagePaths: bundle.pages.map((page) => page.path),
      itemIds: dedupe(bundle.pages.flatMap((page) => page.itemIds), (id) => id),
    };
    const generated = await materializeGeneratedKnowledgeProjection({
      store: this.store,
      artifactStore: this.artifactStore,
      connectorId: 'knowledge-projection',
      sourceId,
      canonicalUri,
      title: bundle.target.title,
      summary: `Generated markdown projection for ${bundle.target.title}.`,
      tags: ['knowledge', 'generated-page', 'projection', bundle.target.kind],
      filename: input.filename?.trim() || bundle.target.defaultFilename,
      markdown: content,
      projectionKind,
      metadata,
      sourceMetadata: metadata,
      artifactMetadata: metadata,
      ...(target ? { target } : {}),
    });
    return {
      bundle,
      artifact: generated.artifact,
      source: generated.source,
      ...(generated.linked ? { linked: generated.linked } : {}),
      artifactCreated: generated.artifactCreated,
    };
  }

  private resolveTarget(kind: KnowledgeProjectionTargetKind, id: string | undefined, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionTarget | null {
    if (kind === 'overview' || kind === 'bundle') return this.createPresetTarget(kind, scope);
    if (kind === 'dashboard') return this.createDashboardTarget(id ?? 'source-health');
    if (kind === 'rollup') {
      if (!id?.trim()) return null;
      const node = this.store.getNode(id);
      return node && this.nodeInScope(node, scope) ? this.createRollupTarget(node) : null;
    }
    if (!id?.trim()) return null;
    if (kind === 'source') {
      const source = this.store.getSource(id);
      return source && isInKnowledgeSpaceScope(source, scope) ? this.createSourceTarget(source) : null;
    }
    if (kind === 'node') {
      const node = this.store.getNode(id);
      return node && this.nodeInScope(node, scope) ? this.createNodeTarget(node) : null;
    }
    const issue = this.store.getIssue(id);
    return issue && this.issueInScope(issue, scope) ? this.createIssueTarget(issue) : null;
  }

  private createPresetTarget(kind: 'overview' | 'bundle', scope: KnowledgeSpaceScopeInput): KnowledgeProjectionTarget {
    const spaceId = resolveKnowledgeSpaceScope(scope);
    const metadata = spaceId === null ? { includeAllSpaces: true } : { knowledgeSpaceId: spaceId };
    if (kind === 'overview') {
      return {
        targetId: 'overview',
        kind,
        title: 'Knowledge Overview',
        description: 'A compact markdown projection of the current structured knowledge store.',
        defaultPath: 'wiki/index.md',
        defaultFilename: 'knowledge-overview.md',
        metadata,
      };
    }
    return {
      targetId: 'bundle',
      kind,
      title: 'Knowledge Bundle',
      description: 'A multi-page markdown bundle containing indexes, dashboards, and recent records.',
      defaultPath: 'wiki/bundle/index.md',
      defaultFilename: 'knowledge-bundle.md',
      metadata,
    };
  }

  private createDashboardTarget(id: string): KnowledgeProjectionTarget {
    if (id === 'backlinks') {
      return {
        targetId: 'dashboard:backlinks',
        kind: 'dashboard',
        title: 'Backlinks Dashboard',
        description: 'Derived backlink and cross-reference projection across sources and nodes.',
        itemId: 'backlinks',
        defaultPath: 'wiki/dashboards/backlinks.md',
        defaultFilename: 'knowledge-backlinks.md',
        metadata: { dashboard: 'backlinks' },
      };
    }
    return {
      targetId: 'dashboard:source-health',
      kind: 'dashboard',
      title: 'Source Health Dashboard',
      description: 'Derived staleness, issue, and extraction-health projection.',
      itemId: 'source-health',
      defaultPath: 'wiki/dashboards/source-health.md',
      defaultFilename: 'knowledge-source-health.md',
      metadata: { dashboard: 'source-health' },
    };
  }

  private createRollupTarget(node: KnowledgeNodeRecord): KnowledgeProjectionTarget {
    return {
      targetId: `rollup:${node.id}`,
      kind: 'rollup',
      title: `${node.title} Rollup`,
      description: `Rollup projection for ${node.kind} ${node.title}.`,
      itemId: node.id,
      defaultPath: `wiki/rollups/${node.kind}-${node.slug}.md`,
      defaultFilename: `${node.kind}-${node.slug}-rollup.md`,
      metadata: {
        kind: node.kind,
      },
    };
  }

  private createSourceTarget(source: KnowledgeSourceRecord): KnowledgeProjectionTarget {
    const title = source.title ?? source.canonicalUri ?? source.sourceUri ?? source.id;
    return {
      targetId: `source:${source.id}`,
      kind: 'source',
      title,
      description: 'Markdown projection for a structured knowledge source.',
      itemId: source.id,
      defaultPath: `wiki/sources/${source.id}.md`,
      defaultFilename: `${slugify(title)}.md`,
      metadata: {
        sourceType: source.sourceType,
        status: source.status,
      },
    };
  }

  private createNodeTarget(node: KnowledgeNodeRecord): KnowledgeProjectionTarget {
    return {
      targetId: `node:${node.id}`,
      kind: 'node',
      title: node.title,
      description: 'Markdown projection for a structured knowledge node.',
      itemId: node.id,
      defaultPath: `wiki/nodes/${node.kind}-${node.slug}.md`,
      defaultFilename: `${node.kind}-${node.slug}.md`,
      metadata: {
        kind: node.kind,
        status: node.status,
      },
    };
  }

  private createIssueTarget(issue: KnowledgeIssueRecord): KnowledgeProjectionTarget {
    return {
      targetId: `issue:${issue.id}`,
      kind: 'issue',
      title: issue.message,
      description: 'Markdown projection for a structured knowledge lint or health issue.',
      itemId: issue.id,
      defaultPath: `wiki/issues/${issue.id}.md`,
      defaultFilename: `${issue.id}.md`,
      metadata: {
        severity: issue.severity,
        code: issue.code,
      },
    };
  }

  private renderOverviewPage(target: KnowledgeProjectionTarget, limit: number, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionPage {
    const sources = this.scopedSources(scope, limit);
    const nodes = this.scopedNodes(scope, limit);
    const issues = this.scopedIssues(scope, limit);
    const allSources = this.scopedSources(scope);
    const allNodes = this.scopedNodes(scope);
    const allIssues = this.scopedIssues(scope);
    const edgeCount = this.store.listEdges().filter((edge) => this.edgeInScope(edge, scope)).length;
    const extractionCount = this.scopedExtractions(scope).length;
    const connectors = this.getConnectors();
    const runs = this.store.listJobRuns(5);
    const content = joinSections(
      `# ${target.title}`,
      'Structured knowledge is canonical in SQL. This markdown page is a derived projection for clients, exports, and future wiki-style surfaces.',
      [
        '## Counts',
        `- sources: ${allSources.length}`,
        `- nodes: ${allNodes.length}`,
        `- edges: ${edgeCount}`,
        `- issues: ${allIssues.length}`,
        `- extractions: ${extractionCount}`,
        `- job runs: ${this.store.listJobRuns(Number.MAX_SAFE_INTEGER).length}`,
      ].join('\n'),
      [
        '## Connectors',
        buildBulletList(connectors.map((connector) => `\`${connector.id}\` - ${connector.description}`)),
      ].join('\n'),
      [
        '## Recent Job Runs',
        buildBulletList(runs.map((run) => `\`${run.jobId}\` - ${run.status} (${formatDateTime(run.completedAt ?? run.startedAt ?? run.requestedAt) ?? 'n/a'})`)),
      ].join('\n'),
      [
        '## Recent Sources',
        buildBulletList(sources.map((source) => this.linkToTarget(this.createSourceTarget(source), `${source.title ?? source.canonicalUri ?? source.id} (${source.sourceType})`))),
      ].join('\n'),
      [
        '## Recent Nodes',
        buildBulletList(nodes.map((node) => this.linkToTarget(this.createNodeTarget(node), `${node.title} (${node.kind})`))),
      ].join('\n'),
      [
        '## Open Issues',
        buildBulletList(issues.map((issue) => this.linkToTarget(this.createIssueTarget(issue), `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`))),
      ].join('\n'),
    );
    return {
      path: target.defaultPath,
      title: target.title,
      format: 'markdown',
      content,
      itemIds: [],
      metadata: {
        generatedFrom: 'knowledge-overview',
      },
    };
  }

  private renderSourceIndexPage(limit: number, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionPage {
    const sources = sortByTitle(this.scopedSources(scope).slice(0, limit));
    const lines = [
      '# Sources Index',
      '',
      ...sources.map((source) => {
        const extraction = this.store.getExtractionBySourceId(source.id);
        const health = source.status === 'indexed' ? 'healthy' : source.status;
        return `- ${this.linkToTarget(this.createSourceTarget(source!), source.title ?? source.canonicalUri ?? source.id)} | ${source.sourceType} | ${health}${extraction ? ` | ${extraction.format}` : ''}`;
      }),
    ];
    return {
      path: 'wiki/indexes/sources.md',
      title: 'Sources Index',
      format: 'markdown',
      content: lines.join('\n'),
      itemIds: sources.map((source) => source.id),
      metadata: {
        kind: 'sources-index',
      },
    };
  }

  private renderNodeIndexPage(limit: number, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionPage {
    const nodes = sortByTitle(this.scopedNodes(scope).slice(0, limit));
    const grouped = new Map<string, KnowledgeNodeRecord[]>();
    for (const node of nodes) {
      const bucket = grouped.get(node.kind) ?? [];
      bucket.push(node);
      grouped.set(node.kind, bucket);
    }
    const sections = [...grouped.entries()].map(([kind, entries]) => [
      `## ${kind}`,
      buildBulletList(entries.map((entry) => this.linkToTarget(this.createNodeTarget(entry), `${entry.title} (${entry.status})`))),
    ].join('\n'));
    return {
      path: 'wiki/indexes/nodes.md',
      title: 'Nodes Index',
      format: 'markdown',
      content: ['# Nodes Index', ...sections].join('\n\n'),
      itemIds: nodes.map((node) => node.id),
      metadata: {
        kind: 'nodes-index',
      },
    };
  }

  private renderIssueDashboardPage(limit: number, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionPage {
    const issues = this.scopedIssues(scope, limit);
    const severityGroups = ['error', 'warning', 'info'].map((severity) => [
      `## ${severity.toUpperCase()}`,
      buildBulletList(issues
        .filter((issue) => issue.severity === severity)
        .map((issue) => this.linkToTarget(this.createIssueTarget(issue), `${issue.code}: ${issue.message}`))),
    ].join('\n'));
    return {
      path: 'wiki/dashboards/issues.md',
      title: 'Issues Dashboard',
      format: 'markdown',
      content: ['# Issues Dashboard', ...severityGroups].join('\n\n'),
      itemIds: issues.map((issue) => issue.id),
      metadata: {
        kind: 'issues-dashboard',
      },
    };
  }

  private renderBacklinksPage(limit: number, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionPage {
    const items = this.scopedSources(scope, limit).map((source) => {
      const incoming = this.store.listEdges()
        .filter((edge) => edge.toKind === 'source' && edge.toId === source.id)
        .filter((edge) => this.edgeInScope(edge, scope));
      return { source, incoming };
    }).filter((entry) => entry.incoming.length > 0);
    const content = [
      '# Backlinks Dashboard',
      '',
      ...items.map((entry) => [
        `## ${entry.source.title ?? entry.source.canonicalUri ?? entry.source.id}`,
        buildBulletList(entry.incoming.map((edge) => {
          if (edge.fromKind === 'source') {
            const linked = this.store.getSource(edge.fromId);
            return linked && isInKnowledgeSpaceScope(linked, scope) ? `${this.linkToTarget(this.createSourceTarget(linked))} via \`${edge.relation}\`` : `source:${edge.fromId}`;
          }
          if (edge.fromKind === 'node') {
            const node = this.store.getNode(edge.fromId);
            return node && this.nodeInScope(node, scope) ? `${this.linkToTarget(this.createNodeTarget(node))} via \`${edge.relation}\`` : `node:${edge.fromId}`;
          }
          return `${edge.fromKind}:${edge.fromId} via \`${edge.relation}\``;
        })),
      ].join('\n')),
    ].join('\n\n');
    return {
      path: 'wiki/dashboards/backlinks.md',
      title: 'Backlinks Dashboard',
      format: 'markdown',
      content,
      itemIds: items.map((entry) => entry.source.id),
      metadata: {
        kind: 'backlinks-dashboard',
      },
    };
  }

  private renderHealthDashboardPage(limit: number, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionPage {
    const sources = this.scopedSources(scope, limit);
    const staleThreshold = Date.now() - (14 * 24 * 60 * 60 * 1000);
    const unhealthy = sources.filter((source) => (
      source.status !== 'indexed'
      || Boolean(source.crawlError)
      || (typeof source.lastCrawledAt === 'number' && source.lastCrawledAt < staleThreshold)
      || !this.store.getExtractionBySourceId(source.id)
    ));
    const content = [
      '# Source Health Dashboard',
      '',
      '## Sources Requiring Attention',
      buildBulletList(unhealthy.map((source) => {
        const extraction = this.store.getExtractionBySourceId(source.id);
        const notes = [
          `status=${source.status}`,
          !extraction ? 'missing extraction' : undefined,
          source.crawlError ? `error=${source.crawlError}` : undefined,
          source.lastCrawledAt && source.lastCrawledAt < staleThreshold ? 'stale' : undefined,
        ].filter(Boolean).join(', ');
        return `${this.linkToTarget(this.createSourceTarget(source))} | ${notes}`;
      })),
    ].join('\n');
    return {
      path: 'wiki/dashboards/source-health.md',
      title: 'Source Health Dashboard',
      format: 'markdown',
      content,
      itemIds: unhealthy.map((source) => source.id),
      metadata: {
        kind: 'source-health-dashboard',
      },
    };
  }

  private renderSourcePage(id: string, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionPage {
    const source = this.store.getSource(id);
    if (!source || !isInKnowledgeSpaceScope(source, scope)) throw new Error(`Unknown knowledge source: ${id}`);
    const extraction = this.store.getExtractionBySourceId(id);
    const view = this.store.getItem(id);
    const target = this.createSourceTarget(source);
    const relatedNodes = view?.linkedNodes ?? [];
    const relatedSources = view?.linkedSources.filter((entry) => (
      entry.id !== source.id && !isGeneratedKnowledgeSource(entry)
    )) ?? [];
    const issues = this.scopedIssues(scope).filter((issue) => issue.sourceId === source.id);
    const incoming = this.store.listEdges().filter((edge) => (
      edge.toKind === 'source'
      && edge.toId === source.id
      && !this.isGeneratedSourceReference(edge.fromKind, edge.fromId)
      && this.edgeInScope(edge, scope)
    ));
    const content = joinSections(
      `# ${target.title}`,
      extraction?.summary ?? source.summary,
      [
        '## Metadata',
        `- id: \`${source.id}\``,
        `- connector: \`${source.connectorId}\``,
        `- source type: \`${source.sourceType}\``,
        `- status: \`${source.status}\``,
        ...(source.sourceUri ? [`- source uri: ${source.sourceUri}`] : []),
        ...(source.canonicalUri ? [`- canonical uri: ${source.canonicalUri}`] : []),
        ...(source.folderPath ? [`- folder path: ${source.folderPath}`] : []),
        ...(formatDateTime(source.lastCrawledAt) ? [`- last crawled: ${formatDateTime(source.lastCrawledAt)}`] : []),
        ...(source.artifactId ? [`- artifact: \`${source.artifactId}\``] : []),
        ...(source.tags.length > 0 ? [`- tags: ${source.tags.join(', ')}`] : []),
      ].join('\n'),
      quote(source.description),
      extraction ? [
        '## Extraction',
        `- format: \`${extraction.format}\``,
        `- estimated tokens: ${extraction.estimatedTokens}`,
        ...(extraction.sections.length > 0 ? [`- sections: ${extraction.sections.join(', ')}`] : []),
        ...(extraction.links.length > 0 ? [`- links: ${extraction.links.join(', ')}`] : []),
      ].join('\n') : null,
      extraction?.excerpt ? ['## Excerpt', extraction.excerpt].join('\n') : null,
      [
        '## Related Nodes',
        buildBulletList(relatedNodes.filter((node) => this.nodeInScope(node, scope)).map((node) => this.linkToTarget(this.createNodeTarget(node), `${node.title} (${node.kind})`))),
      ].join('\n'),
      [
        '## Related Sources',
        buildBulletList(relatedSources.filter((entry) => isInKnowledgeSpaceScope(entry, scope)).map((entry) => this.linkToTarget(this.createSourceTarget(entry)))),
      ].join('\n'),
      [
        '## Backlinks',
        buildBulletList(incoming.map((edge) => `${edge.fromKind}:${edge.fromId} via \`${edge.relation}\``)),
      ].join('\n'),
      [
        '## Issues',
        buildBulletList(issues.map((issue) => this.linkToTarget(this.createIssueTarget(issue), `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`))),
      ].join('\n'),
    );
    return {
      path: target.defaultPath,
      title: target.title,
      format: 'markdown',
      content,
      itemIds: [source.id],
      metadata: {
        sourceId: source.id,
        sourceType: source.sourceType,
        ...(extraction ? { extractionId: extraction.id } : {}),
      },
    };
  }

  private renderNodePage(id: string, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionPage {
    const node = this.store.getNode(id);
    if (!node || !this.nodeInScope(node, scope)) throw new Error(`Unknown knowledge node: ${id}`);
    const view = this.store.getItem(id);
    const target = this.createNodeTarget(node);
    const incoming = this.store.listEdges().filter((edge) => edge.toKind === 'node' && edge.toId === node.id && this.edgeInScope(edge, scope));
    const content = joinSections(
      `# ${target.title}`,
      node.summary,
      [
        '## Metadata',
        `- id: \`${node.id}\``,
        `- kind: \`${node.kind}\``,
        `- slug: \`${node.slug}\``,
        `- status: \`${node.status}\``,
        `- confidence: ${node.confidence}`,
        ...(node.aliases.length > 0 ? [`- aliases: ${node.aliases.join(', ')}`] : []),
        ...(node.sourceId ? [`- source: \`${node.sourceId}\``] : []),
      ].join('\n'),
      [
        '## Linked Sources',
        buildBulletList((view?.linkedSources ?? [])
          .filter((source) => !isGeneratedKnowledgeSource(source))
          .filter((source) => isInKnowledgeSpaceScope(source, scope))
          .map((source) => this.linkToTarget(this.createSourceTarget(source)))),
      ].join('\n'),
      [
        '## Linked Nodes',
        buildBulletList((view?.linkedNodes ?? []).filter((entry) => entry.id !== node.id && isInKnowledgeSpaceScope(entry, scope)).map((entry) => this.linkToTarget(this.createNodeTarget(entry), `${entry.title} (${entry.kind})`))),
      ].join('\n'),
      [
        '## Backlinks',
        buildBulletList(incoming
          .filter((edge) => !this.isGeneratedSourceReference(edge.fromKind, edge.fromId))
          .map((edge) => `${edge.fromKind}:${edge.fromId} via \`${edge.relation}\``)),
      ].join('\n'),
      [
        '## Issues',
        buildBulletList(this.scopedIssues(scope)
          .filter((issue) => issue.nodeId === node.id)
          .map((issue) => this.linkToTarget(this.createIssueTarget(issue), `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`))),
      ].join('\n'),
    );
    return {
      path: target.defaultPath,
      title: target.title,
      format: 'markdown',
      content,
      itemIds: [node.id],
      metadata: {
        nodeId: node.id,
        kind: node.kind,
      },
    };
  }

  private renderIssuePage(id: string, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionPage {
    const issue = this.store.getIssue(id);
    if (!issue || !this.issueInScope(issue, scope)) throw new Error(`Unknown knowledge issue: ${id}`);
    const target = this.createIssueTarget(issue);
    const linkedSource = issue.sourceId ? this.store.getSource(issue.sourceId) : null;
    const linkedNode = issue.nodeId ? this.store.getNode(issue.nodeId) : null;
    const source = linkedSource && isInKnowledgeSpaceScope(linkedSource, scope) ? linkedSource : null;
    const node = linkedNode && isInKnowledgeSpaceScope(linkedNode, scope) ? linkedNode : null;
    const content = joinSections(
      `# ${target.title}`,
      [
        '## Metadata',
        `- id: \`${issue.id}\``,
        `- severity: \`${issue.severity}\``,
        `- code: \`${issue.code}\``,
        `- status: \`${issue.status}\``,
        ...(formatDateTime(issue.createdAt) ? [`- created: ${formatDateTime(issue.createdAt)}`] : []),
        ...(formatDateTime(issue.updatedAt) ? [`- updated: ${formatDateTime(issue.updatedAt)}`] : []),
      ].join('\n'),
      [
        '## Message',
        issue.message,
      ].join('\n'),
      [
        '## Linked Records',
        buildBulletList([
          ...(source ? [this.linkToTarget(this.createSourceTarget(source), `source: ${source.title ?? source.id}`)] : []),
          ...(node ? [this.linkToTarget(this.createNodeTarget(node), `node: ${node.title}`)] : []),
        ]),
      ].join('\n'),
    );
    return {
      path: target.defaultPath,
      title: target.title,
      format: 'markdown',
      content,
      itemIds: [issue.id, ...(source ? [source.id] : []), ...(node ? [node.id] : [])],
      metadata: {
        issueId: issue.id,
        severity: issue.severity,
      },
    };
  }

  private renderDashboardPage(target: KnowledgeProjectionTarget, limit: number, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionPage {
    if (target.itemId === 'backlinks') {
      return this.renderBacklinksPage(limit, scope);
    }
    return this.renderHealthDashboardPage(limit, scope);
  }

  private renderRollupPage(nodeId: string, target: KnowledgeProjectionTarget, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionPage {
    const node = this.store.getNode(nodeId);
    if (!node || !this.nodeInScope(node, scope)) throw new Error(`Unknown rollup node: ${nodeId}`);
    const edges = this.store.edgesFor('node', node.id);
    const sources = edges
      .map((edge) => {
        if (edge.fromKind === 'source') return this.store.getSource(edge.fromId);
        if (edge.toKind === 'source') return this.store.getSource(edge.toId);
        return null;
      })
      .filter((source): source is KnowledgeSourceRecord => Boolean(source) && isInKnowledgeSpaceScope(source, scope));
    const linkedNodes = edges
      .map((edge) => {
        if (edge.fromKind === 'node' && edge.fromId !== node.id) return this.store.getNode(edge.fromId);
        if (edge.toKind === 'node' && edge.toId !== node.id) return this.store.getNode(edge.toId);
        return null;
      })
      .filter((entry): entry is KnowledgeNodeRecord => Boolean(entry) && isInKnowledgeSpaceScope(entry, scope));
    const content = joinSections(
      `# ${target.title}`,
      node.summary,
      [
        '## Included Sources',
        buildBulletList(sortByTitle(dedupe(sources, (source) => source.id)).map((source) => this.linkToTarget(this.createSourceTarget(source!)))),
      ].join('\n'),
      [
        '## Related Nodes',
        buildBulletList(sortByTitle(dedupe(linkedNodes, (entry) => entry.id)).map((entry) => this.linkToTarget(this.createNodeTarget(entry), `${entry.title} (${entry.kind})`))),
      ].join('\n'),
    );
    return {
      path: target.defaultPath,
      title: target.title,
      format: 'markdown',
      content,
      itemIds: [node.id, ...sources.map((source) => source.id)],
      metadata: {
        rollupNodeId: node.id,
        kind: node.kind,
      },
    };
  }

  private renderBundleTarget(target: KnowledgeProjectionTarget, limit: number, scope: KnowledgeSpaceScopeInput): KnowledgeProjectionBundle {
    const overview = this.renderOverviewPage(this.createPresetTarget('overview', scope), limit, scope);
    const sourceIndex = this.renderSourceIndexPage(Math.max(limit * 2, 24), scope);
    const nodeIndex = this.renderNodeIndexPage(Math.max(limit * 2, 24), scope);
    const issueDashboard = this.renderIssueDashboardPage(Math.max(limit * 2, 24), scope);
    const backlinks = this.renderBacklinksPage(Math.max(limit * 2, 16), scope);
    const health = this.renderHealthDashboardPage(Math.max(limit * 2, 16), scope);
    const pages: KnowledgeProjectionPage[] = [overview, sourceIndex, nodeIndex, issueDashboard, backlinks, health];
    const perKind = Math.max(1, Math.ceil(limit / 3));
    for (const node of this.scopedNodes(scope).filter((entry) => entry.kind === 'domain' || entry.kind === 'topic').slice(0, 4)) {
      pages.push(this.renderRollupPage(node.id, this.createRollupTarget(node), scope));
    }
    for (const source of this.scopedSources(scope, perKind)) {
      pages.push(this.renderSourcePage(source.id, scope));
    }
    for (const node of this.scopedNodes(scope, perKind)) {
      pages.push(this.renderNodePage(node.id, scope));
    }
    for (const issue of this.scopedIssues(scope, perKind)) {
      pages.push(this.renderIssuePage(issue.id, scope));
    }
    return this.bundleFromPages(target, pages, {
      preset: 'bundle',
      sourceCount: this.scopedSources(scope).length,
      nodeCount: this.scopedNodes(scope).length,
      issueCount: this.scopedIssues(scope).length,
    }, scope);
  }

  private bundleFromPages(
    target: KnowledgeProjectionTarget,
    pages: readonly KnowledgeProjectionPage[],
    metadata: Record<string, unknown>,
    scope: KnowledgeSpaceScopeInput,
  ): KnowledgeProjectionBundle {
    const spaceId = resolveKnowledgeSpaceScope(scope);
    return {
      id: `projection-${slugify(target.targetId)}`,
      target,
      generatedAt: Date.now(),
      pageCount: pages.length,
      pages,
      metadata: {
        ...metadata,
        ...(spaceId === null ? { includeAllSpaces: true } : { knowledgeSpaceId: spaceId }),
      },
    };
  }

  private linkToTarget(target: KnowledgeProjectionTarget, label?: string): string {
    return `[${label ?? target.title}](${target.defaultPath})`;
  }

  private combineBundleMarkdown(bundle: KnowledgeProjectionBundle): string {
    if (bundle.pages.length === 1) {
      return bundle.pages[0]?.content ?? '';
    }
    const index = [
      `# ${bundle.target.title}`,
      `Generated: ${new Date(bundle.generatedAt).toISOString()}`,
      '',
      '## Pages',
      ...bundle.pages.map((page) => `- [${page.title}](${page.path})`),
    ].join('\n');
    const pages = bundle.pages.map((page) => [
      `## ${page.title}`,
      `Path: \`${page.path}\``,
      '',
      page.content,
    ].join('\n'));
    return [index, ...pages].join('\n\n---\n\n');
  }

  private isGeneratedSourceReference(kind: string, id: string): boolean {
    if (kind !== 'source') return false;
    const source = this.store.getSource(id);
    return source ? isGeneratedKnowledgeSource(source) : false;
  }

  private edgeInScope(edge: { readonly fromKind: string; readonly fromId: string; readonly toKind: string; readonly toId: string }, scope: KnowledgeSpaceScopeInput): boolean {
    return this.recordReferenceInScope(edge.fromKind, edge.fromId, scope)
      && this.recordReferenceInScope(edge.toKind, edge.toId, scope);
  }

  private recordReferenceInScope(kind: string, id: string, scope: KnowledgeSpaceScopeInput): boolean {
    if (kind === 'source') {
      const source = this.store.getSource(id);
      return Boolean(source && isInKnowledgeSpaceScope(source, scope));
    }
    if (kind === 'node') {
      const node = this.store.getNode(id);
      return Boolean(node && this.nodeInScope(node, scope));
    }
    if (kind === 'issue') {
      const issue = this.store.getIssue(id);
      return Boolean(issue && this.issueInScope(issue, scope));
    }
    return true;
  }

  private scopedSources(scope: KnowledgeSpaceScopeInput, limit = Number.MAX_SAFE_INTEGER): KnowledgeSourceRecord[] {
    return this.store.listSources(Number.MAX_SAFE_INTEGER)
      .filter((source) => isInKnowledgeSpaceScope(source, scope))
      .slice(0, Math.max(1, limit));
  }

  private scopedNodes(scope: KnowledgeSpaceScopeInput, limit = Number.MAX_SAFE_INTEGER): KnowledgeNodeRecord[] {
    const scopeLookup = this.getScopeLookup();
    return this.store.listNodes(Number.MAX_SAFE_INTEGER)
      .filter((node) => knowledgeNodeMatchesScope(node, scope, scopeLookup))
      .slice(0, Math.max(1, limit));
  }

  private scopedIssues(scope: KnowledgeSpaceScopeInput, limit = Number.MAX_SAFE_INTEGER): KnowledgeIssueRecord[] {
    const scopeLookup = this.getScopeLookup();
    return this.store.listIssues(Number.MAX_SAFE_INTEGER)
      .filter((issue) => knowledgeIssueMatchesScope(issue, scope, scopeLookup))
      .slice(0, Math.max(1, limit));
  }

  private scopedExtractions(scope: KnowledgeSpaceScopeInput, limit = Number.MAX_SAFE_INTEGER) {
    return this.store.listExtractions(Number.MAX_SAFE_INTEGER)
      .filter((extraction) => isInKnowledgeSpaceScope(extraction, scope))
      .slice(0, Math.max(1, limit));
  }

  private nodeInScope(node: KnowledgeNodeRecord, scope: KnowledgeSpaceScopeInput): boolean {
    return knowledgeNodeMatchesScope(node, scope, this.getScopeLookup());
  }

  private issueInScope(issue: KnowledgeIssueRecord, scope: KnowledgeSpaceScopeInput): boolean {
    return knowledgeIssueMatchesScope(issue, scope, this.getScopeLookup());
  }

  private getScopeLookup(): KnowledgeScopeLookup {
    return {
      getSource: (id) => this.store.getSource(id),
      getNode: (id) => this.store.getNode(id),
      edges: this.store.listEdges(),
    };
  }
}

function projectionScope(input: KnowledgeSpaceScopeInput = {}): KnowledgeSpaceScopeInput {
  return {
    ...(input.knowledgeSpaceId ? { knowledgeSpaceId: input.knowledgeSpaceId } : {}),
    ...(input.includeAllSpaces === true ? { includeAllSpaces: true } : {}),
  };
}
