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

async function harness(text: string = FIXTURE): Promise<Harness> {
  const dir = mkTemp();
  const path = join(dir, 'owner-profile.md');
  writeFileSync(path, text, 'utf-8');
  const store = new OwnerProfileStore({ path, now: () => new Date('2026-07-27T12:00:00Z') });
  await store.load();
  const catalog = new GatewayMethodCatalog();
  registerOwnerProfileGatewayMethods(catalog, store);
  return { catalog, store, path };
}

const ctx = { context: { admin: true } } as const;

describe('profile.* verbs — catalog surface', () => {
  test('all nine are cataloged with handlers and the documented scopes', async () => {
    const { catalog } = await harness();
    const expectedScope: Record<string, string> = {
      'profile.read': 'read:profile',
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
      body: { section: 'Notes', text: 'Allergic to shellfish', surface: 'tui', said: 'I\'m allergic to shellfish' },
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
      body: { fieldId: 'commerce.shippingAddress' },
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
    })).rejects.toThrow(/authority must be one of/);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test.each(['profile.set', 'profile.append', 'profile.forget'] as const)(
    '%s refuses a caller that declared this was not a user request',
    async (verb) => {
      const { catalog, path } = await harness();
      const before = readFileSync(path);
      const body: Record<string, unknown> = verb === 'profile.append'
        ? { section: 'Notes', text: 'x', surface: 'tui', said: 'x' }
        : verb === 'profile.forget'
          ? { fieldId: 'commerce.shippingAddress' }
          : { fieldId: 'identity.goesBy', value: 'Mikey', surface: 'tui', said: 'call me Mikey' };

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
      body: { fieldId: 'identity.goesBy', value: 'Mikey', surface: 'tui', said: 'call me Mikey' },
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
      body: { fieldId: 'identity.goesBy', value: 'Mikey', surface: 'tui', said: 'call me Mikey' },
    }) as ProfileWriteResult;
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('turned off');
    // The file is untouched: disabled means the file is never opened.
    expect(readFileSync(path, 'utf-8')).toBe(FIXTURE);
  });
});
