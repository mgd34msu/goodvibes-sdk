import type { DaemonOperatorRouteHandlers } from './context.js';
import { readBoundedPositiveInteger } from './route-helpers.js';

/**
 * m7: Safe wrapper around decodeURIComponent that returns null instead of
 * throwing URIError on malformed percent-encoded sequences (e.g. `%E0%A4`).
 */
function safeDecodeURIComponent(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * M4: Auth contract for dispatchOperatorRoutes
 *
 * Route-level authentication is enforced inside each handler, not at the
 * dispatcher level. Handler auth requirements by category:
 *
 * - READ-ONLY routes (status, providers, settings, continuity, intelligence,
 *   worktrees, watchers, approvals, telemetry snapshot) — require admin or
 *   authenticated session per handler implementation.
 * - STATE-CHANGING routes (service install/start/stop, route bindings,
 *   automation jobs, knowledge ingest) — always `withAdmin(context, req, ...)`.
 * - SCHEDULER/RUNTIME routes (getSchedulerCapacity, getRuntimeMetrics) —
 *   require admin per handler implementation.
 *
 * Dispatcher does not short-circuit unauthenticated requests; all auth
 * enforcement lives in the handler factories (system-routes.ts,
 * integration-routes.ts, runtime-automation-routes.ts, etc.).
 */
export async function dispatchOperatorRoutes(
  req: Request,
  handlers: DaemonOperatorRouteHandlers,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/status' && method === 'GET') return handlers.getStatus();
  if (pathname === '/api/control-plane/auth' && method === 'GET') return handlers.getCurrentAuth(req);
  if (pathname === '/api/control-plane' && method === 'GET') return handlers.getControlPlaneSnapshot();
  if (pathname === '/api/control-plane/contract' && method === 'GET') return handlers.getOperatorContract();
  if (pathname === '/api/control-plane/web' && method === 'GET') return handlers.getControlPlaneWeb();
  if (pathname === '/api/control-plane/recent-events' && method === 'GET') {
    const limit = readBoundedPositiveInteger(url.searchParams.get('limit'), 100);
    return handlers.getControlPlaneRecentEvents(limit);
  }
  if (pathname === '/api/control-plane/messages' && method === 'GET') return handlers.getControlPlaneMessages();
  if (pathname === '/api/control-plane/clients' && method === 'GET') return handlers.getControlPlaneClients();
  if (pathname === '/api/v1/telemetry' && method === 'GET') return handlers.getTelemetrySnapshot(req);
  if (pathname === '/api/v1/telemetry/events' && method === 'GET') return handlers.getTelemetryEvents(req);
  if (pathname === '/api/v1/telemetry/errors' && method === 'GET') return handlers.getTelemetryErrors(req);
  if (pathname === '/api/v1/telemetry/traces' && method === 'GET') return handlers.getTelemetryTraces(req);
  if (pathname === '/api/v1/telemetry/metrics' && method === 'GET') return handlers.getTelemetryMetrics(req);
  if (pathname === '/api/v1/telemetry/stream' && method === 'GET') return handlers.createTelemetryEventStream(req);
  if (pathname === '/api/v1/telemetry/otlp/v1/traces' && method === 'GET') return handlers.getTelemetryOtlpTraces(req);
  if (pathname === '/api/v1/telemetry/otlp/v1/logs' && method === 'GET') return handlers.getTelemetryOtlpLogs(req);
  if (pathname === '/api/v1/telemetry/otlp/v1/metrics' && method === 'GET') return handlers.getTelemetryOtlpMetrics(req);
  if (pathname === '/api/v1/telemetry/otlp/v1/logs' && method === 'POST') return handlers.postTelemetryOtlpLogs(req);
  if (pathname === '/api/v1/telemetry/otlp/v1/traces' && method === 'POST') return handlers.postTelemetryOtlpTraces(req);
  if (pathname === '/api/v1/telemetry/otlp/v1/metrics' && method === 'POST') return handlers.postTelemetryOtlpMetrics(req);
  if (pathname === '/api/control-plane/methods' && method === 'GET') return handlers.getGatewayMethods(url);
  const gatewayMethodInvokeMatch = pathname.match(/^\/api\/control-plane\/methods\/([^/]+)\/invoke$/);
  if (gatewayMethodInvokeMatch && method === 'POST') return handlers.invokeGatewayMethod(decodeURIComponent(gatewayMethodInvokeMatch[1]!), req);
  const gatewayMethodMatch = pathname.match(/^\/api\/control-plane\/methods\/([^/]+)$/);
  if (gatewayMethodMatch && method === 'GET') return handlers.getGatewayMethod(decodeURIComponent(gatewayMethodMatch[1]!));
  if (pathname === '/api/control-plane/events/catalog' && method === 'GET') return handlers.getGatewayEvents(url);
  if (pathname === '/api/control-plane/events' && method === 'GET') return handlers.createControlPlaneEventStream(req);
  if (pathname === '/api/routes' && method === 'GET') return handlers.getRoutesSnapshot();
  if (pathname === '/api/surfaces' && method === 'GET') return handlers.getSurfaces();
  if (pathname === '/api/channels/accounts' && method === 'GET') return handlers.getChannelAccounts();
  if (pathname === '/api/channels/capabilities' && method === 'GET') return handlers.getChannelCapabilities();
  if (pathname === '/api/channels/tools' && method === 'GET') return handlers.getChannelTools();
  if (pathname === '/api/channels/agent-tools' && method === 'GET') return handlers.getChannelAgentTools();
  if (pathname === '/api/channels/actions' && method === 'GET') return handlers.getChannelActions();
  const channelAccountDefaultActionMatch = pathname.match(/^\/api\/channels\/accounts\/([^/]+)\/actions\/([^/]+)$/);
  if (channelAccountDefaultActionMatch && method === 'POST') {
    return handlers.postChannelAccountAction(
      decodeURIComponent(channelAccountDefaultActionMatch[1]!),
      null,
      decodeURIComponent(channelAccountDefaultActionMatch[2]!),
      req,
    );
  }
  const channelAccountActionMatch = pathname.match(/^\/api\/channels\/accounts\/([^/]+)\/([^/]+)\/actions\/([^/]+)$/);
  if (channelAccountActionMatch && method === 'POST') {
    return handlers.postChannelAccountAction(
      decodeURIComponent(channelAccountActionMatch[1]!),
      decodeURIComponent(channelAccountActionMatch[2]!),
      decodeURIComponent(channelAccountActionMatch[3]!),
      req,
    );
  }
  const channelSetupMatch = pathname.match(/^\/api\/channels\/setup\/([^/]+)$/);
  if (channelSetupMatch && method === 'GET') {
    return handlers.getChannelSetupSchema(decodeURIComponent(channelSetupMatch[1]!), url);
  }
  const channelDoctorMatch = pathname.match(/^\/api\/channels\/doctor\/([^/]+)$/);
  if (channelDoctorMatch && method === 'GET') {
    return handlers.getChannelDoctor(decodeURIComponent(channelDoctorMatch[1]!), url);
  }
  const channelRepairActionsMatch = pathname.match(/^\/api\/channels\/repair-actions\/([^/]+)$/);
  if (channelRepairActionsMatch && method === 'GET') {
    return handlers.getChannelRepairActions(decodeURIComponent(channelRepairActionsMatch[1]!), url);
  }
  const channelLifecycleMatch = pathname.match(/^\/api\/channels\/lifecycle\/([^/]+)$/);
  if (channelLifecycleMatch && method === 'GET') {
    return handlers.getChannelLifecycle(decodeURIComponent(channelLifecycleMatch[1]!), url);
  }
  const channelResolveTargetMatch = pathname.match(/^\/api\/channels\/targets\/([^/]+)\/resolve$/);
  if (channelResolveTargetMatch && method === 'POST') {
    return handlers.postChannelResolveTarget(decodeURIComponent(channelResolveTargetMatch[1]!), req);
  }
  const channelAuthorizeMatch = pathname.match(/^\/api\/channels\/authorize\/([^/]+)$/);
  if (channelAuthorizeMatch && method === 'POST') {
    return handlers.postChannelAuthorize(decodeURIComponent(channelAuthorizeMatch[1]!), req);
  }
  const channelAllowlistResolveMatch = pathname.match(/^\/api\/channels\/allowlist\/([^/]+)\/resolve$/);
  if (channelAllowlistResolveMatch && method === 'POST') {
    return handlers.postChannelAllowlistResolve(decodeURIComponent(channelAllowlistResolveMatch[1]!), req);
  }
  const channelAllowlistEditMatch = pathname.match(/^\/api\/channels\/allowlist\/([^/]+)\/edit$/);
  if (channelAllowlistEditMatch && method === 'POST') {
    return handlers.postChannelAllowlistEdit(decodeURIComponent(channelAllowlistEditMatch[1]!), req);
  }
  const channelAccountMatch = pathname.match(/^\/api\/channels\/accounts\/([^/]+)\/([^/]+)$/);
  if (channelAccountMatch && method === 'GET') {
    return handlers.getChannelAccount(decodeURIComponent(channelAccountMatch[1]!), decodeURIComponent(channelAccountMatch[2]!));
  }
  const channelActionPostMatch = pathname.match(/^\/api\/channels\/actions\/([^/]+)\/([^/]+)$/);
  if (channelActionPostMatch && method === 'POST') {
    return handlers.postChannelAction(decodeURIComponent(channelActionPostMatch[1]!), decodeURIComponent(channelActionPostMatch[2]!), req);
  }
  const channelSurfaceAccountsMatch = pathname.match(/^\/api\/channels\/accounts\/([^/]+)$/);
  if (channelSurfaceAccountsMatch && method === 'GET') {
    return handlers.getChannelSurfaceAccounts(decodeURIComponent(channelSurfaceAccountsMatch[1]!));
  }
  const channelSurfaceCapabilitiesMatch = pathname.match(/^\/api\/channels\/capabilities\/([^/]+)$/);
  if (channelSurfaceCapabilitiesMatch && method === 'GET') {
    return handlers.getChannelSurfaceCapabilities(decodeURIComponent(channelSurfaceCapabilitiesMatch[1]!));
  }
  const channelSurfaceToolsMatch = pathname.match(/^\/api\/channels\/tools\/([^/]+)$/);
  if (channelSurfaceToolsMatch && method === 'GET') {
    return handlers.getChannelSurfaceTools(decodeURIComponent(channelSurfaceToolsMatch[1]!));
  }
  const channelSurfaceAgentToolsMatch = pathname.match(/^\/api\/channels\/agent-tools\/([^/]+)$/);
  if (channelSurfaceAgentToolsMatch && method === 'GET') {
    return handlers.getChannelSurfaceAgentTools(decodeURIComponent(channelSurfaceAgentToolsMatch[1]!));
  }
  const channelToolPostMatch = pathname.match(/^\/api\/channels\/tools\/([^/]+)\/([^/]+)$/);
  if (channelToolPostMatch && method === 'POST') {
    return handlers.postChannelTool(decodeURIComponent(channelToolPostMatch[1]!), decodeURIComponent(channelToolPostMatch[2]!), req);
  }
  const channelSurfaceActionsMatch = pathname.match(/^\/api\/channels\/actions\/([^/]+)$/);
  if (channelSurfaceActionsMatch && method === 'GET') {
    return handlers.getChannelSurfaceActions(decodeURIComponent(channelSurfaceActionsMatch[1]!));
  }
  if (pathname === '/api/channels/policies' && method === 'GET') return handlers.getChannelPolicies();
  const channelPolicyMatch = pathname.match(/^\/api\/channels\/policies\/([^/]+)$/);
  if (channelPolicyMatch && method === 'POST') return handlers.postChannelPolicy(channelPolicyMatch[1]!, req);
  if (channelPolicyMatch && method === 'PATCH') return handlers.patchChannelPolicy(channelPolicyMatch[1]!, req);
  if (pathname === '/api/channels/policies/audit' && method === 'GET') {
    const limit = readBoundedPositiveInteger(url.searchParams.get('limit'), 100);
    return handlers.getChannelPolicyAudit(limit);
  }
  if (pathname === '/api/channels/status' && method === 'GET') return handlers.getChannelStatus();
  const channelDirectoryMatch = pathname.match(/^\/api\/channels\/directory\/([^/]+)$/);
  if (channelDirectoryMatch && method === 'GET') return handlers.getChannelDirectory(channelDirectoryMatch[1]!, url);
  if (pathname === '/api/watchers' && method === 'GET') return handlers.getWatchers();
  if (pathname === '/api/watchers' && method === 'POST') return handlers.postWatcher(req);
  const watcherUpdateMatch = pathname.match(/^\/api\/watchers\/([^/]+)$/);
  if (watcherUpdateMatch && method === 'PATCH') return handlers.patchWatcher(watcherUpdateMatch[1]!, req);
  if (watcherUpdateMatch && method === 'DELETE') return handlers.deleteWatcher(watcherUpdateMatch[1]!, req);
  const watcherActionMatch = pathname.match(/^\/api\/watchers\/([^/]+)\/(start|stop|run)$/);
  if (watcherActionMatch && method === 'POST') return handlers.watcherAction(watcherActionMatch[1]!, watcherActionMatch[2]! as 'start' | 'stop' | 'run', req);

  if (pathname === '/api/service/status' && method === 'GET') return handlers.getServiceStatus();
  if (pathname === '/api/service/install' && method === 'POST') return handlers.installService(req);
  if (pathname === '/api/service/start' && method === 'POST') return handlers.startService(req);
  if (pathname === '/api/service/stop' && method === 'POST') return handlers.stopService(req);
  if (pathname === '/api/service/restart' && method === 'POST') return handlers.restartService(req);
  if (pathname === '/api/service/uninstall' && method === 'POST') return handlers.uninstallService(req);

  if (pathname === '/api/routes/bindings' && method === 'GET') return handlers.getRouteBindings(req);
  if (pathname === '/api/routes/bindings' && method === 'POST') return handlers.postRouteBinding(req);
  const routeBindingMatch = pathname.match(/^\/api\/routes\/bindings\/([^/]+)$/);
  if (routeBindingMatch && method === 'PATCH') return handlers.patchRouteBinding(routeBindingMatch[1]!, req);
  if (routeBindingMatch && method === 'DELETE') return handlers.deleteRouteBinding(routeBindingMatch[1]!, req);

  if (pathname === '/api/approvals' && method === 'GET') return handlers.getApprovals();
  const approvalActionMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/(claim|approve|deny|cancel)$/);
  if (approvalActionMatch && method === 'POST') {
    return handlers.approvalAction(approvalActionMatch[1]!, approvalActionMatch[2]! as 'claim' | 'approve' | 'deny' | 'cancel', req);
  }

  if (pathname === '/api/remote/node-host/contract' && method === 'GET') {
    return handlers.getRemoteNodeHostContract();
  }
  if (pathname === '/api/health' && method === 'GET') return handlers.getHealth();
  if (pathname === '/api/accounts' && method === 'GET') return handlers.getAccounts();
  if (pathname === '/api/providers' && method === 'GET') return handlers.getProviders();
  const providerUsageMatch = pathname.match(/^\/api\/providers\/([^/]+)\/usage$/);
  if (providerUsageMatch && method === 'GET') return handlers.getProviderUsage(decodeURIComponent(providerUsageMatch[1]!));
  const providerMatch = pathname.match(/^\/api\/providers\/([^/]+)$/);
  if (providerMatch && method === 'GET') return handlers.getProvider(decodeURIComponent(providerMatch[1]!));
  if (pathname === '/api/settings' && method === 'GET') return handlers.getSettings();
  if (pathname === '/api/security-settings' && method === 'GET') return handlers.getSecuritySettings();
  if (pathname === '/api/continuity' && method === 'GET') return handlers.getContinuity();
  if (pathname === '/api/worktrees' && method === 'GET') return handlers.getWorktrees();
  if (pathname === '/api/intelligence' && method === 'GET') return handlers.getIntelligence();

  if (pathname === '/api/automation/heartbeat' && method === 'GET') return handlers.getAutomationHeartbeat();
  if (pathname === '/api/automation/heartbeat' && method === 'POST') return handlers.postAutomationHeartbeat(req);
  if (pathname === '/api/memory/doctor' && method === 'GET') return handlers.getMemoryDoctor();
  if (pathname === '/api/memory/vector' && method === 'GET') return handlers.getMemoryVectorStats();
  if (pathname === '/api/memory/vector/rebuild' && method === 'POST') return handlers.postMemoryVectorRebuild(req);
  if (pathname === '/api/memory/embeddings/default' && method === 'POST') return handlers.postMemoryEmbeddingDefault(req);

  if (pathname === '/api/knowledge/status' && method === 'GET') return handlers.getKnowledgeStatus();
  if (pathname === '/api/knowledge/sources' && method === 'GET') return handlers.getKnowledgeSources(url);
  if (pathname === '/api/knowledge/nodes' && method === 'GET') return handlers.getKnowledgeNodes(url);
  if (pathname === '/api/knowledge/issues' && method === 'GET') return handlers.getKnowledgeIssues(url);
  if (pathname === '/api/knowledge/connectors' && method === 'GET') return handlers.getKnowledgeConnectors();
  if (pathname === '/api/knowledge/extractions' && method === 'GET') return handlers.getKnowledgeExtractions(url);
  if (pathname === '/api/knowledge/usage' && method === 'GET') return handlers.getKnowledgeUsage(url);
  if (pathname === '/api/knowledge/candidates' && method === 'GET') return handlers.getKnowledgeCandidates(url);
  if (pathname === '/api/knowledge/reports' && method === 'GET') return handlers.getKnowledgeReports(url);
  if (pathname === '/api/knowledge/jobs' && method === 'GET') return handlers.getKnowledgeJobs();
  if (pathname === '/api/knowledge/job-runs' && method === 'GET') return handlers.getKnowledgeJobRuns(url);
  if (pathname === '/api/knowledge/refinement/tasks' && method === 'GET') return handlers.getKnowledgeRefinementTasks(url);
  if (pathname === '/api/knowledge/refinement/run' && method === 'POST') return handlers.postKnowledgeRunRefinement(req);
  if (pathname === '/api/knowledge/schedules' && method === 'GET') return handlers.getKnowledgeSchedules(url);
  if (pathname === '/api/knowledge/projections' && method === 'GET') return handlers.getKnowledgeProjectionTargets(url);
  if (pathname === '/api/knowledge/map' && method === 'GET') return handlers.getKnowledgeMap(url);
  if (pathname === '/api/knowledge/graphql/schema' && method === 'GET') return handlers.getKnowledgeGraphqlSchema();
  if (pathname === '/api/knowledge/graphql' && (method === 'GET' || method === 'POST')) return handlers.executeKnowledgeGraphql(req);
  if (pathname === '/api/knowledge/ingest/url' && method === 'POST') return handlers.postKnowledgeIngestUrl(req);
  if (pathname === '/api/knowledge/ingest/artifact' && method === 'POST') return handlers.postKnowledgeIngestArtifact(req);
  if (pathname === '/api/knowledge/ingest/browser-history' && method === 'POST') return handlers.postKnowledgeSyncBrowserHistory(req);
  if (pathname === '/api/knowledge/ingest/bookmarks' && method === 'POST') return handlers.postKnowledgeImportBookmarks(req);
  if (pathname === '/api/knowledge/ingest/urls' && method === 'POST') return handlers.postKnowledgeImportUrls(req);
  if (pathname === '/api/knowledge/ingest/connector' && method === 'POST') return handlers.postKnowledgeIngestConnector(req);
  if (pathname === '/api/knowledge/search' && method === 'POST') return handlers.postKnowledgeSearch(req);
  if (pathname === '/api/knowledge/ask' && method === 'POST') return handlers.postKnowledgeAsk(req);
  if (pathname === '/api/knowledge/packet' && method === 'POST') return handlers.postKnowledgePacket(req);
  if (pathname === '/api/knowledge/lint' && method === 'POST') return handlers.postKnowledgeLint(req);
  if (pathname === '/api/knowledge/reindex' && method === 'POST') return handlers.postKnowledgeReindex(req);
  if (pathname === '/api/knowledge/schedules' && method === 'POST') return handlers.postKnowledgeSaveSchedule(req);
  if (pathname === '/api/knowledge/projections/render' && method === 'POST') return handlers.postKnowledgeRenderProjection(req);
  if (pathname === '/api/knowledge/projections/materialize' && method === 'POST') return handlers.postKnowledgeMaterializeProjection(req);
  const knowledgeConnectorDoctorMatch = pathname.match(/^\/api\/knowledge\/connectors\/([^/]+)\/doctor$/);
  if (knowledgeConnectorDoctorMatch && method === 'GET') return handlers.getKnowledgeConnectorDoctor(decodeURIComponent(knowledgeConnectorDoctorMatch[1]!));
  const knowledgeConnectorMatch = pathname.match(/^\/api\/knowledge\/connectors\/([^/]+)$/);
  if (knowledgeConnectorMatch && method === 'GET') return handlers.getKnowledgeConnector(decodeURIComponent(knowledgeConnectorMatch[1]!));
  const knowledgeExtractionMatch = pathname.match(/^\/api\/knowledge\/extractions\/([^/]+)$/);
  if (knowledgeExtractionMatch && method === 'GET') return handlers.getKnowledgeExtraction(decodeURIComponent(knowledgeExtractionMatch[1]!));
  const knowledgeIssueReviewMatch = pathname.match(/^\/api\/knowledge\/issues\/([^/]+)\/review$/);
  if (knowledgeIssueReviewMatch && method === 'POST') return handlers.postKnowledgeReviewIssue(decodeURIComponent(knowledgeIssueReviewMatch[1]!), req);
  const knowledgeCandidateDecideMatch = pathname.match(/^\/api\/knowledge\/candidates\/([^/]+)\/decide$/);
  if (knowledgeCandidateDecideMatch && method === 'POST') return handlers.postKnowledgeDecideCandidate(decodeURIComponent(knowledgeCandidateDecideMatch[1]!), req);
  const knowledgeCandidateMatch = pathname.match(/^\/api\/knowledge\/candidates\/([^/]+)$/);
  if (knowledgeCandidateMatch && method === 'GET') return handlers.getKnowledgeCandidate(decodeURIComponent(knowledgeCandidateMatch[1]!));
  const knowledgeReportMatch = pathname.match(/^\/api\/knowledge\/reports\/([^/]+)$/);
  if (knowledgeReportMatch && method === 'GET') return handlers.getKnowledgeReport(decodeURIComponent(knowledgeReportMatch[1]!));
  const knowledgeSourceExtractionMatch = pathname.match(/^\/api\/knowledge\/sources\/([^/]+)\/extraction$/);
  if (knowledgeSourceExtractionMatch && method === 'GET') return handlers.getKnowledgeSourceExtraction(decodeURIComponent(knowledgeSourceExtractionMatch[1]!));
  const knowledgeJobRunMatch = pathname.match(/^\/api\/knowledge\/jobs\/([^/]+)\/run$/);
  if (knowledgeJobRunMatch && method === 'POST') return handlers.postKnowledgeRunJob(decodeURIComponent(knowledgeJobRunMatch[1]!), req);
  const knowledgeJobMatch = pathname.match(/^\/api\/knowledge\/jobs\/([^/]+)$/);
  if (knowledgeJobMatch && method === 'GET') return handlers.getKnowledgeJob(decodeURIComponent(knowledgeJobMatch[1]!));
  const knowledgeRefinementTaskCancelMatch = pathname.match(/^\/api\/knowledge\/refinement\/tasks\/([^/]+)\/cancel$/);
  if (knowledgeRefinementTaskCancelMatch && method === 'POST') return handlers.postKnowledgeCancelRefinementTask(decodeURIComponent(knowledgeRefinementTaskCancelMatch[1]!), req);
  const knowledgeRefinementTaskMatch = pathname.match(/^\/api\/knowledge\/refinement\/tasks\/([^/]+)$/);
  if (knowledgeRefinementTaskMatch && method === 'GET') return handlers.getKnowledgeRefinementTask(decodeURIComponent(knowledgeRefinementTaskMatch[1]!));
  const knowledgeScheduleEnabledMatch = pathname.match(/^\/api\/knowledge\/schedules\/([^/]+)\/enabled$/);
  if (knowledgeScheduleEnabledMatch && method === 'POST') return handlers.postKnowledgeSetScheduleEnabled(decodeURIComponent(knowledgeScheduleEnabledMatch[1]!), req);
  const knowledgeScheduleMatch = pathname.match(/^\/api\/knowledge\/schedules\/([^/]+)$/);
  if (knowledgeScheduleMatch && method === 'GET') return handlers.getKnowledgeSchedule(decodeURIComponent(knowledgeScheduleMatch[1]!));
  if (knowledgeScheduleMatch && method === 'DELETE') return handlers.deleteKnowledgeSchedule(decodeURIComponent(knowledgeScheduleMatch[1]!), req);
  const knowledgeItemMatch = pathname.match(/^\/api\/knowledge\/items\/([^/]+)$/);
  if (knowledgeItemMatch && method === 'GET') return handlers.getKnowledgeItem(decodeURIComponent(knowledgeItemMatch[1]!));

  if (pathname === '/api/voice' && method === 'GET') return handlers.getVoiceStatus();
  if (pathname === '/api/voice/providers' && method === 'GET') return handlers.getVoiceProviders();
  if (pathname === '/api/voice/voices' && method === 'GET') return handlers.getVoiceVoices(url);
  if (pathname === '/api/voice/tts/stream' && method === 'POST') return handlers.postVoiceTtsStream(req);
  if (pathname === '/api/voice/tts' && method === 'POST') return handlers.postVoiceTts(req);
  if (pathname === '/api/voice/stt' && method === 'POST') return handlers.postVoiceStt(req);
  if (pathname === '/api/voice/realtime/session' && method === 'POST') return handlers.postVoiceRealtimeSession(req);

  if (pathname === '/api/web-search/providers' && method === 'GET') return handlers.getWebSearchProviders();
  if (pathname === '/api/web-search/query' && method === 'POST') return handlers.postWebSearch(req);

  if (pathname === '/api/artifacts' && method === 'GET') return handlers.getArtifacts();
  if (pathname === '/api/artifacts' && method === 'POST') return handlers.postArtifact(req);
  const artifactContentMatch = pathname.match(/^\/api\/artifacts\/([^/]+)\/content$/);
  if (artifactContentMatch && method === 'GET') return handlers.getArtifactContent(decodeURIComponent(artifactContentMatch[1]!), req);
  const artifactMatch = pathname.match(/^\/api\/artifacts\/([^/]+)$/);
  if (artifactMatch && method === 'GET') return handlers.getArtifact(decodeURIComponent(artifactMatch[1]!));

  if (pathname === '/api/media/providers' && method === 'GET') return handlers.getMediaProviders();
  if (pathname === '/api/media/analyze' && method === 'POST') return handlers.postMediaAnalyze(req);
  if (pathname === '/api/media/transform' && method === 'POST') return handlers.postMediaTransform(req);
  if (pathname === '/api/media/generate' && method === 'POST') return handlers.postMediaGenerate(req);

  if (pathname === '/api/multimodal' && method === 'GET') return handlers.getMultimodalStatus();
  if (pathname === '/api/multimodal/providers' && method === 'GET') return handlers.getMultimodalProviders();
  if (pathname === '/api/multimodal/analyze' && method === 'POST') return handlers.postMultimodalAnalyze(req);
  if (pathname === '/api/multimodal/packet' && method === 'POST') return handlers.postMultimodalPacket(req);
  if (pathname === '/api/multimodal/writeback' && method === 'POST') return handlers.postMultimodalWriteback(req);

  if (pathname === '/api/local-auth' && method === 'GET') return handlers.getLocalAuth(req);
  if (pathname === '/api/local-auth/users' && method === 'POST') return handlers.postLocalAuthUser(req);
  const userMatch = pathname.match(/^\/api\/local-auth\/users\/([^/]+)$/);
  if (userMatch && method === 'DELETE') return handlers.deleteLocalAuthUser(decodeURIComponent(userMatch[1]!), req);
  const passwordMatch = pathname.match(/^\/api\/local-auth\/users\/([^/]+)\/password$/);
  if (passwordMatch && method === 'POST') return handlers.postLocalAuthPassword(decodeURIComponent(passwordMatch[1]!), req);
  const sessionMatch = pathname.match(/^\/api\/local-auth\/sessions\/([^/]+)$/);
  if (sessionMatch && method === 'DELETE') return handlers.deleteLocalAuthSession(decodeURIComponent(sessionMatch[1]!), req);
  if (pathname === '/api/local-auth/bootstrap-file' && method === 'DELETE') return handlers.deleteBootstrapFile(req);

  if (pathname === '/api/runtime/scheduler' && method === 'GET') return handlers.getSchedulerCapacity(req);
  if (pathname === '/api/runtime/metrics' && method === 'GET') return handlers.getRuntimeMetrics();

  if (pathname === '/api/panels' && method === 'GET') return handlers.getPanels();
  if (pathname === '/api/panels/open' && method === 'POST') return handlers.postPanelOpen(req);
  if (pathname === '/api/events' && method === 'GET') return handlers.getEvents(req);
  if (pathname === '/config' && method === 'GET') return handlers.getConfig(req);
  if (pathname === '/config' && method === 'POST') return handlers.postConfig(req);

  return null;
}
