/**
 * Registration-time credential-authority contract — the structural
 * enforcement half of the ONE request-time credential resolver.
 *
 * Every provider registered through ProviderRegistry.register() must declare
 * how its credentials are obtained (LLMProvider.credentialAuthority:
 * 'resolver' | 'anonymous' | 'subscription' | 'oauth'). A provider that
 * declares none is REFUSED, fail-closed — exactly like the model-source
 * contract (model-source-contract.ts): an auth path the resolver cannot see
 * is how a status badge stays green while chat 401s.
 */

import type { LLMProvider } from './interface.js';

const CREDENTIAL_AUTHORITIES = new Set(['resolver', 'anonymous', 'subscription', 'oauth']);

export type CredentialAuthorityCheckable = Pick<LLMProvider, 'name' | 'credentialAuthority'>;

export interface ProviderCredentialAuthorityViolation {
  readonly provider: string;
  readonly message: string;
}

export function verifyProviderCredentialAuthority(
  provider: CredentialAuthorityCheckable,
): ProviderCredentialAuthorityViolation | null {
  const authority = provider.credentialAuthority;
  if (authority !== undefined && CREDENTIAL_AUTHORITIES.has(authority)) return null;
  return {
    provider: provider.name,
    message:
      `Provider '${provider.name}' declares no credential authority. Every registered provider must state `
      + `how its credentials are obtained (credentialAuthority: 'resolver' | 'anonymous' | 'subscription' | 'oauth') `
      + `so the shared credential resolver covers its auth path — status and chat availability must derive from `
      + `the same source. Registration refused.`,
  };
}

/** Throws when the provider declares no sanctioned credential authority. */
export function assertProviderCredentialAuthority(provider: CredentialAuthorityCheckable): void {
  const violation = verifyProviderCredentialAuthority(provider);
  if (violation) throw new Error(violation.message);
}
