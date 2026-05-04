import { resolveSecretInput } from '../config/secret-refs.js';
import {
  CLOUDFLARE_API_TOKEN_KEY,
  CLOUDFLARE_WORKER_CLIENT_TOKEN_KEY,
  CLOUDFLARE_WORKER_OPERATOR_TOKEN_KEY,
} from './constants.js';
import type { CloudflareControlPlaneConfig, CloudflareResolvedSecret, CloudflareValidateInput } from './types.js';
import { CloudflareControlPlaneError } from './types.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { clean } from './utils.js';

// ---------------------------------------------------------------------------
// TokenResolverContext
// ---------------------------------------------------------------------------
// Minimal interface exposing exactly what the resolve* functions need from the
// class so they remain pure functions and are fully testable in isolation.
// ---------------------------------------------------------------------------

export interface TokenResolverContext {
  readonly secretsManager?: Pick<{
    get(key: string): Promise<string | null>;
    getGlobalHome(): string | undefined;
  }, 'get' | 'getGlobalHome'> | null;
  readonly authToken?: () => string | null;
  readonly readConfig: () => CloudflareControlPlaneConfig;
}

// ---------------------------------------------------------------------------
// Resolve helpers — pure functions parameterised by TokenResolverContext
// ---------------------------------------------------------------------------

export function resolveAccountId(
  ctx: TokenResolverContext,
  inputAccountId: string | undefined,
): string {
  const accountId = clean(inputAccountId) || ctx.readConfig().accountId;
  if (!accountId) {
    throw new CloudflareControlPlaneError(
      'Cloudflare account id is required. Configure cloudflare.accountId or pass accountId.',
      'CLOUDFLARE_ACCOUNT_REQUIRED',
      400,
    );
  }
  return accountId;
}

export function resolveWorkerName(
  ctx: TokenResolverContext,
  inputWorkerName: string | undefined,
  defaultWorkerName: string,
): string {
  const workerName = clean(inputWorkerName) || ctx.readConfig().workerName || defaultWorkerName;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(workerName)) {
    throw new CloudflareControlPlaneError(
      'Cloudflare workerName must be 1-63 characters using letters, numbers, and dashes.',
      'CLOUDFLARE_WORKER_NAME_INVALID',
      400,
    );
  }
  return workerName;
}

export async function resolveApiToken(
  ctx: TokenResolverContext,
  input: Pick<CloudflareValidateInput, 'apiToken' | 'apiTokenRef'>,
): Promise<CloudflareResolvedSecret> {
  const bodyToken = clean(input.apiToken);
  if (bodyToken) return { value: bodyToken, source: 'body' };
  const ref = clean(input.apiTokenRef) || ctx.readConfig().apiTokenRef;
  const fromRef = await resolveSecretRef(ctx, ref);
  if (fromRef.value) return { value: fromRef.value, source: 'config-ref' };
  const envToken = clean(process.env['CLOUDFLARE_API_TOKEN']);
  if (envToken) return { value: envToken, source: 'env' };
  const stored = await ctx.secretsManager?.get(CLOUDFLARE_API_TOKEN_KEY) ?? null;
  if (stored) return { value: stored, source: 'goodvibes-secret' };
  return { value: null, source: 'missing' };
}

export async function resolveOperatorToken(
  ctx: TokenResolverContext,
  input: { readonly operatorToken?: string; readonly operatorTokenRef?: string },
): Promise<CloudflareResolvedSecret> {
  const bodyToken = clean(input.operatorToken);
  if (bodyToken) return { value: bodyToken, source: 'body' };
  const ref = clean(input.operatorTokenRef) || ctx.readConfig().workerTokenRef;
  const fromRef = await resolveSecretRef(ctx, ref);
  if (fromRef.value) return { value: fromRef.value, source: 'config-ref' };
  const stored = await ctx.secretsManager?.get(CLOUDFLARE_WORKER_OPERATOR_TOKEN_KEY) ?? null;
  if (stored) return { value: stored, source: 'goodvibes-secret' };
  const authToken = clean(ctx.authToken?.() ?? undefined);
  if (authToken) return { value: authToken, source: 'auth-token' };
  return { value: null, source: 'missing' };
}

export async function resolveWorkerClientToken(
  ctx: TokenResolverContext,
  input: { readonly workerClientToken?: string; readonly workerClientTokenRef?: string },
): Promise<CloudflareResolvedSecret> {
  const bodyToken = clean(input.workerClientToken);
  if (bodyToken) return { value: bodyToken, source: 'body' };
  const ref = clean(input.workerClientTokenRef) || ctx.readConfig().workerClientTokenRef;
  const fromRef = await resolveSecretRef(ctx, ref);
  if (fromRef.value) return { value: fromRef.value, source: 'config-ref' };
  const envToken = clean(process.env['GOODVIBES_CLOUDFLARE_WORKER_TOKEN']);
  if (envToken) return { value: envToken, source: 'env' };
  const stored = await ctx.secretsManager?.get(CLOUDFLARE_WORKER_CLIENT_TOKEN_KEY) ?? null;
  if (stored) return { value: stored, source: 'goodvibes-secret' };
  return { value: null, source: 'missing' };
}

export async function resolveSecretRef(
  ctx: TokenResolverContext,
  ref: string,
): Promise<CloudflareResolvedSecret> {
  if (!ref) return { value: null, source: 'missing' };
  try {
    const value = await resolveSecretInput(ref, {
      resolveLocalSecret: async (key) => await ctx.secretsManager?.get(key) ?? null,
      homeDirectory: ctx.secretsManager?.getGlobalHome(),
    });
    return value ? { value, source: 'config-ref' } : { value: null, source: 'missing' };
  } catch (err) {
    logger.debug('resolveSecretRef: failed to resolve secret reference', { ref, error: summarizeError(err) });
    return { value: null, source: 'missing' };
  }
}
