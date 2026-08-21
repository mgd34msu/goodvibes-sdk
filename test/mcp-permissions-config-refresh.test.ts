/**
 * McpPermissionManager: a re-registration carrying a fresh profile refreshes
 * the stored security record.
 *
 * Every (re)connect calls registerServer() with the profile derived from the
 * server's current config. The method used to return early whenever the name
 * was already known, so an in-place config edit (re-adding the same server
 * with new allowedPaths / allowedHosts) left the first insert's profile in
 * place forever, listServerSecurity() then reported the old values and the
 * edit looked like it had never landed, even though the reload reported the
 * server as changed.
 */
import { describe, expect, test } from 'bun:test';
import { McpPermissionManager } from '../packages/sdk/src/platform/runtime/mcp/permissions.js';

function register(
  manager: McpPermissionManager,
  profile: Partial<Parameters<McpPermissionManager['registerServer']>[2]>,
): void {
  manager.registerServer('files', 'standard', profile as never);
}

describe('McpPermissionManager.registerServer — config refresh', () => {
  test('a re-registration with a new profile replaces the stored profile', () => {
    const manager = new McpPermissionManager();
    register(manager, { role: 'general', mode: 'ask-on-risk', allowedPaths: [], allowedHosts: ['a.example'] });

    register(manager, {
      role: 'general',
      mode: 'ask-on-risk',
      allowedPaths: ['/tmp'],
      allowedHosts: ['a.example', 'b.example'],
    });

    const profile = manager.getServerPermissions('files')?.profile;
    expect(profile?.allowedPaths).toEqual(['/tmp']);
    expect(profile?.allowedHosts).toEqual(['a.example', 'b.example']);
  });

  test('clearing a list in config clears it in the stored profile', () => {
    const manager = new McpPermissionManager();
    register(manager, { allowedPaths: ['/tmp'], allowedHosts: ['a.example'] });
    register(manager, { allowedPaths: [], allowedHosts: [] });

    const profile = manager.getServerPermissions('files')?.profile;
    expect(profile?.allowedPaths).toEqual([]);
    expect(profile?.allowedHosts).toEqual([]);
  });

  test('role and mode follow the refreshed config', () => {
    const manager = new McpPermissionManager();
    register(manager, { role: 'general', mode: 'ask-on-risk' });
    register(manager, { role: 'filesystem', mode: 'allow-all' });

    const profile = manager.getServerPermissions('files')?.profile;
    expect(profile?.role).toBe('filesystem');
    expect(profile?.mode).toBe('allow-all');
  });

  test('a runtime trust level survives a config refresh', () => {
    const manager = new McpPermissionManager();
    register(manager, { allowedPaths: [] });
    manager.setTrustLevel('files', 'trusted');

    register(manager, { allowedPaths: ['/tmp'] });

    expect(manager.getTrustLevel('files')).toBe('trusted');
    expect(manager.getServerPermissions('files')?.profile.allowedPaths).toEqual(['/tmp']);
  });

  test('per-tool overrides survive a config refresh', () => {
    const manager = new McpPermissionManager();
    register(manager, { allowedPaths: [] });
    manager.denyTool('files', 'delete_file');

    register(manager, { allowedPaths: ['/tmp'] });

    expect(manager.isToolAllowed('files', 'delete_file').allowed).toBe(false);
    expect(manager.getServerPermissions('files')?.profile.allowedPaths).toEqual(['/tmp']);
  });

  test('a re-registration without a profile leaves the stored profile alone', () => {
    const manager = new McpPermissionManager();
    register(manager, { allowedPaths: ['/tmp'], allowedHosts: ['a.example'] });

    manager.registerServer('files', 'standard');

    const profile = manager.getServerPermissions('files')?.profile;
    expect(profile?.allowedPaths).toEqual(['/tmp']);
    expect(profile?.allowedHosts).toEqual(['a.example']);
  });
});
