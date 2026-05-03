/**
 * Shared router-test stubs for daemon route handlers.
 *
 * The public helper composes small domain builders so route tests can override
 * only the domain under test without reading one giant default object.
 */

import type { DaemonApiRouteHandlers } from '../../packages/daemon-sdk/src/context.js';

type HandlerStubs = Partial<DaemonApiRouteHandlers>;

function unexpectedHandler(): never {
  throw new Error('unexpected handler call');
}

function jsonStub<T>(value: T): () => Response {
  return () => Response.json(value);
}

function controlPlaneStubs(): HandlerStubs {
  return {
    getStatus: jsonStub({ ok: true, version: '0.0.0-test', uptime: 0 }),
    getCurrentAuth: jsonStub({ authenticated: false }),
    getControlPlaneSnapshot: jsonStub({
      totals: { clients: 0, activeClients: 0, surfaceMessages: 0, recentEvents: 0, requests: 0, errors: 0 },
      server: { port: 9000, enabled: true, host: '127.0.0.1' },
    }),
    getOperatorContract: jsonStub({ methods: [], version: '0.0.0-test' }),
    getControlPlaneRecentEvents: (limit: number) => Response.json({ events: [], limit }),
    getControlPlaneMessages: jsonStub({ messages: [] }),
    getControlPlaneClients: jsonStub({ clients: [] }),
    getControlPlaneWeb: () => new Response('<html>control</html>', { headers: { 'content-type': 'text/html' } }),
    getGatewayMethods: jsonStub({ methods: [] }),
    getGatewayEvents: jsonStub({ events: [] }),
    getGatewayMethod: jsonStub(null),
    invokeGatewayMethod: jsonStub({ ok: false }),
    createControlPlaneEventStream: () => new Response('', { status: 200 }),
    getRoutesSnapshot: jsonStub({ routes: [] }),
    getSurfaces: jsonStub({ surfaces: [] }),
    getHealth: jsonStub({ healthy: true }),
    getAccounts: jsonStub({ accounts: [] }),
    getProviders: jsonStub({ providers: [] }),
    getProvider: jsonStub(null),
    getProviderUsage: jsonStub(null),
    getSettings: jsonStub({ settings: {} }),
    getContinuity: jsonStub({ continuity: {} }),
    getWorktrees: jsonStub({ worktrees: [] }),
    getIntelligence: jsonStub({ intelligence: {} }),
    getLocalAuth: jsonStub({ users: [] }),
    postLocalAuthUser: jsonStub({ ok: true }),
    deleteLocalAuthUser: jsonStub({ ok: true }),
    postLocalAuthPassword: jsonStub({ ok: true }),
    deleteLocalAuthSession: jsonStub({ ok: true }),
    deleteBootstrapFile: jsonStub({ ok: true }),
    getPanels: jsonStub({ panels: [] }),
    postPanelOpen: jsonStub({ ok: true }),
    getEvents: jsonStub({ events: [] }),
    getConfig: jsonStub({ config: {} }),
    postConfig: jsonStub({ ok: true }),
    getReview: jsonStub({ review: {} }),
  };
}

function telemetryStubs(): HandlerStubs {
  return {
    getTelemetrySnapshot: jsonStub({ events: [], version: 1 }),
    getTelemetryEvents: jsonStub({ items: [] }),
    getTelemetryErrors: jsonStub({ items: [] }),
    getTelemetryTraces: jsonStub({ items: [] }),
    getTelemetryMetrics: jsonStub({ runtime: {}, sessionMetrics: {} }),
    createTelemetryEventStream: () => new Response('', { status: 200 }),
    getTelemetryOtlpTraces: jsonStub({}),
    getTelemetryOtlpLogs: jsonStub({}),
    getTelemetryOtlpMetrics: jsonStub({}),
    postTelemetryOtlpLogs: jsonStub({ partialSuccess: {} }),
    postTelemetryOtlpTraces: jsonStub({ partialSuccess: {} }),
    postTelemetryOtlpMetrics: jsonStub({ partialSuccess: {} }),
  };
}

function channelAndAutomationStubs(): HandlerStubs {
  return {
    getChannelAccounts: jsonStub({ accounts: [] }),
    getChannelSurfaceAccounts: jsonStub({ accounts: [] }),
    getChannelAccount: jsonStub(null),
    postChannelAccountAction: unexpectedHandler as never,
    getChannelSetupSchema: jsonStub({}),
    getChannelDoctor: jsonStub({ issues: [] }),
    getChannelRepairActions: jsonStub({ actions: [] }),
    getChannelLifecycle: jsonStub({}),
    getChannelCapabilities: jsonStub({ capabilities: [] }),
    getChannelSurfaceCapabilities: jsonStub({ capabilities: [] }),
    getChannelTools: jsonStub({ tools: [] }),
    getChannelSurfaceTools: jsonStub({ tools: [] }),
    getChannelAgentTools: jsonStub({ tools: [] }),
    getChannelSurfaceAgentTools: jsonStub({ tools: [] }),
    postChannelTool: jsonStub({ ok: true }),
    getChannelActions: jsonStub({ actions: [] }),
    getChannelSurfaceActions: jsonStub({ actions: [] }),
    postChannelAction: jsonStub({ ok: true }),
    postChannelResolveTarget: jsonStub({ targets: [] }),
    postChannelAuthorize: jsonStub({ ok: true }),
    postChannelAllowlistResolve: jsonStub({ entries: [] }),
    postChannelAllowlistEdit: jsonStub({ ok: true }),
    getChannelPolicies: jsonStub({ policies: [] }),
    postChannelPolicy: jsonStub({ ok: true }),
    patchChannelPolicy: jsonStub({ ok: true }),
    getChannelPolicyAudit: jsonStub({ entries: [] }),
    getChannelStatus: jsonStub({ ok: true }),
    getChannelDirectory: jsonStub({ entries: [] }),
    getWatchers: jsonStub({ watchers: [] }),
    postWatcher: jsonStub({ id: 'w-1' }),
    patchWatcher: jsonStub({ ok: true }),
    watcherAction: jsonStub({ ok: true }),
    deleteWatcher: jsonStub({ ok: true }),
    getServiceStatus: jsonStub({ services: [] }),
    installService: jsonStub({ ok: true }),
    startService: jsonStub({ ok: true }),
    stopService: jsonStub({ ok: true }),
    restartService: jsonStub({ ok: true }),
    uninstallService: jsonStub({ ok: true }),
    getRouteBindings: jsonStub({ bindings: [] }),
    postRouteBinding: jsonStub({ id: 'rb-1' }),
    patchRouteBinding: jsonStub({ ok: true }),
    deleteRouteBinding: jsonStub({ ok: true }),
    getApprovals: jsonStub({ approvals: [] }),
    approvalAction: jsonStub({ ok: true }),
    getIntegrationSession: jsonStub({}),
    getIntegrationTasks: jsonStub({ tasks: [] }),
    getIntegrationAutomation: jsonStub({}),
    getIntegrationSessions: jsonStub({ sessions: [] }),
    getAutomationHeartbeat: jsonStub({}),
    postAutomationHeartbeat: jsonStub({ ok: true }),
  };
}

function remoteAndRuntimeStubs(): HandlerStubs {
  return {
    getRemote: jsonStub({ peers: [] }),
    getRemotePairRequests: jsonStub({ requests: [] }),
    approveRemotePairRequest: jsonStub({ ok: true }),
    rejectRemotePairRequest: jsonStub({ ok: true }),
    getRemotePeers: jsonStub({ peers: [] }),
    rotateRemotePeerToken: jsonStub({ token: 'new-token' }),
    revokeRemotePeerToken: jsonStub({ ok: true }),
    disconnectRemotePeer: jsonStub({ ok: true }),
    getRemoteWork: jsonStub({ work: [] }),
    invokeRemotePeer: jsonStub({ ok: true }),
    cancelRemoteWork: jsonStub({ ok: true }),
    getRemoteNodeHostContract: jsonStub({}),
    getSchedulerCapacity: jsonStub({ capacity: 0 }),
    getRuntimeMetrics: jsonStub({ metrics: {} }),
    getRuntimeTask: jsonStub(null),
    runtimeTaskAction: jsonStub({ ok: true }),
    getTaskStatus: jsonStub({ status: 'pending' }),
    postTask: async () => jsonStub({ taskId: 'task-stub' })(),
  };
}

function knowledgeStubs(): HandlerStubs {
  return {
    getMemoryDoctor: jsonStub({}),
    getMemoryVectorStats: jsonStub({}),
    postMemoryVectorRebuild: jsonStub({ ok: true }),
    postMemoryEmbeddingDefault: jsonStub({ ok: true }),
    getKnowledgeStatus: jsonStub({}),
    getKnowledgeSources: jsonStub({ sources: [] }),
    getKnowledgeNodes: jsonStub({ nodes: [] }),
    getKnowledgeIssues: jsonStub({ issues: [] }),
    getKnowledgeItem: jsonStub(null),
    getKnowledgeConnectors: jsonStub({ connectors: [] }),
    getKnowledgeConnector: jsonStub(null),
    getKnowledgeConnectorDoctor: jsonStub({}),
    getKnowledgeProjectionTargets: jsonStub({ targets: [] }),
    getKnowledgeGraphqlSchema: jsonStub({ schema: '' }),
    getKnowledgeExtractions: jsonStub({ extractions: [] }),
    getKnowledgeUsage: jsonStub({}),
    getKnowledgeCandidates: jsonStub({ candidates: [] }),
    getKnowledgeCandidate: jsonStub(null),
    getKnowledgeReports: jsonStub({ reports: [] }),
    getKnowledgeReport: jsonStub(null),
    getKnowledgeExtraction: jsonStub(null),
    getKnowledgeSourceExtraction: jsonStub(null),
    getKnowledgeJobs: jsonStub({ jobs: [] }),
    getKnowledgeJob: jsonStub(null),
    getKnowledgeJobRuns: jsonStub({ runs: [] }),
    getKnowledgeSchedules: jsonStub({ schedules: [] }),
    getKnowledgeSchedule: jsonStub(null),
    postKnowledgeIngestUrl: jsonStub({ ok: true }),
    postKnowledgeIngestArtifact: jsonStub({ ok: true }),
    postKnowledgeImportBookmarks: jsonStub({ ok: true }),
    postKnowledgeImportUrls: jsonStub({ ok: true }),
    postKnowledgeIngestConnector: jsonStub({ ok: true }),
    postKnowledgeSearch: jsonStub({ results: [] }),
    postKnowledgePacket: jsonStub({ ok: true }),
    postKnowledgeDecideCandidate: jsonStub({ ok: true }),
    postKnowledgeRunJob: jsonStub({ ok: true }),
    postKnowledgeLint: jsonStub({ ok: true }),
    postKnowledgeReindex: jsonStub({ ok: true }),
    postKnowledgeSaveSchedule: jsonStub({ ok: true }),
    deleteKnowledgeSchedule: jsonStub({ ok: true }),
    postKnowledgeSetScheduleEnabled: jsonStub({ ok: true }),
    postKnowledgeRenderProjection: jsonStub({ ok: true }),
    postKnowledgeMaterializeProjection: jsonStub({ ok: true }),
    executeKnowledgeGraphql: jsonStub({ data: null }),
  };
}

function mediaAndArtifactStubs(): HandlerStubs {
  return {
    getVoiceStatus: jsonStub({}),
    getVoiceProviders: jsonStub({ providers: [] }),
    getVoiceVoices: jsonStub({ voices: [] }),
    postVoiceTts: () => new Response(new Uint8Array(), { headers: { 'content-type': 'audio/mpeg' } }),
    postVoiceTtsStream: () => new Response(new Uint8Array(), { headers: { 'content-type': 'audio/mpeg' } }),
    postVoiceStt: jsonStub({ text: '' }),
    postVoiceRealtimeSession: jsonStub({}),
    getWebSearchProviders: jsonStub({ providers: [] }),
    postWebSearch: jsonStub({ results: [] }),
    getArtifacts: jsonStub({ artifacts: [] }),
    postArtifact: jsonStub({ id: 'art-1' }),
    getArtifact: jsonStub(null),
    getArtifactContent: () => new Response('', { status: 200 }),
    getMediaProviders: jsonStub({ providers: [] }),
    postMediaAnalyze: jsonStub({}),
    postMediaTransform: jsonStub({}),
    postMediaGenerate: jsonStub({}),
    getMultimodalStatus: jsonStub({}),
    getMultimodalProviders: jsonStub({ providers: [] }),
    postMultimodalAnalyze: jsonStub({}),
    postMultimodalPacket: jsonStub({}),
    postMultimodalWriteback: jsonStub({ ok: true }),
  };
}

export function makeDefaultDaemonHandlerStub(
  overrides: Partial<DaemonApiRouteHandlers> = {},
): DaemonApiRouteHandlers {
  const defaults: HandlerStubs = {
    ...controlPlaneStubs(),
    ...telemetryStubs(),
    ...channelAndAutomationStubs(),
    ...remoteAndRuntimeStubs(),
    ...knowledgeStubs(),
    ...mediaAndArtifactStubs(),
  };

  return { ...defaults, ...overrides } as DaemonApiRouteHandlers;
}
