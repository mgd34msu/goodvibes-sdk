// relay/daemon-wiring.ts
//
// Binds the injected-I/O reachability controller (reachability.ts) to the live
// daemon's config, feature flag, secret custody, and request dispatch. Kept out
// of the daemon facade so the facade's boot seam stays a single call and the
// controller itself stays free of daemon-specific types.

import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { isFeatureGateEnabled, type FeatureFlagReader } from '../runtime/feature-flags/index.js';
import type { SerializedRelayIdentity } from '@pellux/goodvibes-transport-core/relay';
import { createRelayReachability, type RelayReachability } from './reachability.js';

const IDENTITY_SECRET_KEY = 'relay.identity';

/**
 * Compose a {@link RelayReachability} from daemon collaborators. The daemon's
 * relay identity is persisted through the SecretsManager (JSON), and tunneled
 * requests are replayed through `dispatch` — the daemon's own request handler —
 * so a relayed call is indistinguishable from a LAN call save for the via-relay
 * marker header.
 */
export function buildDaemonRelayReachability(
  configManager: ConfigManager,
  secrets: Pick<SecretsManager, 'get' | 'set'>,
  featureFlags: FeatureFlagReader,
  dispatch: (req: Request) => Promise<Response | null>,
  logger: { info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void },
): RelayReachability {
  return createRelayReachability({
    config: {
      enabled: configManager.get('relay.enabled'),
      url: configManager.get('relay.url'),
      rendezvousId: configManager.get('relay.rendezvousId'),
      label: configManager.get('relay.label'),
    },
    featureFlagEnabled: isFeatureGateEnabled(featureFlags, 'relay-connect'),
    identityStore: {
      load: async () => {
        const raw = await secrets.get(IDENTITY_SECRET_KEY);
        return raw ? (JSON.parse(raw) as SerializedRelayIdentity) : null;
      },
      save: async (identity) => {
        await secrets.set(IDENTITY_SECRET_KEY, JSON.stringify(identity));
      },
    },
    dispatch,
    onRendezvousId: (rid) => configManager.set('relay.rendezvousId', rid),
    logger: {
      info: (m, f) => logger.info(`relay: ${m}`, f),
      warn: (m, f) => logger.warn(`relay: ${m}`, f),
      error: (m, f) => logger.warn(`relay: ${m}`, f),
    },
  });
}
