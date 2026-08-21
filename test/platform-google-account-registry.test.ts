import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AgentAccountRegistry,
  ACCOUNT_REGISTRY_PATH_SEGMENTS,
  MAX_ACCOUNT_RECORDS,
} from '../packages/sdk/src/platform/google/account-registry.ts';
import { mintAddressFor } from '../packages/sdk/src/platform/google/signup-address.ts';

// ─────────────────────────────────────────────────────────────────────────────
// PERMANENT REGRESSION GUARDS.
//
// This registry is the only enumerable list of accounts the agent created in the
// owner's name. Two properties must never regress: the credential value never
// reaches this file, and a damaged file never makes the list unreadable, a
// corrupt registry is exactly when enumeration matters most.
// ─────────────────────────────────────────────────────────────────────────────

const SECRET_PASSWORD = 'password: hunter2-correct-horse';

interface Harness {
  readonly registry: AgentAccountRegistry;
  readonly storePath: string;
}

/**
 * The same patterns the surfaces use. Passed in rather than defaulted: the
 * registry deliberately has no built-in notion of what a credential looks
 * like, so that its answer and the calling surface's memory guard cannot
 * disagree about a value.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/i,
  /\b(?:password|passwd|api[_-]?key|token|secret)\s*[:=]\s*\S{6,}/i,
];

function containsSecretLikeText(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function tempRegistry(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-signup-'));
  const storePath = join(root, 'agent', ...ACCOUNT_REGISTRY_PATH_SEGMENTS);
  return {
    registry: new AgentAccountRegistry({ storePath, containsSecretLikeText }),
    storePath,
  };
}

/** Write raw store content, creating the store directory the registry would create. */
function seedStore(storePath: string, content: string): void {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, content, 'utf-8');
}

function validInput(overrides: Partial<Parameters<AgentAccountRegistry['record']>[0]> = {}) {
  return {
    serviceDomain: 'github.com',
    serviceUrl: 'https://github.com/signup',
    aliasAddress: 'mike+gv-github-com-k3n9x2p4@example.com',
    purpose: 'Publish the owner release notes',
    credentialSecretKey: 'signup/github.com/k3n9x2p4',
    now: new Date('2026-07-26T12:00:00.000Z'),
    ...overrides,
  };
}

describe('AgentAccountRegistry', () => {
  test('records an account and lists it back with a derived id', () => {
    const { registry } = tempRegistry();
    const account = registry.record(validInput());

    expect(account.id).toBe('github-com');
    expect(account.serviceDomain).toBe('github.com');
    expect(account.credentialSecretKey).toBe('signup/github.com/k3n9x2p4');
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('github-com')?.aliasAddress).toBe('mike+gv-github-com-k3n9x2p4@example.com');
  });

  test('never writes a credential value to the store file', () => {
    const { registry, storePath } = tempRegistry();
    const alias = mintAddressFor('mike@example.com', 'github.com', { nonce: 'k3n9x2p4' });
    registry.record(validInput({ aliasAddress: alias.address }));

    const onDisk = readFileSync(storePath, 'utf-8');
    expect(onDisk).toContain('signup/github.com/k3n9x2p4');
    expect(onDisk).not.toContain('hunter2');
    expect(onDisk).not.toContain('correct-horse');

    const parsed: unknown = JSON.parse(onDisk);
    const serialized = JSON.stringify(parsed);
    // The only credential-shaped field on a record is the secret-store KEY NAME.
    for (const forbidden of ['password', 'passphrase', 'credential"', 'credentialValue', 'secretValue']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(registry.list()[0] ?? {}).sort()).toEqual([
      'aliasAddress',
      'createdAt',
      'credentialSecretKey',
      'id',
      'purpose',
      'serviceDomain',
      'serviceUrl',
    ]);
  });

  test('refuses a credentialSecretKey that carries the credential instead of its key name', () => {
    const { registry } = tempRegistry();
    expect(() => registry.record(validInput({ credentialSecretKey: SECRET_PASSWORD }))).toThrow('key NAME');
  });

  test('refuses secret-looking text smuggled through the purpose field', () => {
    const { registry } = tempRegistry();
    expect(() => registry.record(validInput({ purpose: `signup account, ${SECRET_PASSWORD}` }))).toThrow('secret-looking');
  });

  test('survives a corrupt store file without throwing and stays writable', () => {
    const { registry, storePath } = tempRegistry();
    registry.record(validInput());
    writeFileSync(storePath, '{ this is not json at all', 'utf-8');

    expect(() => registry.list()).not.toThrow();
    expect(registry.list()).toHaveLength(0);
    expect(registry.snapshot().path).toBe(storePath);

    const recovered = registry.record(validInput());
    expect(recovered.id).toBe('github-com');
    expect(registry.list()).toHaveLength(1);
  });

  test('drops malformed records on read instead of failing the whole listing', () => {
    const { registry, storePath } = tempRegistry();
    registry.record(validInput());
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        accounts: [
          { id: 'good-com', serviceDomain: 'good.com', serviceUrl: 'https://good.com/signup', aliasAddress: 'a+gv-good-com-aaaaaaaa@example.com', purpose: 'kept', credentialSecretKey: 'signup/good.com/a', createdAt: '2026-07-26T12:00:00.000Z' },
          { id: 'no-url', serviceDomain: 'bad.com', serviceUrl: 'javascript:alert(1)', aliasAddress: 'a@example.com', purpose: 'dropped', credentialSecretKey: 'k', createdAt: '2026-07-26T12:00:00.000Z' },
          { id: 'no-domain', serviceUrl: 'https://bad.com', aliasAddress: 'a@example.com', purpose: 'dropped', credentialSecretKey: 'k', createdAt: '2026-07-26T12:00:00.000Z' },
          { id: 'no-date', serviceDomain: 'bad.com', serviceUrl: 'https://bad.com', aliasAddress: 'a@example.com', purpose: 'dropped', credentialSecretKey: 'k', createdAt: 'not-a-date' },
          'not even an object',
          null,
        ],
      }),
      'utf-8',
    );

    const snapshot = registry.snapshot();
    expect(snapshot.accounts.map((account) => account.id)).toEqual(['good-com']);
    expect(snapshot.droppedOnRead).toBe(5);
  });

  test('drops a stored record whose fields were hand-edited to hold a credential', () => {
    const { registry, storePath } = tempRegistry();
    seedStore(
      storePath,
      JSON.stringify({
        version: 1,
        accounts: [
          { id: 'leaky-com', serviceDomain: 'leaky.com', serviceUrl: 'https://leaky.com/signup', aliasAddress: 'a+gv-leaky-com-aaaaaaaa@example.com', purpose: `signup ${SECRET_PASSWORD}`, credentialSecretKey: 'signup/leaky.com/a', createdAt: '2026-07-26T12:00:00.000Z' },
        ],
      }),
    );

    expect(registry.list()).toHaveLength(0);
  });

  test('allocates distinct ids for two accounts at the same service', () => {
    const { registry } = tempRegistry();
    const first = registry.record(validInput());
    const second = registry.record(validInput({ aliasAddress: 'mike+gv-github-com-bbbbbbbb@example.com' }));
    expect(first.id).toBe('github-com');
    expect(second.id).toBe('github-com-2');
  });

  test('forgets a recorded account and refuses an unknown id', () => {
    const { registry } = tempRegistry();
    registry.record(validInput());
    expect(registry.forget('github-com').id).toBe('github-com');
    expect(registry.list()).toHaveLength(0);
    expect(() => registry.forget('github-com')).toThrow('Unknown account record');
  });

  test('sweeps records whose credential key no longer exists in the secret store', () => {
    const { registry } = tempRegistry();
    registry.record(validInput());
    registry.record(
      validInput({
        serviceDomain: 'orphan.com',
        serviceUrl: 'https://orphan.com/signup',
        aliasAddress: 'mike+gv-orphan-com-cccccccc@example.com',
        credentialSecretKey: 'signup/orphan.com/cccccccc',
      }),
    );

    const result = registry.sweep({ knownSecretKeys: ['signup/github.com/k3n9x2p4'] });
    expect(result.removed.map((account) => account.id)).toEqual(['orphan-com']);
    expect(result.remaining).toBe(1);
    expect(registry.list().map((account) => account.id)).toEqual(['github-com']);
  });

  test('sweeps records older than the requested maximum age', () => {
    const { registry } = tempRegistry();
    registry.record(validInput({ now: new Date('2026-01-01T00:00:00.000Z') }));
    registry.record(
      validInput({
        serviceDomain: 'fresh.com',
        serviceUrl: 'https://fresh.com/signup',
        aliasAddress: 'mike+gv-fresh-com-dddddddd@example.com',
        credentialSecretKey: 'signup/fresh.com/dddddddd',
        now: new Date('2026-07-25T00:00:00.000Z'),
      }),
    );

    const result = registry.sweep({ now: new Date('2026-07-26T00:00:00.000Z'), maxAgeDays: 30 });
    expect(result.removed.map((account) => account.id)).toEqual(['github-com']);
    expect(registry.list().map((account) => account.id)).toEqual(['fresh-com']);
  });

  test('compacts duplicate ids on a bare sweep without removing anything real', () => {
    const { registry, storePath } = tempRegistry();
    const entry = { id: 'dupe-com', serviceDomain: 'dupe.com', serviceUrl: 'https://dupe.com/signup', aliasAddress: 'a+gv-dupe-com-aaaaaaaa@example.com', purpose: 'kept', credentialSecretKey: 'signup/dupe.com/a', createdAt: '2026-07-26T12:00:00.000Z' };
    seedStore(storePath, JSON.stringify({ version: 1, accounts: [entry, entry] }));

    const result = registry.sweep();
    expect(result.removed).toHaveLength(0);
    expect(result.remaining).toBe(1);
    expect(registry.list()).toHaveLength(1);
  });

  test('refuses to grow past the record ceiling instead of silently discarding accounts', () => {
    const { registry, storePath } = tempRegistry();
    const accounts = Array.from({ length: MAX_ACCOUNT_RECORDS }, (_unused, index) => ({
      id: `svc${index}-com`,
      serviceDomain: `svc${index}.com`,
      serviceUrl: `https://svc${index}.com/signup`,
      aliasAddress: `mike+gv-svc${index}-com-aaaaaaaa@example.com`,
      purpose: 'bulk fixture',
      credentialSecretKey: `signup/svc${index}.com/a`,
      createdAt: '2026-07-26T12:00:00.000Z',
    }));
    seedStore(storePath, JSON.stringify({ version: 1, accounts }));

    expect(registry.list()).toHaveLength(MAX_ACCOUNT_RECORDS);
    expect(() => registry.record(validInput())).toThrow(`${MAX_ACCOUNT_RECORDS}-record limit`);
  });

  test('rejects an account record that is missing the signup URL or the alias address', () => {
    const { registry } = tempRegistry();
    expect(() => registry.record(validInput({ serviceUrl: 'not-a-url' }))).toThrow('http(s) URL');
    expect(() => registry.record(validInput({ aliasAddress: 'nope' }))).toThrow('alias address');
    expect(() => registry.record(validInput({ purpose: '   ' }))).toThrow('stated purpose');
    expect(() => registry.record(validInput({ serviceDomain: 'localhost' }))).toThrow('service domain');
  });

  test('reports an empty registry rather than failing when no store file exists yet', () => {
    const { registry, storePath } = tempRegistry();
    const snapshot = registry.snapshot();
    expect(snapshot.accounts).toHaveLength(0);
    expect(snapshot.droppedOnRead).toBe(0);
    expect(snapshot.path).toBe(storePath);
  });
});
