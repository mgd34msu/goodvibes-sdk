/**
 * method-catalog-channels-test.ts
 *
 * The `channels.test.send` descriptor — a live per-channel test-message probe.
 * Split into its own builtin array (rather than added to the near-cap
 * method-catalog-channels.ts) and aggregated by method-catalog.ts. Unlike the
 * `retest` account-lifecycle action, which only reports whether a surface's
 * config is present, this verb actually delivers a message through the daemon's
 * channel delivery router and reports the real outcome. Handler:
 * routes/channel-test.ts (registered on the catalog over the daemon's own
 * ChannelDeliveryRouter — the daemon owns the delivery/retest lifecycle), so
 * this is a ws-only invoke verb with no REST binding, exactly like the sibling
 * ci and checkin verbs registered from the same composition root.
 */

import { methodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  CHANNEL_TEST_SEND_INPUT_SCHEMA,
  CHANNEL_TEST_SEND_OUTPUT_SCHEMA,
} from './operator-contract-schemas-channels.js';

export const builtinGatewayChannelTestMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'channels.test.send',
    title: 'Send Channel Test Message',
    description: 'Send a real test message through a configured channel surface and report the actual delivery outcome. delivered:true means the daemon\'s delivery router accepted and sent it (with the surface\'s responseId when it returns one); a failed send is delivered:false with the real error (unconfigured/unsupported surface, provider/transport error) — never a fabricated success. Provide address to target a specific recipient/channel, or omit it to use the surface\'s configured default.',
    category: 'channels',
    scopes: ['write:channels'],
    transport: ['ws'],
    inputSchema: CHANNEL_TEST_SEND_INPUT_SCHEMA,
    outputSchema: CHANNEL_TEST_SEND_OUTPUT_SCHEMA,
  }),
];
