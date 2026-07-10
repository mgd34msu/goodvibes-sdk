/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Bridges `permissions.mode` config changes onto the runtime event bus as a
 * `PERMISSION_MODE_CHANGED` event, so surfaces can render a live mode pill
 * without polling. The mode is settable through the ordinary config surface
 * (`config.set` operator method / ConfigManager.set); this binding is the
 * runtime-event half of requirement (b).
 */

import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../config/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { EmitterContext } from '../runtime/emitters/index.js';
import { emitPermissionModeChanged } from '../runtime/emitters/permissions.js';

/**
 * Subscribe to `permissions.mode` config changes and emit
 * `PERMISSION_MODE_CHANGED` on each real transition. Returns an unsubscribe
 * function (mirrors {@link ConfigManager.subscribe} / the feature-flag binding
 * pattern in runtime services).
 *
 * @param sessionId — session/runtime id stamped on the emitted event.
 */
export function bindPermissionModeChangeEvent(
  configManager: Pick<ConfigManager, 'subscribe'>,
  runtimeBus: RuntimeEventBus,
  sessionId: string,
): () => void {
  return configManager.subscribe('permissions.mode', (newValue, oldValue) => {
    if (newValue === oldValue) return;
    const ctx: EmitterContext = {
      sessionId,
      traceId: randomUUID(),
      source: 'permission-mode',
    };
    emitPermissionModeChanged(runtimeBus, ctx, {
      mode: String(newValue),
      previousMode: String(oldValue),
    });
  });
}
