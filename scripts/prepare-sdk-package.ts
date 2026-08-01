import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const SDK_DIST = resolve(SDK_ROOT, 'packages/sdk/dist');
const SOURCE_ARTIFACTS = resolve(
  SDK_ROOT,
  'packages/contracts/artifacts',
);
const DIST_ARTIFACTS = resolve(
  SDK_DIST,
  'contracts/artifacts',
);

/**
 * Plain JavaScript that must reach dist unchanged.
 *
 * `browser-host.mjs` is the Node process platform/browser spawns to attach to a
 * browser over CDP — Bun's node:http client never raises the upgrade event for
 * a 101 response, so the handshake has to happen in real Node. tsc only emits
 * what it compiles, so a hand-written .mjs asset would exist in src and be
 * absent from the published package, and every attach would fail with "the
 * browser host script is missing". Copying it here, after the build, puts it
 * exactly where browserHostScriptPath looks first.
 */
const RUNTIME_ASSETS: readonly string[] = ['platform/browser/browser-host.mjs'];

/**
 * Ambient module declarations that must reach dist so CONSUMERS can use them.
 *
 * `sql-js.d.ts` declares the shape of `sql.js`, which ships no types of its
 * own. tsc treats an ambient .d.ts as an input, never an output, so it never
 * appeared under dist and never reached the published package — and every
 * surface that imports `sql.js` (the daemon's sqlite store, the TUI's
 * dependency probe) had to keep its own byte-identical copy of the declaration
 * to typecheck at all. Copying it here makes the SDK the one place the shape
 * is written; consumers reach it through the `./sql-js` export with a single
 * `/// <reference types="@pellux/goodvibes-sdk/sql-js" />`.
 *
 * Ambient declarations are global by nature, so this list stays deliberately
 * short: only declarations a consumer genuinely needs. The other files in
 * `platform/types/` (peer-deps, vendor-deps, wasm-files, pdfjs-dist) describe
 * the SDK's own build inputs and are not shipped.
 */
const AMBIENT_DECLARATIONS: readonly string[] = ['platform/types/sql-js.d.ts'];

function ensureExists(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Expected path to exist: ${path}`);
  }
}

ensureExists(SDK_DIST);
ensureExists(SOURCE_ARTIFACTS);

rmSync(DIST_ARTIFACTS, { recursive: true, force: true });
mkdirSync(resolve(SDK_DIST, 'contracts'), { recursive: true });
cpSync(SOURCE_ARTIFACTS, DIST_ARTIFACTS, { recursive: true });

for (const asset of [...RUNTIME_ASSETS, ...AMBIENT_DECLARATIONS]) {
  const source = resolve(SDK_ROOT, 'packages/sdk/src', asset);
  ensureExists(source);
  const target = resolve(SDK_DIST, asset);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

console.log('prepared sdk package');
