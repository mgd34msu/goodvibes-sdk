/** The return type for all daemon route handler methods — either a synchronous or async `Response`. */
export type MaybeResponse = Response | Promise<Response>;

/** Combined route handler interface for the remote dispatch surface (overview + management). */
export interface DaemonRemoteDispatchRouteHandlers
  extends DaemonRemoteOverviewRouteHandlers,
    DaemonRemoteManagementRouteHandlers {}

/** Route handlers for the remote overview endpoint. */
export interface DaemonRemoteOverviewRouteHandlers {
  getRemote(): MaybeResponse;
}

/** Full operator route surface — aggregates control, telemetry, channel, integration, system, remote-management, knowledge, media, and runtime handlers. */
export interface DaemonOperatorRouteHandlers
  extends DaemonControlRouteHandlers,
    DaemonTelemetryRouteHandlers,
    DaemonChannelRouteHandlers,
    DaemonIntegrationRouteHandlers,
    DaemonSystemRouteHandlers,
    DaemonRemoteManagementRouteHandlers,
    DaemonKnowledgeRouteHandlers,
    DaemonMediaRouteHandlers,
    DaemonOperatorRuntimeRouteHandlers {}

/** Route handlers for operator-level runtime metrics and heartbeat endpoints. */
export interface DaemonOperatorRuntimeRouteHandlers {
  getAutomationHeartbeat(): MaybeResponse;
  postAutomationHeartbeat(req: Request): MaybeResponse;
  getSchedulerCapacity(req: Request): MaybeResponse;
  getRuntimeMetrics(): MaybeResponse;
}

/** Route handlers for the automation surface — overview, runtime automation, and delivery. */
export interface DaemonAutomationRouteHandlers
  extends DaemonAutomationOverviewRouteHandlers,
    DaemonRuntimeAutomationRouteHandlers,
    DaemonDeliveryRouteHandlers {}

/** Route handlers for automation overview endpoints (review, session, automation summaries). */
export interface DaemonAutomationOverviewRouteHandlers {
  getReview(): MaybeResponse;
  getIntegrationSession(): MaybeResponse;
  getIntegrationAutomation(): MaybeResponse;
}

/** Route handlers for delivery listing and retrieval. */
export interface DaemonDeliveryRouteHandlers {
  getDeliveries(): MaybeResponse;
  getDelivery(deliveryId: string): MaybeResponse;
}

/** Route handlers for the session surface — overview and runtime session management. */
export interface DaemonSessionRouteHandlers
  extends DaemonSessionOverviewRouteHandlers,
    DaemonRuntimeSessionRouteHandlers {}

/** Route handler for the integration sessions listing endpoint. */
export interface DaemonSessionOverviewRouteHandlers {
  /** @param url - When present and contains `limit`/`cursor` params, returns a `PaginatedResponse`. Otherwise returns the legacy session broker snapshot. */
  getIntegrationSessions(url?: URL): MaybeResponse;
}

/** Route handlers for the task surface — overview and runtime task management. */
export interface DaemonTaskRouteHandlers
  extends DaemonTaskOverviewRouteHandlers,
    DaemonRuntimeTaskRouteHandlers {}

/** Route handler for the integration tasks listing endpoint. */
export interface DaemonTaskOverviewRouteHandlers {
  getIntegrationTasks(): MaybeResponse;
}

/** Route handlers for daemon control-plane endpoints: auth, status, gateway, and SSE event streams. */
export interface DaemonControlRouteHandlers {
  postLogin(req: Request): MaybeResponse;
  getStatus(req: Request): MaybeResponse;
  getCurrentAuth(req: Request): MaybeResponse;
  getControlPlaneSnapshot(): MaybeResponse;
  getOperatorContract(): MaybeResponse;
  getControlPlaneWeb(): MaybeResponse;
  getControlPlaneRecentEvents(limit: number): MaybeResponse;
  getControlPlaneMessages(): MaybeResponse;
  getControlPlaneClients(): MaybeResponse;
  getGatewayMethods(url: URL): MaybeResponse;
  getGatewayEvents(url: URL): MaybeResponse;
  getGatewayMethod(methodId: string): MaybeResponse;
  invokeGatewayMethod(methodId: string, req: Request): MaybeResponse;
  createControlPlaneEventStream(req: Request): MaybeResponse;
}

/** Route handlers for telemetry endpoints: snapshots, events, errors, traces, metrics, and OTLP ingest. */
export interface DaemonTelemetryRouteHandlers {
  getTelemetrySnapshot(req: Request): MaybeResponse;
  getTelemetryEvents(req: Request): MaybeResponse;
  getTelemetryErrors(req: Request): MaybeResponse;
  getTelemetryTraces(req: Request): MaybeResponse;
  getTelemetryMetrics(req: Request): MaybeResponse;
  createTelemetryEventStream(req: Request): MaybeResponse;
  getTelemetryOtlpTraces(req: Request): MaybeResponse;
  getTelemetryOtlpLogs(req: Request): MaybeResponse;
  getTelemetryOtlpMetrics(req: Request): MaybeResponse;
  postTelemetryOtlpLogs(req: Request): MaybeResponse;
  postTelemetryOtlpTraces(req: Request): MaybeResponse;
  postTelemetryOtlpMetrics(req: Request): MaybeResponse;
}

/** Route handlers for channel/surface management: accounts, setup, lifecycle, capabilities, tools, actions, policies, and directory. */
export interface DaemonChannelRouteHandlers {
  getSurfaces(): MaybeResponse;
  getChannelAccounts(): MaybeResponse;
  getChannelSurfaceAccounts(surface: string): MaybeResponse;
  getChannelAccount(surface: string, accountId: string): MaybeResponse;
  getChannelSetupSchema(surface: string, url: URL): MaybeResponse;
  getChannelDoctor(surface: string, url: URL): MaybeResponse;
  getChannelRepairActions(surface: string, url: URL): MaybeResponse;
  getChannelLifecycle(surface: string, url: URL): MaybeResponse;
  postChannelAccountAction(surface: string, accountId: string | null, action: string, req: Request): MaybeResponse;
  getChannelCapabilities(): MaybeResponse;
  getChannelSurfaceCapabilities(surface: string): MaybeResponse;
  getChannelTools(): MaybeResponse;
  getChannelSurfaceTools(surface: string): MaybeResponse;
  getChannelAgentTools(): MaybeResponse;
  getChannelSurfaceAgentTools(surface: string): MaybeResponse;
  postChannelTool(surface: string, toolId: string, req: Request): MaybeResponse;
  getChannelActions(): MaybeResponse;
  getChannelSurfaceActions(surface: string): MaybeResponse;
  postChannelAction(surface: string, actionId: string, req: Request): MaybeResponse;
  postChannelResolveTarget(surface: string, req: Request): MaybeResponse;
  postChannelAuthorize(surface: string, req: Request): MaybeResponse;
  postChannelAllowlistResolve(surface: string, req: Request): MaybeResponse;
  postChannelAllowlistEdit(surface: string, req: Request): MaybeResponse;
  getChannelPolicies(): MaybeResponse;
  postChannelPolicy(surface: string, req: Request): MaybeResponse;
  patchChannelPolicy(surface: string, req: Request): MaybeResponse;
  getChannelPolicyAudit(limit: number): MaybeResponse;
  getChannelStatus(): MaybeResponse;
  getChannelDirectory(surface: string, url: URL): MaybeResponse;
}

/** Full integration route surface — overview, delivery, snapshot, remote, platform status, memory, local auth, panels, and event log. */
export interface DaemonIntegrationRouteHandlers
  extends DaemonIntegrationOverviewRouteHandlers,
    DaemonDeliveryRouteHandlers,
    DaemonRouteSnapshotRouteHandlers,
    DaemonRemoteOverviewRouteHandlers,
    DaemonPlatformStatusRouteHandlers,
    DaemonMemoryRouteHandlers,
    DaemonLocalAuthAdminRouteHandlers,
    DaemonPanelRouteHandlers,
    DaemonEventLogRouteHandlers {}

/** Route handlers for integration overview endpoints (review, session, tasks, automation, sessions). */
export interface DaemonIntegrationOverviewRouteHandlers {
  getReview(): MaybeResponse;
  getIntegrationSession(): MaybeResponse;
  getIntegrationTasks(): MaybeResponse;
  getIntegrationAutomation(): MaybeResponse;
  /** @param url - When present and contains `limit`/`cursor` params, returns a `PaginatedResponse`. Otherwise returns the legacy session broker snapshot. */
  getIntegrationSessions(url?: URL): MaybeResponse;
}

/** Route handler for the route-snapshot diagnostic endpoint. */
export interface DaemonRouteSnapshotRouteHandlers {
  getRoutesSnapshot(): MaybeResponse;
}

/** Route handlers for platform status: health, accounts, providers, settings, security, continuity, worktrees, and intelligence. */
export interface DaemonPlatformStatusRouteHandlers {
  getHealth(): MaybeResponse;
  getAccounts(): MaybeResponse;
  getProviders(): MaybeResponse;
  getProvider(providerId: string): MaybeResponse;
  getProviderUsage(providerId: string): MaybeResponse;
  getSettings(): MaybeResponse;
  getSecuritySettings(): MaybeResponse;
  getContinuity(): MaybeResponse;
  getWorktrees(): MaybeResponse;
  getIntelligence(): MaybeResponse;
}

/** Route handlers for the memory subsystem: diagnostics, vector stats, review queue, rebuild, and embedding config. */
export interface DaemonMemoryRouteHandlers {
  getMemoryDoctor(): MaybeResponse;
  getMemoryVectorStats(): MaybeResponse;
  getMemoryReviewQueue(url: URL): MaybeResponse;
  postMemoryVectorRebuild(req: Request): MaybeResponse;
  postMemoryEmbeddingDefault(req: Request): MaybeResponse;
}

/** Route handlers for local auth administration: users, passwords, sessions, and bootstrap file management. */
export interface DaemonLocalAuthAdminRouteHandlers {
  getLocalAuth(req: Request): MaybeResponse;
  postLocalAuthUser(req: Request): MaybeResponse;
  deleteLocalAuthUser(username: string, req: Request): MaybeResponse;
  postLocalAuthPassword(username: string, req: Request): MaybeResponse;
  deleteLocalAuthSession(sessionId: string, req: Request): MaybeResponse;
  deleteBootstrapFile(req: Request): MaybeResponse;
}

/** Route handlers for panel listing and open actions. */
export interface DaemonPanelRouteHandlers {
  getPanels(): MaybeResponse;
  postPanelOpen(req: Request): MaybeResponse;
}

/** Route handler for the event log endpoint. */
export interface DaemonEventLogRouteHandlers {
  getEvents(req: Request): MaybeResponse;
}

/** Route handlers for system management: watchers, service control, route bindings, approvals, and config. */
export interface DaemonSystemRouteHandlers {
  getWatchers(): MaybeResponse;
  postWatcher(req: Request): MaybeResponse;
  patchWatcher(watcherId: string, req: Request): MaybeResponse;
  watcherAction(watcherId: string, action: 'start' | 'stop' | 'run', req: Request): MaybeResponse;
  deleteWatcher(watcherId: string, req: Request): MaybeResponse;
  getServiceStatus(): MaybeResponse;
  installService(req: Request): MaybeResponse;
  startService(req: Request): MaybeResponse;
  stopService(req: Request): MaybeResponse;
  restartService(req: Request): MaybeResponse;
  uninstallService(req: Request): MaybeResponse;
  getRouteBindings(req: Request): MaybeResponse;
  postRouteBinding(req: Request): MaybeResponse;
  patchRouteBinding(bindingId: string, req: Request): MaybeResponse;
  deleteRouteBinding(bindingId: string, req: Request): MaybeResponse;
  getApprovals(): MaybeResponse;
  approvalAction(approvalId: string, action: 'claim' | 'approve' | 'deny' | 'cancel', req: Request): MaybeResponse;
  getConfig(req: Request): MaybeResponse;
  postConfig(req: Request): MaybeResponse;
}

/** Route handlers for remote peer management: pair requests, peer tokens, remote work, and node host contract. */
export interface DaemonRemoteManagementRouteHandlers {
  getRemotePairRequests(): MaybeResponse;
  approveRemotePairRequest(requestId: string, req: Request): MaybeResponse;
  rejectRemotePairRequest(requestId: string, req: Request): MaybeResponse;
  getRemotePeers(): MaybeResponse;
  rotateRemotePeerToken(peerId: string, req: Request): MaybeResponse;
  revokeRemotePeerToken(peerId: string, req: Request): MaybeResponse;
  disconnectRemotePeer(peerId: string, req: Request): MaybeResponse;
  getRemoteWork(): MaybeResponse;
  invokeRemotePeer(peerId: string, req: Request): MaybeResponse;
  cancelRemoteWork(workId: string, req: Request): MaybeResponse;
  getRemoteNodeHostContract(): MaybeResponse;
}

/** Route handlers for the knowledge base: sources, nodes, issues, connectors, jobs, schedules, search, and GraphQL. */
export interface DaemonKnowledgeRouteHandlers extends DaemonKnowledgeRefinementRouteHandlers {
  getKnowledgeStatus(url: URL): MaybeResponse;
  getKnowledgeSources(url: URL): MaybeResponse;
  getKnowledgeNodes(url: URL): MaybeResponse;
  getKnowledgeIssues(url: URL): MaybeResponse;
  getKnowledgeItem(id: string, url: URL): MaybeResponse;
  getKnowledgeConnectors(): MaybeResponse;
  getKnowledgeConnector(id: string): MaybeResponse;
  getKnowledgeConnectorDoctor(id: string): MaybeResponse;
  getKnowledgeProjectionTargets(url: URL): MaybeResponse;
  getKnowledgeMap(url: URL): MaybeResponse;
  getKnowledgeGraphqlSchema(): MaybeResponse;
  getKnowledgeExtractions(url: URL): MaybeResponse;
  getKnowledgeUsage(url: URL): MaybeResponse;
  getKnowledgeCandidates(url: URL): MaybeResponse;
  getKnowledgeCandidate(id: string): MaybeResponse;
  getKnowledgeReports(url: URL): MaybeResponse;
  getKnowledgeReport(id: string): MaybeResponse;
  getKnowledgeExtraction(id: string): MaybeResponse;
  getKnowledgeSourceExtraction(id: string): MaybeResponse;
  getKnowledgeJobs(): MaybeResponse;
  getKnowledgeJob(jobId: string): MaybeResponse;
  getKnowledgeJobRuns(url: URL): MaybeResponse;
  getKnowledgeSchedules(url: URL): MaybeResponse;
  getKnowledgeSchedule(id: string): MaybeResponse;
  postKnowledgeIngestUrl(req: Request): MaybeResponse;
  postKnowledgeIngestArtifact(req: Request): MaybeResponse;
  postKnowledgeSyncBrowserHistory(req: Request): MaybeResponse;
  postKnowledgeImportBookmarks(req: Request): MaybeResponse;
  postKnowledgeImportUrls(req: Request): MaybeResponse;
  postKnowledgeIngestConnector(req: Request): MaybeResponse;
  postKnowledgeSearch(req: Request): MaybeResponse;
  postKnowledgeAsk(req: Request): MaybeResponse;
  postKnowledgePacket(req: Request): MaybeResponse;
  postKnowledgeReviewIssue(id: string, req: Request): MaybeResponse;
  postKnowledgeDecideCandidate(id: string, req: Request): MaybeResponse;
  postKnowledgeRunJob(jobId: string, req: Request): MaybeResponse;
  postKnowledgeLint(req: Request): MaybeResponse;
  postKnowledgeReindex(req: Request): MaybeResponse;
  postKnowledgeSaveSchedule(req: Request): MaybeResponse;
  deleteKnowledgeSchedule(id: string, req: Request): MaybeResponse;
  postKnowledgeSetScheduleEnabled(id: string, req: Request): MaybeResponse;
  postKnowledgeRenderProjection(req: Request): MaybeResponse;
  postKnowledgeMaterializeProjection(req: Request): MaybeResponse;
  executeKnowledgeGraphql(req: Request): MaybeResponse;
}

/** Route handlers for knowledge refinement task management. */
export interface DaemonKnowledgeRefinementRouteHandlers {
  getKnowledgeRefinementTasks(url: URL): MaybeResponse;
  getKnowledgeRefinementTask(taskId: string): MaybeResponse;
  postKnowledgeRunRefinement(req: Request): MaybeResponse;
  postKnowledgeCancelRefinementTask(taskId: string, req: Request): MaybeResponse;
}

/** Route handlers for the media surface — voice, web search, artifacts, media providers, and multimodal. */
export interface DaemonMediaRouteHandlers
  extends DaemonVoiceRouteHandlers,
    DaemonWebSearchRouteHandlers,
    DaemonArtifactRouteHandlers,
    DaemonMediaProviderRouteHandlers,
    DaemonMultimodalRouteHandlers {}

/** Route handlers for voice capabilities: providers, voices, TTS, STT, and realtime sessions. */
export interface DaemonVoiceRouteHandlers {
  getVoiceStatus(): MaybeResponse;
  getVoiceProviders(): MaybeResponse;
  getVoiceVoices(url: URL): MaybeResponse;
  postVoiceTts(req: Request): MaybeResponse;
  postVoiceTtsStream(req: Request): MaybeResponse;
  postVoiceStt(req: Request): MaybeResponse;
  postVoiceRealtimeSession(req: Request): MaybeResponse;
}

/** Route handlers for web search provider listing and query execution. */
export interface DaemonWebSearchRouteHandlers {
  getWebSearchProviders(): MaybeResponse;
  postWebSearch(req: Request): MaybeResponse;
}

/** Route handlers for artifact storage: listing, creation, retrieval, and content access. */
export interface DaemonArtifactRouteHandlers {
  getArtifacts(): MaybeResponse;
  postArtifact(req: Request): MaybeResponse;
  getArtifact(artifactId: string): MaybeResponse;
  getArtifactContent(artifactId: string, req: Request): MaybeResponse;
}

/** Route handlers for media provider operations: analyze, transform, and generate. */
export interface DaemonMediaProviderRouteHandlers {
  getMediaProviders(): MaybeResponse;
  postMediaAnalyze(req: Request): MaybeResponse;
  postMediaTransform(req: Request): MaybeResponse;
  postMediaGenerate(req: Request): MaybeResponse;
}

/** Route handlers for multimodal capabilities: status, providers, analyze, packet, and writeback. */
export interface DaemonMultimodalRouteHandlers {
  getMultimodalStatus(): MaybeResponse;
  getMultimodalProviders(): MaybeResponse;
  postMultimodalAnalyze(req: Request): MaybeResponse;
  postMultimodalPacket(req: Request): MaybeResponse;
  postMultimodalWriteback(req: Request): MaybeResponse;
}

/** Route handlers for shared session management: creation, messaging, steering, follow-up, and SSE events. */
export interface DaemonRuntimeSessionRouteHandlers {
  createSharedSession(req: Request): MaybeResponse;
  registerSharedSession(req: Request): MaybeResponse;
  getSharedSession(sessionId: string): MaybeResponse;
  closeSharedSession(sessionId: string, req: Request): MaybeResponse;
  reopenSharedSession(sessionId: string, req: Request): MaybeResponse;
  detachSharedSession(sessionId: string, req: Request): MaybeResponse;
  getSharedSessionMessages(sessionId: string, url: URL): MaybeResponse;
  getSharedSessionInputs(sessionId: string, url: URL): MaybeResponse;
  postSharedSessionMessage(sessionId: string, req: Request): MaybeResponse;
  postSharedSessionSteer(sessionId: string, req: Request): MaybeResponse;
  postSharedSessionFollowUp(sessionId: string, req: Request): MaybeResponse;
  cancelSharedSessionInput(sessionId: string, inputId: string, req: Request): MaybeResponse;
  deliverSharedSessionInput(sessionId: string, inputId: string, req: Request): MaybeResponse;
  getSharedSessionEvents(sessionId: string, req: Request): MaybeResponse;
}

/** Route handlers for runtime task lifecycle: creation, status, and action dispatch (cancel/retry). */
export interface DaemonRuntimeTaskRouteHandlers {
  postTask(req: Request): MaybeResponse;
  getRuntimeTask(taskId: string): MaybeResponse;
  runtimeTaskAction(taskId: string, action: 'cancel' | 'retry', req: Request): MaybeResponse;
  getTaskStatus(agentId: string): MaybeResponse;
}

/** Route handlers for automation job and schedule management: CRUD, runs, heartbeat, and scheduler capacity. */
export interface DaemonRuntimeAutomationRouteHandlers {
  /** @param url - When present and contains `limit`/`cursor` params, returns a `PaginatedResponse`. Otherwise returns the legacy `{jobs}` array. */
  getAutomationJobs(url?: URL): MaybeResponse;
  postAutomationJob(req: Request): MaybeResponse;
  /** @param url - When present and contains `limit`/`cursor` params, returns a `PaginatedResponse`. Otherwise returns the legacy `{runs}` array. */
  getAutomationRuns(url?: URL): MaybeResponse;
  getAutomationRun(runId: string): MaybeResponse;
  getAutomationHeartbeat(): MaybeResponse;
  postAutomationHeartbeat(req: Request): MaybeResponse;
  automationRunAction(runId: string, action: 'cancel' | 'retry', req: Request): MaybeResponse;
  patchAutomationJob(jobId: string, req: Request): MaybeResponse;
  deleteAutomationJob(jobId: string, req: Request): MaybeResponse;
  setAutomationJobEnabled(jobId: string, enabled: boolean, req: Request): MaybeResponse;
  runAutomationJobNow(jobId: string, req: Request): MaybeResponse;
  getSchedules(): MaybeResponse;
  postSchedule(req: Request): MaybeResponse;
  deleteSchedule(scheduleId: string, req: Request): MaybeResponse;
  setScheduleEnabled(scheduleId: string, enabled: boolean, req: Request): MaybeResponse;
  runScheduleNow(scheduleId: string, req: Request): MaybeResponse;
  getSchedulerCapacity(req: Request): MaybeResponse;
}

/** Combined runtime route surface — sessions, tasks, automation, and metrics. */
export interface DaemonRuntimeRouteHandlers
  extends DaemonRuntimeSessionRouteHandlers,
    DaemonRuntimeTaskRouteHandlers,
    DaemonRuntimeAutomationRouteHandlers,
    DaemonRuntimeMetricsRouteHandlers {}

/** Route handler for the runtime metrics endpoint. */
export interface DaemonRuntimeMetricsRouteHandlers {
  getRuntimeMetrics(): MaybeResponse;
}

/**
 * The complete daemon API route handler interface. Implement this to satisfy
 * all routes dispatched by `dispatchDaemonApiRoutes`.
 */
export interface DaemonApiRouteHandlers
  extends DaemonRemoteDispatchRouteHandlers,
    DaemonOperatorRouteHandlers,
    DaemonAutomationRouteHandlers,
    DaemonSessionRouteHandlers,
    DaemonTaskRouteHandlers,
    DaemonRuntimeRouteHandlers {}
