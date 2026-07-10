#!/usr/bin/env bun
/**
 * plugin-bundle.ts — capability-bundle CLI (init / validate).
 *
 * Backed entirely by the exported library functions in
 * packages/sdk/src/platform/runtime/ecosystem/*, so the CLI is a thin argv
 * front-end and every behavior it exposes is also callable programmatically.
 *
 * Usage:
 *   bun scripts/plugin-bundle.ts init --id my-bundle [--kind plugin] [--out bundle.json]
 *   bun scripts/plugin-bundle.ts validate --manifest bundle.json
 *   bun scripts/plugin-bundle.ts validate --index marketplace.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  scaffoldCapabilityBundleManifest,
  validateCapabilityBundleManifest,
  summarizeBundleCapabilities,
  type CapabilityBundleManifest,
} from '../packages/sdk/src/platform/runtime/ecosystem/bundle-manifest.ts';
import { parseMarketplaceIndex } from '../packages/sdk/src/platform/runtime/ecosystem/marketplace-index.ts';

function flag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function fail(message: string): never {
  console.error(`[plugin-bundle] ${message}`);
  process.exit(1);
}

function runInit(args: string[]): void {
  const id = flag(args, 'id');
  if (!id) fail('init requires --id <bundle-id>');
  const kind = (flag(args, 'kind') ?? 'plugin') as CapabilityBundleManifest['kind'];
  if (!['plugin', 'skill', 'hook-pack', 'policy-pack'].includes(kind)) {
    fail(`init: unknown --kind '${kind}'`);
  }
  const out = flag(args, 'out') ?? 'bundle.json';
  const manifest = scaffoldCapabilityBundleManifest(id as string, kind);
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  console.log(`[plugin-bundle] wrote ${kind} manifest scaffold: ${out}`);
}

function runValidate(args: string[]): void {
  const manifestPath = flag(args, 'manifest');
  const indexPath = flag(args, 'index');
  if (!manifestPath && !indexPath) fail('validate requires --manifest <path> or --index <path>');

  let failed = false;

  if (manifestPath) {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const result = validateCapabilityBundleManifest(parsed);
    if (!result.ok) {
      failed = true;
      console.error(`[plugin-bundle] manifest INVALID (${manifestPath}):`);
      for (const err of result.errors) console.error(`  - ${err}`);
    } else {
      const s = summarizeBundleCapabilities(result.manifest);
      console.log(
        `[plugin-bundle] manifest OK: ${result.manifest.id}@${result.manifest.version} ` +
          `(${result.manifest.kind}) — runtime[${s.runtime.join(', ') || 'none'}], ` +
          `tools:${s.toolCount} hooks:${s.hookCount} config:${s.configDomainCount} ` +
          `channels:${s.channelCount}${s.highRisk ? ' — HIGH-RISK' : ''}`,
      );
    }
  }

  if (indexPath) {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8'));
    const result = parseMarketplaceIndex(parsed);
    if (!result.ok) {
      failed = true;
      console.error(`[plugin-bundle] marketplace index INVALID (${indexPath}):`);
      for (const err of result.errors) console.error(`  - ${err}`);
    } else {
      console.log(`[plugin-bundle] marketplace index OK: ${result.index.bundles.length} pinned bundle(s)`);
    }
  }

  if (failed) process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'init':
    runInit(rest);
    break;
  case 'validate':
    runValidate(rest);
    break;
  default:
    fail(`unknown command '${command ?? ''}' — use 'init' or 'validate'`);
}
