/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { TriggerDefinition } from '../../../tools/workflow/index.js';
import type { ProcessNode } from '../types.js';

/**
 * TriggerDefinition → ProcessNode. Triggers have no timestamps and no run
 * state — enabled means armed ('idle'), disabled maps to 'paused' (Wave 6,
 * wo-F item d2 — NOT 'killed': the definition still exists and
 * TriggerManager.enable() can re-arm it). resumable mirrors the inverse of
 * pausable.
 */
export function adaptTrigger(def: TriggerDefinition): ProcessNode {
  return {
    id: def.id,
    kind: 'trigger',
    parentId: undefined,
    label: `on ${def.event} → ${def.action}`,
    state: def.enabled ? 'idle' : 'paused',
    elapsedMs: 0,
    costUsd: null,
    costState: 'unpriced',
    capabilities: { interruptible: false, killable: true, pausable: def.enabled, resumable: !def.enabled, steerable: false },
    raw: def,
  };
}
