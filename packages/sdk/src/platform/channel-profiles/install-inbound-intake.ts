/**
 * channel-profiles/install-inbound-intake.ts
 *
 * Wires the inbound-intake enrichment substrate (buildInboundIntakeEnrichment)
 * into the live session origination path WITHOUT every channel adapter having to
 * call it by hand. The composition root (registerGatewayVerbGroups, which already
 * constructs the principal and channel-profile registries) installs this once; it
 * decorates the shared broker's `submitMessage` — the single transport intake
 * chokepoint every adapter funnels an inbound message through — so each inbound
 * message gets its sender attributed and its channel's profile applied at the
 * moment the session is originated.
 *
 * submitMessage's input carries the NARROW transport surface kind (a Slack/Signal/
 * etc. surface, never a product surface like webui/agent — those originate via
 * sessions.register, a different path), so decorating it is inherently scoped to
 * channel inbound. The enrichment only augments the session/message metadata (it
 * never drops or rewrites a caller field), so an unmapped sender is stamped with
 * the honest unknown principal (known:false) rather than a guess.
 */
import type { PrincipalRegistry } from '../principals/index.js';
import type { SubmitSharedSessionMessageInput, SharedSessionSubmission } from './../control-plane/session-types.js';
import { buildInboundIntakeEnrichment } from './intake.js';
import {
  CHANNEL_PROFILE_MODEL_KEY,
  CHANNEL_PROFILE_PROVIDER_KEY,
  CHANNEL_PROFILE_PERMISSION_MODE_KEY,
} from './intake.js';
import type { ChannelProfileRegistry } from './registry.js';

/** The broker surface this decorator needs: just the transport intake entry point. */
export interface InboundIntakeBroker {
  submitMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission>;
}

export interface InboundIntakeEnrichmentDeps {
  readonly principals: Pick<PrincipalRegistry, 'resolveByIdentity'>;
  readonly channelProfiles: Pick<ChannelProfileRegistry, 'resolve'>;
}

/**
 * Compute the metadata an inbound submit input should carry: the sender
 * attribution plus the applied channel profile (model/provider/permission mode),
 * merged over whatever metadata the caller already set. Exported for direct
 * testing of the enrichment mapping independent of the broker decoration.
 */
export async function enrichInboundSubmitMetadata(
  deps: InboundIntakeEnrichmentDeps,
  input: SubmitSharedSessionMessageInput,
): Promise<Record<string, unknown>> {
  const enrichment = await buildInboundIntakeEnrichment(deps, {
    surfaceKind: input.surfaceKind,
    userId: input.userId,
    // Scope the profile to the originating channel when the input identifies one,
    // else fall back to the surface-level binding.
    channelId: input.externalId ?? input.surfaceId,
  });
  return {
    ...(input.metadata ?? {}),
    ...enrichment.sessionMetadata,
    ...(enrichment.spawnOverrides.model !== undefined ? { [CHANNEL_PROFILE_MODEL_KEY]: enrichment.spawnOverrides.model } : {}),
    ...(enrichment.spawnOverrides.provider !== undefined ? { [CHANNEL_PROFILE_PROVIDER_KEY]: enrichment.spawnOverrides.provider } : {}),
    ...(enrichment.permissionMode !== undefined ? { [CHANNEL_PROFILE_PERMISSION_MODE_KEY]: enrichment.permissionMode } : {}),
  };
}

/**
 * Decorate a broker's submitMessage so every inbound transport message is
 * enriched before origination. Idempotent guard: a broker already wrapped is left
 * as-is so a double install (defensive composition) never double-stamps.
 */
export function installInboundIntakeEnrichment(
  broker: InboundIntakeBroker,
  deps: InboundIntakeEnrichmentDeps,
): void {
  const marked = broker as InboundIntakeBroker & { __inboundIntakeEnriched?: boolean };
  if (marked.__inboundIntakeEnriched) return;
  const original = broker.submitMessage.bind(broker);
  broker.submitMessage = async (input: SubmitSharedSessionMessageInput) => {
    const metadata = await enrichInboundSubmitMetadata(deps, input);
    return original({ ...input, metadata });
  };
  marked.__inboundIntakeEnriched = true;
}
