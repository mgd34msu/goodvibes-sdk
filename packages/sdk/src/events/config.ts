/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * ConfigEvent, a setting changed, said once, by name.
 *
 * ── What this exists to fix ─────────────────────────────────────────────────
 *
 * `ConfigManager.subscribe(key, cb)` is how live settings work inside a
 * process: the wake-word runtime, the renderer and the provider registry all
 * re-read themselves the moment a key they watch changes. That mechanism is
 * in-process by construction, it fires from the manager that performed the
 * write, or from the file watcher that noticed an external edit to a file this
 * process can see.
 *
 * A pure client has neither. Its settings are daemon-owned, its writes go over
 * the wire through `config.set`, and the daemon's settings file is not on its
 * disk. Before this domain existed, a `subscribeConfig` consumer in a client
 * attached to a remote daemon simply never fired: the value it was watching
 * could change on the daemon and the client would keep running on whatever it
 * read at startup, with nothing anywhere reporting a problem.
 *
 * ── Why names, and values only sometimes ────────────────────────────────────
 *
 * The notice carries the key, its ownership scope, and, for an ordinary
 * setting, the new value, because a subscriber that has to make a round trip
 * to learn what it just changed to is a poll with extra steps.
 *
 * For a SECRET-bearing key the notice carries the name and nothing else. There
 * is no version of "the operator changed the Telegram bot token" that is worth
 * putting the token on an event stream to say. A subscriber that needs the
 * value resolves it through the credential path, which is gated; the event only
 * tells it that resolving again is worthwhile. `secret: true` is the marker,
 * and `value` is absent rather than nulled, so a consumer cannot mistake a
 * withheld credential for one that was cleared.
 */

/** A JSON-shaped config value, as it appears on the wire. */
export type ConfigEventValue =
  | string
  | number
  | boolean
  | null
  | readonly ConfigEventValue[]
  | { readonly [key: string]: ConfigEventValue };

/**
 * Which runtime owns the key that changed, the same three scopes
 * `platform/config/config-ownership.ts` assigns. Carried on the event so a
 * subscriber can tell "the daemon changed something it acts on" from "a client
 * changed its own presentation" without re-deriving ownership itself.
 */
export type ConfigEventScope = 'daemon' | 'client' | 'user';

export type ConfigEvent =
  /**
   * One config key now holds a different value.
   *
   * Emitted for an in-process write (including every `config.set` a client
   * makes) and for an external edit the file watcher picked up, the bridge
   * rides `ConfigManager.subscribe`, which both paths already fire.
   */
  | {
      type: 'CONFIG_KEY_CHANGED';
      /** The full dotted config path, e.g. `voice.wake.enabled`. */
      key: string;
      scope: ConfigEventScope;
      /** True when the key holds credential material; `value` is then absent. */
      secret: boolean;
      /** The new value. Absent for a secret-bearing key, name only. */
      value?: ConfigEventValue | undefined;
      /** When the change was observed, epoch milliseconds. */
      changedAt: number;
    };

export type ConfigEventType = ConfigEvent['type'];
