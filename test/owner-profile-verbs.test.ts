/**
 * owner-profile-verbs.test.ts — the profile.* control-plane surface.
 *
 * Covers docs/owner-profile.md §14 items 6 (disclosure fires), 11 (status
 * returns counts, names and reasons and NO values) and 22 (removal is gated,
 * proven at the verb layer with a byte-identical file afterwards), plus the two
 * structural properties §10 and §11.1 rely on: there is no enumerate-all-people
 * verb, and a caller declaring the call was not a user request is refused before
 * anything else happens.
 *
 * Exercised over a real GatewayMethodCatalog with the handlers attached the way
 * the daemon attaches them, so the descriptors, the scopes and the handler
 * wiring are all in the assertion path rather than assumed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerOwnerProfileGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/owner-profile.ts';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/index.ts';
import {
  SETTINGS_EDIT_UTTERANCE,
  type OwnerProfilePolicy,
} from '../packages/sdk/src/platform/control-plane/routes/owner-profile-policy.ts';
import type { ProfileWriteResult } from '../packages/sdk/src/platform/owner-profile/index.ts';

const VERB_IDS = [
  'profile.read',
  'profile.get',
  'profile.person',
  'profile.provenance',
  'profile.set',
  'profile.append',
  'profile.forget',
  'profile.undo',
  'profile.status',
] as const;

const UNTRUSTED = ['web-page', 'email', 'channel-message', 'document'] as const;

const FIXTURE = [
  '# Mike\'s profile',
  '',
  '## Identity',
  '',
  'name: Mike Davis',
  'goes by: Mike',
  '',
  '## Contact',
  '',
  'email: owner@example.com',
  '',
  '## Commerce',
  '',
  'shipping address: 401 Home St, Lansing, MI 48933, US — tui, 2026-07-20, "ship to 401 Home St"',
  '',
  '## Location',
  '',
  'timezone: Mars/Olympus',
  '',
  '## People',
  '',
  '- Sarah, sister, sarah@example.com',
  '',
].join('\n');

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-profile-verbs-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly catalog: GatewayMethodCatalog;
  readonly store: OwnerProfileStore;
  readonly path: string;
}

async function harness(
  text: string = FIXTURE,
  policy?: OwnerProfilePolicy,
): Promise<Harness> {
  const dir = mkTemp();
  const path = join(dir, 'owner-profile.md');
  writeFileSync(path, text, 'utf-8');
  const store = new OwnerProfileStore({ path, now: () => new Date('2026-07-27T12:00:00Z') });
  await store.load();
  const catalog = new GatewayMethodCatalog();
  registerOwnerProfileGatewayMethods(catalog, store, policy);
  return { catalog, store, path };
}

/** A policy with every switch off, for the "he turned it off" cases. */
const ALL_OFF: OwnerProfilePolicy = {
  autonomousWrites: () => false,
  discloseWrites: () => false,
  discloseClosedTierReads: () => false,
};

const ctx = { context: { admin: true } } as const;

describe('profile.* verbs — catalog surface', () => {
  test('all nine are cataloged with handlers and the documented scopes', async () => {
    const { catalog } = await harness();
    const expectedScope: Record<string, string> = {
      // Its own scope on purpose — see the descriptor's note. A composition
      // path can be granted read:profile without being granted the bulk read.
      'profile.read': 'read:profile.full',
      'profile.get': 'read:profile',
      'profile.person': 'read:profile',
      'profile.provenance': 'read:profile',
      'profile.status': 'read:profile',
      'profile.set': 'write:profile',
      'profile.append': 'write:profile',
      'profile.forget': 'write:profile',
      'profile.undo': 'write:profile',
    };
    for (const id of VERB_IDS) {
      const descriptor = catalog.get(id);
      expect(descriptor).not.toBeNull();
      expect(catalog.hasHandler(id)).toBe(true);
      expect(descriptor?.scopes).toEqual([expectedScope[id]!]);
    }
  });

  // Asserting the SPLIT, not one literal: pinning only `profile.read`'s string
  // would not notice someone later widening `profile.get` to the full scope,
  // which is precisely the change that would quietly hand a composition path
  // the bulk read back.
  test('profile.read alone carries read:profile.full; every other read is read:profile', async () => {
    const { catalog } = await harness();
    const full = VERB_IDS.filter((id) => catalog.get(id)?.scopes.includes('read:profile.full'));
    expect(full).toEqual(['profile.read']);

    const namedReads = ['profile.get', 'profile.person', 'profile.provenance', 'profile.status'];
    for (const id of namedReads) {
      expect(catalog.get(id)?.scopes).toEqual(['read:profile']);
    }
    // And the bulk read does NOT also carry the narrow scope, or holding
    // read:profile would still reach it.
    expect(catalog.get('profile.read')?.scopes).not.toContain('read:profile');
  });

  // The contract and the handler must agree about `authority`. They did not:
  // it sat in `properties` but in none of the four `required` arrays, so every
  // generated client and the OpenAPI document told callers it was optional
  // while the handler answered 400 without it.
  test('all four write verbs declare authority REQUIRED in their input schema', async () => {
    const { catalog } = await harness();
    for (const id of ['profile.set', 'profile.append', 'profile.forget', 'profile.undo']) {
      const schema = catalog.get(id)?.inputSchema as
        | { properties?: Record<string, unknown>; required?: string[] }
        | undefined;
      expect(schema?.properties, `${id} has no authority property`).toHaveProperty('authority');
      expect(schema?.required ?? [], `${id} does not require authority`).toContain('authority');
    }
  });

  test('there is no enumerate-all-people verb, and person requires a name (§10)', async () => {
    const { catalog } = await harness();
    for (const id of ['profile.people', 'profile.people.list', 'profile.persons', 'profile.people.all']) {
      expect(catalog.get(id)).toBeNull();
    }
    await expect(catalog.invoke('profile.person', { ...ctx, body: {} })).rejects.toThrow(/name is required/);
    const found = await catalog.invoke('profile.person', { ...ctx, body: { name: 'Sarah' } }) as {
      lines: readonly { text: string }[];
      disclosure: string;
    };
    expect(found.lines).toHaveLength(1);
    expect(found.disclosure).toBe("Used Sarah's details from your profile.");
  });
});

describe('profile.status — §14 #11: counts, names and reasons, never a value', () => {
  test('reports the invalid field with its reason and leaks no value anywhere', async () => {
    const { catalog } = await harness();
    const status = await catalog.invoke('profile.status', { ...ctx, body: {} }) as Record<string, unknown>;

    expect(status.kind).toBe('loaded');
    expect(status.sections).toContain('Commerce');
    expect(status.lineCount).toBeGreaterThan(0);
    expect(status.fieldCount).toBeGreaterThan(0);
    expect(status.invalidFields).toEqual([
      { fieldId: 'location.timezone', reason: 'not an IANA time zone name' },
    ]);

    // The whole response, flattened: not one profile VALUE may appear in it.
    const serialized = JSON.stringify(status);
    for (const value of [
      'Mike Davis',
      'owner@example.com',
      '401 Home St',
      'Mars/Olympus',
      'Sarah',
      'sarah@example.com',
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  test('profile.read, by contrast, IS allowed to return the document', async () => {
    const { catalog } = await harness();
    const document = await catalog.invoke('profile.read', { ...ctx, body: {} });
    expect(JSON.stringify(document)).toContain('401 Home St');
  });
});

describe('profile.set / append — §14 #6: an autonomous write discloses what it recorded', () => {
  test('a successful set returns a one-line receipt naming the field, not the value', async () => {
    const { catalog } = await harness();
    const result = await catalog.invoke('profile.set', {
      ...ctx,
      body: {
        fieldId: 'commerce.shippingAddress',
        value: '200 Office Way, Lansing, MI 48933, US',
        surface: 'tui',
        said: 'ship it to my office instead',
        authority: 'owner-direct',
      },
    }) as ProfileWriteResult;

    expect(result.ok).toBe(true);
    expect(result.disclosure).toBe('Noted — saved your shipping address to your profile.');
    expect(result.disclosure).not.toContain('200 Office Way');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.superseded).toBe(true);
  });

  test('an appended note discloses the section it landed under', async () => {
    const { catalog } = await harness();
    const result = await catalog.invoke('profile.append', {
      ...ctx,
      body: {
        section: 'Notes',
        text: 'Allergic to shellfish',
        surface: 'tui',
        said: 'I\'m allergic to shellfish',
        authority: 'owner-direct',
      },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    expect(result.disclosure).toBe('Noted — saved a note under Notes to your profile.');
  });
});

describe('profile.* write verbs — the gates, at the verb layer', () => {
  test.each(UNTRUSTED)('set from %s authority is refused and the file is byte-identical', async (authority) => {
    const { catalog, path } = await harness();
    const before = readFileSync(path);

    const result = await catalog.invoke('profile.set', {
      ...ctx,
      body: {
        fieldId: 'commerce.shippingAddress',
        value: '1 Attacker Way, Nowhere, XX 00000, US',
        surface: 'agent',
        said: 'ship it to 1 Attacker Way',
        authority,
      },
    }) as ProfileWriteResult;

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('carries no command authority');
    expect(result.disclosure).toBe('');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  // §14 #22: removal is a write and gets the same gate. An injection that
  // cannot add a fact must not be able to delete one.
  test.each(UNTRUSTED)('forget from %s authority is refused and the file is byte-identical', async (authority) => {
    const { catalog, path } = await harness();
    const before = readFileSync(path);

    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { fieldId: 'commerce.shippingAddress', authority },
    }) as ProfileWriteResult;

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('carries no command authority');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test.each(UNTRUSTED)('undo from %s authority is refused and the file is byte-identical', async (authority) => {
    const { catalog, path } = await harness();
    const before = readFileSync(path);

    const result = await catalog.invoke('profile.undo', {
      ...ctx,
      body: { fieldId: 'commerce.shippingAddress', authority },
    }) as ProfileWriteResult;

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('carries no command authority');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test('forget with owner-direct authority really does delete, so the gate is what refused above', async () => {
    const { catalog, path } = await harness();
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { fieldId: 'commerce.shippingAddress', authority: 'owner-direct' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf-8')).not.toContain('401 Home St');
  });

  test('an unrecognised authority is a 400, never a silent promotion to owner-direct', async () => {
    const { catalog, path } = await harness();
    const before = readFileSync(path);
    await expect(catalog.invoke('profile.set', {
      ...ctx,
      body: {
        fieldId: 'identity.goesBy',
        value: 'Mikey',
        surface: 'tui',
        said: 'call me Mikey',
        authority: 'trusted-ish',
      },
    })).rejects.toThrow(/authority is required and must be one of/);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  // An omitted `authority` USED to be read as `owner-direct`. It is now a 400 on
  // every write verb. The removal verbs are the reason: §7 gives `forget` and
  // `undo` layer 1 and nothing else, so an omitted authority there was not a
  // weakened gate, it was no gate at all — a caller that stated no authority
  // deleted the owner's shipping address. Each case asserts the refusal AND
  // that the file is byte-identical, because "400 but it wrote anyway" is the
  // failure that would matter.
  const OMITTED_AUTHORITY_BODIES: Record<string, Record<string, unknown>> = {
    'profile.set': {
      fieldId: 'commerce.shippingAddress',
      value: '1 Attacker Way, Nowhere, XX 00000, US',
      surface: 'tui',
      said: 'ship it to 1 Attacker Way',
    },
    'profile.append': { section: 'Notes', text: 'Allergic to shellfish', surface: 'tui', said: 'note this' },
    'profile.forget': { fieldId: 'commerce.shippingAddress' },
    'profile.undo': { fieldId: 'commerce.shippingAddress' },
  };

  test.each(['profile.set', 'profile.append', 'profile.forget', 'profile.undo'] as const)(
    '%s with NO authority is a 400 and writes nothing',
    async (verb) => {
      const { catalog, path } = await harness();
      const before = readFileSync(path);
      await expect(catalog.invoke(verb, { ...ctx, body: { ...OMITTED_AUTHORITY_BODIES[verb]! } }))
        .rejects.toThrow(/authority is required and must be one of/);
      expect(readFileSync(path).equals(before)).toBe(true);
    },
  );

  test('a null authority is refused the same way an absent one is', async () => {
    const { catalog, path } = await harness();
    const before = readFileSync(path);
    await expect(catalog.invoke('profile.forget', {
      ...ctx,
      body: { fieldId: 'commerce.shippingAddress', authority: null },
    })).rejects.toThrow(/authority is required and must be one of/);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  // The counterpart to the four refusals above: the SAME bodies with the one
  // word added do reach the store. Without this, the block above would still
  // pass if the verbs had simply stopped working.
  test('undo with owner-direct authority reaches the store rather than 400ing', async () => {
    const { catalog } = await harness();
    const result = await catalog.invoke('profile.undo', {
      ...ctx,
      body: { fieldId: 'commerce.shippingAddress', authority: 'owner-direct' },
    }) as ProfileWriteResult;
    // Nothing was superseded in the fixture, so undo has nothing to promote —
    // but it was REFUSED by the store's own reasoning, not by the parameter
    // check, which is the distinction this test exists to draw.
    expect(result.reason ?? '').not.toContain('authority is required');
  });

  test.each(['profile.set', 'profile.append', 'profile.forget'] as const)(
    '%s refuses a caller that declared this was not a user request',
    async (verb) => {
      const { catalog, path } = await harness();
      const before = readFileSync(path);
      // A complete, otherwise-valid body — including `authority` — so the
      // refusal can only be the user-request gate and not a missing parameter.
      const body: Record<string, unknown> = verb === 'profile.append'
        ? { section: 'Notes', text: 'x', surface: 'tui', said: 'x', authority: 'owner-direct' }
        : verb === 'profile.forget'
          ? { fieldId: 'commerce.shippingAddress', authority: 'owner-direct' }
          : {
            fieldId: 'identity.goesBy',
            value: 'Mikey',
            surface: 'tui',
            said: 'call me Mikey',
            authority: 'owner-direct',
          };

      await expect(catalog.invoke(verb, {
        context: { admin: true, metadata: { explicitUserRequest: false } },
        body,
      })).rejects.toThrow(/needs an explicit user request/);
      expect(readFileSync(path).equals(before)).toBe(true);
    },
  );

  test('an absent explicitUserRequest claim proceeds — silence is not a refusal', async () => {
    const { catalog } = await harness();
    const result = await catalog.invoke('profile.set', {
      context: { admin: true },
      body: {
        fieldId: 'identity.goesBy',
        value: 'Mikey',
        surface: 'tui',
        said: 'call me Mikey',
        authority: 'owner-direct',
      },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
  });

  test('an unknown fieldId is a 400 that names what a profile field is', async () => {
    const { catalog } = await harness();
    await expect(catalog.invoke('profile.get', { ...ctx, body: { fieldId: 'identity.favouriteColour' } }))
      .rejects.toThrow(/is not a profile field/);
  });
});

describe('profile.get / provenance — honest answers about one field', () => {
  test('an invalid value is returned verbatim with its reason, not hidden', async () => {
    const { catalog } = await harness();
    const answer = await catalog.invoke('profile.get', { ...ctx, body: { fieldId: 'location.timezone' } }) as {
      present: boolean;
      field: { value: string; valid: boolean; invalidReason?: string };
      disclosure: string;
    };
    expect(answer.present).toBe(true);
    expect(answer.field.value).toBe('Mars/Olympus');
    expect(answer.field.valid).toBe(false);
    expect(answer.field.invalidReason).toBe('not an IANA time zone name');
    // Open tier ⇒ no disclosure line; it is already in context.
    expect(answer.disclosure).toBe('');
  });

  test('a closed-tier read carries the one-line disclosure', async () => {
    const { catalog } = await harness();
    const answer = await catalog.invoke('profile.get', { ...ctx, body: { fieldId: 'contact.email' } }) as {
      disclosure: string;
    };
    expect(answer.disclosure).toBe('Used your email from your profile.');
  });

  test('an unset field answers present:false rather than inventing a value', async () => {
    const { catalog } = await harness();
    const answer = await catalog.invoke('profile.get', { ...ctx, body: { fieldId: 'contact.phone' } }) as {
      present: boolean;
      field?: unknown;
    };
    expect(answer.present).toBe(false);
    expect(answer.field).toBeUndefined();
  });

  test('provenance answers "where did you get that", including hand-edited fields', async () => {
    const { catalog } = await harness();
    const recorded = await catalog.invoke('profile.provenance', {
      ...ctx,
      body: { fieldId: 'commerce.shippingAddress' },
    }) as { present: boolean; handEdited: boolean; provenance: { surface: string; said: string } | null };
    expect(recorded.present).toBe(true);
    expect(recorded.handEdited).toBe(false);
    expect(recorded.provenance?.surface).toBe('tui');
    expect(recorded.provenance?.said).toBe('ship to 401 Home St');

    const handEdited = await catalog.invoke('profile.provenance', {
      ...ctx,
      body: { fieldId: 'identity.name' },
    }) as { present: boolean; handEdited: boolean; provenance: unknown };
    expect(handEdited.present).toBe(true);
    expect(handEdited.handEdited).toBe(true);
    expect(handEdited.provenance).toBeNull();
  });
});

describe('profile.* verbs — a disabled or unreadable profile is a stated state', () => {
  test('disabled answers with the reason, not an empty profile', async () => {
    const dir = mkTemp();
    const path = join(dir, 'owner-profile.md');
    writeFileSync(path, FIXTURE, 'utf-8');
    const store = new OwnerProfileStore({ path, enabled: false });
    await store.load();
    const catalog = new GatewayMethodCatalog();
    registerOwnerProfileGatewayMethods(catalog, store);

    const status = await catalog.invoke('profile.status', { ...ctx, body: {} }) as { kind: string };
    expect(status.kind).toBe('disabled');

    const result = await catalog.invoke('profile.set', {
      ...ctx,
      body: {
        fieldId: 'identity.goesBy',
        value: 'Mikey',
        surface: 'tui',
        said: 'call me Mikey',
        authority: 'owner-direct',
      },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('turned off');
    // The file is untouched: disabled means the file is never opened.
    expect(readFileSync(path, 'utf-8')).toBe(FIXTURE);
  });
});

describe('§12 — the three owner switches actually govern the runtime', () => {
  test('profile.autonomousWrites off refuses a learned fact, and the file is byte-identical', async () => {
    const { catalog, path } = await harness(FIXTURE, ALL_OFF);
    const before = readFileSync(path);

    const result = await catalog.invoke('profile.set', {
      ...ctx,
      body: {
        fieldId: 'commerce.shippingAddress',
        value: '200 Office Way, Lansing, MI 48933, US',
        surface: 'tui',
        said: 'ship it to my office instead',
        authority: 'owner-direct',
      },
    }) as ProfileWriteResult;

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('profile.autonomousWrites');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test('autonomousWrites off refuses an appended note too', async () => {
    const { catalog, path } = await harness(FIXTURE, ALL_OFF);
    const before = readFileSync(path);
    const result = await catalog.invoke('profile.append', {
      ...ctx,
      body: {
        section: 'Notes', text: 'Allergic to shellfish', surface: 'tui',
        said: "I'm allergic to shellfish", authority: 'owner-direct',
      },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test('autonomousWrites off still lets HIM edit — the honest "I curate this myself" mode', async () => {
    const { catalog, path } = await harness(FIXTURE, ALL_OFF);
    const result = await catalog.invoke('profile.set', {
      ...ctx,
      body: {
        fieldId: 'commerce.shippingAddress',
        value: '200 Office Way, Lansing, MI 48933, US',
        surface: 'webui',
        said: SETTINGS_EDIT_UTTERANCE,
        authority: 'owner-direct',
      },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('200 Office Way');
  });

  test('autonomousWrites off does not lock him out of forgetting', async () => {
    const { catalog, path } = await harness(FIXTURE, ALL_OFF);
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { fieldId: 'commerce.shippingAddress', authority: 'owner-direct' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf-8')).not.toContain('401 Home St');
  });

  test('profile.discloseWrites off records the fact and returns no receipt', async () => {
    const { catalog, path } = await harness(FIXTURE, {
      autonomousWrites: () => true,
      discloseWrites: () => false,
      discloseClosedTierReads: () => true,
    });
    const result = await catalog.invoke('profile.set', {
      ...ctx,
      body: {
        fieldId: 'commerce.shippingAddress',
        value: '200 Office Way, Lansing, MI 48933, US',
        surface: 'tui', said: 'ship it to my office instead', authority: 'owner-direct',
      },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    expect(result.disclosure).toBe('');
    // The write really happened — silenced, not refused.
    expect(readFileSync(path, 'utf-8')).toContain('200 Office Way');
  });

  test('a deletion still confirms what went, even with discloseWrites off', async () => {
    const { catalog } = await harness(FIXTURE, ALL_OFF);
    const result = await catalog.invoke('profile.forget', {
      ...ctx,
      body: { fieldId: 'commerce.shippingAddress', authority: 'owner-direct' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(true);
    expect(result.disclosure).not.toBe('');
  });

  test('profile.discloseClosedTierReads off serves the value and says nothing', async () => {
    const { catalog } = await harness(FIXTURE, ALL_OFF);
    const answer = await catalog.invoke('profile.get', {
      ...ctx, body: { fieldId: 'contact.email' },
    }) as { present: boolean; field: { value: string }; disclosure: string };
    expect(answer.present).toBe(true);
    expect(answer.field.value).toBe('owner@example.com');
    expect(answer.disclosure).toBe('');

    const person = await catalog.invoke('profile.person', {
      ...ctx, body: { name: 'Sarah' },
    }) as { lines: readonly unknown[]; disclosure: string };
    expect(person.lines).toHaveLength(1);
    expect(person.disclosure).toBe('');
  });

  test('with the defaults, all three announce and permit as the schema promises', async () => {
    const { catalog } = await harness();
    const written = await catalog.invoke('profile.set', {
      ...ctx,
      body: {
        fieldId: 'commerce.shippingAddress', value: '200 Office Way, Lansing, MI 48933, US',
        surface: 'tui', said: 'ship it to my office instead', authority: 'owner-direct',
      },
    }) as ProfileWriteResult;
    expect(written.disclosure).not.toBe('');
    const read = await catalog.invoke('profile.get', {
      ...ctx, body: { fieldId: 'contact.email' },
    }) as { disclosure: string };
    expect(read.disclosure).not.toBe('');
  });
});
