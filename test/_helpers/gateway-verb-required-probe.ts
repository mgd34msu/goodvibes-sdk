/**
 * _helpers/gateway-verb-required-probe.ts
 *
 * The machinery behind `test/gateway-verb-required-conformance.test.ts`.
 *
 * WHAT IT CHECKS. A gateway verb is described twice: its method-catalog
 * descriptor declares `inputSchema.required`, and its route handler decides at
 * runtime what it will actually refuse without. The `required` array is what
 * consumers compile against (packages/contracts' generated typed IO) and what
 * `invoke-input-validation.ts` enforces before dispatch. When a handler refuses
 * a field the descriptor never declared required, every consumer type-checks
 * clean and every consumer 400s at runtime. That has now been found three
 * separate times in this control plane, each time by a human reading one file.
 *
 * HOW IT CHECKS IT — and why this shape rather than a static rule. Enforcement
 * here is arbitrary TypeScript inside closures produced by factory functions
 * and composed through injected service objects. A static analyzer would have
 * to model data flow across module boundaries and would either cry wolf or,
 * far worse, silently pass the handlers it could not model. So this probe does
 * the one thing that cannot be wrong about a handler's behaviour: it RUNS the
 * handler.
 *
 * For each verb it builds a params object containing exactly the fields the
 * descriptor declares required (typed sample values), invokes the real
 * registered handler over stub services, and looks at what comes back. A
 * handler that then refuses, naming a field outside the declared set, is the
 * defect — reported with the field name.
 *
 * WHAT IT DOES NOT CLAIM. The probe explores one point in the input space, so
 * a requirement that only appears once some OTHER field holds a particular
 * value is not reached. That incompleteness is real and is reported per verb
 * rather than hidden: every verb lands in exactly one verdict, the counts are
 * asserted, and no verb is silently skipped. A gate that reports green while
 * checking a different property than it claims is worse than no gate.
 *
 * The field name never comes from parsing an error message. It comes from
 * `GatewayVerbError.field`, which the handlers set explicitly — see that
 * class's doc comment for why prose parsing was rejected.
 */
import { GatewayMethodCatalog } from '../../packages/sdk/src/platform/control-plane/method-catalog.js';
import {
  GatewayVerbError,
  isGatewayVerbError,
} from '../../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.js';
import type {
  GatewayMethodDescriptor,
  GatewayMethodInvocationContext,
} from '../../packages/sdk/src/platform/control-plane/method-catalog-shared.js';

import { registerAcpGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/acp.js';
import { registerApprovalRaiseGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/approvals-raise.js';
import { registerCredentialWriteGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/credentials-write.js';
import { registerBrowserGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/browser.js';
import { registerCalendarGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/calendar.js';
import { registerChannelProfilesGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/channel-profiles.js';
import { registerChannelTestGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/channel-test.js';
import { registerCheckinGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/checkin.js';
import { registerCiGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/ci.js';
import { registerCostGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/cost.js';
import { registerDevicesGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/devices.js';
import { registerDaemonEmailVerbs } from '../../packages/sdk/src/platform/control-plane/routes/email-composition.js';
import { registerEmailGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/email.js';
import { registerEmailExpectationGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/email-expectations.ts';
import { registerOccasionsGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/occasions.ts';
import { registerOwnerProfileGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/owner-profile.ts';
import { registerPaymentsGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/payments.ts';
import { registerFlagsGraduationGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/flags-graduation.js';
import { registerFleetCheckpointsSearchGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/register-fleet-checkpoints-search.js';
import { registerMemoryGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/memory.js';
import { registerMemoryProjectionsGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/memory-projections.js';
import { registerPairingGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/pairing.js';
import { registerPairingHandoffGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/pairing-handoff.js';
import { registerPermissionRulesGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/permission-rules.js';
import { registerPowerGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/power.js';
import { registerPrincipalsGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/principals.js';
import { registerPushGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/push.js';
import { registerRewindGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/rewind.js';
import { registerRuntimeMetricsGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/runtime-metrics.js';
import { registerSessionRuntimeGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/session-runtime.js';
import { registerSkillsGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/skills.js';
import { registerStepUpGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/stepup.js';
import { registerTailscaleGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/tailscale.js';
import { registerVoiceSetupGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/voice-setup.js';
import { registerWorkspacesGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/workspaces.js';
import { registerWorktreeSetupGatewayMethods } from '../../packages/sdk/src/platform/control-plane/routes/worktree-setup.js';

/**
 * A stand-in for whatever service/deps a route group is handed.
 *
 * Every property read yields another stub and every call returns an empty
 * object, so a handler reaches its own input validation without any real
 * backend. Once validation passes, the handler is free to fail inside the stub
 * (an empty object where it wanted an array) — that failure is not a
 * GatewayVerbError and the probe reads it for exactly what it is: the input was
 * accepted.
 *
 * `then` is deliberately undefined so awaiting a stub cannot deadlock.
 */
function stubDeps(): never {
  const target = function stubbed(): undefined { return undefined; };
  return new Proxy(target, {
    get(_target, property) {
      if (property === 'then' || property === 'catch' || property === 'finally') return undefined;
      if (typeof property === 'symbol') return undefined;
      if (property === 'constructor') return Object;
      return stubDeps();
    },
    apply() { return Promise.resolve({}); },
    construct() { return stubDeps(); },
    has() { return true; },
  }) as never;
}

/**
 * Every route module that attaches handlers to catalog descriptors.
 *
 * `expectedRouteRegistrars` (below) is asserted against the routes directory,
 * so a new verb family cannot be added without either appearing here or making
 * the conformance test red — which is the point: an unprobed family is an
 * unchecked family.
 */
const ROUTE_REGISTRARS: ReadonlyArray<readonly [string, (catalog: GatewayMethodCatalog) => void]> = [
  ['acp', (catalog) => registerAcpGatewayMethods(catalog, stubDeps())],
  ['approvals-raise', (catalog) => registerApprovalRaiseGatewayMethods(catalog, stubDeps())],
  ['credentials-write', (catalog) => registerCredentialWriteGatewayMethods(catalog, stubDeps())],
  ['browser', (catalog) => registerBrowserGatewayMethods(catalog, stubDeps())],
  ['calendar', (catalog) => registerCalendarGatewayMethods(catalog, stubDeps())],
  ['channel-profiles', (catalog) => registerChannelProfilesGatewayMethods(catalog, stubDeps())],
  ['channel-test', (catalog) => registerChannelTestGatewayMethods(catalog, stubDeps())],
  ['checkin', (catalog) => registerCheckinGatewayMethods(catalog, stubDeps())],
  ['ci', (catalog) => registerCiGatewayMethods(catalog, stubDeps())],
  ['cost', (catalog) => registerCostGatewayMethods(catalog, stubDeps())],
  ['devices', (catalog) => registerDevicesGatewayMethods(catalog, stubDeps())],
  ['email', (catalog) => registerEmailGatewayMethods(catalog, stubDeps())],
  ['email-expectations', (catalog) => registerEmailExpectationGatewayMethods(catalog, stubDeps())],
  ['occasions', (catalog) => registerOccasionsGatewayMethods(catalog, stubDeps())],
  ['owner-profile', (catalog) => registerOwnerProfileGatewayMethods(catalog, stubDeps())],
  ['payments', (catalog) => registerPaymentsGatewayMethods(catalog, stubDeps())],
  ['email-composition', (catalog) => registerDaemonEmailVerbs(catalog, stubDeps())],
  ['flags-graduation', (catalog) => registerFlagsGraduationGatewayMethods(catalog, stubDeps())],
  ['fleet-checkpoints-search', (catalog) => registerFleetCheckpointsSearchGatewayMethods(catalog, stubDeps())],
  ['memory', (catalog) => registerMemoryGatewayMethods(catalog, stubDeps())],
  ['memory-projections', (catalog) => registerMemoryProjectionsGatewayMethods(catalog, stubDeps())],
  ['pairing', (catalog) => registerPairingGatewayMethods(catalog, stubDeps())],
  ['pairing-handoff', (catalog) => registerPairingHandoffGatewayMethods(catalog, stubDeps())],
  ['permission-rules', (catalog) => registerPermissionRulesGatewayMethods(catalog, stubDeps())],
  ['power', (catalog) => registerPowerGatewayMethods(catalog, stubDeps())],
  ['principals', (catalog) => registerPrincipalsGatewayMethods(catalog, stubDeps())],
  ['push', (catalog) => registerPushGatewayMethods(catalog, stubDeps())],
  ['rewind', (catalog) => registerRewindGatewayMethods(catalog, stubDeps())],
  ['runtime-metrics', (catalog) => registerRuntimeMetricsGatewayMethods(catalog)],
  ['session-runtime', (catalog) => registerSessionRuntimeGatewayMethods(catalog, stubDeps())],
  ['skills', (catalog) => registerSkillsGatewayMethods(catalog, stubDeps())],
  ['stepup', (catalog) => registerStepUpGatewayMethods(catalog, stubDeps())],
  ['tailscale', (catalog) => registerTailscaleGatewayMethods(catalog, stubDeps())],
  ['voice-setup', (catalog) => registerVoiceSetupGatewayMethods(catalog, stubDeps())],
  ['workspaces', (catalog) => registerWorkspacesGatewayMethods(catalog, stubDeps())],
  ['worktree-setup', (catalog) => registerWorktreeSetupGatewayMethods(catalog, stubDeps())],
];

/**
 * Every `export function register…GatewayMethods` / `…Verbs` the routes
 * directory is expected to contain. Two entries are deliberately NOT probed
 * directly: `registerGatewayVerbGroups` is the composition root that calls the
 * others, and `registerFleetGatewayMethods` / `registerCheckpointGatewayMethods`
 * are reached through `registerFleetCheckpointsSearchGatewayMethods`.
 */
export const EXPECTED_ROUTE_REGISTRARS: readonly string[] = [
  'registerAcpGatewayMethods',
  'registerApprovalRaiseGatewayMethods',
  'registerBrowserGatewayMethods',
  'registerCalendarGatewayMethods',
  'registerChannelProfilesGatewayMethods',
  'registerChannelTestGatewayMethods',
  'registerCheckinGatewayMethods',
  'registerCheckpointGatewayMethods',
  'registerCiGatewayMethods',
  'registerCostGatewayMethods',
  'registerCredentialWriteGatewayMethods',
  'registerDaemonEmailVerbs',
  'registerDevicesGatewayMethods',
  'registerEmailGatewayMethods',
  'registerEmailExpectationGatewayMethods',
  'registerOccasionsGatewayMethods',
  'registerOwnerProfileGatewayMethods',
  'registerPaymentsGatewayMethods',
  'registerFlagsGraduationGatewayMethods',
  'registerFleetCheckpointsSearchGatewayMethods',
  'registerFleetGatewayMethods',
  'registerGatewayVerbGroups',
  'registerMemoryGatewayMethods',
  'registerMemoryProjectionsGatewayMethods',
  'registerPairingGatewayMethods',
  'registerPairingHandoffGatewayMethods',
  'registerPermissionRulesGatewayMethods',
  'registerPowerGatewayMethods',
  'registerPrincipalsGatewayMethods',
  'registerPushGatewayMethods',
  'registerRewindGatewayMethods',
  'registerRuntimeMetricsGatewayMethods',
  'registerSessionRuntimeGatewayMethods',
  'registerSkillsGatewayMethods',
  'registerStepUpGatewayMethods',
  'registerTailscaleGatewayMethods',
  'registerVoiceSetupGatewayMethods',
  'registerWorkspacesGatewayMethods',
  'registerWorktreeSetupGatewayMethods',
];

/**
 * Sample values for declared-required fields whose schema does not pin the
 * value domain (a plain `{ type: 'string' }` for a field the handler will only
 * accept from a fixed set). Without these the probe stops at `value-rejected`
 * and learns nothing about the rest of the verb's input, so each entry buys
 * real coverage. Keyed `verbId.fieldName`; anything absent falls back to a
 * value derived from the declared schema.
 */
/** A well-formed uncompressed P-256 point (0x04 marker + 64 bytes), base64url. */
const PROBE_P256DH = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0x01)]).toString('base64url');
/** A well-formed 16-byte push auth secret, base64url. */
const PROBE_AUTH_SECRET = Buffer.alloc(16, 0x02).toString('base64url');
const PROBE_PUSH_KEYS = { p256dh: PROBE_P256DH, auth: PROBE_AUTH_SECRET };

const SAMPLE_OVERRIDES: Readonly<Record<string, unknown>> = {
  'sessions.permissionMode.set.mode': 'normal',
  'rewind.plan.scope': 'both',
  'rewind.apply.scope': 'both',
  'cost.attribution.get.window': '24h',
  'cost.attribution.get.dimension': 'agent',
  'checkpoints.create.kind': 'manual',
  // A directory the handler will find on disk, so the probe gets past the
  // existence check and can see the rest of the verb's requirements.
  'acp.sessions.create.cwd': process.cwd(),
  'push.subscriptions.create.endpoint': 'https://example.invalid/push/probe',
  'push.subscriptions.create.keys': PROBE_PUSH_KEYS,
  'push.subscriptions.reconcile.endpoint': 'https://example.invalid/push/probe',
  'push.subscriptions.reconcile.keys': PROBE_PUSH_KEYS,
};

function sampleForSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return 'probe';
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum) && record.enum.length > 0) return record.enum[0];
  switch (record.type) {
    case 'string': return 'probe';
    case 'number': case 'integer': return 1;
    case 'boolean': return true;
    case 'array': return [sampleForSchema(record.items)];
    case 'object': return {};
    default: return 'probe';
  }
}

/** Codes a refusal uses when it is ABOUT the shape of the caller's input. */
const INPUT_SHAPE_CODES: ReadonlySet<string> = new Set([
  'INVALID_ARGUMENT',
  'INVALID_INPUT',
  'CONFIRMATION_REQUIRED',
  'VALIDATION_ERROR',
]);

export type VerbVerdict =
  /** Handler accepted the declared-required set; nothing further was demanded. */
  | 'declared-satisfied'
  /** THE DEFECT: handler demanded a field the descriptor does not declare required. */
  | 'undeclared-requirement'
  /** Handler rejected a declared-required field on VALUE grounds; probe stops there. */
  | 'value-rejected'
  /** Input-shaped refusal that names no field — the probe cannot attribute it. */
  | 'unattributed-refusal';

export interface VerbConformance {
  readonly id: string;
  readonly declaredRequired: readonly string[];
  readonly verdict: VerbVerdict;
  readonly field: string | undefined;
  readonly code: string | undefined;
  readonly message: string | undefined;
}

const PROBE_CONTEXT: GatewayMethodInvocationContext = {
  principalId: 'required-conformance-probe',
  principalKind: 'user',
  admin: true,
  scopes: ['*'],
  metadata: {},
};

function declaredRequiredOf(descriptor: GatewayMethodDescriptor): readonly string[] {
  const schema = descriptor.inputSchema;
  if (!schema) return [];
  const required = (schema as Record<string, unknown>).required;
  return Array.isArray(required) ? required.filter((entry): entry is string => typeof entry === 'string') : [];
}

function buildProbeParams(descriptor: GatewayMethodDescriptor, required: readonly string[]): Record<string, unknown> {
  const schema = (descriptor.inputSchema ?? {}) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  for (const field of required) {
    const override = `${descriptor.id}.${field}`;
    params[field] = Object.hasOwn(SAMPLE_OVERRIDES, override)
      ? SAMPLE_OVERRIDES[override]
      : sampleForSchema(properties[field]);
  }
  return params;
}

/** Build the catalog every registrar has attached its handlers to. */
export function buildProbeCatalog(): GatewayMethodCatalog {
  const catalog = new GatewayMethodCatalog();
  for (const [, register] of ROUTE_REGISTRARS) register(catalog);
  return catalog;
}

/** Probe one verb. See the module comment for what each verdict means. */
export async function probeVerb(
  catalog: GatewayMethodCatalog,
  descriptor: GatewayMethodDescriptor,
): Promise<VerbConformance> {
  const declaredRequired = declaredRequiredOf(descriptor);
  const params = buildProbeParams(descriptor, declaredRequired);
  const base = { id: descriptor.id, declaredRequired };
  try {
    await catalog.invoke(descriptor.id, { body: params, query: {}, context: PROBE_CONTEXT });
    return { ...base, verdict: 'declared-satisfied', field: undefined, code: undefined, message: undefined };
  } catch (error) {
    if (!isGatewayVerbError(error)) {
      // Past input validation and into the stub. The input was accepted.
      return { ...base, verdict: 'declared-satisfied', field: undefined, code: undefined, message: undefined };
    }
    const verbError = error as GatewayVerbError;
    if (!INPUT_SHAPE_CODES.has(verbError.code)) {
      // A refusal about the state of the world (unknown id, wrong node kind,
      // missing principal), not about the caller's input shape.
      return { ...base, verdict: 'declared-satisfied', field: undefined, code: verbError.code, message: undefined };
    }
    const details = { field: verbError.field, code: verbError.code, message: verbError.message };
    if (verbError.field === undefined) {
      return { ...base, verdict: 'unattributed-refusal', ...details };
    }
    const root = verbError.field.split(/[.[]/)[0] ?? verbError.field;
    const isDeclared = declaredRequired.includes(verbError.field) || declaredRequired.includes(root);
    return { ...base, verdict: isDeclared ? 'value-rejected' : 'undeclared-requirement', ...details };
  }
}

/** Probe every verb in the catalog that has a registered handler. */
export async function probeAllHandlerVerbs(catalog: GatewayMethodCatalog): Promise<readonly VerbConformance[]> {
  const results: VerbConformance[] = [];
  for (const descriptor of catalog.list()) {
    if (!catalog.hasHandler(descriptor.id)) continue;
    results.push(await probeVerb(catalog, descriptor));
  }
  return results;
}
