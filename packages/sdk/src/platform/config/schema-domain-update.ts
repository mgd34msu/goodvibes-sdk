/**
 * schema-domain-update.ts — the daemon self-update config domain.
 *
 * The daemon checks for a new release hourly, downloads and
 * checksum-verifies it, swaps binaries at a no-active-work moment (never
 * mid-turn), keeps the previous binary at `<path>.previous` for one-command
 * rollback, and restarts via the service manager. Default-on per the owner
 * directive; `update.auto` turns it off.
 *
 * Like the worktree domain in schema-domain-runtime.ts, `update` is a
 * top-level config section registered via `declare module` here (co-located
 * with its defaults); the scalar keys additionally appear in the ConfigKey
 * union / ConfigValue map in schema-types.ts so config.get is typed.
 */
import { type ConfigSettingDefinition, intRange } from './schema-shared.js';

/** Daemon self-update: hourly check, verify, idle-moment swap, auto-restart. */
export interface UpdateConfig {
  auto: boolean;
  intervalMinutes: number;
  releasesUrl: string;
}

declare module './schema-types.js' {
  interface GoodVibesConfig {
    update: UpdateConfig;
  }
}

export const updateConfigDefaults = {
  update: {
    auto: true,
    intervalMinutes: 60,
    releasesUrl: 'https://github.com/mgd34msu/goodvibes-tui/releases/latest',
  },
} as const;

export const updateConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'update.auto',
    type: 'boolean',
    default: true,
    description: 'Daemon self-update: check for a new release hourly, download and checksum-verify it, swap at a no-active-work moment, and restart (owner-directed default; the previous binary is kept for one-command rollback)',
  },
  {
    key: 'update.intervalMinutes',
    type: 'number',
    default: 60,
    description: 'Minutes between daemon update checks',
    ...intRange(5, 24 * 60),
  },
  {
    key: 'update.releasesUrl',
    type: 'string',
    default: 'https://github.com/mgd34msu/goodvibes-tui/releases/latest',
    description: 'GitHub releases/latest URL the daemon resolves update tags and artifacts from',
  },
];
