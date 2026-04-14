/**
 * Notification routing module — barrel export and factory.
 *
 * Implements conversation noise routing.
 * Operational noise is routed to dedicated panels while the main
 * conversation receives only high-signal items.
 *
 * @example
 * ```ts
 * import { createNotificationRouter } from './notifications/index.js';
 *
 * const router = createNotificationRouter();
 * router.setDomainVerbosity('tools', 'minimal');
 * router.setQuietWhileTyping(true);
 *
 * const decision = router.route(myNotification);
 * ```
 */

export type {
  NotificationLevel,
  NotificationTarget,
  DomainVerbosity,
  NotificationAction,
  Notification,
  RoutingDecision,
  RoutedNotification,
  DomainConfig,
  RoutingReasonCode,
  NotificationTag,
} from './types.js';

export { NotificationRouter } from './router.js';

export {
  applyDefaultPolicy,
  applyQuietTypingPolicy,
  BatchPolicy,
  applyModeContextPolicy,
  BurstPolicy,
} from './policies/index.js';

export {
  formatNotificationSummary,
  formatBatchSummary,
  createPanelJumpAction,
  createDismissAction,
} from './formatters/index.js';

import { NotificationRouter } from './router.js';

/**
 * Factory function — creates a NotificationRouter with default policy stack.
 *
 * @param batchWindowMs - Optional batch window override in milliseconds
 *                        (default: 2000ms).
 * @returns A configured NotificationRouter instance ready for use.
 */
export function createNotificationRouter(
  batchWindowMs?: number,
  adaptiveSuppression?: boolean,
): NotificationRouter {
  return new NotificationRouter(batchWindowMs, adaptiveSuppression);
}
