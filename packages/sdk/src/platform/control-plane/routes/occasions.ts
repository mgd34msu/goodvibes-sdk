/**
 * routes/occasions.ts
 *
 * Handlers for the `occasions.*` gateway verbs over `OccasionsService`
 * (../../occasions/service.js). Thin verb registration in the same shape as
 * routes/owner-profile.ts: read the invocation params, call the service, answer.
 *
 * ## Every rule lives below this file
 *
 * Nothing here decides anything. The kind is not defaulted here, the nudge is
 * not composed here, quiet hours are not evaluated here, and no date is
 * formatted here. That is the point: a surface calls a verb and renders the
 * answer, and this layer is the only thing between the two. A rule implemented
 * in a route is a rule the next transport gets wrong.
 *
 * ## The two writes that touch the owner's file
 *
 * `occasions.confirm` and `occasions.plans.confirm` append a line to the owner
 * profile, and `occasions.remove` deletes one. All three take `authority` as a
 * required body parameter and go through `OwnerProfileStore`, which runs the
 * profile's own write gate before a line lands. `refuseNonUserRequest` runs
 * first on all three, for the same reason it does on `profile.set`: "you told
 * me this was not a user request" deserves its own answer rather than being
 * folded into a trust refusal naming a surface the caller never claimed.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { refuseNonUserRequest } from './explicit-user-request.js';
import type { AuthoritySurface } from '../../security/untrusted-content.js';
import { isProfileSurface, type ProfileSurface } from '../../owner-profile/index.js';
import {
  isOccasionAckSource,
  isOccasionAnswer,
  type OccasionAckSource,
  type OccasionAnswer,
} from '../../occasions/types.js';
import type { OccasionsService } from '../../occasions/service.js';

/** The surface of the service these verbs need. */
export type OccasionsGatewayService = Pick<
  OccasionsService,
  | 'list'
  | 'listPlans'
  | 'proposeOccasion'
  | 'confirmOccasion'
  | 'proposePlan'
  | 'confirmPlan'
  | 'removeOccasion'
  | 'answer'
  | 'acknowledge'
  | 'interview'
  | 'answerInterview'
  | 'recordGiftOutcome'
  | 'giftHistory'
  | 'pending'
  | 'sweep'
  | 'resolveConflict'
  | 'disclose'
>;

const AUTHORITY_SURFACES: readonly AuthoritySurface[] = [
  'owner-direct',
  'web-page',
  'email',
  'channel-message',
  'document',
];

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} is required`, 'INVALID_ARGUMENT', 400, field);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The authority the caller claims. REQUIRED, and never defaulted.
 *
 * Same reasoning as `routes/owner-profile.ts`: it is a body parameter of these
 * verbs rather than a transport-populated context field, so requiring it costs
 * one word and closes the case where omitting it granted the one tier that
 * carries write authority. A removal with no authority at all would otherwise
 * be a delete with no gate.
 */
function readAuthority(value: unknown): AuthoritySurface {
  if (typeof value !== 'string' || !(AUTHORITY_SURFACES as readonly string[]).includes(value)) {
    throw new GatewayVerbError(
      `authority is required and must be one of ${AUTHORITY_SURFACES.join(', ')}`,
      'INVALID_ARGUMENT',
      400,
      'authority',
    );
  }
  return value as AuthoritySurface;
}

function readSurface(value: unknown): ProfileSurface {
  const surface = requireString(value, 'surface');
  if (!isProfileSurface(surface)) {
    throw new GatewayVerbError(
      'surface must be one of tui, agent, webui, voice, hand-edit',
      'INVALID_ARGUMENT',
      400,
      'surface',
    );
  }
  return surface;
}

/**
 * The answer, checked against the three the owner can give.
 *
 * `later` is one of them and is not a decline — a caller that sends anything
 * else is refused rather than folded into `no`, because reading an unknown word
 * as a refusal would silence an occasion the owner never declined.
 */
/**
 * Where an acknowledgement came from, defaulting to `explicit`.
 *
 * A verb call with no source IS a surface offering the action, which is what
 * `explicit` means — so this defaults rather than refusing. Refusing would make
 * the provenance label, which only explains a mute, capable of preventing one.
 */
function readAckSource(value: unknown): OccasionAckSource {
  const source = optionalString(value);
  if (source === undefined) return 'explicit';
  if (!isOccasionAckSource(source)) {
    throw new GatewayVerbError(
      'source must be one of conversation, explicit, gift-flow',
      'INVALID_ARGUMENT',
      400,
      'source',
    );
  }
  return source;
}

function readAnswer(value: unknown): OccasionAnswer {
  const answer = requireString(value, 'answer');
  if (!isOccasionAnswer(answer)) {
    throw new GatewayVerbError(
      'answer must be one of yes, no, later, acknowledged',
      'INVALID_ARGUMENT',
      400,
      'answer',
    );
  }
  return answer;
}

function interviewAnswer(progress: unknown): { present: boolean; interview: unknown } {
  return { present: progress !== null, interview: progress };
}

export function registerOccasionsGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: OccasionsGatewayService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };

  attach('occasions.list', () => service.list());
  attach('occasions.plans.list', () => service.listPlans());
  attach('occasions.state', () => service.disclose());
  attach('occasions.pending', () => service.pending());
  attach('occasions.sweep', () => service.sweep());

  attach('occasions.propose', (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return service.proposeOccasion({
      title: requireString(params.title, 'title'),
      date: requireString(params.date, 'date'),
      ...(optionalString(params.kind) === undefined ? {} : { kind: optionalString(params.kind) }),
      ...(optionalString(params.person) === undefined ? {} : { person: optionalString(params.person) }),
      ...(optionalString(params.recurrence) === undefined ? {} : { recurrence: optionalString(params.recurrence) }),
      ...(optionalNumber(params.leadDays) === undefined ? {} : { leadDays: optionalNumber(params.leadDays) }),
    });
  });

  attach('occasions.confirm', (invocation: GatewayMethodInvocation) => {
    refuseNonUserRequest(invocation, 'occasions.confirm');
    const params = readInvocationParams(invocation);
    return service.confirmOccasion({
      title: requireString(params.title, 'title'),
      date: requireString(params.date, 'date'),
      kind: requireString(params.kind, 'kind'),
      ...(optionalString(params.person) === undefined ? {} : { person: optionalString(params.person) }),
      ...(optionalString(params.recurrence) === undefined ? {} : { recurrence: optionalString(params.recurrence) }),
      ...(optionalNumber(params.leadDays) === undefined ? {} : { leadDays: optionalNumber(params.leadDays) }),
      surface: readSurface(params.surface),
      said: requireString(params.said, 'said'),
      authority: readAuthority(params.authority),
    });
  });

  attach('occasions.remove', (invocation: GatewayMethodInvocation) => {
    refuseNonUserRequest(invocation, 'occasions.remove');
    const params = readInvocationParams(invocation);
    return service.removeOccasion({
      occasionId: requireString(params.occasionId, 'occasionId'),
      confirmed: params.confirmed === true,
      authority: readAuthority(params.authority),
    });
  });

  attach('occasions.answer', (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return service.answer({
      occasionId: requireString(params.occasionId, 'occasionId'),
      answer: readAnswer(params.answer),
      ...(optionalString(params.occurrence) === undefined
        ? {}
        : { occurrence: optionalString(params.occurrence) }),
    });
  });

  attach('occasions.acknowledge', (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return service.acknowledge({
      occasionId: requireString(params.occasionId, 'occasionId'),
      // A verb call is a surface offering the action, unless it says otherwise.
      source: readAckSource(params.source),
      ...(optionalString(params.occurrence) === undefined
        ? {}
        : { occurrence: optionalString(params.occurrence) }),
    });
  });

  attach('occasions.interview.get', async (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return interviewAnswer(await service.interview(requireString(params.interviewId, 'interviewId')));
  });

  attach('occasions.interview.answer', async (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return interviewAnswer(await service.answerInterview({
      interviewId: requireString(params.interviewId, 'interviewId'),
      stepId: requireString(params.stepId, 'stepId'),
      text: requireString(params.text, 'text'),
    }));
  });

  attach('occasions.interview.record', async (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return interviewAnswer(await service.recordGiftOutcome({
      interviewId: requireString(params.interviewId, 'interviewId'),
      landedOn: requireString(params.landedOn, 'landedOn'),
    }));
  });

  attach('occasions.gifts', async (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    const occasionId = requireString(params.occasionId, 'occasionId');
    return { occasionId, gifts: await service.giftHistory(occasionId) };
  });

  attach('occasions.conflict.resolve', async (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    const occasionId = requireString(params.occasionId, 'occasionId');
    return { occasionId, resolved: await service.resolveConflict(occasionId) };
  });

  attach('occasions.plans.propose', (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return service.proposePlan({
      title: requireString(params.title, 'title'),
      from: requireString(params.from, 'from'),
      to: requireString(params.to, 'to'),
      ...(params.away === undefined ? {} : { away: params.away === true }),
      ...(optionalString(params.destination) === undefined
        ? {}
        : { destination: optionalString(params.destination) }),
    });
  });

  attach('occasions.plans.confirm', (invocation: GatewayMethodInvocation) => {
    refuseNonUserRequest(invocation, 'occasions.plans.confirm');
    const params = readInvocationParams(invocation);
    return service.confirmPlan({
      title: requireString(params.title, 'title'),
      from: requireString(params.from, 'from'),
      to: requireString(params.to, 'to'),
      ...(params.away === undefined ? {} : { away: params.away === true }),
      ...(optionalString(params.destination) === undefined
        ? {}
        : { destination: optionalString(params.destination) }),
      surface: readSurface(params.surface),
      said: requireString(params.said, 'said'),
      authority: readAuthority(params.authority),
    });
  });
}
