/**
 * Config emitters — typed wrappers for the ConfigEvent domain.
 *
 * Used by the config emit-bridge (runtime/config/emit-bridge.ts) to surface
 * key-level setting changes onto the runtime event bus `config` domain, which
 * the control-plane gateway fans out to subscribed SSE/WebSocket clients
 * unchanged.
 */

import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { ConfigEvent, ConfigEventScope, ConfigEventValue } from '../../../events/config.js';
import type { EmitterContext } from './index.js';

function configEvent<T extends ConfigEvent['type']>(
  type: T,
  data: Omit<Extract<ConfigEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<ConfigEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<ConfigEvent, { type: T }>, ctx);
}

/**
 * Announce that one config key changed.
 *
 * `value` must be OMITTED for a secret-bearing key rather than passed as null:
 * the absence is the contract, and a null would read as "the credential was
 * cleared". The bridge is the one place that decides which it is.
 */
export function emitConfigKeyChanged(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    key: string;
    scope: ConfigEventScope;
    secret: boolean;
    value?: ConfigEventValue | undefined;
    changedAt: number;
  },
): void {
  bus.emit('config', configEvent('CONFIG_KEY_CHANGED', data, ctx));
}
