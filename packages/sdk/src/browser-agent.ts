import type { OperatorTypedMethodId } from '@pellux/goodvibes-contracts/generated/foundation-client-types';
import {
  createBrowserKnowledgeSdkFromRoutes,
  forSession,
  type BrowserKnowledgeSdk,
} from './browser-knowledge.js';
import type {
  BrowserScopedRouteDefinition,
  ScopedBrowserSdkOptions,
} from './browser-scoped.js';

const AGENT_KNOWLEDGE_PREFIX = '/api/goodvibes-agent/knowledge';

const AGENT_BROWSER_ROUTES = {
  'knowledge.ask': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/ask` },
  'knowledge.candidate.decide': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/candidates/{id}/decide` },
  'knowledge.candidate.get': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/candidates/{id}` },
  'knowledge.candidates.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/candidates` },
  'knowledge.connector.doctor': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/connectors/{id}/doctor` },
  'knowledge.connector.get': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/connectors/{id}` },
  'knowledge.connectors.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/connectors` },
  'knowledge.extraction.get': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/extractions/{id}` },
  'knowledge.extractions.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/extractions` },
  'knowledge.graphql.execute': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/graphql` },
  'knowledge.graphql.schema': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/graphql/schema` },
  'knowledge.ingest.artifact': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/ingest/artifact` },
  'knowledge.ingest.bookmarks': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/ingest/bookmarks` },
  'knowledge.ingest.browserHistory': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/ingest/browser-history` },
  'knowledge.ingest.connector': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/ingest/connector` },
  'knowledge.ingest.url': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/ingest/url` },
  'knowledge.ingest.urls': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/ingest/urls` },
  'knowledge.issue.review': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/issues/{id}/review` },
  'knowledge.issues.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/issues` },
  'knowledge.item.get': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/items/{id}` },
  'knowledge.job-runs.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/job-runs` },
  'knowledge.job.get': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/jobs/{jobId}` },
  'knowledge.job.run': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/jobs/{jobId}/run` },
  'knowledge.jobs.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/jobs` },
  'knowledge.lint': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/lint` },
  'knowledge.map': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/map` },
  'knowledge.nodes.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/nodes` },
  'knowledge.packet': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/packet` },
  'knowledge.projection.materialize': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/projections/materialize` },
  'knowledge.projection.render': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/projections/render` },
  'knowledge.projections.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/projections` },
  'knowledge.refinement.run': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/refinement/run` },
  'knowledge.refinement.task.cancel': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/refinement/tasks/{id}/cancel` },
  'knowledge.refinement.task.get': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/refinement/tasks/{id}` },
  'knowledge.refinement.tasks.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/refinement/tasks` },
  'knowledge.reindex': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/reindex` },
  'knowledge.report.get': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/reports/{id}` },
  'knowledge.reports.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/reports` },
  'knowledge.schedule.delete': { method: 'DELETE', path: `${AGENT_KNOWLEDGE_PREFIX}/schedules/{id}` },
  'knowledge.schedule.enable': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/schedules/{id}/enabled` },
  'knowledge.schedule.get': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/schedules/{id}` },
  'knowledge.schedule.save': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/schedules` },
  'knowledge.schedules.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/schedules` },
  'knowledge.search': { method: 'POST', path: `${AGENT_KNOWLEDGE_PREFIX}/search` },
  'knowledge.source.extraction.get': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/sources/{id}/extraction` },
  'knowledge.sources.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/sources` },
  'knowledge.status': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/status` },
  'knowledge.usage.list': { method: 'GET', path: `${AGENT_KNOWLEDGE_PREFIX}/usage` },
  'projectPlanning.workPlan.clearCompleted': { method: 'POST', path: '/api/projects/planning/work-plan/clear-completed' },
  'projectPlanning.workPlan.snapshot': { method: 'GET', path: '/api/projects/planning/work-plan' },
  'projectPlanning.workPlan.task.create': { method: 'POST', path: '/api/projects/planning/work-plan/tasks' },
  'projectPlanning.workPlan.task.delete': { method: 'DELETE', path: '/api/projects/planning/work-plan/tasks/{taskId}' },
  'projectPlanning.workPlan.task.get': { method: 'GET', path: '/api/projects/planning/work-plan/tasks/{taskId}' },
  'projectPlanning.workPlan.task.status': { method: 'POST', path: '/api/projects/planning/work-plan/tasks/{taskId}/status' },
  'projectPlanning.workPlan.task.update': { method: 'PATCH', path: '/api/projects/planning/work-plan/tasks/{taskId}' },
  'projectPlanning.workPlan.tasks.list': { method: 'GET', path: '/api/projects/planning/work-plan/tasks' },
  'projectPlanning.workPlan.tasks.reorder': { method: 'POST', path: '/api/projects/planning/work-plan/tasks/reorder' },
  'artifacts.create': { method: 'POST', path: '/api/artifacts' },
  'artifacts.get': { method: 'GET', path: '/api/artifacts/{artifactId}' },
  'artifacts.list': { method: 'GET', path: '/api/artifacts' },
  'companion.chat.messages.create': { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/messages' },
  'companion.chat.messages.list': { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}/messages' },
  'companion.chat.sessions.create': { method: 'POST', path: '/api/companion/chat/sessions' },
  'companion.chat.sessions.get': { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}' },
  'companion.chat.sessions.list': { method: 'GET', path: '/api/companion/chat/sessions' },
  'companion.chat.sessions.update': { method: 'PATCH', path: '/api/companion/chat/sessions/{sessionId}' },
} as const satisfies Partial<Record<OperatorTypedMethodId, BrowserScopedRouteDefinition>>;

export type BrowserAgentSdk = BrowserKnowledgeSdk;

export function createBrowserAgentSdk(options: ScopedBrowserSdkOptions = {}): BrowserAgentSdk {
  return createBrowserKnowledgeSdkFromRoutes(AGENT_BROWSER_ROUTES, options);
}

export { forSession };
