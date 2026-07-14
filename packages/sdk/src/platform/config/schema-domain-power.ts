/**
 * schema-domain-power.ts — sleep-ownership config (`power.*`).
 *
 * Three keys with the ruled shape (2026-07-11 owner ruling):
 * - power.keepAwake: the OWNER TOGGLE — daemon-held keep-awake independent of
 *   work state, surviving surface closes. No timers, no AC-only sub-options
 *   (the always-visible chip is the safety mechanism), so this is exactly one
 *   boolean.
 * - power.inhibitWhileWorking: automatic inhibition while real work runs (a
 *   running turn, an active agent, a schedule about to fire). On by default —
 *   a host sleeping mid-turn is the defect this exists to end.
 * - power.workInhibitMaxMinutes: the honest hard cap on the WORK inhibitor
 *   (never the toggle), so a wedged hold cannot pin the host awake forever.
 */
import { type ConfigSettingDefinition, intRange } from './schema-shared.js';

/** Sleep-ownership policy (`power.*`). */
export interface PowerConfig {
  keepAwake: boolean;
  inhibitWhileWorking: boolean;
  workInhibitMaxMinutes: number;
}
declare module './schema-types.js' {
  interface GoodVibesConfig {
    power: PowerConfig;
  }
}

export const powerConfigDefaults: { power: PowerConfig } = {
  power: {
    keepAwake: false,
    inhibitWhileWorking: true,
    workInhibitMaxMinutes: 180,
  },
};

export const powerConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'power.keepAwake',
    type: 'boolean',
    default: false,
    description:
      'The owner keep-awake toggle: the daemon holds a sleep inhibitor INDEPENDENT of work state, so the host stays reachable after work finishes and after surfaces close. Covers idle + sleep + lid-switch inhibitor classes where the OS grants them; the served state names any refused class honestly. Every attached surface shows an always-visible "sleep disabled" chip while this is on — the chip, not a timer, is the safety mechanism.',
  },
  {
    key: 'power.inhibitWhileWorking',
    type: 'boolean',
    default: true,
    description:
      'Hold an idle/sleep inhibitor automatically while real work runs (a running turn, an active agent, a schedule about to fire), released when work drains. On by default so the host cannot sleep mid-work.',
  },
  {
    key: 'power.workInhibitMaxMinutes',
    type: 'number',
    default: 180,
    description:
      'Hard cap in minutes on the automatic WORK inhibitor (never the keep-awake toggle): a wedged hold releases at the cap and the state reports the expiry honestly.',
    ...intRange(1, 24 * 60),
  },
];
