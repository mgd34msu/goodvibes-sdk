/**
 * link-validation.ts, the gate a link from an untrusted surface must pass
 * BEFORE anything opens it.
 *
 * Owner's framing: headers can be spoofed, so any domain we are about to click
 * has to be validated first. This is that validation, and it is written as a
 * gate rather than a helper: the only way a link out of a page or a mailbox
 * should reach a navigation is through `validateLinkTarget`, and the only way
 * a redirect chain should be walked is through `followValidatedRedirects`.
 *
 * Every rule below exists because a naive check fails to a specific real
 * attack, and each refusal names which:
 *
 *  - **userinfo**. `https://accounts.google.com@evil.example/verify` parses
 *    with host `evil.example` and reads as Google to a human. Hard reject, not
 *    a warning, because the whole attack is that it looks fine.
 *  - **scheme**. `javascript:` and `data:` execute; `http:` is
 *    interceptable and a downgrade. Only `https:` is opened.
 *  - **homograph**. `аccounts.google.com` with a Cyrillic `а` is a different
 *    host that renders identically. Mixed script in a label is refused rather
 *    than scored for similarity, a similarity threshold is a number an
 *    attacker can sit just underneath.
 *  - **registrable domain**. `google.com.evil.example`, `google-verify.example`
 *    and `accounts-google.example` all pass at least one substring or
 *    `endsWith` check. Comparison is on eTLD+1 (see public-suffix.ts).
 *  - **redirects**. A link that lands on the right host and then 302s away is
 *    the same attack one hop later, so EVERY hop is validated by these same
 *    rules and any hop leaving the authorized domain refuses the chain.
 *  - **shorteners**. By construction their host is not the service, so they can
 *    never satisfy an exact registrable-domain match. Named as a refusal reason
 *    rather than left to fail incidentally, because "why did this fail" matters
 *    when a person has to finish the job by hand.
 *
 * Refusal is loud and carries both domains, because a refused verification link
 * is often something the owner must complete themselves.
 */

import { toUnicode } from 'node:punycode';
import { registrableDomain } from './public-suffix.js';

/** Hop ceiling for a redirect chain. Beyond this the chain is refused. */
export const MAX_REDIRECT_HOPS = 5;

export type LinkRefusalReason =
  | 'not-https'
  | 'contains-userinfo'
  | 'ip-literal-host'
  | 'non-standard-port'
  | 'malformed-url'
  | 'mixed-script-host'
  | 'known-redirector'
  | 'domain-mismatch'
  | 'redirect-left-domain'
  | 'too-many-redirects';

export interface LinkAccepted {
  readonly ok: true;
  /** The normalized, safe-to-open URL. */
  readonly url: string;
  readonly host: string;
  readonly registrableDomain: string;
}

export interface LinkRefused {
  readonly ok: false;
  readonly reason: LinkRefusalReason;
  /** Plain-language explanation naming both domains where relevant. */
  readonly message: string;
  /** The domain the link actually resolves to, when one could be determined. */
  readonly actualDomain: string | null;
  /** The domain the caller authorized. */
  readonly expectedDomain: string;
}

export type LinkValidation = LinkAccepted | LinkRefused;

/**
 * Hosts whose entire purpose is to point somewhere else.
 *
 * Listed so the refusal says "this is a shortener" rather than the less useful
 * "domain mismatch", but note the list is a courtesy, not the defence: an
 * unlisted shortener still fails the registrable-domain check, because its host
 * is not the service's host.
 */
const KNOWN_REDIRECTORS: ReadonlySet<string> = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'buff.ly', 'rebrand.ly',
  'is.gd', 'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'lnkd.in', 'trib.al',
  'dlvr.it', 'ift.tt', 'bl.ink', 's.id', 'short.io', 'smarturl.it', 'linktr.ee',
]);

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Script families that must not be mixed inside one label. */
const SCRIPT_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'latin', pattern: /\p{Script=Latin}/u },
  { name: 'cyrillic', pattern: /\p{Script=Cyrillic}/u },
  { name: 'greek', pattern: /\p{Script=Greek}/u },
  { name: 'han', pattern: /\p{Script=Han}/u },
  { name: 'arabic', pattern: /\p{Script=Arabic}/u },
  { name: 'hebrew', pattern: /\p{Script=Hebrew}/u },
];

/**
 * Decode a host to Unicode and report a label that mixes scripts.
 *
 * Mixing is the signal because a homograph attack needs at least one character
 * from another script sitting among Latin ones. A wholly non-Latin domain is
 * legitimate and is not refused.
 */
function mixedScriptLabel(host: string): string | null {
  for (const label of host.split('.')) {
    let decoded = label;
    if (label.startsWith('xn--')) {
      try {
        decoded = toUnicode(label);
      } catch {
        return label; // undecodable punycode is not something to open
      }
    }
    const normalized = decoded.normalize('NFKC');
    const present = SCRIPT_PATTERNS.filter((script) => script.pattern.test(normalized));
    if (present.length > 1) return decoded;
  }
  return null;
}

/** Normalize a host for comparison: lowercase, no trailing dot, NFKC. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '').normalize('NFKC');
}

function refuse(
  reason: LinkRefusalReason,
  message: string,
  expectedDomain: string,
  actualDomain: string | null = null,
): LinkRefused {
  return { ok: false, reason, message, actualDomain, expectedDomain };
}

/**
 * Validate one link against the domain a caller authorized.
 *
 * `authorizedDomain` is the domain the agent is actually transacting with,
 * the service it signed up at, or the service it is logging in to. Comparison
 * is on the registrable domain of both, so a subdomain of the authorized
 * domain passes and a lookalike does not.
 */
export function validateLinkTarget(rawUrl: string, authorizedDomain: string): LinkValidation {
  const expected = registrableDomain(normalizeHost(authorizedDomain));
  if (expected === null) {
    return refuse(
      'domain-mismatch',
      `Refused: "${authorizedDomain}" is not a domain a link can be checked against.`,
      authorizedDomain,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return refuse('malformed-url', 'Refused: that link is not a parseable URL.', expected);
  }

  if (parsed.protocol !== 'https:') {
    return refuse(
      'not-https',
      `Refused: the link uses "${parsed.protocol}" rather than https. `
      + 'Only https links are opened, http can be intercepted, and data/javascript links execute rather than navigate.',
      expected,
    );
  }

  // Before anything else about the host: userinfo makes the rendered text lie.
  if (parsed.username !== '' || parsed.password !== '') {
    return refuse(
      'contains-userinfo',
      `Refused: the link embeds credentials before the host ("…@${parsed.hostname}"), which makes it read as `
      + `a different site than the one it opens. It actually goes to "${parsed.hostname}".`,
      expected,
      registrableDomain(normalizeHost(parsed.hostname)),
    );
  }

  const host = normalizeHost(parsed.hostname);

  if (IPV4_LITERAL.test(host) || host.startsWith('[')) {
    return refuse('ip-literal-host', 'Refused: the link points at a bare IP address rather than a named host.', expected, null);
  }

  if (parsed.port !== '' && parsed.port !== '443') {
    return refuse(
      'non-standard-port',
      `Refused: the link uses port ${parsed.port} rather than the standard https port.`,
      expected,
      registrableDomain(host),
    );
  }

  const mixed = mixedScriptLabel(host);
  if (mixed !== null) {
    return refuse(
      'mixed-script-host',
      `Refused: the link's host contains a label mixing character scripts ("${mixed}"), which is how a `
      + 'lookalike domain is built to render identically to a real one.',
      expected,
      null,
    );
  }

  const actual = registrableDomain(host);
  if (actual === null) {
    return refuse('malformed-url', `Refused: "${host}" has no registrable domain to check.`, expected, null);
  }

  if (KNOWN_REDIRECTORS.has(actual)) {
    return refuse(
      'known-redirector',
      `Refused: "${actual}" is a link shortener, so the address does not say where it goes. `
      + `A link for "${expected}" must be on "${expected}".`,
      expected,
      actual,
    );
  }

  if (actual !== expected) {
    return refuse(
      'domain-mismatch',
      `Refused: the link goes to "${actual}" but this action is authorized for "${expected}". `
      + 'A near-miss is how a phishing link is built; nothing is opened.',
      expected,
      actual,
    );
  }

  return { ok: true, url: parsed.toString(), host, registrableDomain: actual };
}

/** A single HEAD/GET that reports only what redirect following needs. */
export interface RedirectProbe {
  (url: string): Promise<{ readonly status: number; readonly location: string | null }>;
}

export interface RedirectChainResult {
  readonly ok: boolean;
  /** Every url visited, in order, all of them validated. */
  readonly chain: readonly string[];
  /** The final validated url, when the whole chain stayed in-domain. */
  readonly finalUrl: string | null;
  readonly refusal: LinkRefused | null;
}

/**
 * Walk a redirect chain, validating EVERY hop by the same rules.
 *
 * The starting url is validated first, so a caller cannot skip the gate by
 * entering here. A hop that leaves the authorized registrable domain refuses
 * the whole chain rather than the hop, because the caller's question is "may I
 * open this link", and the honest answer for a link that ends up elsewhere is
 * no.
 */
export async function followValidatedRedirects(
  rawUrl: string,
  authorizedDomain: string,
  probe: RedirectProbe,
  maxHops: number = MAX_REDIRECT_HOPS,
): Promise<RedirectChainResult> {
  const first = validateLinkTarget(rawUrl, authorizedDomain);
  if (!first.ok) return { ok: false, chain: [], finalUrl: null, refusal: first };

  const chain: string[] = [first.url];
  let current = first.url;

  for (let hop = 0; hop < maxHops; hop += 1) {
    const response = await probe(current);
    const isRedirect = response.status >= 300 && response.status < 400 && response.location !== null;
    if (!isRedirect) {
      return { ok: true, chain, finalUrl: current, refusal: null };
    }

    // Resolve relative Location headers against the current url, then put the
    // result through the SAME gate, a redirect target is not more trustworthy
    // for having been reached by one.
    let next: string;
    try {
      next = new URL(response.location as string, current).toString();
    } catch {
      return {
        ok: false,
        chain,
        finalUrl: null,
        refusal: refuse('malformed-url', 'Refused: a redirect pointed at an unparseable URL.', authorizedDomain),
      };
    }

    const validated = validateLinkTarget(next, authorizedDomain);
    if (!validated.ok) {
      return {
        ok: false,
        chain,
        finalUrl: null,
        refusal: {
          ...validated,
          reason: validated.reason === 'domain-mismatch' ? 'redirect-left-domain' : validated.reason,
          message:
            `Refused after ${String(chain.length)} hop(s): ${validated.message} `
            + 'A link that starts on the right site and then redirects away is the same attack one step later.',
        },
      };
    }
    chain.push(validated.url);
    current = validated.url;
  }

  return {
    ok: false,
    chain,
    finalUrl: null,
    refusal: refuse(
      'too-many-redirects',
      `Refused: the link redirected more than ${String(maxHops)} times without settling.`,
      authorizedDomain,
      null,
    ),
  };
}
