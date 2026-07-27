/**
 * Per-signup email aliasing.
 *
 * Every account the agent creates gets its own delivery address. That address is the
 * correlation key used by `verification-expectations.ts`: a verification mail is only
 * considered if it arrived at the exact address the agent minted for that signup.
 * Without per-signup aliasing, correlation degrades to "some mail about GitHub arrived",
 * which anyone on the internet can manufacture.
 *
 * ── Mechanism verification (checked live 2026-07-26, not from memory) ──────────────
 *
 * Plus-addressing (subaddressing, RFC 5233) is the primary mechanism.
 *
 * Google Workspace Learning Center, "Tips to optimize your Gmail inbox"
 * (https://support.google.com/a/users/answer/9308648):
 *   "You can create variations of your email address where all messages arrive in your
 *    current inbox. Just add a plus sign (+) and any word before the @ sign in your
 *    current address."
 * So `user+gv-github-com-k3n9x2p4@gmail.com` lands in `user@gmail.com`. Confirmed for
 * both gmail.com and Workspace-hosted domains.
 *
 * Cloudflare Email Routing docs, "Email Routing addresses"
 * (https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/):
 *   "supports subaddressing, also known as plus addressing, as defined in RFC 5233" and
 *   "if you send an email to `user+detail@example.com` it will be matched by the
 *    `user@example.com` routing rule."
 * Cloudflare also documents catch-all: "Email Routing forwards every email sent to your
 * domain, including misspelled local parts, to a single destination."
 *
 * Caveat that is NOT hypothetical: a meaningful share of signup forms reject `+` in the
 * email field, either by regex or by silently stripping it. When that happens the caller
 * must fall back to a catch-all local part on a domain the owner controls — see
 * `mintCatchAllAddressFor`, which produces the same encoded tag as a bare local part
 * (`gv-github-com-k3n9x2p4@example.com`) and parses back identically.
 *
 * ── Encoding ──────────────────────────────────────────────────────────────────────
 *
 * Tag layout: `<prefix>-<encodedDomain>-<nonce>`
 *   prefix        `gv` for a full domain encoding, `gvt` when the domain had to be
 *                 truncated to fit the 64-octet local-part limit (RFC 5321 §4.5.3.1).
 *   encodedDomain `.` -> `-`, literal `-` -> `--`. Reversible, and it keeps punycode
 *                 labels (`xn--...`) intact. Dots are deliberately avoided in the tag
 *                 because Gmail ignores dots in the local part.
 *   nonce         8 lowercase alphanumerics, no hyphen, so the tag splits unambiguously
 *                 at its last hyphen.
 *
 * Deterministic enough to parse back to a service; the nonce makes two signups at the
 * same service distinct.
 */

import { randomBytes } from 'node:crypto';

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

export interface SignupAlias {
  /** The full address to hand to the signup form. */
  readonly address: string;
  /** The owner's real delivery address this alias resolves to. */
  readonly baseAddress: string;
  /** The service domain the alias was minted for, normalized. */
  readonly serviceDomain: string;
  readonly nonce: string;
  /** True when the encoded domain had to be shortened to fit the local-part limit. */
  readonly truncated: boolean;
}

export interface ParsedSignupAlias {
  /** The address with the signup tag removed — the owner's real inbox. */
  readonly baseAddress: string;
  /**
   * The decoded service domain, or null when the alias was minted with a truncated
   * encoding. A null here means "ask the account registry", never "any domain".
   */
  readonly serviceDomain: string | null;
  readonly encodedService: string;
  readonly nonce: string;
  readonly truncated: boolean;
}

export interface MintAddressOptions {
  /** Injected nonce, for deterministic tests. Must be 8 lowercase alphanumerics. */
  readonly nonce?: string;
}

// ──────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────

const TAG_PREFIX_FULL = 'gv';
const TAG_PREFIX_TRUNCATED = 'gvt';
const NONCE_LENGTH = 8;
const NONCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** RFC 5321 §4.5.3.1: the local part may not exceed 64 octets. */
const MAX_LOCAL_PART_LENGTH = 64;
const MIN_ENCODED_DOMAIN_LENGTH = 4;

const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const NONCE_PATTERN = /^[a-z0-9]{8}$/;

// ──────────────────────────────────────────────────────────────────
// Address normalization
// ──────────────────────────────────────────────────────────────────

/**
 * Normalize an address for comparison: strip any display name / angle brackets, trim,
 * lowercase.
 *
 * The `+tag` is deliberately preserved — it IS the correlation key. Lowercasing the
 * local part is technically stricter than RFC 5321 (local parts are case-sensitive on
 * the wire) but matches how Gmail, Workspace and Cloudflare Email Routing actually
 * deliver, and being case-insensitive here can only widen what compares equal, never
 * let a different mailbox pass as the expected one.
 */
export function normalizeEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  const angled = /<([^<>]+)>\s*$/.exec(trimmed);
  const bare = (angled?.[1] ?? trimmed).trim();
  return bare.replace(/^<|>$/g, '').trim().toLowerCase();
}

/** Split a normalized address into local part and domain, or null if it is not one. */
export function splitAddress(raw: string): { readonly local: string; readonly domain: string } | null {
  const normalized = normalizeEmailAddress(raw);
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return null;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!local || !domain || local.includes('@')) return null;
  return { local, domain };
}

/** Normalize a hostname or service domain: lowercase, no trailing dot, no port. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, '').replace(/:\d+$/, '');
}

// ──────────────────────────────────────────────────────────────────
// Domain <-> tag encoding
// ──────────────────────────────────────────────────────────────────

function encodeDomain(domain: string): string {
  let encoded = '';
  for (const char of domain) {
    if (char === '.') encoded += '-';
    else if (char === '-') encoded += '--';
    else encoded += char;
  }
  return encoded;
}

function decodeDomain(encoded: string): string | null {
  let decoded = '';
  let index = 0;
  while (index < encoded.length) {
    const char = encoded[index];
    if (char !== '-') {
      decoded += char;
      index += 1;
      continue;
    }
    if (encoded[index + 1] === '-') {
      decoded += '-';
      index += 2;
      continue;
    }
    decoded += '.';
    index += 1;
  }
  return DOMAIN_PATTERN.test(decoded) ? decoded : null;
}

function generateNonce(): string {
  const bytes = randomBytes(NONCE_LENGTH);
  let nonce = '';
  for (const byte of bytes) nonce += NONCE_ALPHABET[byte % NONCE_ALPHABET.length];
  return nonce;
}

function resolveNonce(options: MintAddressOptions | undefined): string {
  const supplied = options?.nonce?.trim().toLowerCase();
  if (supplied === undefined || supplied === '') return generateNonce();
  if (!NONCE_PATTERN.test(supplied)) {
    throw new Error(`Signup alias nonce must be ${NONCE_LENGTH} lowercase alphanumerics; got "${supplied}".`);
  }
  return supplied;
}

function requireServiceDomain(serviceDomain: string): string {
  const normalized = normalizeDomain(serviceDomain);
  if (!DOMAIN_PATTERN.test(normalized)) {
    throw new Error(`"${serviceDomain}" is not a usable service domain for a signup alias.`);
  }
  return normalized;
}

interface BuiltTag {
  readonly tag: string;
  readonly truncated: boolean;
}

function buildTag(serviceDomain: string, nonce: string, budget: number): BuiltTag {
  const encoded = encodeDomain(serviceDomain);
  const fullLength = TAG_PREFIX_FULL.length + 1 + encoded.length + 1 + nonce.length;
  if (fullLength <= budget) {
    return { tag: `${TAG_PREFIX_FULL}-${encoded}-${nonce}`, truncated: false };
  }
  const room = budget - (TAG_PREFIX_TRUNCATED.length + 1 + 1 + nonce.length);
  if (room < MIN_ENCODED_DOMAIN_LENGTH) {
    throw new Error(
      `Base address leaves no room for a signup tag (needs at least ${MIN_ENCODED_DOMAIN_LENGTH} characters of service encoding).`,
    );
  }
  return { tag: `${TAG_PREFIX_TRUNCATED}-${encoded.slice(0, room)}-${nonce}`, truncated: true };
}

// ──────────────────────────────────────────────────────────────────
// Minting
// ──────────────────────────────────────────────────────────────────

/**
 * Mint a plus-addressed alias for one signup at `serviceDomain`.
 *
 * `mintAddressFor('owner@example.com', 'github.com')`
 *   -> `mike+gv-github-com-k3n9x2p4@example.com`
 */
export function mintAddressFor(
  baseAddress: string,
  serviceDomain: string,
  options?: MintAddressOptions,
): SignupAlias {
  const parts = splitAddress(baseAddress);
  if (!parts) throw new Error(`"${baseAddress}" is not a usable base address.`);
  const domain = requireServiceDomain(serviceDomain);
  const nonce = resolveNonce(options);
  const baseLocal = parts.local.split('+')[0] ?? parts.local;
  if (!baseLocal) throw new Error(`"${baseAddress}" has no local part before the "+".`);

  const budget = MAX_LOCAL_PART_LENGTH - baseLocal.length - 1;
  const { tag, truncated } = buildTag(domain, nonce, budget);
  return {
    address: `${baseLocal}+${tag}@${parts.domain}`,
    baseAddress: `${baseLocal}@${parts.domain}`,
    serviceDomain: domain,
    nonce,
    truncated,
  };
}

/**
 * Mint the same tag as a bare local part, for a catch-all domain. Use when a signup form
 * rejects `+` in the email field. `parseAlias` handles both shapes.
 *
 * `mintCatchAllAddressFor('example.com', 'github.com')`
 *   -> `gv-github-com-k3n9x2p4@example.com`
 */
export function mintCatchAllAddressFor(
  mailDomain: string,
  serviceDomain: string,
  options?: MintAddressOptions,
): SignupAlias {
  const inbox = normalizeDomain(mailDomain);
  if (!DOMAIN_PATTERN.test(inbox)) throw new Error(`"${mailDomain}" is not a usable mail domain.`);
  const domain = requireServiceDomain(serviceDomain);
  const nonce = resolveNonce(options);
  const { tag, truncated } = buildTag(domain, nonce, MAX_LOCAL_PART_LENGTH);
  return {
    address: `${tag}@${inbox}`,
    baseAddress: `@${inbox}`,
    serviceDomain: domain,
    nonce,
    truncated,
  };
}

// ──────────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────────

function parseTag(tag: string): Omit<ParsedSignupAlias, 'baseAddress'> | null {
  const firstDash = tag.indexOf('-');
  if (firstDash <= 0) return null;
  const prefix = tag.slice(0, firstDash);
  if (prefix !== TAG_PREFIX_FULL && prefix !== TAG_PREFIX_TRUNCATED) return null;
  const rest = tag.slice(firstDash + 1);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash <= 0) return null;
  const encodedService = rest.slice(0, lastDash);
  const nonce = rest.slice(lastDash + 1);
  if (!encodedService || !NONCE_PATTERN.test(nonce)) return null;
  const truncated = prefix === TAG_PREFIX_TRUNCATED;
  return {
    serviceDomain: truncated ? null : decodeDomain(encodedService),
    encodedService,
    nonce,
    truncated,
  };
}

/**
 * Parse an address minted by `mintAddressFor` / `mintCatchAllAddressFor` back to the
 * service it belongs to. Returns null for any address this module did not mint — a
 * non-alias address is never treated as belonging to a service.
 */
export function parseAlias(address: string): ParsedSignupAlias | null {
  const parts = splitAddress(address);
  if (!parts) return null;
  const plus = parts.local.indexOf('+');
  const tag = plus >= 0 ? parts.local.slice(plus + 1) : parts.local;
  const baseLocal = plus > 0 ? parts.local.slice(0, plus) : '';
  const parsedTag = parseTag(tag);
  if (!parsedTag) return null;
  return {
    baseAddress: baseLocal ? `${baseLocal}@${parts.domain}` : `@${parts.domain}`,
    ...parsedTag,
  };
}
