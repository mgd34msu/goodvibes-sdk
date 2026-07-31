/**
 * session-runtime.ts — the per-session half of a hosted session: the loop.
 *
 * The workspace floor (workspace-floor.ts) supplies everything a turn needs
 * that is shared — the model stack, the agent graph, hooks, plugins, the file
 * cache and project index, the permission manager with the product's trust
 * gate on its ask seam. This file builds what a turn needs that is NOT shared:
 *
 *  - a `ConversationManager` — this session's history, restorable from disk;
 *  - a `ToolRegistry` populated by the SAME `registerAllTools` a terminal
 *    calls, rooted at THIS session's workspace, with this session's id
 *    resolving for the task tool;
 *  - a `ContextAccountingHolder` bound to this session's orchestrator, so the
 *    context_accounting tool reports this conversation rather than another;
 *  - the `Orchestrator` itself.
 *
 * The permission path is deliberately NOT rebuilt here. `floor.services
 * .permissionManager` is the manager the product composed, with the ask seam
 * the product chose (for the daemon: the workspace trust gate in front of the
 * approval broker, so a hosted run's ask becomes an approval record any
 * attached surface can answer). Building a second manager here would give
 * hosted runs a different gate from the one the product's own composition
 * documents — which is the exact defect the trust-gated seam was added to fix.
 *
 * The approval-DERIVED handlers (sandbox escalation, exec terminal prompts, the
 * localhost-fetch one-tap) are rebuilt from that same `requestApproval` seam,
 * because the floor exposes the seam rather than the handlers. Same seam, same
 * gate, so a hosted run asks exactly like a terminal run.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { ConversationManager } from '../core/conversation.js';
import { Orchestrator } from '../core/orchestrator.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerAllTools } from '../tools/index.js';
import { ContextAccountingHolder } from '../tools/context-accounting/index.js';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '../runtime/feature-announcements.js';
import { createApprovalDerivedHandlers } from '../runtime/permissions/permission-composition.js';
import type { SessionLiveTurnControls } from '../control-plane/routes/session-runtime.js';
import type { ModelDefinition } from '../providers/registry.js';
import { withHostedSessionModel } from './model-route.js';
import type { HostedWorkspaceFloor } from './workspace-floor.js';

/** What a hosted session's loop is composed with. */
export interface HostedSessionRuntimeOptions {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly floor: HostedWorkspaceFloor;
  /**
   * The base system prompt for this session's turns. The orchestrator appends
   * the runtime-awareness block itself, so this is the product's own operator
   * policy and nothing more.
   */
  readonly systemPrompt: string;
  /**
   * This session's model, already resolved against the live registry (see
   * model-route.ts). Omitted ⇒ the session follows the shared registry's
   * current selection, exactly as a terminal does.
   */
  readonly model?: ModelDefinition | undefined;
}

/**
 * A composed hosted session. Everything a caller needs to drive one turn, read
 * its history, and take it apart again.
 */
export interface HostedSessionRuntime {
  readonly sessionId: string;
  readonly conversation: ConversationManager;
  readonly toolRegistry: ToolRegistry;
  readonly orchestrator: Orchestrator;
  /** The per-call cancel / queued-message surface the session verbs act on. */
  readonly liveTurnControls: SessionLiveTurnControls;
  /** True while a turn is in flight. */
  isRunning(): boolean;
  /**
   * Submit a user message. Resolves when the turn this call started has ended;
   * a message submitted while a turn is running is QUEUED by the orchestrator
   * and this resolves immediately, which is the same contract a terminal has.
   */
  submit(text: string): Promise<void>;
  /** Interrupt the in-flight turn. Returns whether one was running. */
  cancel(): boolean;
  dispose(): void;
}

/** Compose one hosted session's loop over an already-acquired workspace floor. */
export function createHostedSessionRuntime(options: HostedSessionRuntimeOptions): HostedSessionRuntime {
  const services = options.floor.services;
  const sessionId = options.sessionId;
  const conversation = new ConversationManager();
  const toolRegistry = new ToolRegistry();
  const contextAccountingHolder = new ContextAccountingHolder();

  // Per-session selection over the ONE shared registry (model-route.ts): every
  // mutation still lands on the shared instance; only `getCurrentModel` differs.
  const providerRegistry = options.model
    ? withHostedSessionModel(services.providerRegistry, options.model)
    : services.providerRegistry;

  const announcementStore = new FeatureAnnouncementStore(featureAnnouncementsPath(services.configManager));
  const approvalHandlers = createApprovalDerivedHandlers({
    requestApproval: services.requestApproval,
    providerRegistry,
    configManager: services.configManager,
    featureFlags: services.featureFlags,
    announcementStore,
  });

  registerAllTools(toolRegistry, {
    // Shared per WORKSPACE, deliberately: two sessions editing one tree must
    // agree about the file they both just wrote (see workspace-floor.ts).
    fileCache: services.fileCache,
    projectIndex: services.projectIndex,
    fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager,
    processManager: services.processManager,
    agentManager: services.agentManager,
    agentMessageBus: services.agentMessageBus,
    webSearchService: services.webSearchService,
    workflowServices: services.workflow,
    mcpRegistry: services.mcpRegistry,
    sessionOrchestration: services.sessionOrchestration,
    // Per SESSION: without it every task-tool ref lands in the unowned legacy
    // namespace and owner-existence reaping cannot run.
    resolveSessionId: () => sessionId,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    workingDirectory: options.workspaceRoot,
    surfaceRoot: services.surfaceRoot,
    archetypeLoader: services.archetypeLoader,
    configManager: services.configManager,
    providerRegistry,
    toolLLM: services.toolLLM,
    featureFlags: services.featureFlags,
    serviceRegistry: services.serviceRegistry,
    secretsManager: services.secretsManager,
    overflowHandler: services.overflowHandler,
    contextAccountingHolder,
    // A file the read tool would gate must not leak its content through a
    // search — the same filter a terminal composition installs.
    readAccessFilter: (path: string) => services.permissionManager.previewReadAccess(path) === 'allow',
    sandboxEscalationHandler: approvalHandlers.sandboxEscalationHandler,
    execPromptAnswerHandler: approvalHandlers.execPromptAnswerHandler,
    localhostFetchApproval: approvalHandlers.localhostFetchApproval,
    onSandboxedRun: approvalHandlers.onSandboxedRun,
  });

  const orchestrator = new Orchestrator({
    conversation,
    // A hosted session has no viewport. The scroll seam is the renderer's, and
    // reporting a fixed height is honest here rather than pretending to measure
    // a terminal that is not attached.
    getViewportHeight: () => 0,
    scrollToEnd: () => {},
    toolRegistry,
    permissionManager: services.permissionManager,
    getSystemPrompt: () => options.systemPrompt,
    hookDispatcher: services.hookDispatcher,
    flagManager: services.featureFlags,
    runtimeBus: services.runtimeBus,
    sessionId,
    services: {
      agentManager: services.agentManager,
      // No review/fix chains on this floor: an honest empty listing rather than
      // a missing dependency (see workspace-floor.ts).
      wrfcController: options.floor.wrfcController ?? { listChains: () => [] },
    },
  });
  orchestrator.setCoreServices({
    configManager: services.configManager,
    providerRegistry,
  });

  let running = false;
  const runtime: HostedSessionRuntime = {
    sessionId,
    conversation,
    toolRegistry,
    orchestrator,
    liveTurnControls: {
      cancelToolCall: (callId: string) => orchestrator.cancelToolCall(callId),
      listQueuedMessages: () => orchestrator.listQueuedMessages(),
      editQueuedMessage: (id: string, text: string) => orchestrator.editQueuedMessage(id, text),
      deleteQueuedMessage: (id: string) => orchestrator.deleteQueuedMessage(id),
    },
    isRunning: () => running,
    submit: async (text: string): Promise<void> => {
      running = true;
      try {
        // `ownerDirect` is deliberately unset. It attests that the transport
        // authenticated the OWNER himself, and a verb call carrying an operator
        // token cannot honestly claim that — leaving it unset keeps the
        // untrusted-content window open, which is the safe direction.
        await orchestrator.handleUserInput(text, undefined, {
          origin: { source: 'hosted-session', surface: 'service' },
        });
      } finally {
        running = false;
      }
    },
    cancel: (): boolean => {
      if (!orchestrator.isThinking) return false;
      orchestrator.abort();
      return true;
    },
    dispose: (): void => {
      try {
        orchestrator.dispose();
      } catch (error) {
        logger.debug('[hosted-sessions] orchestrator disposal raised', {
          sessionId,
          error: summarizeError(error),
        });
      }
    },
  };
  return runtime;
}

/** A stable id for a new hosted session. */
export function newHostedSessionId(): string {
  return `hosted-${randomUUID()}`;
}
