/**
 * Coverage-gap smoke test — platform/discovery
 * Verifies that the scanner and mcp-scanner modules load and export their
 * primary symbols without throwing at import time.
 * Closes coverage gap: platform/discovery (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import {
  scan,
  scanHosts,
  scanLocalhost,
  loadPersistedProviders,
} from '../packages/sdk/src/platform/discovery/scanner.js';
import {
  scanMcpServers,
} from '../packages/sdk/src/platform/discovery/mcp-scanner.js';

describe('platform/discovery — module load smoke', () => {
  test('scan is a function', () => {
    expect(typeof scan).toBe('function');
  });

  test('scanHosts is a function', () => {
    expect(typeof scanHosts).toBe('function');
  });

  test('scanLocalhost is a function', () => {
    expect(typeof scanLocalhost).toBe('function');
  });

  test('loadPersistedProviders is a function', () => {
    expect(typeof loadPersistedProviders).toBe('function');
  });

  test('scanMcpServers is a function', () => {
    expect(typeof scanMcpServers).toBe('function');
  });
});
