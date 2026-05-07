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

const HOME_ASSISTANT_BROWSER_ROUTES = {
  'homeassistant.homeGraph.askHomeGraph': { method: 'POST', path: '/api/homeassistant/home-graph/ask' },
  'homeassistant.homeGraph.browse': { method: 'GET', path: '/api/homeassistant/home-graph/browse' },
  'homeassistant.homeGraph.export': { method: 'POST', path: '/api/homeassistant/home-graph/export' },
  'homeassistant.homeGraph.generateHomeGraphPacket': { method: 'POST', path: '/api/homeassistant/home-graph/packet' },
  'homeassistant.homeGraph.generateRoomPage': { method: 'POST', path: '/api/homeassistant/home-graph/room-page' },
  'homeassistant.homeGraph.import': { method: 'POST', path: '/api/homeassistant/home-graph/import' },
  'homeassistant.homeGraph.ingestHomeGraphArtifact': { method: 'POST', path: '/api/homeassistant/home-graph/ingest/artifact' },
  'homeassistant.homeGraph.ingestHomeGraphNote': { method: 'POST', path: '/api/homeassistant/home-graph/ingest/note' },
  'homeassistant.homeGraph.ingestHomeGraphUrl': { method: 'POST', path: '/api/homeassistant/home-graph/ingest/url' },
  'homeassistant.homeGraph.linkHomeGraphKnowledge': { method: 'POST', path: '/api/homeassistant/home-graph/link' },
  'homeassistant.homeGraph.listHomeGraphIssues': { method: 'GET', path: '/api/homeassistant/home-graph/issues' },
  'homeassistant.homeGraph.map': { method: 'POST', path: '/api/homeassistant/home-graph/map' },
  'homeassistant.homeGraph.pages.list': { method: 'GET', path: '/api/homeassistant/home-graph/pages' },
  'homeassistant.homeGraph.refinement.run': { method: 'POST', path: '/api/homeassistant/home-graph/refinement/run' },
  'homeassistant.homeGraph.refinement.task.cancel': { method: 'POST', path: '/api/homeassistant/home-graph/refinement/tasks/{id}/cancel' },
  'homeassistant.homeGraph.refinement.task.get': { method: 'GET', path: '/api/homeassistant/home-graph/refinement/tasks/{id}' },
  'homeassistant.homeGraph.refinement.tasks.list': { method: 'GET', path: '/api/homeassistant/home-graph/refinement/tasks' },
  'homeassistant.homeGraph.refreshDevicePassport': { method: 'POST', path: '/api/homeassistant/home-graph/device-passport' },
  'homeassistant.homeGraph.reindex': { method: 'POST', path: '/api/homeassistant/home-graph/reindex' },
  'homeassistant.homeGraph.reset': { method: 'POST', path: '/api/homeassistant/home-graph/reset' },
  'homeassistant.homeGraph.reviewHomeGraphFact': { method: 'POST', path: '/api/homeassistant/home-graph/facts/review' },
  'homeassistant.homeGraph.sources.list': { method: 'GET', path: '/api/homeassistant/home-graph/sources' },
  'homeassistant.homeGraph.status': { method: 'GET', path: '/api/homeassistant/home-graph/status' },
  'homeassistant.homeGraph.syncHomeGraph': { method: 'POST', path: '/api/homeassistant/home-graph/sync' },
  'homeassistant.homeGraph.unlinkHomeGraphKnowledge': { method: 'POST', path: '/api/homeassistant/home-graph/unlink' },
} as const satisfies Partial<Record<OperatorTypedMethodId, BrowserScopedRouteDefinition>>;

const HOME_ASSISTANT_BROWSER_DOMAINS = [
  'session',
  'turn',
  'tasks',
  'providers',
  'surfaces',
  'routes',
  'knowledge',
  'control-plane',
] as const;

export type BrowserHomeAssistantMethodId =
  | SharedBrowserMethodId
  | Extract<keyof typeof HOME_ASSISTANT_BROWSER_ROUTES, OperatorTypedMethodId>;

export type BrowserHomeAssistantDomain = typeof HOME_ASSISTANT_BROWSER_DOMAINS[number];

export interface BrowserHomeAssistantSdk extends ScopedBrowserSdk<BrowserHomeAssistantMethodId, BrowserHomeAssistantDomain> {
  readonly homeGraph: {
    status(input?: OperatorMethodInput<'homeassistant.homeGraph.status'>): Promise<OperatorMethodOutput<'homeassistant.homeGraph.status'>>;
    ask(input: OperatorMethodInput<'homeassistant.homeGraph.askHomeGraph'>): Promise<OperatorMethodOutput<'homeassistant.homeGraph.askHomeGraph'>>;
    map(input?: OperatorMethodInput<'homeassistant.homeGraph.map'>): Promise<OperatorMethodOutput<'homeassistant.homeGraph.map'>>;
    pages(input?: OperatorMethodInput<'homeassistant.homeGraph.pages.list'>): Promise<OperatorMethodOutput<'homeassistant.homeGraph.pages.list'>>;
  };
}

export function createBrowserHomeAssistantSdk(options: ScopedBrowserSdkOptions = {}): BrowserHomeAssistantSdk {
  const sdk = createScopedBrowserSdk<BrowserHomeAssistantMethodId, BrowserHomeAssistantDomain>(
    {
      ...SHARED_BROWSER_ROUTES,
      ...HOME_ASSISTANT_BROWSER_ROUTES,
    } as Record<BrowserHomeAssistantMethodId, BrowserScopedRouteDefinition>,
    HOME_ASSISTANT_BROWSER_DOMAINS,
    options,
  );
  return {
    ...sdk,
    homeGraph: {
      status: (input = {}) => sdk.operator.invoke('homeassistant.homeGraph.status', input),
      ask: (input) => sdk.operator.invoke('homeassistant.homeGraph.askHomeGraph', input),
      map: (input = {}) => sdk.operator.invoke('homeassistant.homeGraph.map', input),
      pages: (input = {}) => sdk.operator.invoke('homeassistant.homeGraph.pages.list', input),
    },
  };
}

export { forScopedBrowserSession as forSession };
