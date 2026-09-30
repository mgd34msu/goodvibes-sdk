#!/usr/bin/env bun
/**
 * packed-daemon-smoke.ts, one scripted turn through a daemon composed from the
 * PACKED SDK.
 *
 * Packs every public workspace package exactly as publish would (the same path
 * as scripts/release-artifact-lane.ts), installs the tarballs into a scratch
 * consumer, and runs scripts/daemon-smoke-turn.mjs there under Bun: bootDaemon
 * from the installed @pellux/goodvibes-sdk, a custom provider pointed at a
 * scripted OpenAI-compatible endpoint, and one companion-chat turn over the
 * daemon's HTTP API. It fails when the packed daemon cannot boot, cannot reach
 * a provider, or cannot carry a reply back into a session.
 *
 * Usage:
 *   bun run smoke:daemon               pack + install + one turn (what CI runs)
 *   bun run smoke:daemon --workspace   the same turn against the workspace
 *                                      dist, no packing (run `bun run build` first)
 */

import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { installPackedWorkspace } from './release-artifact-lane.ts';
import { createSdkTempDir, run, SDK_ROOT } from './release-shared.ts';

const TURN_SCRIPT = resolve(SDK_ROOT, 'scripts', 'daemon-smoke-turn.mjs');

if (process.argv.includes('--workspace')) {
  run('bun', [TURN_SCRIPT], SDK_ROOT, { stdio: 'inherit' });
} else {
  const projectDir = createSdkTempDir('goodvibes-sdk-daemon-smoke-consumer-');
  let cleanup: (() => void) | null = null;
  try {
    writeFileSync(
      resolve(projectDir, 'package.json'),
      `${JSON.stringify({ name: 'goodvibes-sdk-daemon-smoke', private: true, type: 'module' }, null, 2)}\n`,
    );
    cleanup = await installPackedWorkspace(projectDir, 'daemon-smoke');
    copyFileSync(TURN_SCRIPT, resolve(projectDir, 'daemon-smoke-turn.mjs'));
    console.log('[daemon-smoke] running one scripted turn through the packed daemon...');
    run('bun', ['daemon-smoke-turn.mjs'], projectDir, { stdio: 'inherit' });
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    cleanup?.();
  }
}
