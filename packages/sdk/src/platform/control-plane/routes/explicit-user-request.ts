/**
 * explicit-user-request.ts, the second half of a confirmation gate.
 *
 * `confirm: true` says the CALL was reviewed. `explicitUserRequest` says a
 * person asked for it, and it travels in `context.metadata.explicitUserRequest`
 *, a field of `GatewayMethodInvocationContext`, so an SDK-registered handler
 * can read it, which is what the product-side wrapper this replaces did.
 *
 * The rule here is: an explicit `false` refuses, `true` and absent proceed.
 *
 * Why not require `true` outright, which is what the product wrapper did? Two
 * facts about who invokes these verbs:
 *
 *  - **No live transport sets the field.** Neither the daemon's HTTP dispatch
 *    nor its WebSocket dispatch populates `context.metadata`, so requiring
 *    `true` would refuse every real caller, the verbs would answer 403
 *    forever, which is not a stricter guarantee, it is a dead capability.
 *  - **The daemon's job includes callers that are honestly not a person.**
 *    Scheduled work, triggers and channel-driven work are exactly why these
 *    verbs are served with no product process attached. A reminder that sends
 *    itself at 08:00 cannot claim to be an explicit user request, and should
 *    not have to lie to send.
 *
 * So a caller that says nothing gets the `confirm: true` gate, unchanged, and a
 * caller that takes the trouble to say "this is not a user request" is taken at
 * its word and refused. Silence is not consent here; it is simply not a claim
 * either way, and the confirmation gate is what stands in front of the write.
 */

import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';

/**
 * Refuse a write whose caller declared it was not a user request.
 *
 * @param invocation - the invocation whose context may carry the claim.
 * @param action - the verb id, for the message.
 */
export function refuseNonUserRequest(invocation: GatewayMethodInvocation, action: string): void {
  if (invocation.context.metadata?.['explicitUserRequest'] === false) {
    throw new GatewayVerbError(
      `${action} needs an explicit user request. The caller declared this was not one, so it was refused rather than performed on someone's behalf.`,
      'EXPLICIT_USER_REQUEST_REQUIRED',
      403,
    );
  }
}
