/**
 * schema-domain-occasions.ts, the proactive occasions config (`occasions.*`).
 *
 * Daemon-owned, like the owner profile's keys and for the same reason: the
 * sweep runs in the daemon with every surface closed, so the policy that
 * governs it cannot live in whichever surface silo an operator happened to
 * edit.
 *
 * Every key here is a real configurable feature, not an enable/disable stub.
 * `occasions.enabled = false` is a stated state, the dates are still held,
 * still readable, still answerable when he asks, and it is the honest "stop
 * raising these at me" mode rather than a dead feature. The rest describe the
 * rhythm, the runway, the hours and the retention, each of which he can move
 * without a release.
 *
 * Every default in this file was confirmed by the owner key by key on
 * 2026-07-28. Two were his own words from the outset, the ten-day lead and the
 * 08:00–22:00 window, and one he changed at that point: `nudgeChannel` ships as
 * `telegram` rather than empty, so a nudge pushes out of the box instead of
 * waiting to be pulled.
 *
 * `nudgeChannel` is a comma-separated LIST, because his ruling on where these go
 * was Telegram AND the agent, and a single-valued key would have made that a
 * choice between them. The shipped default is still exactly `telegram`, the
 * value he confirmed, and adding `agent` to it is his to do.
 */
import { type ConfigSettingDefinition, intRange } from './schema-shared.js';
import type { OccasionsConfig } from './schema-types-occasions.js';

export type { OccasionsConfig } from './schema-types-occasions.js';

declare module './schema-types.js' {
  interface GoodVibesConfig {
    occasions: OccasionsConfig;
  }
}

export const occasionsConfigDefaults: { occasions: OccasionsConfig } = {
  occasions: {
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
  },
};

export const occasionsConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'occasions.enabled',
    type: 'boolean',
    default: true,
    description:
      'Raise your important dates on their own, before they matter. On by default because a feature that ships off ships dark, and because being told about your wife\'s birthday in time is the whole point. Turning it off does NOT forget anything: the dates stay in your profile, stay readable, and are still answered when you ask, it only stops the system raising them unprompted.',
  },
  {
    key: 'occasions.leadDays',
    type: 'number',
    default: 10,
    description:
      'How many days ahead an occasion starts being raised. Ten because that is enough runway to order something and have it arrive. An individual entry overrides this by carrying "lead 21" on its line, so a date that needs longer does not force everything else earlier.',
    ...intRange(0, 365),
  },
  {
    key: 'occasions.activeHours',
    type: 'string',
    default: '08:00-22:00',
    description:
      'The hours a nudge may arrive, HH:MM-HH:MM, reckoned in daemon.timezone. 08:00–22:00 because those hours are generally fine and anything outside them probably is not. Outside this window nothing is dropped, it waits. An empty or unreadable value means no restriction rather than permanent silence, so a typo cannot switch the feature off invisibly.',
  },
  {
    key: 'occasions.nudgeChannel',
    type: 'string',
    default: 'telegram',
    description:
      'Where a nudge is delivered: a comma-separated list of channel destinations, each a surface or surface:address, "telegram", "agent", "telegram,agent", "telegram:12345,agent". Telegram by default, because an occasion nudge that waits to be asked for has already missed the date it existed to protect, the owner ruled that these push out of the box, to Telegram and to the agent. Naming "agent" pushes the nudge into the agent conversation itself, which the agent product makes possible by registering its own sender; naming both means both get it, once each, and each is attempted independently so a broken credential on one cannot silence the other. Set it to empty to make the feature pull-only instead: nothing is pushed, and a surface picks up what is outstanding at the start of a turn. The TUI is refused as a destination whatever is set here: it is a get-work-done interface, and life admin does not belong in it.',
  },
  {
    key: 'occasions.cadenceDays',
    type: 'number',
    default: 3,
    description:
      'How often an unresolved CONFLICT in your dates, two different dates recorded for the same thing, is raised again, in days. It no longer governs birthday reminders: those speak twice, when the date enters its runway and on the day itself, and never repeat beyond that. A conflict is a fact about your file that stays wrong until you fix it, so it does keep coming back.',
    ...intRange(1, 60),
  },
  {
    key: 'occasions.awayAdjust',
    type: 'boolean',
    default: true,
    description:
      'Let a plan that has you away from home move a nudge EARLIER, to the day before you leave. On because you cannot have something delivered to a house you are not in, so a reminder that arrives while you are abroad has already missed the window it existed to protect. When you have already left there is nothing earlier to move to and the nudge stands rather than waiting for your return.',
  },
  {
    key: 'occasions.calendarMirror',
    type: 'boolean',
    default: false,
    description:
      'Write your occasions out to the connected calendar as well. Off by default because your profile is the record and the calendar is a copy, calendar entries are single occurrences that do not persist across years, which is exactly why these dates live in the profile instead. Nothing is ever read back the other way, and deleting a calendar entry never removes the occasion.',
  },
  {
    key: 'occasions.suppressMirroredNudges',
    type: 'boolean',
    default: true,
    description:
      'Stay quiet about an occasion that is already in a calendar, so the calendar\'s own reminder is the only ping. On by default because two pings for one birthday is how a useful reminder becomes one you mute. Turn it off if you would rather have both, an occasion marked "mirrored" on its own line is covered by this too.',
  },
  {
    key: 'occasions.interviewQuestions',
    type: 'number',
    default: 3,
    description:
      'How many questions are asked after you say yes to sorting a gift. Three, because it is meant to guide you to an idea rather than fill in a form, and a long one is a form. The questions open from what your profile already knows about the person and from what you landed on last time; none of them recommends anything.',
    ...intRange(1, 8),
  },
  {
    key: 'occasions.giftHistoryYears',
    type: 'number',
    default: 10,
    description:
      'How long the record of what you landed on is kept, in years. Ten, so year three is not steered by year one. This is the one part of the machine-owned state that deliberately outlives its occasion\'s answer, the answers expire with their date so next year asks fresh, the history does not.',
    ...intRange(1, 50),
  },
  {
    key: 'occasions.sweepIntervalMinutes',
    type: 'number',
    default: 60,
    description:
      'How often the daemon looks for dates entering their lead window, in minutes. Hourly by default, which is frequent enough that a nudge lands within an hour of the window opening and cheap enough to be invisible, the pass reads memory and touches one small file. It cannot over-nudge whatever this is set to: each occasion carries its own next-due date, so a shorter interval makes the FIRST nudge land sooner and changes nothing about the rhythm after it. Housekeeping runs on every pass, including the ones that are inside quiet hours or that raise nothing.',
    ...intRange(5, 1440),
  },
];
