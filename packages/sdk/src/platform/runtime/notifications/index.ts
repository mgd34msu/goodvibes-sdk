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
import type { ConfigManager } from '../../config/manager.js';

/**
 * Factory function — creates a NotificationRouter with default policy stack.
 *
 * @param batchWindowMs - Optional batch window override in milliseconds
 *                        (default: 2000ms).
 * @param adaptiveSuppression - Whether the adaptive-suppression policies
 *                        (mode-context + burst collapse) are active. Omitted
 *                        with a configManager supplied, it derives from the
 *                        notifications.adaptiveSuppression setting (default on).
 * @param configManager - Optional config source; when supplied, burst-detector
 *                        thresholds are read from notifications.burst* (window /
 *                        threshold / cooldown). Constructor params still override.
 * @returns A configured NotificationRouter instance ready for use.
 */
export function createNotificationRouter(
  batchWindowMs?: number,
  adaptiveSuppression?: boolean,
  configManager?: Pick<ConfigManager, 'get'>,
): NotificationRouter {
  const burstConfig = configManager
    ? {
        windowMs: configManager.get('notifications.burstWindowMs'),
        threshold: configManager.get('notifications.burstThreshold'),
        cooldownMs: configManager.get('notifications.burstCooldownMs'),
      }
    : undefined;
  const effectiveSuppression = adaptiveSuppression
    ?? (configManager ? configManager.get('notifications.adaptiveSuppression') : undefined);
  return new NotificationRouter(batchWindowMs, effectiveSuppression, burstConfig);
}
