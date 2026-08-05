/**
 * gateway-response-contract-conformance.test.ts — real route responses against
 * the published contract, using the client's own validator.
 *
 * ## The class this file closes
 *
 * `packages/operator-sdk/src/client-core.ts` validates every response it
 * receives against the method's `outputSchema` from the generated contract, and
 * every one of those schemas carries `additionalProperties: false`. A handler
 * that answers with one property the schema does not declare therefore does not
 * degrade — it fails outright, for every strict client, on every call.
 *
 * That is not hypothetical. `profile.get` answered with the store's internal
 * `ProfileFieldValue`, which carries `section` and `lineIndex` on top of the six
 * properties the contract declared, so every profile field read from a strict
 * client failed with:
 *
 *   Response validation failed for operator method "profile.get": field
 *   "$.field.section" expected no additional property but received present.
 *
 * Nothing caught it, because the descriptor tests assert the SCHEMA and the verb
 * tests assert the RESPONSE, and no test put the two on the same page. This file
 * is that page: it builds the handlers the way the daemon builds them, invokes
 * them, and runs the answers through `firstJsonSchemaFailure` — the exact
 * function the client calls — against the exact generated artifact the client
 * ships with.
 *
 * ## Hermetic by construction
 *
 * Every store here is pointed at a fresh `mkdtemp` directory and torn down
 * afterwards. Nothing reads or writes `~/.goodvibes` or the owner's real
 * profile: `OwnerProfileStore` takes an explicit `path`, and the assertion in
 * "every fixture path stays inside the temp directory" holds that in place
 * rather than trusting it.
 *
 * ## Families covered
 *
 * `profile.*` (all nine verbs, reads and writes, present/absent/invalid/refused
 * shapes), `occasions.*` (sixteen verbs over a real OccasionsService and a real
 * state store), and `runtime.metrics.get`. Those are the families whose real
 * implementations can be constructed in-process without a daemon; a family
 * exercised through a stub would only be asserting the stub's shape, which is
 * why none are here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
// The checked-in generated source, not the package's build output: this file
// exists to catch a runtime/contract divergence, and reading a stale `dist`
// would be a way to miss one.
import { OPERATOR_CONTRACT } from '../packages/contracts/src/generated/operator-contract.ts';
import { firstJsonSchemaFailure } from '../packages/transport-http/src/client-plumbing.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerOwnerProfileGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/owner-profile.ts';
import { registerOccasionsGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/occasions.ts';
import { registerRuntimeMetricsGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/runtime-metrics.ts';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/index.ts';
import { OccasionStateStore } from '../packages/sdk/src/platform/occasions/state-store.ts';
import { OccasionsService } from '../packages/sdk/src/platform/occasions/service.ts';
import { OCCASIONS_DEFAULTS } from '../packages/sdk/src/platform/occasions/policy.ts';

const CONTRACT_METHODS = new Map(
  OPERATOR_CONTRACT.operator.methods.map((method) => [method.id, method] as const),
);

const ctx = { context: { admin: true } } as const;

const dirs: string[] = [];
function mkTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Invoke a real handler and hold its answer to the published output schema.
 *
 * The failure message carries the offending payload, because "field $.field.section
 * expected no additional property" is only actionable next to the object that
 * carried it.
 */
async function invokeAndCheck(
  catalog: GatewayMethodCatalog,
  id: string,
  body: Record<string, unknown>,
  note: string,
): Promise<unknown> {
  const method = CONTRACT_METHODS.get(id);
  expect(method, `${id} is not in the generated operator contract`).toBeDefined();
  const response = await catalog.invoke(id, { ...ctx, body });
  const schema = method?.outputSchema;
  if (!schema || typeof schema !== 'object') return response;
  const failure = firstJsonSchemaFailure(schema as Record<string, unknown>, response);
  expect(
    failure === undefined ? 'conforms' : `${failure.path}: expected ${failure.expected}, received ${failure.received}`,
    `${id} (${note}) answered a payload the published contract rejects:\n${JSON.stringify(response, null, 2)}`,
  ).toBe('conforms');
  return response;
}

// ---------------------------------------------------------------------------
// profile.*
// ---------------------------------------------------------------------------

const PROFILE_FIXTURE = [
  "# Mike's profile",
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

interface ProfileHarness {
  readonly catalog: GatewayMethodCatalog;
  readonly path: string;
}

async function profileHarness(): Promise<ProfileHarness> {
  const dir = mkTemp('gv-contract-conformance-profile-');
  const path = join(dir, 'owner-profile.md');
  writeFileSync(path, PROFILE_FIXTURE, 'utf-8');
  const store = new OwnerProfileStore({ path, now: () => new Date('2026-07-27T12:00:00Z') });
  await store.load();
  const catalog = new GatewayMethodCatalog();
  registerOwnerProfileGatewayMethods(catalog, store);
  return { catalog, path };
}

describe('profile.* responses conform to the published contract', () => {
  test('every fixture path stays inside the temp directory', async () => {
    const { path } = await profileHarness();
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(path.startsWith(join(homedir(), '.goodvibes'))).toBe(false);
  });

  test('profile.status and profile.read', async () => {
    const { catalog } = await profileHarness();
    await invokeAndCheck(catalog, 'profile.status', {}, 'loaded profile');
    await invokeAndCheck(catalog, 'profile.read', {}, 'whole document');
  });

  /**
   * The live defect, at the exact field that broke on the owner's machine: a
   * present, closed-tier field carrying provenance.
   */
  test('profile.get — a present field with provenance', async () => {
    const { catalog } = await profileHarness();
    const answer = await invokeAndCheck(
      catalog,
      'profile.get',
      { fieldId: 'commerce.shippingAddress' },
      'present, closed tier, has provenance',
    ) as { present: boolean; field?: Record<string, unknown> };
    expect(answer.present).toBe(true);
    // The read really did carry the value — a conforming empty answer would
    // pass the schema and prove nothing.
    expect(answer.field?.value).toContain('401 Home St');
  });

  test('profile.get — a field whose recorded value does not validate', async () => {
    const { catalog } = await profileHarness();
    const answer = await invokeAndCheck(
      catalog,
      'profile.get',
      { fieldId: 'location.timezone' },
      'present but invalid, carries invalidReason',
    ) as { field?: Record<string, unknown> };
    expect(answer.field?.valid).toBe(false);
    expect(typeof answer.field?.invalidReason).toBe('string');
  });

  test('profile.get — a field with no provenance suffix, and one he never recorded', async () => {
    const { catalog } = await profileHarness();
    const handEdited = await invokeAndCheck(
      catalog,
      'profile.get',
      { fieldId: 'identity.name' },
      'present, no provenance',
    ) as { field?: Record<string, unknown> };
    expect(handEdited.field?.provenance).toBeUndefined();
    const absent = await invokeAndCheck(
      catalog,
      'profile.get',
      { fieldId: 'contact.phone' },
      'absent — present:false and no field',
    ) as { present: boolean };
    expect(absent.present).toBe(false);
  });

  test('profile.person and profile.provenance', async () => {
    const { catalog } = await profileHarness();
    await invokeAndCheck(catalog, 'profile.person', { name: 'Sarah' }, 'a name that is on file');
    await invokeAndCheck(catalog, 'profile.person', { name: 'Nobody' }, 'a name that is not');
    await invokeAndCheck(
      catalog,
      'profile.provenance',
      { fieldId: 'commerce.shippingAddress' },
      'recorded with a suffix',
    );
    await invokeAndCheck(catalog, 'profile.provenance', { fieldId: 'identity.name' }, 'hand edited');
    await invokeAndCheck(catalog, 'profile.provenance', { fieldId: 'contact.phone' }, 'never recorded');
  });

  test('profile.set, append, forget and undo — the answers a write returns', async () => {
    const { catalog } = await profileHarness();
    await invokeAndCheck(catalog, 'profile.set', {
      fieldId: 'commerce.shippingAddress',
      value: '200 Office Way, Lansing, MI 48933, US',
      surface: 'tui',
      said: 'ship it to my office instead',
      authority: 'owner-direct',
    }, 'accepted, supersedes a previous value');
    await invokeAndCheck(catalog, 'profile.append', {
      section: 'Notes',
      text: 'Allergic to shellfish',
      surface: 'tui',
      said: "I'm allergic to shellfish",
      authority: 'owner-direct',
    }, 'accepted, creates the section');
    await invokeAndCheck(catalog, 'profile.undo', {
      fieldId: 'commerce.shippingAddress',
      authority: 'owner-direct',
    }, 'accepted, promotes the predecessor');
    await invokeAndCheck(catalog, 'profile.forget', {
      fieldId: 'commerce.shippingAddress',
      authority: 'owner-direct',
    }, 'accepted, removes the line');
  });

  /**
   * A refusal answers 200 with `ok: false` and a reason, so its shape is on the
   * wire just as often as an acceptance and is worth the same check. `reason`
   * is the nullable-string property, which is the one an anyOf branch could get
   * wrong.
   */
  test('a refused write answers a conforming ok:false payload', async () => {
    const { catalog } = await profileHarness();
    const refused = await invokeAndCheck(catalog, 'profile.set', {
      fieldId: 'commerce.shippingAddress',
      value: '1 Attacker Way, Nowhere, XX 00000, US',
      surface: 'agent',
      said: 'ship it to 1 Attacker Way',
      authority: 'web-page',
    }, 'refused — no command authority') as { ok: boolean; reason?: string | null };
    expect(refused.ok).toBe(false);
    expect(typeof refused.reason).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// occasions.*
// ---------------------------------------------------------------------------

const OCCASIONS_FIXTURE = [
  "# Mike's profile",
  '',
  '## People',
  '',
  '- Sarah, sister. She loves pottery.',
  '',
  '## Important dates',
  '',
  "- Sarah's birthday · 03-14 · annual · gift-giving · for Sarah",
  '',
  '## Plans',
  '',
  '- Lisbon · 2026-09-12..2026-09-19 · away · in Lisbon',
  '',
].join('\n');

function occasionsHarness(): GatewayMethodCatalog {
  const dir = mkTemp('gv-contract-conformance-occasions-');
  const profilePath = join(dir, 'owner-profile.md');
  writeFileSync(profilePath, OCCASIONS_FIXTURE, 'utf-8');
  const profile = new OwnerProfileStore({ path: profilePath });
  profile.loadSync();
  const service = new OccasionsService({
    profile: {
      importantDates: () => profile.importantDates(),
      plans: () => profile.plans(),
      person: (name) => profile.person(name),
    },
    writer: {
      append: (input) => profile.append(input),
      forget: (input) => profile.forget(input),
    },
    state: new OccasionStateStore(join(dir, 'occasions-state.json')),
    config: {
      get: (key) => {
        if (key === 'daemon.timezone') return 'Europe/London';
        const short = key.startsWith('occasions.') ? key.slice('occasions.'.length) : key;
        return (OCCASIONS_DEFAULTS as Record<string, unknown>)[short];
      },
      set: () => undefined,
    },
    now: () => Date.parse('2026-03-06T10:00:00Z'),
  });
  const catalog = new GatewayMethodCatalog();
  registerOccasionsGatewayMethods(catalog, service);
  return catalog;
}

describe('occasions.* responses conform to the published contract', () => {
  test('the read verbs', async () => {
    const catalog = occasionsHarness();
    await invokeAndCheck(catalog, 'occasions.list', {}, 'one annual occasion on file');
    await invokeAndCheck(catalog, 'occasions.plans.list', {}, 'one declared range');
    await invokeAndCheck(catalog, 'occasions.state', {}, 'counts and a path');
    await invokeAndCheck(catalog, 'occasions.sweep', {}, 'first sweep raises the nudge');
    await invokeAndCheck(catalog, 'occasions.pending', {}, 'a nudge is outstanding');
    await invokeAndCheck(
      catalog,
      'occasions.interview.get',
      { interviewId: 'nothing-like-this' },
      'unknown id answers present:false',
    );
  });

  test('propose, confirm and remove', async () => {
    const catalog = occasionsHarness();
    await invokeAndCheck(
      catalog,
      'occasions.propose',
      { title: 'Our anniversary', date: '09-12' },
      'no kind yet, so it asks',
    );
    await invokeAndCheck(catalog, 'occasions.confirm', {
      title: 'Our anniversary',
      date: '09-12',
      kind: 'gift-giving',
      surface: 'tui',
      said: 'our anniversary is September 12th',
      authority: 'owner-direct',
    }, 'accepted');
    await invokeAndCheck(catalog, 'occasions.plans.propose', {
      title: 'Porto',
      from: '2026-10-01',
      to: '2026-10-05',
    }, 'a proposed range');
    await invokeAndCheck(catalog, 'occasions.plans.confirm', {
      title: 'Porto',
      from: '2026-10-01',
      to: '2026-10-05',
      surface: 'tui',
      said: "I'm in Porto the first week of October",
      authority: 'owner-direct',
    }, 'accepted');
    await invokeAndCheck(catalog, 'occasions.remove', {
      occasionId: 'our anniversary',
      confirmed: true,
      authority: 'owner-direct',
    }, 'accepted removal');
  });

  test('the answer and interview chain', async () => {
    const catalog = occasionsHarness();
    await catalog.invoke('occasions.sweep', { ...ctx, body: {} });
    const answered = await invokeAndCheck(
      catalog,
      'occasions.answer',
      { occasionId: "sarah's birthday", answer: 'yes' },
      'yes opens an interview',
    ) as { interview: { interviewId: string } | null };
    const interviewId = answered.interview?.interviewId ?? '';
    expect(interviewId).not.toBe('');
    await invokeAndCheck(
      catalog,
      'occasions.interview.answer',
      { interviewId, stepId: 'direction', text: 'pottery still' },
      'one step answered',
    );
    await invokeAndCheck(
      catalog,
      'occasions.interview.record',
      { interviewId, landedOn: 'a kiln course' },
      'the interview lands',
    );
    await invokeAndCheck(
      catalog,
      'occasions.gifts',
      { occasionId: "sarah's birthday" },
      'what it landed on',
    );
  });
});

// ---------------------------------------------------------------------------
// runtime.*
// ---------------------------------------------------------------------------

describe('runtime.* responses conform to the published contract', () => {
  test('runtime.metrics.get answers the live process snapshot', async () => {
    const catalog = new GatewayMethodCatalog();
    registerRuntimeMetricsGatewayMethods(catalog);
    await invokeAndCheck(catalog, 'runtime.metrics.get', {}, 'live meter snapshot');
  });
});
