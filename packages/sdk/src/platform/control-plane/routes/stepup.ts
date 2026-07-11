/**
 * routes/stepup.ts
 *
 * Handlers for the relay step-up ceremony verbs over the shared StepUpService
 * (relay/step-up-service.ts). Thin verb registration: read+validate the
 * invocation params, call the service, return its result. The same service
 * instance backs the daemon's real StepUpAssertionVerifier, so a challenge
 * minted here is the object the relay gate later consumes.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import type {
  StepUpService,
  UserVerificationRequirement,
} from '../../relay/step-up-service.js';

export type StepUpGatewayService = Pick<StepUpService, 'registerCredential' | 'mintChallenge'>;

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${key} is required`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function optionalUserVerification(value: unknown): UserVerificationRequirement | undefined {
  if (value === undefined) return undefined;
  if (value === 'required' || value === 'preferred' || value === 'discouraged') return value;
  throw new GatewayVerbError('userVerification must be one of required|preferred|discouraged', 'INVALID_ARGUMENT', 400);
}

function createRegisterHandler(service: StepUpGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const originValue = params['origin'];
    const origin = typeof originValue === 'string'
      ? originValue
      : Array.isArray(originValue) && originValue.every((o) => typeof o === 'string')
        ? (originValue as string[])
        : undefined;
    if (origin === undefined) throw new GatewayVerbError('origin is required (string or string[])', 'INVALID_ARGUMENT', 400);
    const signCountRaw = params['signCount'];
    if (signCountRaw !== undefined && (typeof signCountRaw !== 'number' || !Number.isFinite(signCountRaw) || signCountRaw < 0)) {
      throw new GatewayVerbError('signCount must be a non-negative number', 'INVALID_ARGUMENT', 400);
    }
    try {
      const credential = await service.registerCredential({
        rpId: requireString(params, 'rpId'),
        origin,
        credentialId: requireString(params, 'credentialId'),
        publicKeyCose: requireString(params, 'publicKeyCose'),
        ...(typeof signCountRaw === 'number' ? { signCount: signCountRaw } : {}),
        ...(optionalUserVerification(params['userVerification']) ? { userVerification: optionalUserVerification(params['userVerification'])! } : {}),
        ...(typeof params['label'] === 'string' ? { label: params['label'] } : {}),
      });
      return { credential };
    } catch (error) {
      if (error instanceof GatewayVerbError) throw error;
      throw new GatewayVerbError(error instanceof Error ? error.message : 'registration failed', 'INVALID_ARGUMENT', 400);
    }
  };
}

function createMintHandler(service: StepUpGatewayService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const ttlRaw = params['ttlMs'];
    if (ttlRaw !== undefined && (typeof ttlRaw !== 'number' || !Number.isFinite(ttlRaw))) {
      throw new GatewayVerbError('ttlMs must be a number', 'INVALID_ARGUMENT', 400);
    }
    return service.mintChallenge({
      ...(typeof params['rendezvousId'] === 'string' ? { rendezvousId: params['rendezvousId'] } : {}),
      ...(typeof params['sessionId'] === 'string' ? { sessionId: params['sessionId'] } : {}),
      ...(typeof ttlRaw === 'number' ? { ttlMs: ttlRaw } : {}),
    });
  };
}

export function registerStepUpGatewayMethods(catalog: GatewayMethodCatalog, service: StepUpGatewayService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('stepup.credentials.register', createRegisterHandler(service));
  attach('stepup.challenge.mint', createMintHandler(service));
}
