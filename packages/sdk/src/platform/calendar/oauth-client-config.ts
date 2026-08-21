/**
 * oauth-client-config.ts, reading the operator's own OAuth app credentials out
 * of config, so a flow runs on what THEY registered.
 *
 * No client id ships with the product. Whoever sets up a GoodVibes environment
 * registers an app with Google or Microsoft and puts its client id in config;
 * this module is the one place that turns those settings into the
 * `OAuthClientOverrides` the connector already accepts. The profile names the
 * keys (`clientIdConfigKey`, `clientSecretRefConfigKey`), so a caller never
 * builds a key string of its own and the refusal message, the setup steps and
 * this reader all quote the same key.
 *
 * Two rules the surrounding code already established and this follows:
 *
 *  - An unreachable config path reads as UNSET, not as an error. `calendar.*` is
 *    an app-layer section rather than a CONFIG_SCHEMA category, and
 *    `ConfigManager.resolvePath` throws `Invalid config path` for a section that
 *    is not on the live config object. On a machine where nobody has run setup
 *    the section is simply absent, and "no calendar account is connected" is the
 *    honest answer to that, not a 500. Same reasoning as
 *    `google/config-access.ts`, which this mirrors.
 *  - The client SECRET is never in config. Config holds a reference under
 *    `clientSecretRefConfigKey`; the value lives in the secret store under the
 *    platform-derived name `daemonSecretKeyFor(<that key>)`. Deriving the name
 *    rather than writing it out is load-bearing: daemon-owned credentials are
 *    identified by that derivation, and a hand-written name would sit outside
 *    daemon ownership and fail to follow a handover.
 *
 * A public/desktop registration has no secret at all, which is the recommended
 * shape for both providers (PKCE, RFC 8252/7636). An absent secret is therefore
 * a normal result here, not a partial read.
 */

import { daemonSecretKeyFor } from '../config/daemon-secret-keys.js';
import type { OAuthClientOverrides, OAuthProviderProfile } from './oauth-types.js';

/**
 * The narrow config read this module needs: one `get(key)` that may throw for an
 * absent section. Structural rather than a nominal ConfigManager import, so the
 * calendar module stays free of the manager's dependency graph, the same shape
 * the connector's other injected boundaries use.
 */
export interface CalendarConfigReader {
  get(key: string): unknown;
}

/** Reads one secret by its store name. Returns null when nothing is stored. */
export type CalendarSecretReader = (secretKey: string) => Promise<string | null>;

/** A trimmed non-empty string from config, or null. Never throws. */
function configString(config: CalendarConfigReader, key: string): string | null {
  let value: unknown;
  try {
    value = config.get(key);
  } catch {
    return null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The secret-store name a provider's client secret is filed under. */
export function clientSecretStoreKey(profile: OAuthProviderProfile): string {
  return daemonSecretKeyFor(profile.clientSecretRefConfigKey);
}

/**
 * The client id an operator configured for this provider, or null when they have
 * not set one up yet.
 */
export function readConfiguredClientId(
  config: CalendarConfigReader,
  profile: OAuthProviderProfile,
): string | null {
  return configString(config, profile.clientIdConfigKey);
}

/**
 * Build the client credentials a flow runs with from config plus the secret
 * store.
 *
 * Returns overrides with no `clientId` when none is configured rather than
 * throwing: the caller resolves them into a `ResolvedClientConfig` that reports
 * `isConfigured: false`, and the flow refuses by name. That keeps "nobody has
 * registered an app yet" a state a status view can render, not an exception it
 * has to catch.
 *
 * The secret is fetched only when config carries a reference for it, so a
 * desktop/public-client registration costs no secret-store read.
 */
export async function readCalendarClientOverrides(
  profile: OAuthProviderProfile,
  sources: {
    readonly config: CalendarConfigReader;
    readonly secretGet?: CalendarSecretReader | undefined;
    /** Scope/redirect knobs a caller supplies on top of the stored credentials. */
    readonly extra?: Omit<OAuthClientOverrides, 'clientId' | 'clientSecret'> | undefined;
  },
): Promise<OAuthClientOverrides> {
  const clientId = readConfiguredClientId(sources.config, profile);
  const secretRef = configString(sources.config, profile.clientSecretRefConfigKey);

  let clientSecret: string | null = null;
  if (secretRef !== null && sources.secretGet) {
    try {
      const stored = await sources.secretGet(clientSecretStoreKey(profile));
      clientSecret = typeof stored === 'string' && stored.trim().length > 0 ? stored.trim() : null;
    } catch {
      // A secret store that cannot be read leaves the secret absent. The flow
      // then either succeeds (a public client never needed one) or fails at the
      // provider with that provider's own reason, both of which are honest,
      // and neither of which should take out a status read.
      clientSecret = null;
    }
  }

  return {
    ...(sources.extra ?? {}),
    ...(clientId !== null ? { clientId } : {}),
    ...(clientSecret !== null ? { clientSecret } : {}),
  };
}
