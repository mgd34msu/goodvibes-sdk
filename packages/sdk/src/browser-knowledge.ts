import type {
  OperatorMethodInput,
  OperatorMethodOutput,
  OperatorTypedMethodId,
} from '@pellux/goodvibes-contracts/generated/foundation-client-types';
import {
  createScopedBrowserSdk,
  forScopedBrowserSession,
  SHARED_BROWSER_ROUTES,
  type BrowserScopedRouteDefinition,
  type ScopedBrowserSdk,
  type ScopedBrowserSdkOptions,
  type SharedBrowserMethodId,
} from './browser-scoped.js';

const KNOWLEDGE_BROWSER_ROUTES = {
  'knowledge.ask': { method: 'POST', path: '/api/knowledge/ask' },
  'knowledge.candidate.decide': { method: 'POST', path: '/api/knowledge/candidates/{id}/decide' },
  'knowledge.candidate.get': { method: 'GET', path: '/api/knowledge/candidates/{id}' },
  'knowledge.candidates.list': { method: 'GET', path: '/api/knowledge/candidates' },
  'knowledge.connector.doctor': { method: 'GET', path: '/api/knowledge/connectors/{id}/doctor' },
  'knowledge.connector.get': { method: 'GET', path: '/api/knowledge/connectors/{id}' },
  'knowledge.connectors.list': { method: 'GET', path: '/api/knowledge/connectors' },
  'knowledge.extraction.get': { method: 'GET', path: '/api/knowledge/extractions/{id}' },
  'knowledge.extractions.list': { method: 'GET', path: '/api/knowledge/extractions' },
  'knowledge.graphql.execute': { method: 'POST', path: '/api/knowledge/graphql' },
  'knowledge.graphql.schema': { method: 'GET', path: '/api/knowledge/graphql/schema' },
  'knowledge.ingest.artifact': { method: 'POST', path: '/api/knowledge/ingest/artifact' },
  'knowledge.ingest.bookmarks': { method: 'POST', path: '/api/knowledge/ingest/bookmarks' },
  'knowledge.ingest.browserHistory': { method: 'POST', path: '/api/knowledge/ingest/browser-history' },
  'knowledge.ingest.connector': { method: 'POST', path: '/api/knowledge/ingest/connector' },
  'knowledge.ingest.url': { method: 'POST', path: '/api/knowledge/ingest/url' },
  'knowledge.ingest.urls': { method: 'POST', path: '/api/knowledge/ingest/urls' },
  'knowledge.issue.review': { method: 'POST', path: '/api/knowledge/issues/{id}/review' },
  'knowledge.issues.list': { method: 'GET', path: '/api/knowledge/issues' },
  'knowledge.item.get': { method: 'GET', path: '/api/knowledge/items/{id}' },
  'knowledge.job-runs.list': { method: 'GET', path: '/api/knowledge/job-runs' },
  'knowledge.job.get': { method: 'GET', path: '/api/knowledge/jobs/{jobId}' },
  'knowledge.job.run': { method: 'POST', path: '/api/knowledge/jobs/{jobId}/run' },
  'knowledge.jobs.list': { method: 'GET', path: '/api/knowledge/jobs' },
  'knowledge.lint': { method: 'POST', path: '/api/knowledge/lint' },
  'knowledge.map': { method: 'GET', path: '/api/knowledge/map' },
  'knowledge.nodes.list': { method: 'GET', path: '/api/knowledge/nodes' },
  'knowledge.packet': { method: 'POST', path: '/api/knowledge/packet' },
  'knowledge.projection.materialize': { method: 'POST', path: '/api/knowledge/projections/materialize' },
  'knowledge.projection.render': { method: 'POST', path: '/api/knowledge/projections/render' },
  'knowledge.projections.list': { method: 'GET', path: '/api/knowledge/projections' },
  'knowledge.refinement.run': { method: 'POST', path: '/api/knowledge/refinement/run' },
  'knowledge.refinement.task.cancel': { method: 'POST', path: '/api/knowledge/refinement/tasks/{id}/cancel' },
  'knowledge.refinement.task.get': { method: 'GET', path: '/api/knowledge/refinement/tasks/{id}' },
  'knowledge.refinement.tasks.list': { method: 'GET', path: '/api/knowledge/refinement/tasks' },
  'knowledge.reindex': { method: 'POST', path: '/api/knowledge/reindex' },
  'knowledge.report.get': { method: 'GET', path: '/api/knowledge/reports/{id}' },
  'knowledge.reports.list': { method: 'GET', path: '/api/knowledge/reports' },
  'knowledge.schedule.delete': { method: 'DELETE', path: '/api/knowledge/schedules/{id}' },
  'knowledge.schedule.enable': { method: 'POST', path: '/api/knowledge/schedules/{id}/enabled' },
  'knowledge.schedule.get': { method: 'GET', path: '/api/knowledge/schedules/{id}' },
  'knowledge.schedule.save': { method: 'POST', path: '/api/knowledge/schedules' },
  'knowledge.schedules.list': { method: 'GET', path: '/api/knowledge/schedules' },
  'knowledge.search': { method: 'POST', path: '/api/knowledge/search' },
  'knowledge.source.extraction.get': { method: 'GET', path: '/api/knowledge/sources/{id}/extraction' },
  'knowledge.sources.list': { method: 'GET', path: '/api/knowledge/sources' },
  'knowledge.status': { method: 'GET', path: '/api/knowledge/status' },
  'knowledge.usage.list': { method: 'GET', path: '/api/knowledge/usage' },
} as const satisfies Partial<Record<OperatorTypedMethodId, BrowserScopedRouteDefinition>>;

const KNOWLEDGE_BROWSER_DOMAINS = [
  'session',
  'turn',
  'tasks',
  'providers',
  'knowledge',
  'control-plane',
] as const;

export type BrowserKnowledgeMethodId =
  | SharedBrowserMethodId
  | Extract<keyof typeof KNOWLEDGE_BROWSER_ROUTES, OperatorTypedMethodId>;

export type BrowserKnowledgeDomain = typeof KNOWLEDGE_BROWSER_DOMAINS[number];

export interface BrowserKnowledgeSdk extends ScopedBrowserSdk<BrowserKnowledgeMethodId, BrowserKnowledgeDomain> {
  readonly knowledge: {
    ask(input: OperatorMethodInput<'knowledge.ask'>): Promise<OperatorMethodOutput<'knowledge.ask'>>;
    search(input: OperatorMethodInput<'knowledge.search'>): Promise<OperatorMethodOutput<'knowledge.search'>>;
    status(): Promise<OperatorMethodOutput<'knowledge.status'>>;
    map(input?: OperatorMethodInput<'knowledge.map'>): Promise<OperatorMethodOutput<'knowledge.map'>>;
  };
}

export function createBrowserKnowledgeSdk(options: ScopedBrowserSdkOptions = {}): BrowserKnowledgeSdk {
  const sdk = createScopedBrowserSdk<BrowserKnowledgeMethodId, BrowserKnowledgeDomain>(
    {
      ...SHARED_BROWSER_ROUTES,
      ...KNOWLEDGE_BROWSER_ROUTES,
    } as Record<BrowserKnowledgeMethodId, BrowserScopedRouteDefinition>,
    KNOWLEDGE_BROWSER_DOMAINS,
    options,
  );
  return {
    ...sdk,
    knowledge: {
      ask: (input) => sdk.operator.invoke('knowledge.ask', input),
      search: (input) => sdk.operator.invoke('knowledge.search', input),
      status: () => sdk.operator.invoke('knowledge.status', {}),
      map: (input = {}) => sdk.operator.invoke('knowledge.map', input),
    },
  };
}

export { forScopedBrowserSession as forSession };
