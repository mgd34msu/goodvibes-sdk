/**
 * skills-gateway-verbs.test.ts
 *
 * The skills.* CRUD gateway verbs, proven over a real GatewayMethodCatalog with
 * the handlers attached the same way the daemon attaches them
 * (registerSkillsGatewayMethods). This proves the descriptor and handler
 * register TOGETHER — a cataloged-but-unhandled verb would be an honest
 * NOT_INVOKABLE/501, which these invocations would surface.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerSkillsGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/skills.ts';
import { SkillService, InMemorySkillStore } from '../packages/sdk/src/platform/skills/index.ts';

function makeCatalog(): GatewayMethodCatalog {
  const catalog = new GatewayMethodCatalog();
  registerSkillsGatewayMethods(catalog, new SkillService(new InMemorySkillStore()));
  return catalog;
}

const ctx = { context: { admin: true } } as const;

describe('skills.* gateway verbs', () => {
  test('all five verbs are cataloged with handlers attached', () => {
    const catalog = makeCatalog();
    for (const id of ['skills.list', 'skills.get', 'skills.create', 'skills.update', 'skills.delete']) {
      expect(catalog.get(id)).not.toBeNull();
      expect(catalog.hasHandler(id)).toBe(true);
    }
  });

  test('create -> list -> get -> update -> delete round-trips through the catalog', async () => {
    const catalog = makeCatalog();

    const created = await catalog.invoke('skills.create', {
      ...ctx,
      body: { name: 'deploy', description: 'Deploy the app', body: '# Deploy\nRun it.', metadata: { area: 'ops' } },
    }) as { skill: { name: string; body: string } };
    expect(created.skill.name).toBe('deploy');

    const listed = await catalog.invoke('skills.list', { ...ctx, body: {} }) as { skills: { name: string }[] };
    expect(listed.skills.map((s) => s.name)).toEqual(['deploy']);
    // Progressive disclosure: the list entries carry no body.
    expect(listed.skills.every((s) => !('body' in s))).toBe(true);

    const got = await catalog.invoke('skills.get', { ...ctx, body: { name: 'deploy' } }) as { skill: { body: string } };
    expect(got.skill.body).toBe('# Deploy\nRun it.');

    const updated = await catalog.invoke('skills.update', {
      ...ctx,
      body: { name: 'deploy', description: 'Deploy it well' },
    }) as { skill: { description: string; body: string } };
    expect(updated.skill.description).toBe('Deploy it well');
    expect(updated.skill.body).toBe('# Deploy\nRun it.');

    const deleted = await catalog.invoke('skills.delete', { ...ctx, body: { name: 'deploy' } });
    expect(deleted).toEqual({ name: 'deploy', deleted: true });
  });

  test('get on a missing skill is a 404 GatewayVerbError', async () => {
    const catalog = makeCatalog();
    const error = await catalog.invoke('skills.get', { ...ctx, body: { name: 'ghost' } }).catch((e) => e);
    expect((error as { status?: number }).status).toBe(404);
  });

  test('duplicate create is a 409 conflict', async () => {
    const catalog = makeCatalog();
    await catalog.invoke('skills.create', { ...ctx, body: { name: 'dup', description: 'd', body: '' } });
    const error = await catalog
      .invoke('skills.create', { ...ctx, body: { name: 'dup', description: 'd2', body: '' } })
      .catch((e) => e);
    expect((error as { status?: number }).status).toBe(409);
  });

  test('delete of a missing skill is an honest { deleted: false }', async () => {
    const catalog = makeCatalog();
    const result = await catalog.invoke('skills.delete', { ...ctx, body: { name: 'nope' } });
    expect(result).toEqual({ name: 'nope', deleted: false });
  });
});
