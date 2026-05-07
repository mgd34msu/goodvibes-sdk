export type {
  CompanionChatMessage,
  CompanionChatSession,
  CompanionChatSessionKind,
  CompanionChatSessionStatus,
  CompanionChatMessageRole,
  CompanionChatTurnEvent,
  CompanionChatTurnStartedEvent,
  CompanionChatTurnDeltaEvent,
  CompanionChatTurnToolCallEvent,
  CompanionChatTurnToolResultEvent,
  CompanionChatTurnCompletedEvent,
  CompanionChatTurnErrorEvent,
  CreateCompanionChatSessionInput,
  CreateCompanionChatSessionOutput,
  ListCompanionChatSessionsInput,
  ListCompanionChatSessionsOutput,
  UpdateCompanionChatSessionInput,
  UpdateCompanionChatSessionOutput,
  PostCompanionChatMessageInput,
  PostCompanionChatMessageOutput,
  GetCompanionChatSessionOutput,
  ConversationMessageEnvelope,
} from './companion-chat-types.js';

export type {
  CompanionLLMProvider,
  CompanionChatEventPublisher,
  CompanionChatManagerConfig,
  CompanionProviderMessage,
  CompanionProviderChunk,
} from './companion-chat-manager.js';
export { CompanionChatManager } from './companion-chat-manager.js';

export { dispatchCompanionChatRoutes } from './companion-chat-routes.js';
export type { CompanionChatRouteContext } from './companion-chat-route-types.js';

export { CompanionChatPersistence, defaultSessionsDir } from './companion-chat-persistence.js';
export type { PersistedChatSession } from './companion-chat-persistence.js';
export { CompanionChatRateLimiter } from './companion-chat-rate-limiter.js';
export type { CompanionChatRateLimiterOptions } from './companion-chat-rate-limiter.js';
