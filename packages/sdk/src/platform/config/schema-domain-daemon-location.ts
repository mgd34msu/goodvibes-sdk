/**
 * schema-domain-daemon-location.ts — where on earth the daemon thinks it is.
 *
 * Split from schema-domain-core.ts to keep that file under its line ceiling,
 * and separate on merit: this is the platform's ONLY notion of the daemon's
 * location, and it is general rather than owned by whichever feature needed it
 * first. Anything that resets on a calendar day reads it.
 *
 * Before this existed the daemon had no timezone concept at all — schedules
 * carried their own per-schedule IANA names and `device.location.*` is a paired
 * phone's GPS permission, neither of which says where the daemon is. A daily
 * budget cannot be built without that answer.
 */
import type { ConfigSetting } from './schema-types.js';

export const daemonLocationConfigSettings: ConfigSetting[] = [
  {
    key: 'daemon.timezone',
    type: 'string',
    default: '',
    description:
      "IANA timezone name the daemon reckons CALENDAR DAYS in — e.g. 'America/New_York', 'Europe/London'. Empty means UTC. This is the daemon's own location, not a display preference and not a per-schedule zone (schedules keep their own). Anything that resets daily reads it: the payment capability's daily budgets roll over at midnight in this zone. Changing it does not refill a spent budget — daily totals are recomputed from each record's UTC instant rather than carried as a counter.",
    validate: (value: unknown): boolean => {
      if (typeof value !== 'string') return false;
      if (value.trim().length === 0) return true;
      try {
        new Intl.DateTimeFormat(undefined, { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    validationHint: "empty (UTC) or an IANA timezone name like 'America/New_York'",
  },
];
