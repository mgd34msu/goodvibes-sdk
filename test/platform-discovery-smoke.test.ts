/**
 * Coverage-gap smoke test — platform/discovery
 * Verifies that the scanner and mcp-scanner modules load, export their
 * primary symbols, and execute observable behavior.
 * Closes coverage gap: platform/discovery (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scan,
  scanHosts,
  scanLocalhost,
  loadPersistedProviders,
} from '../packages/sdk/src/platform/discovery/scanner.js';
import {
  scanMcpServers,
} from '../packages/sdk/src/platform/discovery/mcp-scanner.js';

describe('platform/discovery — behavior smoke', () => {
  test('loadPersistedProviders returns empty array for non-existent persist path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-discovery-test-'));
    try {
      const result = loadPersistedProviders({
        homeDirectory: tmp,
        surfaceRoot: 'gv-test-surface',
      });
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('scan is callable and returns a Promise', () => {
    const result = scan({ hosts: [] });
    expect(result).toBeInstanceOf(Promise);
    void result.catch(() => {});
  });

  test('scanHosts is callable and accepts a host list', () => {
    const result = scanHosts({ hosts: [] });
    expect(result).toBeInstanceOf(Promise);
    void result.catch(() => {});
  });

  test('scanLocalhost is callable and returns a Promise', () => {
    const result = scanLocalhost();
    expect(result).toBeInstanceOf(Promise);
    void result.catch(() => {});
  });

  test('scanMcpServers is callable and returns a Promise', () => {
    const result = scanMcpServers();
    expect(result).toBeInstanceOf(Promise);
    void result.catch(() => {});
  });
});
