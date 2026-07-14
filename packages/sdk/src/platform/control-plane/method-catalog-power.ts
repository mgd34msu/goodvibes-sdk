/**
 * method-catalog-power.ts — sleep-ownership verbs: the served power state
 * (the always-visible "sleep disabled" chip renders from it) and the owner
 * keep-awake toggle (daemon-held, independent of work state).
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  methodDescriptor,
  objectSchema,
  runtimeEventId,
} from './method-catalog-shared.js';

const INHIBIT_CLASS_SCHEMA = { type: 'string', enum: ['handle-lid-switch', 'idle', 'sleep'] };
const NULLABLE_STRING_SCHEMA = { anyOf: [STRING_SCHEMA, { type: 'null' }] };
const NULLABLE_NUMBER_SCHEMA = { anyOf: [NUMBER_SCHEMA, { type: 'null' }] };

const POWER_STATE_SCHEMA = objectSchema({
  platform: STRING_SCHEMA,
  work: objectSchema({
    held: BOOLEAN_SCHEMA,
    grantedClasses: { type: 'array', items: INHIBIT_CLASS_SCHEMA },
    deniedClasses: { type: 'array', items: INHIBIT_CLASS_SCHEMA },
    reasons: { type: 'array', items: STRING_SCHEMA },
    heldSince: NULLABLE_NUMBER_SCHEMA,
    capMinutes: NUMBER_SCHEMA,
    capExpiresAt: NULLABLE_NUMBER_SCHEMA,
    capExpired: BOOLEAN_SCHEMA,
  }, ['held', 'grantedClasses', 'deniedClasses', 'reasons', 'heldSince', 'capMinutes', 'capExpiresAt', 'capExpired']),
  keepAwake: objectSchema({
    enabled: BOOLEAN_SCHEMA,
    held: BOOLEAN_SCHEMA,
    grantedClasses: { type: 'array', items: INHIBIT_CLASS_SCHEMA },
    deniedClasses: { type: 'array', items: INHIBIT_CLASS_SCHEMA },
    note: NULLABLE_STRING_SCHEMA,
  }, ['enabled', 'held', 'grantedClasses', 'deniedClasses', 'note']),
}, ['platform', 'work', 'keepAwake']);

export const builtinGatewayPowerMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'power.status.get',
    title: 'Get Sleep-Ownership State',
    description: 'The host sleep-ownership state: whether the automatic work inhibitor is held (and the live "held because X" reasons, cap, and expiry), and the owner keep-awake toggle with the classes the OS actually granted vs refused — a refused lid-switch block is stated honestly ("idle sleep blocked; lid-close suspend is controlled by your OS here"), never papered over. Surfaces render the always-visible "sleep disabled" chip from this state and the runtime.ops OPS_POWER_STATE_CHANGED event.',
    category: 'health',
    scopes: ['read:health'],
    http: { method: 'GET', path: '/api/power/status' },
    inputSchema: objectSchema({}, []),
    outputSchema: POWER_STATE_SCHEMA,
  }),
  methodDescriptor({
    id: 'power.keepAwake.set',
    title: 'Set the Owner Keep-Awake Toggle',
    description: 'Turn the owner keep-awake toggle on or off: a daemon-held sleep inhibitor INDEPENDENT of work state, surviving surface closes, persisted as power.keepAwake. Covers idle + sleep + lid-switch classes where grantable; the returned state names any refused class honestly. No timers, no AC-only sub-options — the always-visible chip is the safety mechanism. Emits runtime.ops OPS_POWER_STATE_CHANGED so every attached surface updates its chip.',
    category: 'health',
    scopes: ['write:config'],
    http: { method: 'POST', path: '/api/power/keep-awake' },
    events: [runtimeEventId('ops')],
    inputSchema: objectSchema({ enabled: BOOLEAN_SCHEMA }, ['enabled']),
    outputSchema: POWER_STATE_SCHEMA,
  }),
];
