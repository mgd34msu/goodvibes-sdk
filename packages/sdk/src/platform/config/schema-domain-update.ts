/**
 * schema-domain-update.ts, the daemon self-update config domain.
 *
 * The daemon checks for a new release hourly, downloads and
 * checksum-verifies it, swaps binaries at a no-active-work moment (never
 * mid-turn), keeps the previous binary at `<path>.previous` for one-command
 * rollback, and restarts via the service manager. Default-on per the owner
 * directive; `update.auto` turns it off.
 *
 * WHICH REPOSITORY. `releasesUrl` names the daemon's own repository,
 * `mgd34msu/goodvibes-daemon`. The daemon used to be built and released inside
 * the terminal app's repository and rode its tags; it is now a separate product
 * with its own release line, so its update source moved with it. The asset
 * names did not change (`goodvibes-daemon-<os>-<arch>`, `sqlite-vec-<os>-<arch>`),
 * so a daemon already installed on a machine hands itself over on its next
 * hourly check: it resolves the next tag from the new repository, downloads the
 * same-named asset, and swaps itself in place. The service unit's ExecStart is
 * path-stable, so nothing else has to change for the handover to complete.
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
  firstCheckSeconds: number;
  releasesUrl: string;
  rollbackAfterFailedStarts: number;
  alertAfterFailedChecks: number;
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
    firstCheckSeconds: 30,
    releasesUrl: 'https://github.com/mgd34msu/goodvibes-daemon/releases/latest',
    rollbackAfterFailedStarts: 3,
    alertAfterFailedChecks: 3,
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
    key: 'update.firstCheckSeconds',
    type: 'number',
    default: 30,
    description: 'Seconds after daemon start before the FIRST update check (a boot-settle delay, so a daemon that was down while releases shipped does not stay stale for a whole interval). Capped at one check interval',
    ...intRange(0, 60 * 60),
  },
  {
    key: 'update.releasesUrl',
    type: 'string',
    default: 'https://github.com/mgd34msu/goodvibes-daemon/releases/latest',
    description: 'GitHub releases/latest URL the daemon resolves its own update tags and artifacts from. The daemon is its own product with its own repository and its own release line; the terminal app updates itself from the goodvibes-tui repository and is never touched by a daemon update. A value written into settings.json overrides this default and is never re-derived',
  },
  {
    key: 'update.rollbackAfterFailedStarts',
    type: 'number',
    default: 3,
    description: 'Consecutive rapid boots that fail to reach a fully-started daemon before the startup path automatically restores the kept previous binary and restarts onto it. 0 leaves a bad update in place for a hand-run rollback',
    ...intRange(0, 10),
  },
  {
    key: 'update.alertAfterFailedChecks',
    type: 'number',
    default: 3,
    description: 'Consecutive failed update checks before the daemon tells the owner over a channel that still works that it can no longer update itself. Lower is louder; 1 reports the first failure. A repeat is held back for 12 hours so an ongoing outage is one message rather than one an hour',
    ...intRange(1, 100),
  },
];
