import { describe, expect, spyOn, test, type Mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  loadPersistedProviders,
  persistProviders,
  removePersistedProviders,
  type DiscoveredServer,
} from '../packages/sdk/src/platform/discovery/scanner.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';

const surfaceRoot = 'gv-test-surface';

function roots(tmp: string): { homeDirectory: string; surfaceRoot: string } {
  return { homeDirectory: tmp, surfaceRoot };
}

function persistedPath(tmp: string): string {
  return join(tmp, '.goodvibes', surfaceRoot, 'discovered-providers.json');
}

function sampleServer(): DiscoveredServer {
  return {
    name: 'Local Test',
    host: '127.0.0.1',
    port: 1234,
    baseURL: 'http://127.0.0.1:1234/v1',
    models: ['test-model'],
    serverType: 'unknown',
  };
}

function warningMessages(warnSpy: Mock<typeof logger.warn>): string[] {
  return warnSpy.mock.calls.map((call) => String(call[0]));
}

describe('discovery persistence observability', () => {
  test('loadPersistedProviders warns when the discovery cache cannot be parsed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-discovery-observe-'));
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    try {
      const path = persistedPath(tmp);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{ bad json', 'utf-8');

      expect(loadPersistedProviders(roots(tmp))).toEqual([]);
      expect(warningMessages(warnSpy).some((message) => message.includes('loadPersistedProviders failed'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('persistProviders warns when the discovery cache cannot be written', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-discovery-observe-'));
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    try {
      mkdirSync(join(tmp, '.goodvibes'), { recursive: true });
      writeFileSync(join(tmp, '.goodvibes', surfaceRoot), 'not a directory', 'utf-8');

      expect(() => persistProviders(roots(tmp), [sampleServer()])).not.toThrow();
      expect(warningMessages(warnSpy).some((message) => message.includes('persistProviders failed'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('removePersistedProviders warns when the discovery cache cannot be parsed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-discovery-observe-'));
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    try {
      const path = persistedPath(tmp);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{ bad json', 'utf-8');

      expect(() => removePersistedProviders(roots(tmp), [{ host: '127.0.0.1', port: 1234 }])).not.toThrow();
      expect(warningMessages(warnSpy).some((message) => message.includes('removePersistedProviders failed'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
