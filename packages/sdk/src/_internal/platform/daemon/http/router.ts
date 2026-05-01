import type { ConfigManager } from '../../config/manager.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import { isValidConfigKey } from '../../config/schema.js';
import type { UserAuthManager } from '../../security/user-auth.js';
import { buildOperatorSessionCookie, OPERATOR_SESSION_COOKIE_NAME } from '../../security/http-auth.js';
import type { AgentManager } from '../../tools/agent/index.js';
import { normalizeAtSchedule, normalizeCronSchedule, normalizeEverySchedule, type AutomationManager } from '../../automation/index.js';
import type { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '../../control-plane/index.js';
import type { GatewayMethodCatalog } from '../../control-plane/index.js';
import { buildOperatorContract } from '../../control-plane/operator-contract.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import {
  getProviderRuntimeSnapshot,
  getProviderUsageSnapshot,
  listProviderRuntimeSnapshots,
} from '../../providers/runtime-snapshot.js';
import type { RouteBindingManager, ChannelPolicyManager, ChannelPluginRegistry, SurfaceRegistry } from '../../channels/index.js';
import type { WatcherRegistry } from '../../watchers/index.js';
import type { DistributedPeerAuth, DistributedRuntimeManager } from '../../runtime/remote/index.js';
import type { HomeGraphService, KnowledgeGraphqlService, KnowledgeService, ProjectPlanningService } from '../../knowledge/index.js';
import { inspectKnowledgeGraphqlAccess } from '../../knowledge/index.js';
import type { VoiceService } from '../../voice/index.js';
import type { WebSearchService } from '../../web-search/index.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import type { MediaProviderRegistry } from '../../media/index.js';
import type { MultimodalService } from '../../multimodal/index.js';
import type { IntegrationHelperService } from '../../runtime/integration/helpers.js';
import type { DomainDispatch, RuntimeStore } from '../../runtime/store/index.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { DaemonBatchManager } from '../../batch/index.js';
import { emitCompanionMessageReceived } from '../../runtime/emitters/session.js';
import { correlationCtx } from '../../runtime/correlation.js';
import { TelemetryApiService } from '../../runtime/telemetry/api.js';
import { inspectInboundTls, inspectOutboundTls } from '../../runtime/network/index.js';
import type { MemoryEmbeddingProviderRegistry, MemoryRegistry } from '../../state/index.js';
import { dispatchDaemonApiRoutes } from '../../control-plane/routes/index.js';
import { handleGitHubAutomationWebhook, handleSlackSurfaceWebhook, handleDiscordSurfaceWebhook, handleNtfySurfaceWebhook, handleGenericWebhookSurface } from '../../adapters/index.js';
import { createDaemonKnowledgeRouteHandlers } from './knowledge-routes.js';
import { createDaemonMediaRouteHandlers } from './media-routes.js';
import {
  createDaemonRemoteRouteHandlers,
  handleRemotePairRequest,
  handleRemotePairVerify,
  handleRemotePeerHeartbeat,
  handleRemotePeerWorkPull,
  handleRemotePeerWorkComplete,
} from './remote-routes.js';
import { createDaemonRuntimeRouteHandlers } from './runtime-routes.js';
import { snapshotMetrics } from '../../runtime/metrics.js';
import { createDaemonControlRouteHandlers } from './control-routes.js';
import { createDaemonIntegrationRouteHandlers } from './integration-routes.js';
import { createDaemonTelemetryRouteHandlers } from './telemetry-routes.js';
import { createDaemonChannelRouteHandlers } from './channel-routes.js';
import { createDaemonSystemRouteHandlers } from './system-routes.js';
import {
  buildChannelRouteContext,
  buildKnowledgeRouteContext,
  buildMediaRouteContext,
  buildSystemRouteContext,
} from './router-route-contexts.js';
import type { GenericWebhookAdapterContext, SurfaceAdapterContext } from '../../adapters/index.js';
import type { PlatformServiceManager } from '../service-manager.js';
import type { JsonRecord } from '../helpers.js';
import { jsonErrorResponse } from './error-response.js';
import { AppError } from '../../types/errors.js';
import { VERSION } from '../../version.js';
import type { CompanionChatManager } from '../../companion/companion-chat-manager.js';
import { dispatchCompanionChatRoutes } from '../../companion/companion-chat-routes.js';
import { dispatchProviderRoutes } from './provider-routes.js';
import { dispatchBatchRoutes } from './batch-routes.js';
import { dispatchCloudflareRoutes } from './cloudflare-routes.js';
import { HomeAssistantConversationRoutes } from './homeassistant-routes.js';
import { HomeGraphRoutes } from './home-graph-routes.js';
import { dispatchOpenAICompatibleRoutes } from './openai-compatible-routes.js';
import { ProjectPlanningRoutes } from './project-planning-routes.js';
import { readTextBodyWithinLimit } from '../../utils/request-body.js';

interface DaemonHttpRouterContext {
  readonly configManager: ConfigManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly userAuth: UserAuthManager;
  readonly agentManager: AgentManager;
  readonly automationManager: AutomationManager;
  readonly approvalBroker: ApprovalBroker;
  readonly controlPlaneGateway: ControlPlaneGateway;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly providerRegistry: ProviderRegistry;
  readonly sessionBroker: SharedSessionBroker;
  readonly routeBindings: RouteBindingManager;
  readonly channelPolicy: ChannelPolicyManager;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly watcherRegistry: WatcherRegistry;
  readonly voiceService: VoiceService;
  readonly webSearchService: WebSearchService;
  readonly knowledgeService: KnowledgeService;
  readonly homeGraphService: HomeGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly knowledgeGraphqlService: KnowledgeGraphqlService;
  readonly mediaProviders: MediaProviderRegistry;
  readonly multimodalService: MultimodalService;
  readonly artifactStore: ArtifactStore;
  readonly memoryRegistry: MemoryRegistry;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  readonly platformServiceManager: PlatformServiceManager;
  readonly integrationHelpers: IntegrationHelperService | null;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore | null;
  readonly runtimeDispatch: DomainDispatch | null;
  readonly batchManager?: DaemonBatchManager | null;
  readonly githubWebhookSecret: string | null;
  readonly authToken: () => string | null;
  readonly buildSurfaceAdapterContext: () => SurfaceAdapterContext;
  readonly buildGenericWebhookAdapterContext: () => GenericWebhookAdapterContext;
  readonly checkAuth: (req: Request) => boolean;
  readonly extractAuthToken: (req: Request) => string;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireRemotePeer: (req: Request, scope?: string) => Promise<DistributedPeerAuth | Response>;
  readonly describeAuthenticatedPrincipal: (token: string) => {
    principalId: string;
    principalKind: 'user' | 'bot' | 'service' | 'token';
    admin: boolean;
    scopes: readonly string[];
  } | null;
  readonly invokeGatewayMethodCall: (input: {
    readonly authToken: string;
    readonly methodId: string;
    readonly query?: Record<string, unknown>;
    readonly body?: unknown;
    readonly context?: {
      readonly principalId?: string;
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer';
      readonly admin?: boolean;
      readonly scopes?: readonly string[];
      readonly clientKind?: string;
    };
  }) => Promise<{ status: number; ok: boolean; body: unknown }>;
  readonly queueSurfaceReplyFromBinding: (
    binding: import('@pellux/goodvibes-sdk/platform/automation/routes').AutomationRouteBinding | undefined,
    input: { readonly agentId: string; readonly task: string; readonly agentTask?: string; readonly workflowChainId?: string; readonly sessionId?: string },
  ) => void;
  readonly surfaceDeliveryEnabled: (
    surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix',
  ) => boolean;
  readonly syncSpawnedAgentTask: (record: import('../../tools/agent/index.js').AgentRecord, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: import('../../tools/agent/index.js').AgentRecord) => void;
  /**
   * WorkspaceSwapManager instance for delegating POST /config runtime.workingDir
   * requests. Null in embedded/test contexts that don't support live workspace swaps.
   */
  readonly swapManager: import('../../../daemon/system-route-types.js').WorkspaceSwapManagerLike | null;
  /**
   * Optional companion chat manager. When present, companion chat routes
   * (/api/companion/chat/...) are enabled. Injected by the daemon facade
   * when the companion feature is active.
   */
  readonly companionChatManager?: CompanionChatManager | null;
  /**
   * F16b: Resolve the current default provider/model from the provider registry.
   * Forwarded into CompanionChatRouteContext so that session-create can fill in
   * provider/model when the caller does not supply them. Optional — when absent,
   * the legacy behavior (null provider/model allowed through) is preserved.
   */
  readonly resolveDefaultProviderModel?: () => { provider: string; model: string } | null;
  /**
   * SecretsManager instance used to resolve provider API keys stored as secrets
   * rather than env vars. Threaded into ProviderRouteContext so that
   * resolveSecretKeys() can return the correct configuredVia='secrets' tier.
   * Without this, the production router always passes undefined and the secrets
   * tier is permanently dead on live code paths.
   */
  readonly secretsManager?: Pick<import('../../config/secrets.js').SecretsManager, 'get' | 'set' | 'getGlobalHome'> | null;
  readonly trySpawnAgent: (
    input: Parameters<AgentManager['spawn']>[0],
    logLabel?: string,
    sessionId?: string,
  ) => import('../../tools/agent/index.js').AgentRecord | Response;
}

export class DaemonHttpRouter {
  private readonly telemetryApi: TelemetryApiService | null;
  private homeAssistantRoutes: HomeAssistantConversationRoutes | null = null;
  private homeGraphRoutes: HomeGraphRoutes | null = null;
  private projectPlanningRoutes: ProjectPlanningRoutes | null = null;

  constructor(private readonly context: DaemonHttpRouterContext) {
    this.telemetryApi = context.runtimeStore
      ? new TelemetryApiService({
        runtimeBus: context.runtimeBus,
        runtimeStore: context.runtimeStore,
      })
      : null;
  }

  dispose(): void {
    this.telemetryApi?.dispose();
    this.context.batchManager?.dispose();
  }

  async handleRequest(req: Request): Promise<Response> {
    return correlationCtx.run(
      { requestId: req.headers.get('x-request-id') ?? crypto.randomUUID() },
      async () => {
        const url = new URL(req.url);

        if (url.pathname === '/login' && req.method === 'POST') {
          return this.handleLogin(req);
        }

        if (url.pathname === '/api/remote/pair/request' && req.method === 'POST') {
          return handleRemotePairRequest({
            parseJsonBody: (request) => this.parseJsonBody(request),
            distributedRuntime: this.context.distributedRuntime,
          }, req);
        }
        if (url.pathname === '/api/remote/pair/verify' && req.method === 'POST') {
          return handleRemotePairVerify({
            parseJsonBody: (request) => this.parseJsonBody(request),
            distributedRuntime: this.context.distributedRuntime,
          }, req);
        }
        if (url.pathname === '/api/remote/heartbeat' && req.method === 'POST') {
          return handleRemotePeerHeartbeat({
            parseJsonBody: (request) => this.parseJsonBody(request),
            requireRemotePeer: (request, scope) => this.context.requireRemotePeer(request, scope),
            distributedRuntime: this.context.distributedRuntime,
          }, req);
        }
        if (url.pathname === '/api/remote/work/pull' && req.method === 'POST') {
          return handleRemotePeerWorkPull({
            parseJsonBody: (request) => this.parseJsonBody(request),
            requireRemotePeer: (request, scope) => this.context.requireRemotePeer(request, scope),
            distributedRuntime: this.context.distributedRuntime,
          }, req);
        }
        const remoteWorkCompleteMatch = url.pathname.match(/^\/api\/remote\/work\/([^/]+)\/complete$/);
        if (remoteWorkCompleteMatch && req.method === 'POST') {
          return handleRemotePeerWorkComplete({
            parseJsonBody: (request) => this.parseJsonBody(request),
            requireRemotePeer: (request, scope) => this.context.requireRemotePeer(request, scope),
            distributedRuntime: this.context.distributedRuntime,
          }, remoteWorkCompleteMatch[1], req);
        }

        if (url.pathname === '/webhook/github' && req.method === 'POST') {
          return this.handleGitHubWebhook(req);
        }
        if (url.pathname.startsWith('/webhook/')) {
          const pluginResponse = await this.context.channelPlugins.handleInbound(url.pathname, req);
          if (pluginResponse) return pluginResponse;
        }

        if (url.pathname === '/api/control-plane/web' && req.method === 'GET') {
          return this.context.controlPlaneGateway.renderWebUi();
        }
        if ((url.pathname === '/api/control-plane/auth' || url.pathname === '/api/control-plane/whoami') && req.method === 'GET') {
          const apiResponse = await this.dispatchApiRoutes(req);
          if (apiResponse) return apiResponse;
        }

        if (!this.context.checkAuth(req)) {
          return jsonErrorResponse(
            new AppError('Authentication required', 'AUTH_REQUIRED', false, {
              category: 'authentication',
              source: 'runtime',
              guidance: 'Authenticate with the operator shared token or an authenticated user session before calling daemon APIs.',
            }),
            { status: 401 },
          );
        }

        const apiResponse = await this.dispatchApiRoutes(req);
        if (apiResponse) return apiResponse;
        return jsonErrorResponse(
          new AppError(`Route not found: ${url.pathname}`, 'NOT_FOUND', false, {
            category: 'not_found',
            source: 'runtime',
            guidance: 'Check the daemon API path and version. New SDK-facing routes are published under /api/v1.',
          }),
          { status: 404 },
        );
      },
    );
  }

  async dispatchApiRoutes(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const openAICompatibleEnabled = this.context.configManager.get('controlPlane.openaiCompatible.enabled') !== false;
    if (openAICompatibleEnabled) {
      const pathPrefix = this.context.configManager.get('controlPlane.openaiCompatible.pathPrefix');
      const response = await dispatchOpenAICompatibleRoutes(req, {
        providerRegistry: this.context.providerRegistry,
        parseJsonBody: (request: Request) => this.parseJsonBody(request),
        recordApiResponse: (request, path, routeResponse) => this.recordApiResponse(request, path, routeResponse),
      }, typeof pathPrefix === 'string' && pathPrefix.trim() ? pathPrefix : '/v1');
      if (response) return response;
    }

    if (url.pathname.startsWith('/api/batch')) {
      if (!this.context.batchManager) {
        return Response.json({ error: 'Batch manager is not available', code: 'BATCH_MANAGER_UNAVAILABLE' }, { status: 503 });
      }
      const batchResponse = await dispatchBatchRoutes(req, {
        batchManager: this.context.batchManager,
        parseJsonBody: (request: Request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request: Request) => this.parseOptionalJsonBody(request),
      });
      if (batchResponse) return batchResponse;
    }

    if (url.pathname.startsWith('/api/cloudflare')) {
      const adminError = this.context.requireAdmin(req);
      if (adminError) return adminError;
      const cloudflareResponse = await dispatchCloudflareRoutes(req, {
        configManager: this.context.configManager,
        secretsManager: this.context.secretsManager,
        authToken: this.context.authToken,
        parseJsonBody: (request: Request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request: Request) => this.parseOptionalJsonBody(request),
      });
      if (cloudflareResponse) return cloudflareResponse;
    }

    if (url.pathname.startsWith('/api/homeassistant')) {
      const homeGraphResponse = await this.getHomeGraphRoutes().handle(req);
      if (homeGraphResponse) return homeGraphResponse;
      const homeAssistantResponse = await this.getHomeAssistantRoutes().handle(req);
      if (homeAssistantResponse) return homeAssistantResponse;
    }

    if (url.pathname.startsWith('/api/projects/planning')) {
      const projectPlanningResponse = await this.getProjectPlanningRoutes().handle(req);
      if (projectPlanningResponse) return projectPlanningResponse;
    }

    // Companion chat routes — scoped to /api/companion/chat/..., session-isolated.
    // Handled before the main API router so they never touch the global control-plane feed.
    // Provider discovery + model-switching routes
    if (req.url.includes('/api/providers')) {
      const providerResponse = await dispatchProviderRoutes(req, {
        providerRegistry: this.context.providerRegistry,
        configManager: this.context.configManager,
        runtimeBus: this.context.runtimeBus,
        parseJsonBody: (request: Request) => this.parseJsonBody(request),
        // threaded for configuredVia='secrets' tier — see DaemonHttpRouterContext.secretsManager doc above
        secretsManager: this.context.secretsManager,
      });
      if (providerResponse) return providerResponse;
    }

    if (this.context.companionChatManager && req.url.includes('/api/companion/chat/')) {
      const gateway = this.context.controlPlaneGateway;
      const chatManager = this.context.companionChatManager;
      const companionResponse = await dispatchCompanionChatRoutes(req, {
        chatManager,
        parseJsonBody: (request: Request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request: Request) => this.parseOptionalJsonBody(request),
        resolveDefaultProviderModel: this.context.resolveDefaultProviderModel,
        openSessionEventStream: (request: Request, sessionId: string) => {
          // Create a session-scoped SSE stream. Use the clientId as the isolation key.
          const clientId = `companion-chat:${sessionId}`;
          chatManager.registerSubscriber(sessionId, clientId);
          return gateway.createEventStream(request, {
            clientId,
            // Companion chat sessions are isolated per-session via the clientId above;
            // we reuse 'web' as the clientKind since the gateway's kind union does not
            // yet include 'companion'. Client-side filtering uses clientId, not clientKind.
            clientKind: 'web',
            sessionId,
            label: `companion-chat/${sessionId}`,
          });
        },
      });
      if (companionResponse) return companionResponse;
    }

    return dispatchDaemonApiRoutes(req, {
      ...createDaemonControlRouteHandlers({
        authToken: this.context.authToken(),
        version: VERSION,
        sessionCookieName: OPERATOR_SESSION_COOKIE_NAME,
        controlPlaneGateway: this.context.controlPlaneGateway,
        extractAuthToken: this.context.extractAuthToken,
        resolveAuthenticatedPrincipal: (request) => {
          const token = this.context.extractAuthToken(request);
          return token ? this.context.describeAuthenticatedPrincipal(token) : null;
        },
        gatewayMethods: this.context.gatewayMethods,
        getOperatorContract: () => buildOperatorContract(this.context.gatewayMethods),
        inspectInboundTls: (surface) => inspectInboundTls(this.context.configManager, surface),
        inspectOutboundTls: () => inspectOutboundTls(this.context.configManager),
        invokeGatewayMethodCall: this.context.invokeGatewayMethodCall,
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        requireAdmin: this.context.requireAdmin,
        requireAuthenticatedSession: this.context.requireAuthenticatedSession,
      }, req),
      ...createDaemonIntegrationRouteHandlers({
        channelPlugins: this.context.channelPlugins,
        integrationHelpers: this.context.integrationHelpers,
        memoryEmbeddingRegistry: this.context.memoryEmbeddingRegistry,
        memoryRegistry: this.context.memoryRegistry,
        parseJsonBody: (request) => this.parseJsonBody(request),
        providerRuntime: {
          listSnapshots: () => listProviderRuntimeSnapshots(this.context.providerRegistry),
          getSnapshot: (providerId) => getProviderRuntimeSnapshot(this.context.providerRegistry, providerId),
          getUsageSnapshot: (providerId) => getProviderUsageSnapshot(this.context.providerRegistry, providerId),
        },
        requireAdmin: (request) => this.context.requireAdmin(request),
        userAuth: this.context.userAuth,
      }, req),
      ...createDaemonTelemetryRouteHandlers({
        telemetryApi: this.telemetryApi,
        resolveAuthenticatedPrincipal: (request) => {
          const token = this.context.extractAuthToken(request);
          return token ? this.context.describeAuthenticatedPrincipal(token) : null;
        },
        ingestSink: this.telemetryApi,
      }),
      ...createDaemonChannelRouteHandlers({
        ...buildChannelRouteContext({
          channelPlugins: this.context.channelPlugins,
          channelPolicy: this.context.channelPolicy,
          parseJsonBody: (request) => this.parseJsonBody(request),
          parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
          requireAdmin: (request) => this.context.requireAdmin(request),
          surfaceRegistry: this.context.surfaceRegistry,
        }),
      }),
      ...createDaemonSystemRouteHandlers({
        ...buildSystemRouteContext({
          approvalBroker: this.context.approvalBroker,
          configManager: this.context.configManager,
          integrationHelpers: this.context.integrationHelpers,
          inspectInboundTls: (surface) => inspectInboundTls(this.context.configManager, surface),
          inspectOutboundTls: () => inspectOutboundTls(this.context.configManager),
          isValidConfigKey,
          parseJsonBody: (request) => this.parseJsonBody(request),
          parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
          platformServiceManager: this.context.platformServiceManager,
          recordApiResponse: (request, path, response, clientKind) => this.recordApiResponse(request, path, response, clientKind),
          requireAdmin: (request) => this.context.requireAdmin(request),
          requireAuthenticatedSession: (request) => this.context.requireAuthenticatedSession(request),
          routeBindings: this.context.routeBindings,
          swapManager: this.context.swapManager,
          watcherRegistry: this.context.watcherRegistry,
        }),
      }, req),
      ...createDaemonRuntimeRouteHandlers({
        parseJsonBody: (request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        recordApiResponse: (request, path, response) => this.recordApiResponse(request, path, response),
        requireAdmin: (request) => this.context.requireAdmin(request),
        sessionBroker: {
          start: () => this.context.sessionBroker.start(),
          submitMessage: (input) => this.context.sessionBroker.submitMessage(
            input as Parameters<SharedSessionBroker['submitMessage']>[0],
          ),
          steerMessage: (input) => this.context.sessionBroker.steerMessage(
            input as Parameters<SharedSessionBroker['steerMessage']>[0],
          ),
          followUpMessage: (input) => this.context.sessionBroker.followUpMessage(
            input as Parameters<SharedSessionBroker['followUpMessage']>[0],
          ),
          bindAgent: async (sessionId, agentId) => {
            await this.context.sessionBroker.bindAgent(sessionId, agentId);
          },
          createSession: (input) => this.context.sessionBroker.createSession(
            input as Parameters<SharedSessionBroker['createSession']>[0],
          ),
          getSession: (sessionId) => this.context.sessionBroker.getSession(sessionId),
          getMessages: (sessionId, limit) => this.context.sessionBroker.getMessages(sessionId, limit),
          getInputs: (sessionId, limit) => this.context.sessionBroker.getInputs(sessionId, limit),
          closeSession: (sessionId) => this.context.sessionBroker.closeSession(sessionId),
          reopenSession: (sessionId) => this.context.sessionBroker.reopenSession(sessionId),
          cancelInput: (sessionId, inputId) => this.context.sessionBroker.cancelInput(sessionId, inputId),
          completeAgent: async (sessionId, agentId, message, meta) => {
            await this.context.sessionBroker.completeAgent(sessionId, agentId, message, meta);
          },
          appendCompanionMessage: (sessionId, input) =>
            this.context.sessionBroker.appendCompanionMessage(sessionId, input),
        },
        agentManager: {
          getStatus: (agentId) => this.context.agentManager.getStatus(agentId),
          cancel: (agentId) => this.context.agentManager.cancel(agentId),
        },
        automationManager: {
          listJobs: () => this.context.automationManager.listJobs(),
          listRuns: () => this.context.automationManager.listRuns(),
          getRun: (runId) => this.context.automationManager.getRun(runId) ?? null,
          triggerHeartbeat: (input) => this.context.automationManager.triggerHeartbeat(input),
          cancelRun: (runId, reason) => this.context.automationManager.cancelRun(runId, reason),
          retryRun: (runId) => this.context.automationManager.retryRun(runId),
          createJob: (input) => this.context.automationManager.createJob(input as unknown as import('../../automation/index.js').CreateAutomationJobInput),
          updateJob: (jobId, input) => this.context.automationManager.updateJob(jobId, input as unknown as import('../../automation/index.js').UpdateAutomationJobInput),
          removeJob: async (jobId) => {
            await this.context.automationManager.removeJob(jobId);
          },
          setEnabled: (jobId, enabled) => this.context.automationManager.setEnabled(jobId, enabled),
          runNow: (jobId) => this.context.automationManager.runNow(jobId),
          getSchedulerCapacity: () => this.context.automationManager.getSchedulerCapacity(),
        },
        normalizeAtSchedule,
        normalizeEverySchedule,
        normalizeCronSchedule,
        routeBindings: {
          start: () => this.context.routeBindings.start(),
          getBinding: (id) => this.context.routeBindings.getBinding(id),
        },
        trySpawnAgent: (input, logLabel, sessionId) => this.context.trySpawnAgent({
          ...input,
          ...(input.tools ? { tools: [...input.tools] } : {}),
        } as Parameters<AgentManager['spawn']>[0], logLabel, sessionId),
        queueSurfaceReplyFromBinding: (binding, input) => this.context.queueSurfaceReplyFromBinding(
          binding as Parameters<typeof this.context.queueSurfaceReplyFromBinding>[0],
          input,
        ),
        surfaceDeliveryEnabled: (surface) => this.context.surfaceDeliveryEnabled(surface),
        syncSpawnedAgentTask: (record, sessionId) => this.context.syncSpawnedAgentTask(
          record as Parameters<typeof this.context.syncSpawnedAgentTask>[0],
          sessionId,
        ),
        syncFinishedAgentTask: (record) => this.context.syncFinishedAgentTask(
          record as Parameters<typeof this.context.syncFinishedAgentTask>[0],
        ),
        configManager: this.context.configManager,
        runtimeStore: this.context.runtimeStore,
        runtimeDispatch: this.context.runtimeDispatch,
        publishConversationFollowup: (sessionId, envelope) => {
          // Scope the event to TUI-kind clients only: non-TUI clients (web, companion
          // app, etc.) must not receive raw operator conversation follow-ups. Using
          // clientKind:'tui' ensures only the TUI surface receives this event.
          this.context.controlPlaneGateway.publishEvent(
            'conversation.followup.companion',
            { sessionId, ...envelope },
            { clientKind: 'tui' },
          );
          // Also emit on the runtime bus so the in-process TUI surface can
          // subscribe and render the companion message in the conversation view.
          emitCompanionMessageReceived(
            this.context.runtimeBus,
            { sessionId, traceId: `companion:${envelope.messageId}`, source: 'companion-followup' },
            { sessionId, ...envelope },
          );
        },
        snapshotMetrics: () => snapshotMetrics(),
        openSessionEventStream: (req, sessionId) => {
          // Create a session-scoped SSE stream for the companion app to receive
          // turn events (STREAM_DELTA, TURN_COMPLETED, etc.) and agent events.
          // The 'turn' domain is included in DEFAULT_DOMAINS so turn events
          // automatically flow to all SSE subscribers without extra configuration.
          const clientId = `shared-session:${sessionId}`;
          return this.context.controlPlaneGateway.createEventStream(req, {
            clientId,
            clientKind: 'web',
            sessionId,
            label: `shared-session/${sessionId}`,
          });
        },
      }),
      ...createDaemonRemoteRouteHandlers({
        authToken: this.context.authToken(),
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireAdmin: (request) => this.context.requireAdmin(request),
        requireRemotePeer: (request, scope) => this.context.requireRemotePeer(request, scope),
        requireAuthenticatedSession: (request) => this.context.requireAuthenticatedSession(request),
        distributedRuntime: this.context.distributedRuntime,
      }),
      ...createDaemonKnowledgeRouteHandlers({
        ...buildKnowledgeRouteContext({
          artifactStore: this.context.artifactStore,
          configManager: this.context.configManager,
          inspectGraphqlAccess: inspectKnowledgeGraphqlAccess,
          normalizeAtSchedule,
          normalizeEverySchedule,
          normalizeCronSchedule,
          parseJsonBody: (request) => this.parseJsonBody(request),
          parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
          parseJsonText: (raw) => this.parseJsonText(raw),
          requireAdmin: (request) => this.context.requireAdmin(request),
          resolveAuthenticatedPrincipal: (request) => {
            const token = this.context.extractAuthToken(request);
            return token ? this.context.describeAuthenticatedPrincipal(token) : null;
          },
          knowledgeService: this.context.knowledgeService,
          knowledgeGraphqlService: this.context.knowledgeGraphqlService,
        }),
      }),
      ...createDaemonMediaRouteHandlers({
        ...buildMediaRouteContext({
          artifactStore: this.context.artifactStore,
          configManager: this.context.configManager,
          mediaProviders: this.context.mediaProviders,
          multimodalService: this.context.multimodalService,
          parseJsonBody: (request) => this.parseJsonBody(request),
          requireAdmin: (request) => this.context.requireAdmin(request),
          voiceService: this.context.voiceService,
          webSearchService: this.context.webSearchService,
        }),
      }),
    });
  }

  private getHomeAssistantRoutes(): HomeAssistantConversationRoutes {
    if (!this.homeAssistantRoutes) {
      const chatManager = this.context.companionChatManager;
      if (!chatManager) {
        throw new Error('Home Assistant remote chat manager is unavailable.');
      }
      this.homeAssistantRoutes = new HomeAssistantConversationRoutes({
        configManager: this.context.configManager,
        routeBindings: this.context.routeBindings,
        chatManager,
        parseJsonBody: (request) => this.parseJsonBody(request),
        resolveDefaultProviderModel: this.context.resolveDefaultProviderModel,
      });
    }
    return this.homeAssistantRoutes;
  }

  private getHomeGraphRoutes(): HomeGraphRoutes {
    if (!this.homeGraphRoutes) {
      this.homeGraphRoutes = new HomeGraphRoutes({
        artifactStore: this.context.artifactStore,
        homeGraphService: this.context.homeGraphService,
        parseJsonBody: (request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        requireAdmin: (request) => this.context.requireAdmin(request),
      });
    }
    return this.homeGraphRoutes;
  }

  private getProjectPlanningRoutes(): ProjectPlanningRoutes {
    if (!this.projectPlanningRoutes) {
      this.projectPlanningRoutes = new ProjectPlanningRoutes({
        projectPlanningService: this.context.projectPlanningService,
        parseJsonBody: (request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        requireAdmin: (request) => this.context.requireAdmin(request),
      });
    }
    return this.projectPlanningRoutes;
  }

  async parseJsonBody(req: Request): Promise<JsonRecord | Response> {
    // SEC-05: cap inbound JSON bodies at 1 MiB to prevent memory exhaustion.
    const MAX_JSON_BYTES = 1 * 1024 * 1024; // 1 MiB
    try {
      const text = await readTextBodyWithinLimit(req, MAX_JSON_BYTES);
      if (text instanceof Response) return text;
      return this.parseJsonText(text);
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  async parseOptionalJsonBody(req: Request): Promise<JsonRecord | null | Response> {
    // SEC-05: cap inbound JSON bodies at 1 MiB to prevent memory exhaustion.
    const MAX_JSON_BYTES = 1 * 1024 * 1024; // 1 MiB
    const raw = await readTextBodyWithinLimit(req, MAX_JSON_BYTES);
    if (raw instanceof Response) return raw;
    if (!raw.trim()) return null;
    return this.parseJsonText(raw);
  }

  parseJsonText(rawBody: string): JsonRecord | Response {
    try {
      return JSON.parse(rawBody) as JsonRecord;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  recordApiResponse(
    req: Request,
    path: string,
    response: Response,
    clientKind:
      | 'web'
      | 'slack'
      | 'discord'
      | 'ntfy'
      | 'webhook'
      | 'homeassistant'
      | 'telegram'
      | 'google-chat'
      | 'signal'
      | 'whatsapp'
      | 'imessage'
      | 'msteams'
      | 'bluebubbles'
      | 'mattermost'
      | 'matrix'
      | 'daemon' = 'web',
  ): Response {
    this.context.controlPlaneGateway.recordApiRequest({
      method: req.method,
      path,
      status: response.status,
      clientKind,
      ...(response.status >= 400 ? { error: `${req.method} ${path} -> ${response.status}` } : {}),
    });
    return response;
  }

  private async handleLogin(req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;

    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = this.context.userAuth.authenticate(username, password);

    if (!user) {
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const session = this.context.userAuth.createSession(user.username);
    return Response.json({
      authenticated: true,
      token: session.token,
      username: session.username,
      expiresAt: session.expiresAt,
    }, {
      headers: {
        'Set-Cookie': buildOperatorSessionCookie(session.token, {
          req,
          expiresAt: session.expiresAt,
          trustProxy: Boolean(this.context.configManager.get('controlPlane.trustProxy')),
        }),
      },
    });
  }

  private async handleGitHubWebhook(req: Request): Promise<Response> {
    return handleGitHubAutomationWebhook(req, {
      serviceRegistry: this.context.serviceRegistry,
      githubWebhookSecret: this.context.githubWebhookSecret,
      trySpawnAgent: (input, logLabel, sessionId) => this.context.trySpawnAgent(input, logLabel, sessionId),
    });
  }

  async handleSlackWebhook(req: Request): Promise<Response> {
    return handleSlackSurfaceWebhook(req, this.context.buildSurfaceAdapterContext());
  }

  async handleDiscordWebhook(req: Request): Promise<Response> {
    return handleDiscordSurfaceWebhook(req, this.context.buildSurfaceAdapterContext());
  }

  async handleNtfyWebhook(req: Request): Promise<Response> {
    return handleNtfySurfaceWebhook(req, this.context.buildSurfaceAdapterContext());
  }

  async handleGenericWebhook(req: Request): Promise<Response> {
    return handleGenericWebhookSurface(req, this.context.buildGenericWebhookAdapterContext());
  }
}
