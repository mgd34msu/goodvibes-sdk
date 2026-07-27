/**
 * security-link-validation.test.ts
 *
 * Owner: "headers can be spoofed etc… need to validate any domain we 'click'
 * on before we click on it."
 *
 * Every test here is an attack that defeats at least one naive check, so each
 * one is written as the attack rather than as a property. If a future change
 * makes any of these pass, the gate is no longer doing the job it was built
 * for.
 */

import { describe, expect, test } from 'bun:test';
import {
  MAX_REDIRECT_HOPS,
  followValidatedRedirects,
  validateLinkTarget,
} from '../packages/sdk/src/platform/security/link-validation.ts';
import {
  registrableDomain,
  sameRegistrableDomain,
} from '../packages/sdk/src/platform/security/public-suffix.ts';

const TARGET = 'google.com';

describe('registrable domain — the comparison every naive check gets wrong', () => {
  test.each([
    ['google.com', 'google.com'],
    ['accounts.google.com', 'google.com'],
    ['a.b.c.google.com', 'google.com'],
    ['bbc.co.uk', 'bbc.co.uk'],
    ['www.bbc.co.uk', 'bbc.co.uk'],
    ['shop.example.com.au', 'example.com.au'],
    // Each label under a hosting suffix is a separate registrant.
    ['alice.github.io', 'alice.github.io'],
    ['bob.github.io', 'bob.github.io'],
  ])('%s -> %s', (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  test('a public suffix has no registrable domain of its own', () => {
    expect(registrableDomain('co.uk')).toBeNull();
    expect(registrableDomain('com')).toBeNull();
  });

  test('two sites under the same hosting suffix are NOT the same domain', () => {
    // endsWith('github.io') would call these equal.
    expect(sameRegistrableDomain('alice.github.io', 'bob.github.io')).toBe(false);
  });
});

describe('refusals — each defeats a check somebody would otherwise have written', () => {
  test('userinfo: reads as Google, opens evil.example', () => {
    const result = validateLinkTarget('https://accounts.google.com@evil.example/verify', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('contains-userinfo');
    // The refusal must name where it ACTUALLY goes, or a reader learns nothing.
    expect(result.message).toContain('evil.example');
  });

  test('homograph: Cyrillic a in accounts', () => {
    const result = validateLinkTarget('https://аccounts.google.com/verify', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('mixed-script-host');
  });

  test('suffix trick: google.com.evil.example', () => {
    // endsWith and includes both pass this.
    const result = validateLinkTarget('https://google.com.evil.example/verify', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('domain-mismatch');
    expect(result.actualDomain).toBe('evil.example');
  });

  test('lookalike registrations: google-verify.example and accounts-google.example', () => {
    for (const url of ['https://google-verify.example/v', 'https://accounts-google.example/v']) {
      const result = validateLinkTarget(url, TARGET);
      expect(result.ok, url).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('domain-mismatch');
    }
  });

  test('http is refused, not upgraded', () => {
    const result = validateLinkTarget('http://accounts.google.com/verify', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('not-https');
  });

  test('javascript: and data: are refused', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>']) {
      const result = validateLinkTarget(url, TARGET);
      expect(result.ok, url).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('not-https');
    }
  });

  test('a shortener is refused by name, because the address cannot say where it goes', () => {
    const result = validateLinkTarget('https://bit.ly/3xYz', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('known-redirector');
  });

  test('a non-443 port is refused', () => {
    const result = validateLinkTarget('https://accounts.google.com:8443/verify', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('non-standard-port');
  });

  test('a bare IP host is refused', () => {
    const result = validateLinkTarget('https://192.0.2.10/verify', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('ip-literal-host');
  });
});

describe('the positive case — a genuine link is opened', () => {
  test('the real link on the exact registrable domain passes', () => {
    const result = validateLinkTarget('https://accounts.google.com/verify?token=abc', TARGET);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.registrableDomain).toBe('google.com');
  });

  test('a trailing-dot host still matches, rather than failing a person for a typo', () => {
    expect(validateLinkTarget('https://accounts.google.com./verify', TARGET).ok).toBe(true);
  });
});

describe('redirect chains — the same attack one hop later', () => {
  function probeFrom(map: Readonly<Record<string, { status: number; location: string | null }>>) {
    return async (url: string) => map[url] ?? { status: 200, location: null };
  }

  test('a valid host that redirects cross-domain on hop 2 is refused', async () => {
    const result = await followValidatedRedirects(
      'https://accounts.google.com/verify',
      TARGET,
      probeFrom({
        'https://accounts.google.com/verify': { status: 302, location: 'https://evil.example/steal' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.finalUrl).toBeNull();
    expect(result.refusal?.reason).toBe('redirect-left-domain');
    expect(result.refusal?.message).toContain('redirects away');
  });

  test('an in-domain redirect chain is followed and settles', async () => {
    const result = await followValidatedRedirects(
      'https://accounts.google.com/verify',
      TARGET,
      probeFrom({
        'https://accounts.google.com/verify': { status: 302, location: 'https://myaccount.google.com/done' },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.finalUrl).toBe('https://myaccount.google.com/done');
    expect(result.chain).toHaveLength(2);
  });

  test('a redirect to a userinfo URL is refused even though the chain started well', async () => {
    const result = await followValidatedRedirects(
      'https://accounts.google.com/verify',
      TARGET,
      probeFrom({
        'https://accounts.google.com/verify': { status: 302, location: 'https://accounts.google.com@evil.example/' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe('contains-userinfo');
  });

  test('an endless redirect loop is refused rather than followed forever', async () => {
    const result = await followValidatedRedirects(
      'https://accounts.google.com/a',
      TARGET,
      async (url: string) => ({ status: 302, location: `${url}a` }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe('too-many-redirects');
    expect(result.chain.length).toBeLessThanOrEqual(MAX_REDIRECT_HOPS + 1);
  });

  test('the entry point is gated too — a caller cannot skip validation by starting here', async () => {
    const result = await followValidatedRedirects(
      'https://evil.example/verify',
      TARGET,
      probeFrom({}),
    );
    expect(result.ok).toBe(false);
    expect(result.chain).toHaveLength(0);
    expect(result.refusal?.reason).toBe('domain-mismatch');
  });
});
