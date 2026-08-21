/**
 * policy.ts, the effective settings, read live.
 *
 * Every value is read through a predicate at the moment it is used rather than
 * snapshotted at construction, so each one is a real toggle instead of a
 * restart-only one. That is the same treatment the owner-profile composition
 * gives its switches, and for the same reason: a setting that needs a daemon
 * restart to take effect is a setting he will believe he changed.
 *
 * The accessor is string-keyed. The `occasions.*` keys live in the config
 * defaults tree and the flat settings surface, and the daemon adapts its
 * ConfigManager to this narrow interface, the same adaptation the check-in
 * uses, and for the same reason: the grandfathered ConfigKey union is
 * shrink-only.
 */
import { OCCASIONS_CONFIG_KEYS } from './types.js';
import type { OccasionsPolicy } from './sweep.js';

/** The narrow config surface this feature reads and writes. */
export interface OccasionsConfigAccess {
  get(key: string): unknown;
  set(key: string, value: string | boolean | number): void;
}

/** Defaults, matching the schema domain exactly. Restated so a narrow embed
 * with no config still behaves as the settings describe rather than as zero. */
export const OCCASIONS_DEFAULTS = {
  enabled: true,
  leadDays: 10,
  activeHours: '08:00-22:00',
  nudgeChannel: 'telegram',
  cadenceDays: 3,
  awayAdjust: true,
  calendarMirror: false,
  suppressMirroredNudges: true,
  interviewQuestions: 3,
  giftHistoryYears: 10,
  sweepIntervalMinutes: 60,
} as const;

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** The whole policy, read fresh. */
export function readOccasionsPolicy(config: OccasionsConfigAccess): OccasionsPolicy {
  const get = (key: string): unknown => config.get(key);
  return {
    enabled: bool(get(OCCASIONS_CONFIG_KEYS.enabled), OCCASIONS_DEFAULTS.enabled),
    leadDays: int(get(OCCASIONS_CONFIG_KEYS.leadDays), OCCASIONS_DEFAULTS.leadDays, 0, 365),
    activeHours: text(get(OCCASIONS_CONFIG_KEYS.activeHours), OCCASIONS_DEFAULTS.activeHours),
    nudgeChannel: text(get(OCCASIONS_CONFIG_KEYS.nudgeChannel), OCCASIONS_DEFAULTS.nudgeChannel),
    cadenceDays: int(get(OCCASIONS_CONFIG_KEYS.cadenceDays), OCCASIONS_DEFAULTS.cadenceDays, 1, 60),
    awayAdjust: bool(get(OCCASIONS_CONFIG_KEYS.awayAdjust), OCCASIONS_DEFAULTS.awayAdjust),
    calendarMirror: bool(get(OCCASIONS_CONFIG_KEYS.calendarMirror), OCCASIONS_DEFAULTS.calendarMirror),
    suppressMirroredNudges: bool(
      get(OCCASIONS_CONFIG_KEYS.suppressMirroredNudges),
      OCCASIONS_DEFAULTS.suppressMirroredNudges,
    ),
    interviewQuestions: int(
      get(OCCASIONS_CONFIG_KEYS.interviewQuestions),
      OCCASIONS_DEFAULTS.interviewQuestions,
      1,
      8,
    ),
    giftHistoryYears: int(
      get(OCCASIONS_CONFIG_KEYS.giftHistoryYears),
      OCCASIONS_DEFAULTS.giftHistoryYears,
      1,
      50,
    ),
    sweepIntervalMinutes: int(
      get(OCCASIONS_CONFIG_KEYS.sweepIntervalMinutes),
      OCCASIONS_DEFAULTS.sweepIntervalMinutes,
      5,
      1440,
    ),
  };
}

/**
 * The zone the owner's days and hours are reckoned in.
 *
 * `daemon.timezone` and nothing else. There is deliberately no
 * `occasions.timezone`: the daemon-location setting exists precisely so the
 * next feature needing a calendar day does not add a second one, and two zone
 * settings that disagree is a defect nobody would find until a nudge arrived at
 * 3am.
 */
export function readOccasionsTimezone(config: OccasionsConfigAccess): string {
  const value = config.get('daemon.timezone');
  return typeof value === 'string' ? value : '';
}
