/**
 * worktree-setup-derivation.test.ts
 *
 * Worktree setup DERIVES from the repo: each ecosystem's lockfile yields its
 * install command, .env/.env.* files yield the carry-over globs, user config
 * OVERRIDES the derivation per field (never merely enables it), and a repo
 * with no signal at all derives nothing — setup stays an honest no-op.
 */
import { describe, expect, test } from 'bun:test';
import {
  deriveWorktreeSetup,
  resolveEffectiveWorktreeSetup,
  runWorktreeSetup,
  type DeriveSetupIo,
} from '../packages/sdk/src/platform/runtime/worktree/setup.ts';

function io(files: readonly string[]): DeriveSetupIo {
  const set = new Set(files.map((f) => `/repo/${f}`));
  return {
    fileExists: (path) => set.has(path),
    listDir: (path) => (path === '/repo' ? files.map((f) => f) : []),
  };
}

describe('deriveWorktreeSetup — lockfile → install command', () => {
  const cases: Array<[string, string]> = [
    ['bun.lock', 'bun install'],
    ['bun.lockb', 'bun install'],
    ['package-lock.json', 'npm ci'],
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn install --frozen-lockfile'],
    ['uv.lock', 'uv sync'],
    ['requirements.txt', 'pip install -r requirements.txt'],
    ['Cargo.lock', 'cargo fetch'],
    ['go.sum', 'go mod download'],
  ];
  for (const [lockfile, command] of cases) {
    test(`${lockfile} derives "${command}"`, () => {
      expect(deriveWorktreeSetup('/repo', io([lockfile])).commands).toEqual([command]);
    });
  }

  test('one install per ecosystem: bun.lock beats package-lock; uv.lock beats requirements', () => {
    const derived = deriveWorktreeSetup('/repo', io(['bun.lock', 'package-lock.json', 'uv.lock', 'requirements.txt']));
    expect(derived.commands).toEqual(['bun install', 'uv sync']);
  });

  test('a polyglot repo derives one install per ecosystem', () => {
    const derived = deriveWorktreeSetup('/repo', io(['bun.lock', 'Cargo.lock', 'go.sum']));
    expect(derived.commands).toEqual(['bun install', 'cargo fetch', 'go mod download']);
  });

  test('.env files derive the carry-over globs; none derive none', () => {
    expect(deriveWorktreeSetup('/repo', io(['bun.lock', '.env'])).carryOverGlobs).toEqual(['.env', '.env.*']);
    expect(deriveWorktreeSetup('/repo', io(['bun.lock', '.env.local'])).carryOverGlobs).toEqual(['.env', '.env.*']);
    expect(deriveWorktreeSetup('/repo', io(['bun.lock'])).carryOverGlobs).toEqual([]);
  });

  test('absence of any signal derives NOTHING', () => {
    const derived = deriveWorktreeSetup('/repo', io(['README.md', 'src']));
    expect(derived.commands).toEqual([]);
    expect(derived.carryOverGlobs).toEqual([]);
  });
});

describe('resolveEffectiveWorktreeSetup — user config OVERRIDES the derivation', () => {
  const repoIo = io(['bun.lock', '.env']);
  const get = (config: Record<string, unknown>) => (key: string) => config[key];

  test('no user config: the derivation applies (deps + env with zero configuration)', () => {
    const effective = resolveEffectiveWorktreeSetup(get({}), '/repo', repoIo);
    expect(effective.commands).toEqual(['bun install']);
    expect(effective.carryOverGlobs).toEqual(['.env', '.env.*']);
  });

  test('configured commands REPLACE the derived install; derived globs still apply', () => {
    const effective = resolveEffectiveWorktreeSetup(
      get({ 'worktree.setup.commands': ['make bootstrap'] }), '/repo', repoIo,
    );
    expect(effective.commands).toEqual(['make bootstrap']);
    expect(effective.carryOverGlobs).toEqual(['.env', '.env.*']);
  });

  test('configured globs REPLACE the derived env globs; derived commands still apply', () => {
    const effective = resolveEffectiveWorktreeSetup(
      get({ 'worktree.setup.carryOverGlobs': ['config/local.json'] }), '/repo', repoIo,
    );
    expect(effective.commands).toEqual(['bun install']);
    expect(effective.carryOverGlobs).toEqual(['config/local.json']);
  });

  test('fully configured: derivation is not consulted at all', () => {
    let derivationTouched = false;
    const spyIo: DeriveSetupIo = {
      fileExists: () => { derivationTouched = true; return false; },
      listDir: () => { derivationTouched = true; return []; },
    };
    const effective = resolveEffectiveWorktreeSetup(
      get({ 'worktree.setup.commands': ['make x'], 'worktree.setup.carryOverGlobs': ['.npmrc'] }), '/repo', spyIo,
    );
    expect(effective).toEqual({ commands: ['make x'], carryOverGlobs: ['.npmrc'] });
    expect(derivationTouched).toBe(false);
  });

  test('no signal + no config: runWorktreeSetup reports the honest skipped no-op', async () => {
    const effective = resolveEffectiveWorktreeSetup(get({}), '/repo', io(['README.md']));
    const result = await runWorktreeSetup('/tmp/never-used', '/repo', effective, {
      runCommand: async () => { throw new Error('must not run'); },
      listUntracked: async () => { throw new Error('must not list'); },
    });
    expect(result.state).toBe('skipped');
    expect(result.steps).toEqual([]);
  });
});
