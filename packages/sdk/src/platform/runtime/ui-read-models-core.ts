import type { RuntimeServices } from './services.js';
import type { RuntimeTask } from './store/domains/tasks.js';
import type { RuntimeAgent } from './store/domains/agents.js';
import type { SessionDomainState } from './store/domains/session.js';
import type { TurnState } from './store/domains/conversation.js';
import { createStoreBackedReadModel, listProviderIds, projectRecords, projectValues } from './ui-read-model-helpers.js';
import type { UiReadModel } from './ui-read-models-base.js';
import { deriveContextUsage } from './context-usage.js';

/** Fraction of the model context window at which the context-warning flag activates. */
const CONTEXT_WARNING_THRESHOLD = 0.85;

export interface UiProvidersSnapshot {
  readonly providerIds: readonly string[];
}

export interface UiSessionSnapshot {
  readonly session: SessionDomainState;
  readonly totalTurns: number;
  readonly messageCount: number;
  readonly estimatedContextTokens: number;
  readonly contextWindow: number;
  /** Context usage as a 0–100 percentage (0 when the window is unknown). Cheap readable for a live context chip. */
  readonly contextUsagePct: number;
  /** Tokens remaining before the context window is full (0 when unknown/exhausted). */
  readonly contextRemainingTokens: number;
  readonly turnState: TurnState;
  readonly streamToolPreview?: string | undefined;
  readonly contextWarningActive: boolean;
  readonly pendingApproval: boolean;
  readonly denialCount: number;
}

export interface UiAgentsSnapshot {
  readonly active: readonly RuntimeAgent[];
  readonly totalSpawned: number;
  readonly totalCompleted: number;
  readonly totalFailed: number;
}

export interface UiTasksSnapshot {
  readonly tasks: readonly RuntimeTask[];
}

export interface UiCoreReadModels {
  readonly providers: UiReadModel<UiProvidersSnapshot>;
  readonly session: UiReadModel<UiSessionSnapshot>;
  readonly agents: UiReadModel<UiAgentsSnapshot>;
  readonly tasks: UiReadModel<UiTasksSnapshot>;
}

export function createCoreReadModels(runtimeServices: RuntimeServices): UiCoreReadModels {
  const { runtimeStore } = runtimeServices;

  return {
    providers: {
      getSnapshot() {
        return {
          providerIds: listProviderIds(runtimeServices),
        };
      },
      subscribe(listener) {
        return runtimeServices.runtimeBus.on('PROVIDERS_CHANGED', listener);
      },
    },
    session: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      const usedTokens = state.conversation.estimatedContextTokens;
      const window = state.model.tokenLimits.contextWindow;
      const usage = deriveContextUsage(usedTokens, window);
      return {
        session: state.session,
        totalTurns: state.conversation.totalTurns,
        messageCount: state.conversation.messageCount,
        estimatedContextTokens: usedTokens,
        contextWindow: window,
        contextUsagePct: usage.contextUsagePct,
        contextRemainingTokens: usage.contextRemainingTokens,
        turnState: state.conversation.turnState,
        streamToolPreview: state.conversation.stream.partialToolPreview,
        contextWarningActive:
          state.model.tokenLimits.contextWindow > 0 &&
          state.conversation.estimatedContextTokens >= state.model.tokenLimits.contextWindow * CONTEXT_WARNING_THRESHOLD,
        pendingApproval: state.permissions.awaitingDecision,
        denialCount: state.permissions.denialCount,
      };
    }),
    agents: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().agents;
      const active = projectRecords(state.activeAgentIds, state.agents);
      return {
        active,
        totalSpawned: state.totalSpawned,
        totalCompleted: state.totalCompleted,
        totalFailed: state.totalFailed,
      };
    }),
    tasks: createStoreBackedReadModel(runtimeServices, () => {
      const tasksState = runtimeStore.getState().tasks;
      const tasks = projectValues(tasksState.tasks, (a, b) => {
        const aTime = a.startedAt ?? a.queuedAt;
        const bTime = b.startedAt ?? b.queuedAt;
        return bTime - aTime || a.title.localeCompare(b.title);
      });
      return { tasks };
    }),
  };
}
