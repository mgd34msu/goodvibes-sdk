/**
 * bundle-for-hermes.ts
 *
 * Bun script: bundles the SDK react-native entry + Hermes test cases into a
 * single flat JS file that the Hermes binary can execute.
 *
 * Uses esbuild (bundled with Bun) with target=es2019 to ensure:
 *   - Private class fields (#field) are downleveled to WeakMap equivalents
 *   - async/await is preserved (supported in Hermes runtimes embedded in RN 0.64+;
 *     some standalone CLI tarballs reject it and are useful only for syntax probes)
 *   - No node: builtins leak in (matches Metro/Expo bundler constraints)
 *
 * Usage (from repo root):
 *   bun run test/hermes/bundle-for-hermes.ts
 *
 * Output:
 *   test/hermes/dist/hermes-test-bundle.js
 *
 * NOTE: If the standalone Hermes CLI reports "async functions are unsupported",
 * use a React Native embedded Hermes binary for runtime checks instead.
 */

import { spawnSync } from 'bun';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, 'dist');
const entrypoint = resolve(__dirname, 'hermes-runner.js');
const outfile = resolve(outDir, 'hermes-test-bundle.js');

mkdirSync(outDir, { recursive: true });

// Use esbuild CLI via bunx so we can specify --target=es2019:
//   es2019 = no private class fields (#field), no logical-assignment ops
//   Some standalone CLI tarballs reject newer syntax even when React Native
//   embedded Hermes runtimes support it.
//
// The bundle is IIFE format so it runs in Hermes without module plumbing.
const result = spawnSync([
  'bun', 'x', 'esbuild',
  '--bundle',
  '--target=es2019',
  '--format=iife',
  '--platform=browser',   // no node: builtins
  `--outfile=${outfile}`,
  entrypoint,
]);

if (result.exitCode !== 0) {
  const stderr = new TextDecoder().decode(result.stderr);
  console.error('esbuild failed:');
  console.error(stderr);
  process.exit(1);
}

const stdout = new TextDecoder().decode(result.stdout);
if (stdout.trim()) console.log(stdout.trim());

console.log(`Hermes bundle written to ${outfile}`);
