import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  GOODVIBES_CLIENT_SAFE_ENTRYPOINTS,
  GOODVIBES_NODE_RUNTIME_ENTRYPOINTS,
  GOODVIBES_RUNTIME_CAPABILITIES,
  isClientSafeGoodVibesEntrypoint,
  isNodeRuntimeGoodVibesEntrypoint,
  listGoodVibesRuntimeCapabilities,
} from '../packages/sdk/src/platform/node/capabilities.js';
import {
  getNodeRuntimeBoundaryStatus,
  isNodeLikeRuntime,
} from '../packages/sdk/src/platform/node/runtime-boundary.js';

const SDK_PACKAGE_JSON = new URL('../packages/sdk/package.json', import.meta.url);

describe('SDK runtime boundaries and export map', () => {
  test('uses explicit platform exports instead of the old wildcard API surface', () => {
    const packageJson = JSON.parse(readFileSync(SDK_PACKAGE_JSON, 'utf8')) as {
      readonly exports: Record<string, unknown>;
    };
    const exports = packageJson.exports;

    expect(exports['./platform/*']).toBeUndefined();
    expect(exports['./platform']).toBeDefined();
    expect(exports['./platform/knowledge']).toBeDefined();
    expect(exports['./platform/knowledge/home-graph']).toBeDefined();
    expect(exports['./platform/node']).toBeDefined();
    expect(exports['./platform/node/runtime-boundary']).toBeDefined();
    for (const entrypoint of GOODVIBES_CLIENT_SAFE_ENTRYPOINTS) {
      const exportKey = entrypoint.replace('@pellux/goodvibes-sdk', '.') || '.';
      expect(exports[exportKey]).toBeDefined();
    }
    for (const entrypoint of GOODVIBES_NODE_RUNTIME_ENTRYPOINTS) {
      const exportKey = entrypoint.replace('@pellux/goodvibes-sdk', '.') || '.';
      expect(exports[exportKey]).toBeDefined();
    }
  });

  test('classifies client-safe and node runtime entrypoints without overlap', () => {
    for (const entrypoint of GOODVIBES_CLIENT_SAFE_ENTRYPOINTS) {
      expect(isClientSafeGoodVibesEntrypoint(entrypoint)).toBe(true);
      expect(isNodeRuntimeGoodVibesEntrypoint(entrypoint)).toBe(false);
    }
    for (const entrypoint of GOODVIBES_NODE_RUNTIME_ENTRYPOINTS) {
      expect(isNodeRuntimeGoodVibesEntrypoint(entrypoint)).toBe(true);
      expect(isClientSafeGoodVibesEntrypoint(entrypoint)).toBe(false);
    }
  });

  test('keeps client capabilities free of node-only requirements', () => {
    const clientCapabilities = listGoodVibesRuntimeCapabilities('client');

    expect(clientCapabilities.length).toBeGreaterThan(0);
    expect(clientCapabilities.every((capability) => (
      !capability.requirements.includes('filesystem')
      && !capability.requirements.includes('child-process')
      && !capability.requirements.includes('local-database')
      && !capability.requirements.includes('native-module')
    ))).toBe(true);
    expect(GOODVIBES_RUNTIME_CAPABILITIES.some((capability) => capability.id === 'knowledge-system')).toBe(true);
  });

  test('client-safe source entrypoints avoid node-only imports', () => {
    const clientFiles = [
      'browser.ts',
      'web.ts',
      'workers.ts',
      'react-native.ts',
      'expo.ts',
      'index.ts',
    ];
    const forbidden = /\bfrom ['"]node:|import\(['"]node:|platform\/node/;

    for (const file of clientFiles) {
      const source = readFileSync(join(new URL('../packages/sdk/src', import.meta.url).pathname, file), 'utf8');
      expect(source, `${file} should remain client-safe`).not.toMatch(forbidden);
    }
  });

  test('node runtime boundary detects node-like and non-node-like runtimes', () => {
    const nodeRuntime = {
      process: { versions: { node: '22.0.0' }, release: { name: 'node' } },
    } as Parameters<typeof getNodeRuntimeBoundaryStatus>[0];
    const browserRuntime = {} as Parameters<typeof getNodeRuntimeBoundaryStatus>[0];
    const nodeStatus = getNodeRuntimeBoundaryStatus(nodeRuntime);
    const browserLikeStatus = getNodeRuntimeBoundaryStatus(browserRuntime);

    expect(nodeStatus.nodeLike).toBe(true);
    expect(nodeStatus.hasFilesystemAssumption).toBe(true);
    expect(isNodeLikeRuntime(nodeRuntime)).toBe(true);
    expect(browserLikeStatus.nodeLike).toBe(false);
    expect(browserLikeStatus.hasFilesystemAssumption).toBe(false);
    expect(isNodeLikeRuntime(browserRuntime)).toBe(false);
  });
});
