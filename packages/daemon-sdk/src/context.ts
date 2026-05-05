export type MaybeResponse = Response | Promise<Response>;

export interface DaemonRemoteDispatchRouteHandlers
  extends DaemonRemoteOverviewRouteHandlers,
    DaemonRemoteManagementRouteHandlers {}

export interface DaemonRemoteOverviewRouteHandlers {
  getRemote(): MaybeResponse;
}

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

export interface DaemonOperatorRuntimeRouteHandlers {
  getAutomationHeartbeat(): MaybeResponse;
  postAutomationHeartbeat(req: Request): MaybeResponse;
  getSchedulerCapacity(req: Request): MaybeResponse;
  getRuntimeMetrics(): MaybeResponse;
}

export interface DaemonAutomationRouteHandlers
  extends DaemonAutomationOverviewRouteHandlers,
    DaemonRuntimeAutomationRouteHandlers,
    DaemonDeliveryRouteHandlers {}

export interface DaemonAutomationOverviewRouteHandlers {
  getReview(): MaybeResponse;
  getIntegrationSession(): MaybeResponse;
  getIntegrationAutomation(): MaybeResponse;
}

export interface DaemonDeliveryRouteHandlers {
  getDeliveries(): MaybeResponse;
  getDelivery(deliveryId: string): MaybeResponse;
}

export interface DaemonSessionRouteHandlers
  extends DaemonSessionOverviewRouteHandlers,
    DaemonRuntimeSessionRouteHandlers {}

export interface DaemonSessionOverviewRouteHandlers {
  getIntegrationSessions(): MaybeResponse;
}

export interface DaemonTaskRouteHandlers
  extends DaemonTaskOverviewRouteHandlers,
    DaemonRuntimeTaskRouteHandlers {}

export interface DaemonTaskOverviewRouteHandlers {
  getIntegrationTasks(): MaybeResponse;
}

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

export interface DaemonIntegrationOverviewRouteHandlers {
  getReview(): MaybeResponse;
  getIntegrationSession(): MaybeResponse;
  getIntegrationTasks(): MaybeResponse;
  getIntegrationAutomation(): MaybeResponse;
  getIntegrationSessions(): MaybeResponse;
}

export interface DaemonRouteSnapshotRouteHandlers {
  getRoutesSnapshot(): MaybeResponse;
}

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

export interface DaemonMemoryRouteHandlers {
  getMemoryDoctor(): MaybeResponse;
  getMemoryVectorStats(): MaybeResponse;
  postMemoryVectorRebuild(req: Request): MaybeResponse;
  postMemoryEmbeddingDefault(req: Request): MaybeResponse;
}

export interface DaemonLocalAuthAdminRouteHandlers {
  getLocalAuth(req: Request): MaybeResponse;
  postLocalAuthUser(req: Request): MaybeResponse;
  deleteLocalAuthUser(username: string, req: Request): MaybeResponse;
  postLocalAuthPassword(username: string, req: Request): MaybeResponse;
  deleteLocalAuthSession(sessionId: string, req: Request): MaybeResponse;
  deleteBootstrapFile(req: Request): MaybeResponse;
}

export interface DaemonPanelRouteHandlers {
  getPanels(): MaybeResponse;
  postPanelOpen(req: Request): MaybeResponse;
}

export interface DaemonEventLogRouteHandlers {
  getEvents(req: Request): MaybeResponse;
}

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

export interface DaemonKnowledgeRouteHandlers extends DaemonKnowledgeRefinementRouteHandlers {
  getKnowledgeStatus(): MaybeResponse;
  getKnowledgeSources(url: URL): MaybeResponse;
  getKnowledgeNodes(url: URL): MaybeResponse;
  getKnowledgeIssues(url: URL): MaybeResponse;
  getKnowledgeItem(id: string): MaybeResponse;
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

export interface DaemonKnowledgeRefinementRouteHandlers {
  getKnowledgeRefinementTasks(url: URL): MaybeResponse;
  getKnowledgeRefinementTask(taskId: string): MaybeResponse;
  postKnowledgeRunRefinement(req: Request): MaybeResponse;
  postKnowledgeCancelRefinementTask(taskId: string, req: Request): MaybeResponse;
}

export interface DaemonMediaRouteHandlers
  extends DaemonVoiceRouteHandlers,
    DaemonWebSearchRouteHandlers,
    DaemonArtifactRouteHandlers,
    DaemonMediaProviderRouteHandlers,
    DaemonMultimodalRouteHandlers {}

export interface DaemonVoiceRouteHandlers {
  getVoiceStatus(): MaybeResponse;
  getVoiceProviders(): MaybeResponse;
  getVoiceVoices(url: URL): MaybeResponse;
  postVoiceTts(req: Request): MaybeResponse;
  postVoiceTtsStream(req: Request): MaybeResponse;
  postVoiceStt(req: Request): MaybeResponse;
  postVoiceRealtimeSession(req: Request): MaybeResponse;
}

export interface DaemonWebSearchRouteHandlers {
  getWebSearchProviders(): MaybeResponse;
  postWebSearch(req: Request): MaybeResponse;
}

export interface DaemonArtifactRouteHandlers {
  getArtifacts(): MaybeResponse;
  postArtifact(req: Request): MaybeResponse;
  getArtifact(artifactId: string): MaybeResponse;
  getArtifactContent(artifactId: string, req: Request): MaybeResponse;
}

export interface DaemonMediaProviderRouteHandlers {
  getMediaProviders(): MaybeResponse;
  postMediaAnalyze(req: Request): MaybeResponse;
  postMediaTransform(req: Request): MaybeResponse;
  postMediaGenerate(req: Request): MaybeResponse;
}

export interface DaemonMultimodalRouteHandlers {
  getMultimodalStatus(): MaybeResponse;
  getMultimodalProviders(): MaybeResponse;
  postMultimodalAnalyze(req: Request): MaybeResponse;
  postMultimodalPacket(req: Request): MaybeResponse;
  postMultimodalWriteback(req: Request): MaybeResponse;
}

export interface DaemonRuntimeSessionRouteHandlers {
  createSharedSession(req: Request): MaybeResponse;
  getSharedSession(sessionId: string): MaybeResponse;
  closeSharedSession(sessionId: string, req: Request): MaybeResponse;
  reopenSharedSession(sessionId: string, req: Request): MaybeResponse;
  getSharedSessionMessages(sessionId: string, url: URL): MaybeResponse;
  getSharedSessionInputs(sessionId: string, url: URL): MaybeResponse;
  postSharedSessionMessage(sessionId: string, req: Request): MaybeResponse;
  postSharedSessionSteer(sessionId: string, req: Request): MaybeResponse;
  postSharedSessionFollowUp(sessionId: string, req: Request): MaybeResponse;
  cancelSharedSessionInput(sessionId: string, inputId: string, req: Request): MaybeResponse;
  getSharedSessionEvents(sessionId: string, req: Request): MaybeResponse;
}

export interface DaemonRuntimeTaskRouteHandlers {
  postTask(req: Request): MaybeResponse;
  getRuntimeTask(taskId: string): MaybeResponse;
  runtimeTaskAction(taskId: string, action: 'cancel' | 'retry', req: Request): MaybeResponse;
  getTaskStatus(agentId: string): MaybeResponse;
}

export interface DaemonRuntimeAutomationRouteHandlers {
  getAutomationJobs(): MaybeResponse;
  postAutomationJob(req: Request): MaybeResponse;
  getAutomationRuns(): MaybeResponse;
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

export interface DaemonRuntimeRouteHandlers
  extends DaemonRuntimeSessionRouteHandlers,
    DaemonRuntimeTaskRouteHandlers,
    DaemonRuntimeAutomationRouteHandlers,
    DaemonRuntimeMetricsRouteHandlers {}

export interface DaemonRuntimeMetricsRouteHandlers {
  getRuntimeMetrics(): MaybeResponse;
}

export interface DaemonApiRouteHandlers
  extends DaemonRemoteDispatchRouteHandlers,
    DaemonOperatorRouteHandlers,
    DaemonAutomationRouteHandlers,
    DaemonSessionRouteHandlers,
    DaemonTaskRouteHandlers,
    DaemonRuntimeRouteHandlers {}
