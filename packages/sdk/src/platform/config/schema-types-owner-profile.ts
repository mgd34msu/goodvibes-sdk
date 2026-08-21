/**
 * schema-types-owner-profile.ts, the `profile.*` config domain's types.
 *
 * Split out of schema-types.ts the same way schema-types-network.ts and
 * schema-types-platform.ts were: the shape, the key union and the key→value map
 * live beside each other here, and schema-types.ts folds them into `ConfigKey`
 * and `ConfigValue` with one arm each.
 *
 * Types only. The defaults, the descriptions and the editable settings rows are
 * in schema-domain-owner-profile.ts, which is also where the `declare module`
 * merge into `GoodVibesConfig` lives, co-located with the defaults, as every
 * other domain does it.
 */

/** The owner profile's operator-editable policy (`profile.*`). */
export interface OwnerProfileConfig {
  /** Whether the profile is loaded and served at all. */
  enabled: boolean;
  /** Whether the runtime may record facts it learns from the owner without asking. */
  autonomousWrites: boolean;
  /** Whether an autonomous write says, in one line, what it recorded. */
  discloseWrites: boolean;
  /** Whether the open tier is rendered into system context each turn. */
  injectOpenTier: boolean;
  /** Whether a named closed-tier read is announced in the reply. */
  discloseClosedTierReads: boolean;
  /** Whether an unset consumer config key falls back to the matching profile field. */
  consumerFallback: boolean;
  /** Poll interval, in ms, where `fs.watch` is unavailable. Never on a read. */
  reloadThrottleMs: number;
  /** Absolute path override. Empty means the default under the daemon home. */
  path: string;
  /** Whether a conversational turn may record what the owner says about himself. */
  conversationalCapture: boolean;
  /** Comma-separated channels that carry the owner's own voice. Empty inherits the nudge channels. */
  ownerChannels: string;
}

/** Dot-path keys for the `profile.*` domain. */
export type ProfileConfigKey =
  | 'profile.enabled'
  | 'profile.autonomousWrites'
  | 'profile.discloseWrites'
  | 'profile.injectOpenTier'
  | 'profile.discloseClosedTierReads'
  | 'profile.consumerFallback'
  | 'profile.reloadThrottleMs'
  | 'profile.path'
  | 'profile.conversationalCapture'
  | 'profile.ownerChannels';

/**
 * Maps a `profile.*` key to its value type.
 *
 * Every key is written out, terminating in `never`, rather than collapsing the
 * six booleans into a default arm. The completeness gate
 * (test/config-key-union-completeness.test.ts) reads these clauses out of the
 * source to prove no schema key is missing a typed accessor, and a default arm
 * would make five of the eight invisible to it, a gate that passes because it
 * stopped looking is worse than no gate.
 */
export type ProfileConfigValue<K extends ProfileConfigKey> =
  K extends 'profile.enabled' ? boolean :
  K extends 'profile.autonomousWrites' ? boolean :
  K extends 'profile.discloseWrites' ? boolean :
  K extends 'profile.injectOpenTier' ? boolean :
  K extends 'profile.discloseClosedTierReads' ? boolean :
  K extends 'profile.consumerFallback' ? boolean :
  K extends 'profile.reloadThrottleMs' ? number :
  K extends 'profile.path' ? string :
  K extends 'profile.conversationalCapture' ? boolean :
  K extends 'profile.ownerChannels' ? string :
  never;
