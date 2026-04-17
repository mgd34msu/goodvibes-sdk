/**
 * normalize.ts — Shared normalization helpers for sync-sdk-internals.ts and sync-check.ts.
 *
 * Both scripts must apply identical import-specifier rewrites. Centralising here
 * prevents the two scripts from drifting in their transformation logic.
 */

import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..', '..');
const TARGET_ROOT = resolve(SDK_ROOT, 'packages/sdk/src/_internal');

export const SPECIFIER_TARGETS = new Map([
  ['@pellux/goodvibes-contracts/node', resolve(TARGET_ROOT, 'contracts/node.ts')],
  ['@pellux/goodvibes-contracts', resolve(TARGET_ROOT, 'contracts/index.ts')],
  ['@pellux/goodvibes-errors', resolve(TARGET_ROOT, 'errors/index.ts')],
  ['@pellux/goodvibes-daemon-sdk', resolve(TARGET_ROOT, 'daemon/index.ts')],
  ['@pellux/goodvibes-transport-core', resolve(TARGET_ROOT, 'transport-core/index.ts')],
  ['@pellux/goodvibes-transport-direct', resolve(TARGET_ROOT, 'transport-direct/index.ts')],
  ['@pellux/goodvibes-transport-http', resolve(TARGET_ROOT, 'transport-http/index.ts')],
  ['@pellux/goodvibes-transport-realtime', resolve(TARGET_ROOT, 'transport-realtime/index.ts')],
  ['@pellux/goodvibes-operator-sdk', resolve(TARGET_ROOT, 'operator/index.ts')],
  ['@pellux/goodvibes-peer-sdk', resolve(TARGET_ROOT, 'peer/index.ts')],
]);

export function toImportPath(fromFile: string, toFile: string): string {
  const raw = relative(dirname(fromFile), toFile).replaceAll('\\', '/');
  return raw.startsWith('.') ? raw : `./${raw}`;
}

export function rewriteRelativeTsSpecifiers(content: string): string {
  return content
    .replaceAll(
      /((?:from|import)\s*['"](?:\.\.?\/[^'"]+))\.ts(['"])/g,
      '$1.js$2',
    )
    .replaceAll(
      /(['"])(\.\.?\/[^'"]+)\.ts\1/g,
      '$1$2.js$1',
    );
}

/**
 * Rewrite package import specifiers to relative paths pointing at the mirror
 * location inside packages/sdk/src/_internal/.
 *
 * The contracts/node.ts special case: when the target file IS contracts/node.ts,
 * artifact imports that the sync script places at '../artifacts/' must be
 * rewritten to './artifacts/' (relative to the target, not source).
 */
export function rewritePackageSpecifiers(content: string, targetPath: string): string {
  let next = content;
  for (const [specifier, targetSourcePath] of SPECIFIER_TARGETS.entries()) {
    const importPath = toImportPath(targetPath, targetSourcePath).replace(/\.ts$/, '.js');
    next = next.replaceAll(`'${specifier}'`, `'${importPath}'`);
    next = next.replaceAll(`"${specifier}"`, `"${importPath}"`);
  }
  // contracts/node.ts references artifact files that live alongside it.
  // The sync script rewrites '../artifacts/' → './artifacts/' for this file.
  if (targetPath.endsWith('/contracts/node.ts')) {
    next = next.replaceAll('../artifacts/', './artifacts/');
  }
  return next;
}
