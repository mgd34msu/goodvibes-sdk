/**
 * schema-domain-owner-profile.ts, owner-profile config (`profile.*`).
 *
 * The defaults are docs/owner-profile.md §12's table, unchanged, and each key's
 * `description` carries that table's reasoning rather than restating the key
 * name. They are all daemon-owned (see config-ownership.ts): a fact written from
 * the agent has to be readable by the daemon with every surface closed, so the
 * policy that governs it cannot live in whichever surface silo an operator
 * happened to edit.
 *
 * Every key here is a real editable setting in the TUI, the agent and the webui.
 * None of them is an enable/disable stub, `profile.enabled = false` is a stated
 * state ("your profile is turned off"), not an empty profile, and
 * `profile.autonomousWrites = false` leaves reads and hand edits fully working,
 * which is the honest "I will curate this myself" mode rather than a dead
 * feature.
 */
import { type ConfigSettingDefinition, intRange } from './schema-shared.js';
import type { OwnerProfileConfig } from './schema-types-owner-profile.js';

export type { OwnerProfileConfig } from './schema-types-owner-profile.js';

declare module './schema-types.js' {
  interface GoodVibesConfig {
    profile: OwnerProfileConfig;
  }
}

export const ownerProfileConfigDefaults: { profile: OwnerProfileConfig } = {
  profile: {
    enabled: true,
    autonomousWrites: true,
    discloseWrites: true,
    injectOpenTier: true,
    discloseClosedTierReads: true,
    consumerFallback: true,
    reloadThrottleMs: 2000,
    path: '',
    conversationalCapture: true,
    ownerChannels: '',
  },
};

export const ownerProfileConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'profile.enabled',
    type: 'boolean',
    default: true,
    description:
      'Load and serve the owner profile. On by default because the owner asked for it built, and a feature that ships off ships dark. Turning it off means the file is never opened and every profile verb answers "your profile is turned off", a stated state, not an empty profile that would read as "I know nothing about you".',
  },
  {
    key: 'profile.autonomousWrites',
    type: 'boolean',
    default: true,
    description:
      'Let the runtime record facts it learns from things you say directly to it, without asking each time. On by default because that was the owner\'s explicit choice over propose-first. Off leaves reads and your own hand edits working exactly as before, the honest "I will curate this myself" mode, not a disabled feature. Untrusted sources are barred either way.',
  },
  {
    key: 'profile.discloseWrites',
    type: 'boolean',
    default: true,
    description:
      'Say in one line what was recorded, e.g. "Noted, saved your office address to your profile." On by default because telling you what it recorded was a condition attached to autonomous learning. Editable because the receipts may read as noisy over time, but turning them off is your decision made knowingly rather than a default that hides writes.',
  },
  {
    key: 'profile.injectOpenTier',
    type: 'boolean',
    default: true,
    description:
      'Put the open tier, how you like to be addressed, your pronouns, your city, your timezone, your unit/date/locale preferences and your style notes, into system context as a short block each turn. On by default because otherwise the agent still guesses a metro area for a weather answer, which is the failure that started this. Closed-tier content (addresses, contact details, people, notes) is never bulk-injected regardless of this setting.',
  },
  {
    key: 'profile.discloseClosedTierReads',
    type: 'boolean',
    default: true,
    description:
      'Announce it in the reply when a closed-tier value is used, e.g. "Used your shipping address from your profile." On by default because using your address on an order should be visible to you at the moment it happens rather than discoverable afterwards in a log.',
  },
  {
    key: 'profile.consumerFallback',
    type: 'boolean',
    default: true,
    description:
      'Let an UNSET consumer setting read its value from the matching profile field, quiet hours, delivery channel, and the commerce fields as their keys arrive. On because a profile nothing reads is a diary. A value you configured explicitly always wins; the profile only fills a gap, and only for a single keyed read, never in a settings listing or export.',
  },
  {
    key: 'profile.reloadThrottleMs',
    type: 'number',
    default: 2000,
    description:
      'How often, in milliseconds, to check the profile file for a hand edit on hosts where filesystem watching is unavailable. Used only on that fallback path and never on a read, so it costs nothing in the common case. 2000 sits under human edit-then-check latency: you save the file, look at the assistant, and it already knows.',
    ...intRange(50, 3_600_000),
  },
  {
    key: 'profile.path',
    type: 'string',
    default: '',
    description:
      'Absolute path to the profile Markdown file. Empty means the default, owner-profile.md under the daemon home, which already honours GOODVIBES_DAEMON_HOME, so this override is only for keeping the file somewhere else entirely.',
  },
  {
    key: 'profile.conversationalCapture',
    type: 'boolean',
    default: true,
    description:
      'Let a conversation record what you say about yourself as you say it, a trip and its itinerary, a birthday, a preference, a person. On by default because the alternative is what shipped before it: you paste a flight itinerary, get a warm reply, and nothing is stored. Off leaves conversations working and every profile read unchanged; it only stops the writing, and a turn that would have recorded something says so instead of staying quiet.',
  },
  {
    key: 'profile.ownerChannels',
    type: 'string',
    default: '',
    description:
      'The channels whose incoming messages are you, comma-separated, each as a surface name or surface:address, the same form as occasions.nudgeChannel. Only these may record to your profile; anything arriving anywhere else is treated as someone else\'s words and is refused, which is the rule that keeps a forwarded email from editing what the system believes about you. Empty means the channels already set to reach you privately in occasions.nudgeChannel, so the channel that sends you a birthday reminder can also hear you say when your flight leaves.',
  },
];
