/**
 * A malformed secret reference is a refusal, not a credential.
 *
 * `resolveSecretInput` parsed a `goodvibes://…` string and, when the parse
 * failed, fell through to "then it must be a literal secret" — a rule that
 * succeeds by convention. So a typo in a config reference became the auth
 * token: the reference TEXT went on the wire to a third party and into their
 * logs, and what came back was a 401, which sends whoever debugs it hunting for
 * a wrong token rather than a malformed reference.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeSecretRef } from '../packages/sdk/src/platform/config/secret-refs.ts';
import {
  describeMalformedSecretRef,
  looksLikeSecretRef,
  resolveSecretInput,
} from '../packages/sdk/src/platform/config/secret-ref-refusal.ts';
import { secretReferenceFor } from '../packages/sdk/src/platform/config/plaintext-credential-sweep.ts';

const NEVER_RESOLVES = { resolveLocalSecret: async () => null };

/** Reference-shaped strings that do not parse. Each was a passthrough. */
const MALFORMED = [
  'goodvibes://secrets/GOODVIBES_SURFACES_EMAIL_PASSWORD',
  'goodvibes://typo/goodvibes/TELEGRAM_BOT_TOKEN',
  'goodvibes://secrets/nonsense/whatever',
  'goodvibes://',
  'bw://',
];

/**
 * `op://anything` is accepted by the parser as a 1Password ref without checking
 * its vault/item/field structure, so it is not "malformed" by this module's
 * reckoning. It still never becomes the credential — resolution returns null —
 * which is the property that matters here. Asserted separately rather than
 * folded in, because calling it malformed would misdescribe the parser.
 */
const PERMISSIVELY_PARSED = ['op://', 'op://vault/item/field'];

describe('a reference that does not parse is never used as the credential', () => {
  test.each(MALFORMED)('%s resolves to nothing', async (input) => {
    expect(normalizeSecretRef(input)).toBeNull();
    const resolved = await resolveSecretInput(input, NEVER_RESOLVES);
    expect(resolved).toBeNull();
    // The specific catastrophe: the reference text itself as the credential.
    expect(resolved).not.toBe(input);
  });

  test.each(PERMISSIVELY_PARSED)('%s parses, and still never becomes the credential', async (input) => {
    expect(normalizeSecretRef(input)).not.toBeNull();
    const resolved = await resolveSecretInput(input, {
      ...NEVER_RESOLVES,
      runCommand: async () => { throw new Error('no 1Password CLI in this test'); },
    });
    expect(resolved).not.toBe(input);
    expect(resolved).toBeNull();
  });

  test('a well-formed reference still resolves normally', async () => {
    const value = await resolveSecretInput('goodvibes://secrets/goodvibes/SOME_KEY', {
      resolveLocalSecret: async (key) => (key === 'SOME_KEY' ? 'the-real-token' : null),
    });
    expect(value).toBe('the-real-token');
  });

  test('an ordinary literal secret is untouched — this is not a blanket refusal', async () => {
    for (const literal of ['xoxb-a-real-looking-token', 'sk-abc123', 'hunter2', 'https://example.com/hook']) {
      expect(await resolveSecretInput(literal, NEVER_RESOLVES)).toBe(literal);
    }
  });

  test('the escape hatch is explicit, and off by default', async () => {
    const lookalike = 'goodvibes://secrets/GOODVIBES_LITERAL';
    expect(await resolveSecretInput(lookalike, NEVER_RESOLVES)).toBeNull();
    expect(await resolveSecretInput(lookalike, { ...NEVER_RESOLVES, treatUnparseableRefAsLiteral: true }))
      .toBe(lookalike);
  });
});

describe('the refusal names the setting and the shape, never the value', () => {
  test('the shape describes structure only', () => {
    const shape = describeMalformedSecretRef('goodvibes://typo/goodvibes/SUPER_SECRET_VALUE_HERE');
    expect(shape).toContain('goodvibes://');
    expect(shape).toContain('typo');
    // The part that would be the credential, or the operator's paste, is absent.
    expect(shape).not.toContain('SUPER_SECRET_VALUE_HERE');
  });

  test('an unparseable URI is described without its text', () => {
    const shape = describeMalformedSecretRef('goodvibes://  spaces and %%% junk SECRETBIT');
    expect(shape).not.toContain('SECRETBIT');
    expect(shape).toContain('characters');
  });
});

describe('what counts as reference-shaped', () => {
  test('every scheme the parser accepts is recognised as a reference shape', () => {
    for (const input of ['goodvibes://x', 'op://x', 'bw://x', 'vaultwarden://x', 'bws://x']) {
      expect(looksLikeSecretRef(input)).toBe(true);
    }
  });

  test('an ordinary secret is not reference-shaped', () => {
    for (const input of ['xoxb-token', 'https://example.com', 'postgres://user:pw@host/db', '']) {
      expect(looksLikeSecretRef(input)).toBe(false);
    }
  });
});

describe('the reference this platform WRITES is one it can read back', () => {
  test('the sweep emits a reference that parses', () => {
    // It did not. `goodvibes://secrets/<KEY>` puts the key where the parser
    // expects a provider name, so it resolved to no provider — and combined
    // with the old passthrough, the sweep would have replaced a working
    // password with a reference that resolved to its own text.
    const emitted = secretReferenceFor('GOODVIBES_SURFACES_EMAIL_PASSWORD');
    expect(normalizeSecretRef(emitted)).toEqual({
      source: 'goodvibes',
      id: 'GOODVIBES_SURFACES_EMAIL_PASSWORD',
    });
  });

  test('a key needing encoding survives the round trip', () => {
    const emitted = secretReferenceFor('weird/key with spaces');
    expect(normalizeSecretRef(emitted)).toEqual({ source: 'goodvibes', id: 'weird/key with spaces' });
  });
});
