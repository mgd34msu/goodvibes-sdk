/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Config emit-bridge — turns in-process `ConfigManager.subscribe` callbacks
 * into poll-free key-level events on the runtime event bus `config` domain.
 *
 * ── Why a bridge rather than a new hook on ConfigManager ────────────────────
 *
 * The manager already has exactly the seam this needs. `subscribe(key, cb)`
 * fires on an in-process `set`/`setDynamic` AND on an external file edit the
 * watcher picked up (`reloadFromDiskAndNotify` diffs precisely the keys
 * something subscribed to). Subscribing every known path therefore gets both
 * paths for free — and, not incidentally, is what makes the external-edit case
 * work at all: that diff walks the SUBSCRIBED keys, so a key nobody subscribed
 * to was never compared and never fired. Attaching this bridge widens that walk
 * to the whole declared surface as a side effect of doing its own job.
 *
 * ── What is subscribed ──────────────────────────────────────────────────────
 *
 * Every scalar key in CONFIG_SCHEMA, plus the daemon-owned paths that are not
 * scalar schema keys (`email.passwordRef`, `cluster.peers`, …) and the declared
 * secret-bearing paths. A path that no store ever holds simply never fires.
 *
 * The domain is not filtered down to daemon-owned keys, deliberately. A client
 * subscribing to this stream is watching the DAEMON's settings, and which of
 * them the daemon considers client-owned is a fact the subscriber may want to
 * see rather than one the emitter should decide for it — each notice carries
 * its `scope`, so a consumer that only cares about daemon-owned keys filters on
 * a field instead of losing the others silently.
 *
 * ── What never crosses ──────────────────────────────────────────────────────
 *
 * A secret-bearing key's value. The notice names the key and sets
 * `secret: true`; `value` is omitted entirely. See events/config.ts.
 */

import { randomUUID } from 'node:crypto';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from '../emitters/index.js';
import { emitConfigKeyChanged } from '../emitters/config.js';
import type { ConfigEventValue } from '../../../events/config.js';
import { CONFIG_SCHEMA } from '../../config/schema.js';
import {
  DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS,
  configKeyScope,
} from '../../config/config-ownership.js';
import {
  SECRET_BEARING_CONFIG_PATHS,
  isSecretBearingConfigKey,
} from '../../config/secret-bearing-config-keys.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/**
 * The narrow config surface this needs: one subscription per key, and nothing
 * else. Structural so a test supplies four lines instead of a whole manager.
 */
export interface ConfigChangeSource {
  subscribe(key: string, callback: (newValue: unknown, previousValue: unknown) => void): () => void;
}

export interface ConfigEmitBridgeDeps {
  /** The live ConfigManager — only its per-key subscription is used. */
  readonly config: ConfigChangeSource;
  /** The runtime event bus the config events are emitted onto. */
  readonly bus: Pick<RuntimeEventBus, 'emit'>;
  /**
   * Extra config paths a product knows about that the platform set does not
   * name. Merged with the platform set; duplicates are collapsed.
   */
  readonly additionalKeys?: readonly string[] | undefined;
  /**
   * Trace id source for the emitted envelopes. A settings change is not born of
   * a single caller turn, so absent a real trace a fresh id per event is honest
   * (default). Injected in tests for determinism.
   */
  readonly traceId?: (() => string) | undefined;
  /** Clock seam for `changedAt`; injected in tests. */
  readonly now?: (() => number) | undefined;
}

/**
 * Every config path this bridge watches: the declared scalar schema keys, the
 * daemon-owned non-scalar paths, and the declared secret-bearing paths.
 */
export function listWatchableConfigPaths(additionalKeys: readonly string[] = []): readonly string[] {
  return [...new Set<string>([
    ...CONFIG_SCHEMA.map((setting) => setting.key),
    ...DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS,
    ...SECRET_BEARING_CONFIG_PATHS,
    ...additionalKeys,
  ])];
}

/**
 * A config value in the JSON shape the wire carries, or undefined when it is
 * not representable.
 *
 * A value that cannot survive a JSON round trip (a function, a class instance,
 * a cyclic object) is dropped rather than coerced into something that reads as
 * the setting: an event saying `value: "[object Object]"` is worse than one
 * saying only that the key changed, and the subscriber's fallback — re-read the
 * key — is correct in both cases.
 */
export function toConfigEventValue(value: unknown): ConfigEventValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as ConfigEventValue;
  } catch {
    return undefined;
  }
}

/**
 * Attach the bridge. Returns a function that detaches every subscription.
 *
 * Safe to call once at composition time. Detaching matters: the subscriptions
 * are held by the ConfigManager, so a bridge that outlived its bus would keep
 * emitting into a torn-down graph — the same reason the push event sources are
 * registered with the disposal registry.
 */
export function attachConfigEmitBridge(deps: ConfigEmitBridgeDeps): () => void {
  const nextTraceId = deps.traceId ?? ((): string => randomUUID());
  const clock = deps.now ?? ((): number => Date.now());
  const unsubscribes: (() => void)[] = [];

  for (const key of listWatchableConfigPaths(deps.additionalKeys ?? [])) {
    const secret = isSecretBearingConfigKey(key);
    const scope = configKeyScope(key);
    try {
      unsubscribes.push(deps.config.subscribe(key, (newValue) => {
        // A settings change belongs to no conversation, so the envelope's
        // required sessionId carries the emitter's own name rather than a
        // borrowed one — the same sentinel shape the fleet bridge uses for a
        // node with no session.
        const ctx: EmitterContext = {
          traceId: nextTraceId(),
          source: 'config-emit-bridge',
          sessionId: 'config-manager',
        };
        try {
          emitConfigKeyChanged(deps.bus as RuntimeEventBus, ctx, {
            key,
            scope,
            secret,
            // Omitted, never nulled, for a credential: the absence IS the
            // contract, and a null would read as "the credential was cleared".
            ...(secret ? {} : { value: toConfigEventValue(newValue) }),
            changedAt: clock(),
          });
        } catch (error) {
          // A failed emit must never break the write that triggered it.
          logger.warn('Config event bridge: emitting a change notice failed', {
            key,
            error: summarizeError(error),
          });
        }
      }));
    } catch (error) {
      // A manager that refuses one key must not cost the other several hundred.
      logger.warn('Config event bridge: could not watch a config key', {
        key,
        error: summarizeError(error),
      });
    }
  }

  return (): void => {
    for (let index = unsubscribes.length - 1; index >= 0; index -= 1) {
      try {
        unsubscribes[index]!();
      } catch {
        // Detaching is best-effort; a listener set that is already gone is fine.
      }
    }
    unsubscribes.length = 0;
  };
}
