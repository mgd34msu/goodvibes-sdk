/**
 * routes/pairing-handoff.ts
 *
 * The `pairing.handoff.*` verbs: one pairing exchange carries an OFFER SET
 * (notifications, relay, passkey step-up) so a freshly-paired surface can
 * complete several set-up steps in a single pass, each independently declinable.
 *
 * - pairing.handoff.create mints a per-device token and returns the offer set
 *   that is actually available on this daemon (notifications carry the VAPID
 *   public key; relay/passkey are advertised only when the daemon supports
 *   them), plus the `#pair=<token>` deep-link fragment (and a full deep link
 *   when a web origin is configured). The token secret is returned ONCE.
 * - pairing.handoff.complete applies the surface's per-offer decisions in one
 *   pass: an accepted notifications offer registers the browser push
 *   subscription, an accepted passkey offer registers the WebAuthn credential,
 *   an accepted relay offer is acknowledged; each returns an honest per-offer
 *   result, and a declined/omitted offer is reported as declined — never
 *   silently half-applied.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import type { PairingTokenManager } from '../../pairing/pairing-token-store.js';
import type { StepUpGatewayService } from './stepup.js';
import type { PushGatewayService } from './push.js';
import {
  buildPairingHandoffFragment,
  buildPairingHandoffLink,
  normalizeOffers,
  PAIRING_HANDOFF_OFFER_KINDS,
  type PairingHandoffOfferKind,
} from '../../pairing/pairing-handoff.js';
import { describeOriginPosture } from '../../pairing/origin-posture.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** What the hand-off verbs need from the surrounding composition. */
export interface PairingHandoffDeps {
  readonly tokens: Pick<PairingTokenManager, 'mint'>;
  /** The push service — VAPID key for the notifications offer + subscription registration. */
  readonly push: Pick<PushGatewayService, 'getPublicKey' | 'subscribe'>;
  /** WebAuthn step-up; present ⇒ the passkey offer is available. */
  readonly stepUp?: StepUpGatewayService | undefined;
  /** Whether the rendezvous relay is available ⇒ the relay offer is available. */
  readonly relayAvailable: () => boolean;
  /** The configured web-app origin the QR points at; absent ⇒ only a fragment is returned. */
  readonly webOrigin?: (() => string | undefined) | undefined;
}

function requirePrincipal(invocation: GatewayMethodInvocation): string {
  const principalId = invocation.context.principalId;
  if (!principalId) {
    throw new GatewayVerbError('Pairing hand-off verbs require an authenticated principal', 'UNAUTHENTICATED', 401);
  }
  return principalId;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`Missing or invalid ${field}`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function requestedOffers(value: unknown): readonly PairingHandoffOfferKind[] {
  if (value === undefined) return PAIRING_HANDOFF_OFFER_KINDS;
  if (!Array.isArray(value)) {
    throw new GatewayVerbError('offers must be an array of offer kinds', 'INVALID_ARGUMENT', 400);
  }
  return normalizeOffers(value.filter((v): v is string => typeof v === 'string'));
}

/** The offers this daemon can actually satisfy right now. */
function availableOffers(deps: PairingHandoffDeps): Set<PairingHandoffOfferKind> {
  const available = new Set<PairingHandoffOfferKind>(['notifications']);
  if (deps.relayAvailable()) available.add('relay');
  if (deps.stepUp) available.add('passkey');
  return available;
}

function createHandoffCreateHandler(deps: PairingHandoffDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const name = requireString(params.name, 'name');
    const available = availableOffers(deps);
    const offers = requestedOffers(params.offers).filter((kind) => available.has(kind));

    const minted = deps.tokens.mint({ name });
    const offerDetails = await Promise.all(offers.map(async (kind) => {
      if (kind === 'notifications') {
        return { kind, available: true, vapidPublicKey: await deps.push.getPublicKey() };
      }
      return { kind, available: true };
    }));

    const fragment = buildPairingHandoffFragment({ token: minted.token, offers });
    const webOrigin = deps.webOrigin?.();
    const deepLink = webOrigin ? buildPairingHandoffLink({ webOrigin, token: minted.token, offers }) : undefined;
    return {
      token: minted,
      offers: offerDetails,
      fragment,
      ...(deepLink ? { deepLink } : {}),
      // The honest TLS/capability posture of the origin the QR points at, so a
      // surface states the plain-http-LAN line ONCE at pairing (never a nag)
      // and labels browser-gated gaps instead of rendering dead buttons.
      ...(webOrigin ? { posture: describeOriginPosture(webOrigin) } : {}),
    };
  };
}

/**
 * pairing.posture.get — the same posture read outside a pairing exchange: a
 * surface passes its OWN current origin (or omits it to read the configured web
 * origin) and renders labeled capability gaps for wherever it is running.
 */
function createPostureGetHandler(deps: PairingHandoffDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const origin = typeof params.origin === 'string' && params.origin.trim().length > 0
      ? params.origin
      : deps.webOrigin?.();
    if (!origin) {
      throw new GatewayVerbError('No origin supplied and no web origin is configured', 'ORIGIN_UNKNOWN', 404);
    }
    return { posture: describeOriginPosture(origin) };
  };
}

interface OfferResult {
  readonly kind: PairingHandoffOfferKind;
  readonly status: 'completed' | 'declined' | 'unavailable' | 'failed';
  readonly detail?: string;
}

function readKeys(value: unknown): { p256dh: string; auth: string } {
  if (value === null || typeof value !== 'object') {
    throw new GatewayVerbError('notifications.keys is required', 'INVALID_ARGUMENT', 400);
  }
  const keys = value as Record<string, unknown>;
  return { p256dh: requireString(keys.p256dh, 'notifications.keys.p256dh'), auth: requireString(keys.auth, 'notifications.keys.auth') };
}

function createHandoffCompleteHandler(deps: PairingHandoffDeps): GatewayMethodHandler {
  return async (invocation) => {
    const principalId = requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const accept = (params.accept && typeof params.accept === 'object' ? params.accept : {}) as Record<string, unknown>;
    const available = availableOffers(deps);
    const results: OfferResult[] = [];

    for (const kind of PAIRING_HANDOFF_OFFER_KINDS) {
      const offered = accept[kind];
      if (offered === undefined || offered === false) {
        // Omitted or explicitly declined — reported, never silently applied.
        results.push({ kind, status: 'declined' });
        continue;
      }
      if (!available.has(kind)) {
        results.push({ kind, status: 'unavailable', detail: `${kind} is not offered by this daemon` });
        continue;
      }
      try {
        if (kind === 'notifications') {
          const offer = offered as Record<string, unknown>;
          const endpoint = requireString(offer.endpoint, 'notifications.endpoint');
          const keys = readKeys(offer.keys);
          const deviceId = typeof offer.deviceId === 'string' ? offer.deviceId : undefined;
          await deps.push.subscribe({ principalId, endpoint, keys, ...(deviceId ? { deviceId } : {}) });
          results.push({ kind, status: 'completed' });
        } else if (kind === 'passkey' && deps.stepUp) {
          const offer = offered as Record<string, unknown>;
          await deps.stepUp.registerCredential({
            rpId: requireString(offer.rpId, 'passkey.rpId'),
            origin: requireString(offer.origin, 'passkey.origin'),
            credentialId: requireString(offer.credentialId, 'passkey.credentialId'),
            publicKeyCose: requireString(offer.publicKeyCose, 'passkey.publicKeyCose'),
          });
          results.push({ kind, status: 'completed' });
        } else if (kind === 'relay') {
          // Relay acceptance is an acknowledgement: the surface is cleared to
          // connect through the rendezvous relay with its pairing token.
          results.push({ kind, status: 'completed' });
        } else {
          results.push({ kind, status: 'unavailable', detail: `${kind} cannot be completed here` });
        }
      } catch (error) {
        if (error instanceof GatewayVerbError) throw error;
        results.push({ kind, status: 'failed', detail: error instanceof Error ? error.message : String(error) });
      }
    }

    return { results };
  };
}

const HANDOFF_HANDLER_FACTORIES: Readonly<Record<string, (deps: PairingHandoffDeps) => GatewayMethodHandler>> = {
  'pairing.handoff.create': createHandoffCreateHandler,
  'pairing.handoff.complete': createHandoffCompleteHandler,
  'pairing.posture.get': createPostureGetHandler,
};

/**
 * Attach the `pairing.handoff.*` handlers to their cataloged descriptors. A
 * missing descriptor is a silent no-op (construction must never fail because one
 * verb failed to register; the operator-contract gates catch a real drift).
 */
export function registerPairingHandoffGatewayMethods(catalog: GatewayMethodCatalog, deps: PairingHandoffDeps): void {
  for (const [methodId, factory] of Object.entries(HANDOFF_HANDLER_FACTORIES)) {
    const descriptor = catalog.get(methodId);
    if (descriptor) {
      catalog.register(descriptor, factory(deps), { replace: true });
    }
  }
}
