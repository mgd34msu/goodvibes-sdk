/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { TriggerDefinition } from '../../../tools/workflow/index.js';
import type { ProcessNode } from '../types.js';

/**
 * TriggerDefinition → ProcessNode. Triggers have no timestamps and no run
 * state — enabled means armed ('idle'), disabled maps to 'killed' (their only
 * controls ARE remove/disable). Silent source: liveness rides the tick.
 */
export function adaptTrigger(def: TriggerDefinition): ProcessNode {
  return {
    id: def.id,
    kind: 'trigger',
    parentId: undefined,
    label: `on ${def.event} → ${def.action}`,
    state: def.enabled ? 'idle' : 'killed',
    elapsedMs: 0,
    costUsd: null,
    costState: 'unpriced',
    capabilities: { interruptible: false, killable: true, pausable: def.enabled, steerable: false },
    raw: def,
  };
}
