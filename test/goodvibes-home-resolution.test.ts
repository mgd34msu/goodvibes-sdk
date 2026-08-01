/**
 * goodvibes-home-resolution.test.ts
 *
 * `GOODVIBES_HOME` names the tree ROOT and `GOODVIBES_DAEMON_HOME` names only
 * the daemon's identity directory. Every surface resolves both through this
 * one module, so a process told to run out of a throwaway tree cannot reach
 * the real one — the incident that produced the module was a client entry
 * point that ignored the redirect and wrote two throwaway credentials into the
 * owner's live daemon-tier secret store.
 *
 * Every case here passes `env` explicitly, so nothing mutates the environment
 * of the process running the suite.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  hasOverriddenGoodVibesHome,
  resolveGoodVibesDaemonHome,
  resolveGoodVibesHome,
  resolveGoodVibesHomeOwnership,
  resolveGoodVibesTreeDirectory,
} from '../packages/sdk/src/platform/config/goodvibes-home.ts';

describe('the tree root every surface shares', () => {
  test('an unset, blank, or whitespace value means the login home, never the filesystem root', () => {
    expect(resolveGoodVibesHome({ HOME: '/tmp/login-home-fixture' })).toBe('/tmp/login-home-fixture');
    expect(resolveGoodVibesHome({ HOME: '/tmp/login-home-fixture', GOODVIBES_HOME: '' })).toBe('/tmp/login-home-fixture');
    expect(resolveGoodVibesHome({ HOME: '/tmp/login-home-fixture', GOODVIBES_HOME: '   ' })).toBe('/tmp/login-home-fixture');
  });

  test('an absolute override is used as given', () => {
    expect(resolveGoodVibesHome({ HOME: '/tmp/login', GOODVIBES_HOME: '/tmp/tree' })).toBe('/tmp/tree');
  });

  test('a relative override resolves against the working directory rather than being used as-is', () => {
    const resolved = resolveGoodVibesHome({ HOME: '/tmp/login-home-fixture', GOODVIBES_HOME: 'sandbox-home' });
    expect(resolved).toBe(join(process.cwd(), 'sandbox-home'));
  });
});

describe('the daemon identity directory', () => {
  test('falls under an overridden tree root unless named separately', () => {
    const under = resolveGoodVibesHomeOwnership({ HOME: '/tmp/login', GOODVIBES_HOME: '/tmp/tree' });
    expect(under.homeDirectory).toBe('/tmp/tree');
    expect(under.daemonHomeDirectory).toBe(join('/tmp/tree', '.goodvibes', 'daemon'));
  });

  test('naming it does not move the tree with it', () => {
    const named = resolveGoodVibesHomeOwnership({
      HOME: '/tmp/login',
      GOODVIBES_HOME: '/tmp/tree',
      GOODVIBES_DAEMON_HOME: '/tmp/identity',
    });
    expect(named.homeDirectory).toBe('/tmp/tree');
    expect(named.daemonHomeDirectory).toBe('/tmp/identity');
    expect(resolveGoodVibesDaemonHome('/tmp/tree', { GOODVIBES_DAEMON_HOME: '/tmp/identity' })).toBe('/tmp/identity');
  });

  test('a blank value falls back to the default under the given root', () => {
    expect(resolveGoodVibesDaemonHome('/tmp/tree', { GOODVIBES_DAEMON_HOME: '  ' }))
      .toBe(join('/tmp/tree', '.goodvibes', 'daemon'));
  });

  test('a relative value resolves against the working directory', () => {
    expect(resolveGoodVibesDaemonHome('/tmp/tree', { GOODVIBES_DAEMON_HOME: 'identity-dir' }))
      .toBe(join(process.cwd(), 'identity-dir'));
  });
});

describe('GOODVIBES_HOME has exactly one meaning', () => {
  test('it names the tree root, and the .goodvibes directory is derived from it', () => {
    expect(resolveGoodVibesTreeDirectory({ HOME: '/tmp/login', GOODVIBES_HOME: '/tmp/tree' }))
      .toBe(join('/tmp/tree', '.goodvibes'));
  });

  test('with the variable unset the derived tree is ~/.goodvibes', () => {
    expect(resolveGoodVibesTreeDirectory({ HOME: '/tmp/login' })).toBe(join('/tmp/login', '.goodvibes'));
  });
});

describe('"is this process relocated"', () => {
  test('is false for no override and for blank overrides', () => {
    expect(hasOverriddenGoodVibesHome({ HOME: '/tmp/login' })).toBe(false);
    expect(hasOverriddenGoodVibesHome({ HOME: '/tmp/login', GOODVIBES_HOME: '' })).toBe(false);
    expect(hasOverriddenGoodVibesHome({ HOME: '/tmp/login', GOODVIBES_DAEMON_HOME: '   ' })).toBe(false);
  });

  test('is true when either variable names somewhere', () => {
    expect(hasOverriddenGoodVibesHome({ GOODVIBES_HOME: '/tmp/tree' })).toBe(true);
    expect(hasOverriddenGoodVibesHome({ GOODVIBES_DAEMON_HOME: '/tmp/identity' })).toBe(true);
  });

  test('agrees with the ownership record, which is what callers read', () => {
    for (const env of [
      { HOME: '/tmp/login' },
      { HOME: '/tmp/login', GOODVIBES_HOME: '' },
      { HOME: '/tmp/login', GOODVIBES_HOME: '/tmp/tree' },
      { HOME: '/tmp/login', GOODVIBES_DAEMON_HOME: '/tmp/identity' },
    ]) {
      expect(resolveGoodVibesHomeOwnership(env).isOverridden).toBe(hasOverriddenGoodVibesHome(env));
    }
  });
});
