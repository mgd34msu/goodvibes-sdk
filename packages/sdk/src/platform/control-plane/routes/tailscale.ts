/**
 * routes/tailscale.ts
 *
 * Handlers for the tailscale.* verbs over the remote-access tailscale module.
 * Detection is read-only; the serve action is the ONE state-changing tailscale
 * command, run only from this explicit user-initiated verb, recorded with an
 * honest receipt, and on success web.publicBaseUrl updates from the same
 * resolution (the https MagicDNS URL).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import {
  detectTailscale,
  enableTailscaleServe,
  type TailscaleCommandRunner,
  type TailscaleServeReceiptStore,
} from '../../remote-access/tailscale.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { logger } from '../../utils/logger.js';

export interface TailscaleGatewayDeps {
  /** Injectable command runner (tests never touch a real tailscale). */
  readonly runner: TailscaleCommandRunner;
  readonly receipts: TailscaleServeReceiptStore;
  /** The daemon web port `tailscale serve` fronts. */
  readonly resolveWebPort: () => number;
  /** Persist the https MagicDNS URL as web.publicBaseUrl on a successful serve. */
  readonly setPublicBaseUrl: (url: string) => void;
}

function requirePrincipal(invocation: GatewayMethodInvocation): void {
  if (!invocation.context.principalId) {
    throw new GatewayVerbError('Tailscale verbs require an authenticated principal', 'UNAUTHENTICATED', 401);
  }
}

function createGetHandler(deps: TailscaleGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const detection = detectTailscale(deps.runner);
    const lastServe = deps.receipts.latest();
    return { ...detection, ...(lastServe ? { lastServe } : {}) };
  };
}

function createServeRunHandler(deps: TailscaleGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const receipt = enableTailscaleServe(deps.resolveWebPort(), deps.runner);
    // The attempt is recorded either way — an honest receipt, never a silent failure.
    deps.receipts.append(receipt);
    let publicBaseUrlUpdated = false;
    if (receipt.ok && receipt.url) {
      try {
        deps.setPublicBaseUrl(receipt.url);
        publicBaseUrlUpdated = true;
      } catch (error) {
        logger.warn('tailscale.serve.run: web.publicBaseUrl update failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { receipt, publicBaseUrlUpdated };
  };
}

const TAILSCALE_HANDLER_FACTORIES: Readonly<Record<string, (deps: TailscaleGatewayDeps) => GatewayMethodHandler>> = {
  'tailscale.get': createGetHandler,
  'tailscale.serve.run': createServeRunHandler,
};

/**
 * Attach the tailscale.* handlers to their cataloged descriptors. A missing
 * descriptor is a silent no-op (the operator-contract gates catch real drift).
 */
export function registerTailscaleGatewayMethods(catalog: GatewayMethodCatalog, deps: TailscaleGatewayDeps): void {
  for (const [methodId, factory] of Object.entries(TAILSCALE_HANDLER_FACTORIES)) {
    const descriptor = catalog.get(methodId);
    if (descriptor) {
      catalog.register(descriptor, factory(deps), { replace: true });
    }
  }
}
