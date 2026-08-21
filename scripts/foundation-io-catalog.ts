// foundation-io-catalog.ts
//
// The one composition of every builtin gateway method descriptor, used by both
// the typed-IO drift check (check-foundation-io-types.ts) and the typed-IO
// entry generator (generate-foundation-io-entries.ts).
//
// It mirrors BUILTIN_GATEWAY_METHODS in
// packages/sdk/src/platform/control-plane/method-catalog.ts exactly, the same
// 27 descriptor arrays in the same order. That constant is module-private, so
// this file re-composes it from the exported arrays rather than duplicating any
// descriptor. `assertCoversMethodIds` below proves the composition has not
// fallen behind the generated operator method id list, so a new catalog module
// that is wired into method-catalog.ts but not into this file FAILS the gate
// instead of silently dropping its verbs out of typed-IO coverage.

import { builtinGatewayAdminMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-admin.ts';
import { builtinGatewayChannelMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-channels.ts';
import { builtinGatewayChannelTestMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-channels-test.ts';
import { builtinGatewayCostMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-cost.ts';
import { builtinGatewayPermissionRuleMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-permission-rules.ts';
import { builtinGatewayControlMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-control.ts';
import { builtinGatewayEmailMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-email.ts';
import { builtinGatewayPaymentsMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-payments.ts';
import { builtinGatewayOwnerProfileMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-owner-profile.ts';
import { builtinGatewayOccasionsMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-occasions.ts';
import { builtinGatewayCalendarMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-calendar.ts';
import { builtinGatewayBrowserMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-browser.ts';
import { builtinGatewayRuntimeMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-runtime.ts';
import { builtinGatewayModelMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-models.ts';
import { builtinGatewayUpdateMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-update.ts';
import { builtinGatewayRelayMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-relay.ts';
import { builtinGatewayKnowledgeMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-knowledge.ts';
import { builtinGatewayMediaMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-media.ts';
import { builtinGatewayPushMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-push.ts';
import { builtinGatewayPairingMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-pairing.ts';
import { builtinGatewayTailscaleMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-tailscale.ts';
import { builtinGatewayAcpMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-acp.ts';
import { builtinGatewaySkillsMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-skills.ts';
import { builtinGatewayPrincipalsMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-principals.ts';
import { builtinGatewayChannelProfilesMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-channel-profiles.ts';
import { builtinGatewayCheckinMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-checkin.ts';
import { builtinGatewayCiMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-ci.ts';
import { builtinGatewayFlagsMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-flags.ts';
import { builtinGatewayRewindMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-rewind.ts';
import { builtinGatewayWorkspacesMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-workspaces.ts';
import { builtinGatewayStepUpMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-stepup.ts';

import { EMPTY_OBJECT_SCHEMA } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.ts';
import type { GatewayMethodDescriptor } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.ts';

/** Every builtin gateway method descriptor, in method-catalog.ts's own order. */
export const ALL_GATEWAY_METHOD_DESCRIPTORS: readonly GatewayMethodDescriptor[] = [
  ...builtinGatewayControlMethodDescriptors,
  ...builtinGatewayChannelMethodDescriptors,
  ...builtinGatewayChannelTestMethodDescriptors,
  ...builtinGatewayCostMethodDescriptors,
  ...builtinGatewayPermissionRuleMethodDescriptors,
  ...builtinGatewayEmailMethodDescriptors,
  ...builtinGatewayPaymentsMethodDescriptors,
  ...builtinGatewayCalendarMethodDescriptors,
  ...builtinGatewayBrowserMethodDescriptors,
  ...builtinGatewayRuntimeMethodDescriptors,
  ...builtinGatewayModelMethodDescriptors,
  ...builtinGatewayUpdateMethodDescriptors,
  ...builtinGatewayRelayMethodDescriptors,
  ...builtinGatewayKnowledgeMethodDescriptors,
  ...builtinGatewayMediaMethodDescriptors,
  ...builtinGatewayAdminMethodDescriptors,
  ...builtinGatewayPushMethodDescriptors,
  ...builtinGatewayPairingMethodDescriptors,
  ...builtinGatewayTailscaleMethodDescriptors,
  ...builtinGatewayAcpMethodDescriptors,
  ...builtinGatewaySkillsMethodDescriptors,
  ...builtinGatewayPrincipalsMethodDescriptors,
  ...builtinGatewayOwnerProfileMethodDescriptors,
  ...builtinGatewayOccasionsMethodDescriptors,
  ...builtinGatewayChannelProfilesMethodDescriptors,
  ...builtinGatewayCheckinMethodDescriptors,
  ...builtinGatewayCiMethodDescriptors,
  ...builtinGatewayFlagsMethodDescriptors,
  ...builtinGatewayRewindMethodDescriptors,
  ...builtinGatewayWorkspacesMethodDescriptors,
  ...builtinGatewayStepUpMethodDescriptors,
];

const DESCRIPTORS_BY_ID = new Map(ALL_GATEWAY_METHOD_DESCRIPTORS.map((d) => [d.id, d]));

/**
 * The verbs whose `anyOf` requirement branches are dropped from the CLIENT TYPE
 * while the SCHEMA keeps them.
 *
 * The schema still carries the branches, the invoke gate enforces them, so the
 * runtime refusal is honest, but the rendered type omits them, because it
 * provably cannot carry them. The reason is a measured TypeScript limit, not a
 * preference: the automation create verbs take a ~35-property input whose
 * members include several deeply nested unions (delivery targets, failure
 * policy, session target, each with a 19-member surfaceKind). Intersecting that
 * with a requirement union makes the operator client's method map exceed the
 * compiler's union-complexity ceiling, `packages/operator-sdk/src/client-core.ts`
 * fails with TS2590, and so does `packages/sdk/src/browser-scoped.ts`. Measured
 * at two, three and four branches, and with the branch contents reduced to a
 * single property: every one fails, while the same file compiles the moment the
 * intersection is removed. There is no branch count that fits.
 *
 * Declared here rather than being a silent difference between schema and type.
 */
const TYPE_DROPS_REQUIREMENT_BRANCHES: ReadonlySet<string> = new Set([
  'automation.jobs.create',
  'automation.schedules.create',
]);

/** Drop a schema's `anyOf` requirement branches, keeping the base. */
function withoutRequirementBranches(schema: Record<string, unknown>): Record<string, unknown> {
  const { anyOf: _dropped, ...base } = schema;
  return base;
}

/** The input/output schema pair for one method id, straight off its catalog descriptor. */
export function descriptorSchemas(methodId: string): {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
} {
  const descriptor = DESCRIPTORS_BY_ID.get(methodId);
  if (!descriptor?.outputSchema) {
    throw new Error(`method-catalog descriptor for "${methodId}" is missing or lacks an output schema`);
  }
  // A verb with no declared input has empty-object input (the contract's own
  // treatment), so it renders the same `{  }` shape a no-arg method would.
  const input = descriptor.inputSchema ?? EMPTY_OBJECT_SCHEMA;
  return {
    input: TYPE_DROPS_REQUIREMENT_BRANCHES.has(methodId) ? withoutRequirementBranches(input) : input,
    output: descriptor.outputSchema,
  };
}

/** Parse the dotted ids out of the generated operator-method-ids.ts source. */
export function parseMethodIds(idsFileText: string): string[] {
  return [...idsFileText.matchAll(/^ {2}"([^"]+)",/gm)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

/**
 * Fail loudly if the generated method id list contains an id this composition
 * cannot resolve, the signal that a new catalog module was wired into
 * method-catalog.ts but not into ALL_GATEWAY_METHOD_DESCRIPTORS above.
 */
export function assertCoversMethodIds(methodIds: readonly string[]): void {
  const unresolved = methodIds.filter((id) => !DESCRIPTORS_BY_ID.has(id));
  if (unresolved.length > 0) {
    throw new Error(
      `foundation-io-catalog.ts does not compose the descriptor arrays for ${unresolved.length} ` +
        `operator method id(s), add the missing method-catalog-*.ts module to ` +
        `ALL_GATEWAY_METHOD_DESCRIPTORS:\n  ${unresolved.join('\n  ')}`,
    );
  }
}
