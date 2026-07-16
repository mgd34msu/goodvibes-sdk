/**
 * Disk loader for toolchain.config. Kept separate from config.ts so the
 * contract types stay import-safe in environments without a filesystem.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { type ToolchainConfig, parseToolchainConfig } from '../config.js';

/** Load `toolchain.config.json` from a repo root. Throws if absent or invalid. */
export function loadToolchainConfig(root: string = process.cwd()): ToolchainConfig {
  const path = resolve(root, 'toolchain.config.json');
  if (!existsSync(path)) {
    throw new Error(`toolchain.config.json not found at ${path}. See @pellux/goodvibes-toolchain docs for the contract.`);
  }
  return parseToolchainConfig(readFileSync(path, 'utf8'));
}
