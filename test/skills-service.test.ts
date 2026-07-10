/**
 * skills-service.test.ts
 *
 * The canonical skill model + service hoisted into the SDK: frontmatter
 * parse/serialize, progressive disclosure (cheap index line vs full body), and
 * CRUD with honest absence, proven over both the in-memory and filesystem
 * stores.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSystemSkillStore,
  InMemorySkillStore,
  SkillService,
  SkillServiceError,
  parseSkill,
  parseSkillIndex,
  serializeSkill,
  isValidSkillName,
} from '../packages/sdk/src/platform/skills/index.ts';

describe('skill model', () => {
  const doc = [
    '---',
    'name: greet',
    'description: Greet the user warmly',
    'tags: [social, onboarding]',
    '---',
    '# Greeting',
    '',
    'Say hello.',
  ].join('\n');

  test('parseSkillIndex reads only the frontmatter, never the body', () => {
    const index = parseSkillIndex(doc, 123);
    expect(index.name).toBe('greet');
    expect(index.description).toBe('Greet the user warmly');
    expect(index.metadata.tags).toEqual(['social', 'onboarding']);
    expect(index.updatedAt).toBe(123);
    // Progressive disclosure: the index type carries no body field at all.
    expect('body' in index).toBe(false);
  });

  test('parseSkill reads the full document including the body', () => {
    const skill = parseSkill(doc);
    expect(skill.name).toBe('greet');
    expect(skill.body).toBe('# Greeting\n\nSay hello.');
  });

  test('serialize -> parse round-trips name, description, metadata, and body', () => {
    const skill = parseSkill(doc);
    const round = parseSkill(serializeSkill(skill));
    expect(round.name).toBe(skill.name);
    expect(round.description).toBe(skill.description);
    expect(round.metadata).toEqual(skill.metadata);
    expect(round.body).toBe(skill.body);
  });

  test('name validation rejects unsafe slugs', () => {
    expect(isValidSkillName('good-name_1')).toBe(true);
    expect(isValidSkillName('../escape')).toBe(false);
    expect(isValidSkillName('with space')).toBe(false);
    expect(isValidSkillName('')).toBe(false);
  });
});

function runServiceContract(name: string, makeService: () => SkillService): void {
  describe(`SkillService over ${name}`, () => {
    test('create then get returns the full skill; list omits the body', async () => {
      const service = makeService();
      await service.create({ name: 'alpha', description: 'first', body: 'body A', metadata: { area: 'x' } });
      const got = await service.get('alpha');
      expect(got.body).toBe('body A');
      expect(got.metadata.area).toBe('x');
      const list = await service.list();
      expect(list.map((s) => s.name)).toContain('alpha');
      expect(list.every((entry) => !('body' in entry))).toBe(true);
    });

    test('create is a conflict when the name is taken', async () => {
      const service = makeService();
      await service.create({ name: 'dup', description: 'one', body: '' });
      const error = await service.create({ name: 'dup', description: 'two', body: '' }).catch((e) => e);
      expect(error).toBeInstanceOf(SkillServiceError);
      expect((error as SkillServiceError).code).toBe('ALREADY_EXISTS');
    });

    test('get / update / delete are honest about absence', async () => {
      const service = makeService();
      const getMiss = await service.get('ghost').catch((e) => e);
      expect((getMiss as SkillServiceError).code).toBe('NOT_FOUND');
      const updateMiss = await service.update('ghost', { body: 'x' }).catch((e) => e);
      expect((updateMiss as SkillServiceError).code).toBe('NOT_FOUND');
      const del = await service.delete('ghost');
      expect(del).toEqual({ name: 'ghost', deleted: false });
    });

    test('update changes only the provided fields', async () => {
      const service = makeService();
      await service.create({ name: 'edit', description: 'old', body: 'old body', metadata: { k: 'v' } });
      const updated = await service.update('edit', { body: 'new body' });
      expect(updated.body).toBe('new body');
      expect(updated.description).toBe('old');
      expect(updated.metadata.k).toBe('v');
    });

    test('delete means delete', async () => {
      const service = makeService();
      await service.create({ name: 'gone', description: 'd', body: '' });
      expect(await service.delete('gone')).toEqual({ name: 'gone', deleted: true });
      const miss = await service.get('gone').catch((e) => e);
      expect((miss as SkillServiceError).code).toBe('NOT_FOUND');
    });

    test('invalid names are rejected before touching the store', async () => {
      const service = makeService();
      const error = await service.create({ name: '../evil', description: 'd', body: '' }).catch((e) => e);
      expect((error as SkillServiceError).code).toBe('INVALID_ARGUMENT');
    });
  });
}

runServiceContract('InMemorySkillStore', () => new SkillService(new InMemorySkillStore()));

describe('FileSystemSkillStore', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gv-skills-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('persists a skill as a Markdown document on disk', async () => {
    const store = new FileSystemSkillStore(dir);
    await store.put({ name: 'ondisk', description: 'persisted', body: 'hello', metadata: {} });
    const round = await store.get('ondisk');
    expect(round?.description).toBe('persisted');
    expect(round?.body).toBe('hello');
    expect(round?.updatedAt).toBeGreaterThan(0);
  });

  test('reads a hand-written skill file, index-only then full', async () => {
    writeFileSync(
      join(dir, 'manual.md'),
      '---\nname: manual\ndescription: hand written\n---\nManual body.\n',
      'utf8',
    );
    const store = new FileSystemSkillStore(dir);
    const index = await store.listIndex();
    expect(index.find((s) => s.name === 'manual')?.description).toBe('hand written');
    const full = await store.get('manual');
    expect(full?.body).toBe('Manual body.');
  });

  test('listIndex on a missing directory is an empty store, not an error', async () => {
    const store = new FileSystemSkillStore(join(dir, 'does-not-exist'));
    expect(await store.listIndex()).toEqual([]);
  });
});

runServiceContract('FileSystemSkillStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-skills-svc-'));
  return new SkillService(new FileSystemSkillStore(dir));
});
