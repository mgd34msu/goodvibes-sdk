/**
 * bundle-for-hermes.ts
 *
 * Bun script: bundles the SDK react-native entry + Hermes test cases into a
 * single flat JS file that the Hermes binary can execute.
 *
 * Uses esbuild (bundled with Bun) with target=es2019 to ensure:
 *   - Private class fields (#field) are downleveled to WeakMap equivalents
 *   - async/await is preserved (supported in Hermes runtimes embedded in RN 0.64+;
 *     rejected by the standalone CLI binary, see FINDINGS.md F1)
 *   - No node: builtins leak in (matches Metro/Expo bundler constraints)
 *
 * Usage (from repo root):
 *   bun run test/hermes/bundle-for-hermes.ts
 *
 * Output:
 *   test/hermes/dist/hermes-test-bundle.js
 *
 * NOTE: If you see "async functions are unsupported" from the Hermes CLI binary,
 * you have a very old standalone Hermes binary (pre-0.11). See SETUP.md for
 * guidance on obtaining a modern Hermes binary.
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
//   These features were not in Hermes 0.12/0.13 standalone CLI.
//   Modern Hermes (RN 0.73+) supports ES2021+ but the CLI binary from
//   github.com/facebook/hermes releases does not.
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
