/**
 * companion-chat-turn-execution.ts
 *
 * The two turn-execution helpers used by CompanionChatManager._runTurn, split
 * out of companion-chat-manager.ts (see CHANGELOG) so the manager stays under
 * the repo's hand-authored file-size cap while regenerate/edit verbs are added.
 * These are a pure move: the logic is unchanged, the manager now passes the
 * dependencies it used to reach through `this`.
 *
 * - runToolExhaustionFinalizer: after the tool-call budget is exhausted, run one
 *   more streamed turn that is instructed not to call tools, returning its text.
 * - executeCompanionToolCalls: execute model-emitted tool calls through the
 *   permission boundary and publish per-call results, degrading honestly when a
 *   registry is present without a permission manager.
 */

import type { ConversationManager } from '../core/conversation.js';
import type { CompanionChatTurnEvent } from './companion-chat-types.js';
import type { CompanionLLMProvider } from './companion-chat-manager.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import type { PermissionManager } from '../permissions/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { HookEvent, HookResult } from '../hooks/types.js';
import { executeToolCalls as executeOrchestratorToolCalls } from '../core/orchestrator-tool-runtime.js';
import { appendGoodVibesRuntimeAwarenessPrompt } from '../tools/goodvibes-runtime/index.js';

type HookDispatcherLike = {
  fire(event: HookEvent): Promise<HookResult>;
};

/** The minimal session shape the finalizer needs (avoids importing the private InternalSession). */
interface FinalizerSession {
  readonly meta: {
    readonly id: string;
    readonly model: string | null;
    readonly provider: string | null;
    readonly systemPrompt: string | null;
  };
  readonly conversation: ConversationManager;
}

export interface ToolExhaustionFinalizerDeps {
  readonly provider: CompanionLLMProvider;
  /** The pre-built finalizer system prompt (kept in the manager alongside its round cap). */
  readonly finalizerPrompt: string;
}

/**
 * Run a single streamed turn after the per-turn tool-call budget is exhausted,
 * instructing the model not to call more tools, and return the collected text.
 */
export async function runToolExhaustionFinalizer(
  deps: ToolExhaustionFinalizerDeps,
  session: FinalizerSession,
  abortSignal: AbortSignal,
  turnId: string,
  publish: (event: CompanionChatTurnEvent) => void,
): Promise<string> {
  const sessionId = session.meta.id;
  let finalContent = '';
  const stream = deps.provider.chatStream([...session.conversation.getMessagesForLLM()], {
    systemPrompt: appendGoodVibesRuntimeAwarenessPrompt(
      [session.meta.systemPrompt, deps.finalizerPrompt].filter(Boolean).join('\n\n'),
    ),
    model: session.meta.model,
    provider: session.meta.provider,
    abortSignal,
  });

  for await (const chunk of stream) {
    if (abortSignal.aborted) break;

    switch (chunk.type) {
      case 'text_delta': {
        const delta = chunk.delta ?? '';
        finalContent += delta;
        publish({ type: 'turn.delta', sessionId, turnId, delta });
        break;
      }
      case 'error':
        throw new Error(chunk.error ?? 'Provider streaming error');
      case 'tool_call':
      case 'tool_result':
      case 'done':
        break;
    }
  }

  return finalContent;
}

export interface CompanionToolExecutionDeps {
  readonly toolRegistry: ToolRegistry | null;
  readonly permissionManager: PermissionManager | null;
  readonly hookDispatcher: HookDispatcherLike | null;
  readonly runtimeBus: RuntimeEventBus | null;
}

/**
 * Execute model-emitted tool calls through the permission boundary and publish
 * each result. Returns [] when no registry is configured; denies every call
 * honestly (isError result + published event) when a registry exists without a
 * permission manager.
 */
export async function executeCompanionToolCalls(
  deps: CompanionToolExecutionDeps,
  toolCalls: ToolCall[],
  publish: (event: CompanionChatTurnEvent) => void,
  sessionId: string,
  turnId: string,
): Promise<ToolResult[]> {
  const toolRegistry = deps.toolRegistry;
  if (!toolRegistry) return [];

  if (!deps.permissionManager) {
    return toolCalls.map((call) => {
      const toolResult: ToolResult = {
        callId: call.id,
        success: false,
        error: 'Tool execution denied: permission manager unavailable for companion chat',
      };
      publish({
        type: 'turn.tool_result',
        sessionId,
        turnId,
        toolCallId: call.id,
        toolName: call.name,
        result: toolResult.error,
        isError: true,
      });
      return toolResult;
    });
  }

  const results = await executeOrchestratorToolCalls({
    toolRegistry,
    permissionManager: deps.permissionManager,
    hookDispatcher: deps.hookDispatcher,
    runtimeBus: deps.runtimeBus,
    sessionId,
    emitterContext: (id) => ({
      sessionId,
      traceId: `${sessionId}:${id}`,
      source: 'companion-chat',
    }),
  }, turnId, toolCalls);

  for (const [index, toolResult] of results.entries()) {
    const call = toolCalls[index]!;
    if (!call) continue;
    publish({
      type: 'turn.tool_result',
      sessionId,
      turnId,
      toolCallId: call.id,
      toolName: call.name,
      result: toolResult.output ?? toolResult.error ?? null,
      isError: !toolResult.success,
    });
  }

  return results;
}
