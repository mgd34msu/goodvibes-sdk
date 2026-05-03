import { describe, expect, test } from 'bun:test';
import { PermissionResolver } from '../packages/sdk/src/client-auth/permission-resolver.js';
import type { ControlPlaneAuthSnapshot } from '../packages/sdk/src/client-auth/control-plane-auth-snapshot.js';

function makeSnapshot(overrides: Partial<ControlPlaneAuthSnapshot> = {}): ControlPlaneAuthSnapshot {
  return {
    authenticated: true,
    authMode: 'session',
    tokenPresent: true,
    authorizationHeaderPresent: true,
    sessionCookiePresent: false,
    principalId: 'user-1',
    principalKind: 'user',
    admin: false,
    scopes: ['read', 'write'],
    roles: ['editor'],
    ...overrides,
  };
}

describe('PermissionResolver', () => {
  test('authenticated reflects snapshot', () => {
    const r = new PermissionResolver(makeSnapshot({ authenticated: true }));
    expect(r.authenticated).toBe(true);

    const r2 = new PermissionResolver(makeSnapshot({ authenticated: false }));
    expect(r2.authenticated).toBe(false);
  });

  test('isAdmin reflects admin flag', () => {
    expect(new PermissionResolver(makeSnapshot({ admin: true })).isAdmin).toBe(true);
    expect(new PermissionResolver(makeSnapshot({ admin: false })).isAdmin).toBe(false);
  });

  test('principalId returns snapshot principalId', () => {
    const r = new PermissionResolver(makeSnapshot({ principalId: 'bot-99' }));
    expect(r.principalId).toBe('bot-99');
  });

  test('principalId is null when anonymous', () => {
    const r = new PermissionResolver(makeSnapshot({ principalId: null }));
    expect(r.principalId).toBeNull();
  });

  test('principalKind reflects snapshot', () => {
    const r = new PermissionResolver(makeSnapshot({ principalKind: 'bot' }));
    expect(r.principalKind).toBe('bot');
  });

  describe('hasRole', () => {
    test('returns true for held role', () => {
      const r = new PermissionResolver(makeSnapshot({ roles: ['editor', 'viewer'] }));
      expect(r.hasRole('editor')).toBe(true);
    });
    test('returns false for absent role', () => {
      const r = new PermissionResolver(makeSnapshot({ roles: ['viewer'] }));
      expect(r.hasRole('admin')).toBe(false);
    });
  });

  describe('hasAllRoles', () => {
    test('returns true when all roles held', () => {
      const r = new PermissionResolver(makeSnapshot({ roles: ['a', 'b', 'c'] }));
      expect(r.hasAllRoles(['a', 'b'])).toBe(true);
    });
    test('returns false when any role missing', () => {
      const r = new PermissionResolver(makeSnapshot({ roles: ['a'] }));
      expect(r.hasAllRoles(['a', 'b'])).toBe(false);
    });
    test('returns true for empty array', () => {
      const r = new PermissionResolver(makeSnapshot({ roles: [] }));
      expect(r.hasAllRoles([])).toBe(true);
    });
  });

  describe('hasAnyRole', () => {
    test('returns true when at least one role held', () => {
      const r = new PermissionResolver(makeSnapshot({ roles: ['viewer'] }));
      expect(r.hasAnyRole(['admin', 'viewer'])).toBe(true);
    });
    test('returns false when no roles held', () => {
      const r = new PermissionResolver(makeSnapshot({ roles: [] }));
      expect(r.hasAnyRole(['admin', 'editor'])).toBe(false);
    });
  });

  describe('hasScope', () => {
    test('returns true for held scope', () => {
      const r = new PermissionResolver(makeSnapshot({ scopes: ['read', 'write'] }));
      expect(r.hasScope('read')).toBe(true);
    });
    test('returns false for absent scope', () => {
      const r = new PermissionResolver(makeSnapshot({ scopes: ['read'] }));
      expect(r.hasScope('delete')).toBe(false);
    });
  });

  describe('hasAllScopes', () => {
    test('returns true when all scopes held', () => {
      const r = new PermissionResolver(makeSnapshot({ scopes: ['read', 'write', 'delete'] }));
      expect(r.hasAllScopes(['read', 'write'])).toBe(true);
    });
    test('returns false when any scope missing', () => {
      const r = new PermissionResolver(makeSnapshot({ scopes: ['read'] }));
      expect(r.hasAllScopes(['read', 'write'])).toBe(false);
    });
  });

  describe('hasAnyScope', () => {
    test('returns true when at least one scope held', () => {
      const r = new PermissionResolver(makeSnapshot({ scopes: ['write'] }));
      expect(r.hasAnyScope(['read', 'write'])).toBe(true);
    });
    test('returns false when no scopes held', () => {
      const r = new PermissionResolver(makeSnapshot({ scopes: [] }));
      expect(r.hasAnyScope(['read', 'write'])).toBe(false);
    });
  });

  test('snapshot accessor returns the raw snapshot', () => {
    const snap = makeSnapshot();
    const r = new PermissionResolver(snap);
    expect(r.snapshot).toBe(snap);
  });
});
