/**
 * credential-env.ts — scrub credential-bearing environment variables out of the
 * environment handed to spawned tool processes.
 *
 * WHY. A shell command the model runs inherits this process's environment by
 * default. That environment routinely carries provider tokens and cloud
 * credentials (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, OPENAI_API_KEY, …) that the
 * command has no need for and could exfiltrate. This module removes the
 * well-known credential-bearing variables from the base environment before it is
 * passed to a spawn, and reports exactly which variable NAMES were withheld (by
 * name only — never the value) so the exec result can state the scrub honestly.
 *
 * NOT a permission decision and NOT the frozen catastrophic-command block. This
 * is an environment hygiene step on the spawn path. A credential a command
 * legitimately needs is re-added two ways, both explicit: the model supplies it
 * in the per-command `env`, or the operator adds the variable name to the
 * configured allowlist.
 */

/**
 * Name-shape matchers for credential-bearing variables. Matched against the
 * UPPER-cased variable name so casing never lets a secret through. Deliberately
 * keyed on the sensitive TOKEN/SECRET/KEY/PASSWORD/CREDENTIAL segments rather
 * than a broad provider prefix, so non-secret companions (AWS_REGION,
 * AWS_PROFILE, GITHUB_REPOSITORY, …) are left in place.
 */
const CREDENTIAL_NAME_PATTERNS: readonly RegExp[] = [
  /(^|_)SECRETS?(_|$)/,
  /(^|_)TOKEN(_|$)/,
  /(^|_)API_?KEY(_|$)/,
  /(^|_)ACCESS_?KEY(_ID)?(_|$)/,
  /(^|_)SECRET_?ACCESS_?KEY(_|$)/,
  /(^|_)PRIVATE_?KEY(_|$)/,
  /(^|_)(PASSWORD|PASSWD|PASSPHRASE)(_|$)/,
  /(^|_)CREDENTIALS?(_|$)/,
  /(^|_)SESSION_?TOKEN(_|$)/,
  /(^|_)SECURITY_?TOKEN(_|$)/,
];

/**
 * A short curated set of secret-bearing names whose SHAPE does not match the
 * patterns above (e.g. no TOKEN/SECRET/KEY segment). Extend conservatively.
 */
const CREDENTIAL_NAME_EXACT: ReadonlySet<string> = new Set([
  'GOOGLE_APPLICATION_CREDENTIALS',
  'NETRC',
  'PGPASSFILE',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
]);

/** Whether a variable NAME looks credential-bearing (case-insensitive). */
export function isCredentialEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (CREDENTIAL_NAME_EXACT.has(upper)) return true;
  return CREDENTIAL_NAME_PATTERNS.some((pattern) => pattern.test(upper));
}

/** Injectable scrub configuration (wired from `permissions.exec.*` config by the consumer). */
export interface CredentialEnvScrubConfig {
  /** Master switch. Default true — the scrub is on unless a consumer disables it. */
  readonly enabled?: boolean | undefined;
  /** Variable names always kept, overriding the credential matchers (case-insensitive). */
  readonly allowlist?: readonly string[] | undefined;
}

/** Resolved, non-optional scrub configuration. */
export interface ResolvedCredentialEnvScrub {
  readonly enabled: boolean;
  readonly allowlist: ReadonlySet<string>;
}

/** Resolve raw scrub config into the internal form. Enabled by default. */
export function resolveCredentialEnvScrub(config: CredentialEnvScrubConfig = {}): ResolvedCredentialEnvScrub {
  return {
    enabled: config.enabled !== false,
    allowlist: new Set((config.allowlist ?? []).map((name) => name.toUpperCase())),
  };
}

export interface CredentialEnvScrubResult {
  /** The environment with credential-bearing variables removed. */
  readonly env: Record<string, string>;
  /** Names withheld from `env`, sorted. NEVER includes values. */
  readonly withheld: string[];
}

/**
 * Remove credential-bearing variables from `env`. A name is withheld when
 * {@link isCredentialEnvName} matches and it is not on the allowlist. When the
 * scrub is disabled the env passes through untouched with an empty withheld set.
 */
export function scrubCredentialEnv(
  env: Record<string, string>,
  scrub: ResolvedCredentialEnvScrub,
): CredentialEnvScrubResult {
  if (!scrub.enabled) return { env, withheld: [] };
  const kept: Record<string, string> = {};
  const withheld: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (isCredentialEnvName(name) && !scrub.allowlist.has(name.toUpperCase())) {
      withheld.push(name);
      continue;
    }
    kept[name] = value;
  }
  withheld.sort();
  return { env: kept, withheld };
}
