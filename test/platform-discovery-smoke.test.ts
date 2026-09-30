/**
 * Coverage-gap smoke test, platform/discovery
 * Verifies that the scanner and mcp-scanner modules load, export their
 * primary symbols, and execute observable behavior via await.
 * Closes coverage gap: platform/discovery
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanHosts,
  loadPersistedProviders,
} from '../packages/sdk/src/platform/discovery/scanner.js';
import {
  scanMcpServers,
} from '../packages/sdk/src/platform/discovery/mcp-scanner.js';

describe('platform/discovery: behavior smoke', () => {
  test('loadPersistedProviders returns empty array for non-existent persist path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-discovery-test-'));
    try {
      const result = loadPersistedProviders({
        homeDirectory: tmp,
        surfaceRoot: 'gv-test-surface',
      });
      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('scanHosts([]) resolves with empty DiscoveredServer array for empty host list', async () => {
    // Empty host list, no probes, immediate resolution
    const result = await scanHosts([]);
    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBe(0);
  });

  test('scanMcpServers() resolves with McpDiscoveryResult shape (suggestions array, locationsScanned)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-mcp-scan-test-'));
    try {
      const result = await scanMcpServers({
        workingDirectory: tmp,
        homeDirectory: tmp,
        surfaceRoot: 'gv-test',
      });
      expect(result.suggestions).toBeInstanceOf(Array);
      expect(typeof result.locationsScanned).toBe('number');
      expect(result.locationsScanned).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
