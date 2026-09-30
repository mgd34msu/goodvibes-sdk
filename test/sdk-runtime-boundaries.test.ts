import { readFileSync } from 'node:fs';
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
const SDK_PACKAGE_NAME = '@pellux/goodvibes-sdk';

function sdkExportKey(entrypoint: string): string {
  if (entrypoint === SDK_PACKAGE_NAME) return '.';
  return entrypoint.startsWith(`${SDK_PACKAGE_NAME}/`)
    ? `.${entrypoint.slice(SDK_PACKAGE_NAME.length)}`
    : entrypoint;
}

describe('SDK runtime boundaries and export map', () => {
  test('uses explicit platform exports without catch-all platform surfaces', () => {
    const packageJson = JSON.parse(readFileSync(SDK_PACKAGE_JSON, 'utf8')) as {
      readonly exports: Record<string, unknown>;
    };
    const exports = packageJson.exports;

    expect(exports['./platform/*']).toBeUndefined();
    expect(exports['./platform']).toBeUndefined();
    expect(exports['./platform/knowledge']).not.toBeUndefined(); // presence-only: export key existence
    expect(exports['./platform/knowledge/home-graph']).not.toBeUndefined(); // presence-only: export key existence
    expect(exports['./platform/node']).not.toBeUndefined(); // presence-only: export key existence
    expect(exports['./platform/node/runtime-boundary']).not.toBeUndefined(); // presence-only: export key existence
    expect(exports['./platform/runtime/sandbox/*']).toBeUndefined();
    expect(exports['./platform/runtime/settings/*']).toBeUndefined();
    for (const entrypoint of GOODVIBES_CLIENT_SAFE_ENTRYPOINTS) {
      expect(exports[sdkExportKey(entrypoint)]).not.toBeUndefined(); // presence-only: export key existence
    }
    for (const entrypoint of GOODVIBES_NODE_RUNTIME_ENTRYPOINTS) {
      expect(exports[sdkExportKey(entrypoint)]).not.toBeUndefined(); // presence-only: export key existence
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

    expect(clientCapabilities.map((capability) => capability.id)).toEqual(['remote-client']);
    expect(clientCapabilities.every((capability) => (
      !capability.requirements.includes('filesystem')
      && !capability.requirements.includes('child-process')
      && !capability.requirements.includes('local-database')
      && !capability.requirements.includes('native-module')
    ))).toBe(true);
    expect(GOODVIBES_RUNTIME_CAPABILITIES.some((capability) => capability.id === 'knowledge-system')).toBe(true);
  });

  test('node runtime boundary detects node-like and non-node-like runtimes', () => {
    const nodeRuntime = {
      process: { versions: { node: '22.0.0' }, release: { name: 'node' } },
    } as Parameters<typeof getNodeRuntimeBoundaryStatus>[0];
    const browserRuntime = {} as Parameters<typeof getNodeRuntimeBoundaryStatus>[0];
    // Bun: process present but process.versions.node is undefined
    const bunRuntime = {
      process: { versions: {}, release: { name: 'bun' } },
    } as Parameters<typeof getNodeRuntimeBoundaryStatus>[0];
    // Workerd: process present with a release.name of 'workerd'
    const workerdRuntime = {
      process: { versions: {}, release: { name: 'workerd' } },
    } as Parameters<typeof getNodeRuntimeBoundaryStatus>[0];
    const nodeStatus = getNodeRuntimeBoundaryStatus(nodeRuntime);
    const browserLikeStatus = getNodeRuntimeBoundaryStatus(browserRuntime);
    const bunStatus = getNodeRuntimeBoundaryStatus(bunRuntime);
    const workerdStatus = getNodeRuntimeBoundaryStatus(workerdRuntime);

    expect(nodeStatus.nodeLike).toBe(true);
    expect(nodeStatus.hasFilesystemAssumption).toBe(true);
    expect(isNodeLikeRuntime(nodeRuntime)).toBe(true);
    expect(browserLikeStatus.nodeLike).toBe(false);
    expect(browserLikeStatus.hasFilesystemAssumption).toBe(false);
    expect(isNodeLikeRuntime(browserRuntime)).toBe(false);
    // Bun and workerd with no node version should fall back to runtimeName = 'unknown' or their release name
    expect(isNodeLikeRuntime(bunRuntime)).toBe(false);
    expect(isNodeLikeRuntime(workerdRuntime)).toBe(false);
    expect(bunStatus.nodeLike).toBe(false);
    expect(workerdStatus.nodeLike).toBe(false);
  });
});
