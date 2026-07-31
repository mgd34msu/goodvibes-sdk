/**
 * method-catalog-relay.ts — asking a daemon whether it is reachable through
 * the relay, and getting the pairing payload that makes a surface able to.
 *
 * The controller has been composed on every daemon that turns the relay on
 * (platform/relay/reachability.ts), and its state was reachable through
 * exactly one door: `DaemonServer.getRelayReachability()`, an in-process method
 * on the facade. A surface running in the same process could read it; every
 * pure client — the terminal, the web surface, the agent, anything over the
 * wire — had no verb to ask and could only report the relay as unavailable,
 * which it did, honestly and uselessly.
 *
 * These two verbs expose what already exists and nothing more. `status` is the
 * controller's own value, including the `disabled` it reports when any of the
 * three gates (relay.enabled, the relay-connect capability, a configured
 * relay.url) is off — so "not reachable" and "not turned on" stay different
 * answers. `mint` is the same call the facade's capability exposes, and returns
 * null the same way when there is no live registration to mint against.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

/** The controller's own status vocabulary, plus the gated-off value. */
const RELAY_STATUS_SCHEMA: Record<string, unknown> = {
  type: 'string',
  enum: ['disabled', 'idle', 'connecting', 'registered', 'reconnecting', 'stopped'],
};

const RELAY_PAIRING_SCHEMA = objectSchema({
  protocol: NUMBER_SCHEMA,
  relayUrl: STRING_SCHEMA,
  rid: STRING_SCHEMA,
  daemonPublicKey: STRING_SCHEMA,
  label: STRING_SCHEMA,
}, ['protocol', 'relayUrl', 'rid', 'daemonPublicKey']);

export const builtinGatewayRelayMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'relay.reachability.get',
    title: 'Relay Reachability',
    description: 'Whether this daemon is registered with the relay, and what state its registration is in. `disabled` is a distinct answer from every other one and the distinction is the point: it means a gate is off — `relay.enabled`, the relay-connect capability, or an empty `relay.url` — rather than that a connection is failing. `idle` means the gates are open and nothing has started; `connecting`, `registered` and `reconnecting` are the live registration; `stopped` is a controller that was told to stop. `configured` says whether all three gates are open, so a caller can render "turn it on" instead of "it is broken". ws-only invoke verb; no REST binding.',
    category: 'control-plane',
    scopes: ['read:control-plane'],
    transport: ['ws'],
    // Declared and empty rather than omitted: the invoke gate skips a verb with
    // no typed inputSchema, so "takes nothing" has to be stated to be enforced.
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({
      status: RELAY_STATUS_SCHEMA,
      configured: { type: 'boolean' },
    }, ['status', 'configured']),
  }),
  methodDescriptor({
    id: 'relay.pairing.mint',
    title: 'Mint A Relay Pairing Payload',
    description: 'Return the pairing payload a surface scans to reach this daemon through the relay: the relay URL to dial, the rendezvous id the daemon registered under, and the daemon\'s static public key. `pairing` is null — not an error — when there is no live registration to mint against, which is the honest answer for a daemon whose relay is off or has not connected yet, and is the same value the in-process capability returns. Minting does not create a second identity or a second registration; it describes the one that exists.',
    category: 'control-plane',
    scopes: ['write:control-plane'],
    access: 'admin',
    transport: ['ws'],
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({
      pairing: { anyOf: [RELAY_PAIRING_SCHEMA, { type: 'null' }] },
      status: RELAY_STATUS_SCHEMA,
    }, ['pairing', 'status']),
  }),
];
