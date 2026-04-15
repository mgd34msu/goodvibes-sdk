import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  installEcosystemCatalogEntry,
  loadEcosystemCatalog,
} from '../packages/sdk/dist/_internal/platform/runtime/ecosystem/catalog.js';

describe('ecosystem catalog paths', () => {
  const testTmpRoot = join(import.meta.dir, '.tmp-tests');
  let root = '';
  let homeDir = '';

  beforeEach(() => {
    mkdirSync(testTmpRoot, { recursive: true });
    root = mkdtempSync(join(testTmpRoot, 'ecosystem-paths-'));
    homeDir = join(root, 'home');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, '.goodvibes', 'tui', 'ecosystem'), { recursive: true });
    mkdirSync(join(root, 'catalog', 'plugins', 'deploy-audit'), { recursive: true });
  });

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('supports host-owned catalog roots without changing install destinations', () => {
    writeFileSync(
      join(root, 'catalog', 'plugins', 'deploy-audit', 'manifest.json'),
      JSON.stringify({
        name: 'deploy-audit',
        version: '1.0.0',
        description: 'Reviews deploy surfaces before release',
      }, null, 2),
    );
    writeFileSync(
      join(root, 'catalog', 'plugins', 'deploy-audit', 'index.ts'),
      'export function init() {}\n',
    );
    writeFileSync(
      join(root, '.goodvibes', 'tui', 'ecosystem', 'plugins.json'),
      JSON.stringify({
        version: 1,
        entries: [{
          id: 'deploy-audit',
          kind: 'plugin',
          name: 'Deploy Audit',
          summary: 'Reviews deploy surfaces before release',
          source: './catalog/plugins/deploy-audit',
          tags: ['security'],
        }],
      }, null, 2),
    );

    const options = {
      cwd: root,
      homeDir,
      projectCatalogRoot: join(root, '.goodvibes', 'tui', 'ecosystem'),
      userCatalogRoot: join(homeDir, '.goodvibes', 'tui', 'ecosystem'),
    } as const;

    const entries = loadEcosystemCatalog('plugin', options);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('deploy-audit');

    const installed = installEcosystemCatalogEntry('plugin', 'deploy-audit', {
      ...options,
      scope: 'project',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) {
      return;
    }

    expect(existsSync(join(root, '.goodvibes', 'plugins', 'deploy-audit', 'manifest.json'))).toBe(true);
    expect(readFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'installed', 'plugin-deploy-audit.json'), 'utf-8'))
      .toContain('"scope": "project"');
  });
});
