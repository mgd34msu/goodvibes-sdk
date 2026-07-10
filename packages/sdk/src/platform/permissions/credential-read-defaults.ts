/**
 * credential-read-defaults.ts — SHIPPED default protection for reads of
 * well-known credential files/directories.
 *
 * These are ORDINARY permission-settings defaults the user can override, NOT
 * additions to the frozen exec-layer unconditional block. Doctrine (verbatim):
 * "permission settings are the sole authority for command-class risk; the
 * exec-layer unconditional block is a frozen catastrophic-only list (rm -rf /,
 * dd to devices, mkfs, fork bomb…) that must NEVER expand without Mike's
 * explicit approval." This module touches neither that list nor the exec guard.
 *
 * Two shipped surfaces, both overridable:
 *   1. Default posture (any mode that auto-allows reads): a read whose path
 *      matches a credential store is NOT silently auto-allowed — it falls
 *      through to the ask/prompt path. Approving once (session cache), switching
 *      to allow-all, or a user policy allow-rule all override it.
 *   2. Policy engine (when enabled): SHIPPED_CREDENTIAL_READ_RULES are managed
 *      deny PathScopeRules evaluated in Layer 4. A user-origin allow rule is
 *      evaluated first and wins.
 */

import { normalize, resolve } from 'node:path';
import type { PolicyRule } from '../runtime/permissions/types.js';

/**
 * Absolute-anchored glob patterns for unambiguous credential stores. Anchored at
 * `/` with a leading `/**​/` so they match the store wherever the user's home is
 * (`/home/<u>/.ssh/id_rsa`, `/Users/<u>/.ssh/id_rsa`, …) without hardcoding a
 * home directory. `.env` outside the workspace is handled separately (it needs
 * the project root) — see {@link matchesShippedCredentialReadPath}.
 */
export const CREDENTIAL_READ_PATH_PATTERNS: readonly string[] = [
  '/**/.ssh/**',
  '/**/.aws/credentials',
  '/**/.config/gcloud/**',
  '/**/.kube/config',
  '/**/.docker/config.json',
  '/**/.netrc',
  '/**/.pgpass',
  '/**/.gnupg/**',
  // Browser credential stores (login/password databases).
  '/**/.config/google-chrome/**/Login Data',
  '/**/.config/chromium/**/Login Data',
  '/**/.mozilla/firefox/**/logins.json',
  '/**/Library/Application Support/Google/Chrome/**/Login Data',
  '/**/Library/Application Support/Firefox/**/logins.json',
];

/** The shipped managed deny rules for the policy engine (Layer 4). */
export const SHIPPED_CREDENTIAL_READ_RULES: readonly PolicyRule[] = [
  {
    id: 'shipped-credential-read-deny',
    description: 'Deny reads of well-known credential files/directories by default (a user allow-rule overrides).',
    origin: 'managed',
    effect: 'deny',
    type: 'path-scope',
    toolPattern: ['read', 'find', 'fetch', 'analyze', 'inspect', '*'],
    pathPatterns: [...CREDENTIAL_READ_PATH_PATTERNS],
  },
];

/** Minimal glob → RegExp (mirrors the path-scope evaluator's semantics). */
function credentialGlobToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' DOUBLESTAR ')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/ DOUBLESTAR /g, '.*');
  return new RegExp(`^${escaped}$`);
}

export interface CredentialReadMatchOptions {
  /** Workspace root, used to resolve relative paths and to exempt a workspace-local `.env`. */
  readonly projectRoot?: string | undefined;
}

export interface CredentialReadMatch {
  readonly matched: boolean;
  /** The pattern (or `.env-outside-workspace`) that matched, for an honest reason string. */
  readonly pattern?: string | undefined;
}

/**
 * Whether `rawPath` names a well-known credential store that the shipped default
 * protects. Absolute paths match directly; relative paths resolve against
 * `projectRoot` (or cwd). A `.env`/`.env.*` file matches ONLY when it resolves
 * OUTSIDE the workspace — a workspace-local `.env` is left alone.
 */
export function matchesShippedCredentialReadPath(
  rawPath: string,
  options: CredentialReadMatchOptions = {},
): CredentialReadMatch {
  if (!rawPath || typeof rawPath !== 'string') return { matched: false };
  const base = options.projectRoot ?? process.cwd();
  const absolute = normalize(rawPath.startsWith('/') ? rawPath : resolve(base, rawPath));

  for (const pattern of CREDENTIAL_READ_PATH_PATTERNS) {
    if (credentialGlobToRegex(pattern).test(absolute)) return { matched: true, pattern };
  }

  // .env outside the workspace: dotenv files routinely hold secrets, but a
  // workspace-local .env is expected reading, so only gate ones outside it.
  const fileName = absolute.split('/').pop() ?? '';
  if (fileName === '.env' || fileName.startsWith('.env.')) {
    const root = normalize(resolve(base));
    const insideWorkspace = absolute === root || absolute.startsWith(`${root}/`);
    if (!insideWorkspace) return { matched: true, pattern: '.env-outside-workspace' };
  }

  return { matched: false };
}
