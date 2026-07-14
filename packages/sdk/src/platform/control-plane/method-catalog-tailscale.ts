/**
 * method-catalog-tailscale.ts
 *
 * Tailscale auto-wire verbs: read-only detection of a usable tailscale
 * environment, and the one-action affordance that sets up `tailscale serve`
 * for the daemon's web surface — the recommended https path, because the
 * daemon NEVER mints certificates. Where tailscale is absent, detection says
 * so once and nothing nags.
 *
 * Like the other handler-registered verb groups these declare
 * `transport: ['ws']` and are served through the generic
 * `/api/control-plane/methods/{id}/invoke` endpoint.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

/** The honest record of one serve attempt. */
const TAILSCALE_SERVE_RECEIPT_SCHEMA = objectSchema({
  at: NUMBER_SCHEMA,
  command: STRING_SCHEMA,
  ok: BOOLEAN_SCHEMA,
  url: STRING_SCHEMA,
  detail: STRING_SCHEMA,
}, ['at', 'command', 'ok', 'detail']);

export const builtinGatewayTailscaleMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'tailscale.get',
    title: 'Detect Tailscale Environment',
    description: 'READ-ONLY detection of a usable tailscale environment: binary present, logged-in status, MagicDNS name, and the https URL `tailscale serve` would yield. Never invokes a state-changing tailscale command. Where tailscale is absent the result says so once — surfaces offer the auto-wire affordance only when this reports a usable environment; nothing nags. Includes the most recent serve receipt, if any.',
    category: 'remote-access',
    scopes: ['read:control-plane'],
    transport: ['ws'],
    outputSchema: objectSchema({
      available: BOOLEAN_SCHEMA,
      loggedIn: BOOLEAN_SCHEMA,
      magicDnsName: STRING_SCHEMA,
      httpsUrl: STRING_SCHEMA,
      detail: STRING_SCHEMA,
      lastServe: TAILSCALE_SERVE_RECEIPT_SCHEMA,
    }, ['available', 'loggedIn', 'detail']),
  }),
  methodDescriptor({
    id: 'tailscale.serve.run',
    title: 'Set Up Tailscale Serve For The Daemon',
    description: 'The one-action https affordance: run `tailscale serve --bg <web port>` so tailscale fronts the daemon\'s web surface at its https MagicDNS URL. This is the ONLY state-changing tailscale command the daemon ever runs, and only from this explicit user-initiated verb. The attempt is recorded with an honest receipt either way; on success web.publicBaseUrl is updated to the https URL from the same resolution. The daemon never mints certificates — TLS is terminated by tailscale.',
    category: 'remote-access',
    scopes: ['write:control-plane'],
    transport: ['ws'],
    outputSchema: objectSchema({
      receipt: TAILSCALE_SERVE_RECEIPT_SCHEMA,
      publicBaseUrlUpdated: BOOLEAN_SCHEMA,
    }, ['receipt', 'publicBaseUrlUpdated']),
  }),
];
