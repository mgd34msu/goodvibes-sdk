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
import { isRelayTunneledRequest } from '@pellux/goodvibes-daemon-sdk';
import { createRelayReachability, type RelayReachability } from './reachability.js';
import {
  STEP_UP_ASSERTION_HEADER,
  evaluateStepUp,
  isMutatingMethod,
  type StepUpAssertionVerifier,
} from './step-up-policy.js';

/**
 * Wrap a dispatch so mutating relay calls are gated by the WebAuthn step-up
 * policy. When the requirement is off this returns the dispatch untouched (zero
 * overhead). When on, it fails closed unless a wired verifier genuinely
 * confirms a fresh assertion carried in the step-up header.
 */
function wrapDispatchWithStepUp(
  dispatch: (req: Request) => Promise<Response | null>,
  requireStepUp: boolean,
  verifier: StepUpAssertionVerifier | undefined,
): (req: Request) => Promise<Response | null> {
  if (!requireStepUp) return dispatch;
  return async (req) => {
    const viaRelay = isRelayTunneledRequest(req);
    const mutating = isMutatingMethod(req.method);
    // Bootstrap exemption: minting a step-up challenge is the prerequisite for
    // producing an assertion, so it cannot itself require one — otherwise a relay
    // client could never obtain a challenge (a deadlock). It creates only an
    // ephemeral, single-use challenge and returns no privileged data. Credential
    // registration is deliberately NOT exempt: it is an admin/local-only
    // bootstrap that a mutating-relay caller must not be able to perform.
    if (viaRelay && mutating && new URL(req.url).pathname === STEP_UP_CHALLENGE_MINT_PATH) {
      return dispatch(req);
    }
    if (viaRelay && mutating) {
      const assertion = req.headers.get(STEP_UP_ASSERTION_HEADER);
      const verified = !verifier
        ? null
        : assertion
          ? await verifier(assertion, { method: req.method, path: new URL(req.url).pathname })
          : false;
      const decision = evaluateStepUp({ viaRelay, mutating, requireStepUp: true, assertionVerified: verified });
      if (!decision.allow) {
        return new Response(JSON.stringify({ error: decision.code, message: decision.message }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'www-authenticate': 'WebAuthn' },
        });
      }
    }
    return dispatch(req);
  };
}

const IDENTITY_SECRET_KEY = 'relay.identity';

/** The step-up challenge-mint REST path, exempt from the step-up gate (bootstrap). */
const STEP_UP_CHALLENGE_MINT_PATH = '/api/stepup/challenge';

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
  verifyStepUp?: StepUpAssertionVerifier,
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
    dispatch: wrapDispatchWithStepUp(dispatch, configManager.get('relay.requireStepUpForMutations'), verifyStepUp),
    onRendezvousId: (rid) => configManager.set('relay.rendezvousId', rid),
    logger: {
      info: (m, f) => logger.info(`relay: ${m}`, f),
      warn: (m, f) => logger.warn(`relay: ${m}`, f),
      error: (m, f) => logger.warn(`relay: ${m}`, f),
    },
  });
}
