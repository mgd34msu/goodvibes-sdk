import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getOperatorContractPath, getPeerContractPath } from '../packages/contracts/dist/node.js';

describe('contracts portability', () => {
  test('default browser-facing entries do not depend on node builtins', () => {
    const runtimeNeutralEntries = [
      'packages/contracts/dist/index.js',
      'packages/errors/dist/index.js',
      'packages/operator-sdk/dist/index.js',
      'packages/peer-sdk/dist/index.js',
      'packages/sdk/dist/index.js',
      'packages/sdk/dist/browser.js',
      'packages/sdk/dist/react-native.js',
      'packages/transport-core/dist/index.js',
      'packages/transport-http/dist/index.js',
      'packages/transport-realtime/dist/index.js',
    ];

    for (const entry of runtimeNeutralEntries) {
      const content = readFileSync(resolve(import.meta.dir, '..', entry), 'utf8');
      expect(content.includes("from 'node:")).toBe(false);
      expect(content.includes('from "node:')).toBe(false);
      expect(content.includes("require('node:")).toBe(false);
      expect(content.includes('require("node:')).toBe(false);
    }
  });

  test('node helpers still expose raw artifact paths', () => {
    expect(getOperatorContractPath()).toEndWith('/packages/contracts/artifacts/operator-contract.json');
    expect(getPeerContractPath()).toEndWith('/packages/contracts/artifacts/peer-contract.json');
  });
});
