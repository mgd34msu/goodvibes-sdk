/**
 * sbom-generate.ts
 *
 * Generates a CycloneDX 1.x JSON SBOM for the SDK workspace.
 * Wraps @cyclonedx/cyclonedx-npm to ensure it uses the system npm binary
 * rather than Bun's npm shim (which reports version 1.x, below cyclonedx-npm's floor).
 *
 * Output: sbom.cdx.json in the workspace root.
 */

import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

const SDK_ROOT = new URL('..', import.meta.url).pathname;
const OUTPUT_FILE = join(SDK_ROOT, 'sbom.cdx.json');

// Locate system npm-cli.js by walking PATH to find the real npm binary
function findSystemNpmCli(): string | undefined {
  const pathDirs = (process.env.PATH ?? '').split(':');
  for (const dir of pathDirs) {
    const npmBin = join(dir, 'npm');
    if (!existsSync(npmBin)) continue;
    // Resolve symlink to find npm-cli.js
    try {
      const target = execFileSync('readlink', ['-f', npmBin], { encoding: 'utf8' }).trim();
      // npm binary is npm-cli.js or links near it
      const cliPath = join(target, '../npm-cli.js');
      if (existsSync(cliPath)) return cliPath;
      // Some installs: target IS npm-cli.js
      if (target.endsWith('npm-cli.js') && existsSync(target)) return target;
    } catch {
      // readlink not available or not a symlink — try adjacent npm-cli.js
      const cliPath = join(dir, '../lib/node_modules/npm/bin/npm-cli.js');
      if (existsSync(cliPath)) return cliPath;
    }
  }
  return undefined;
}

const cyclonedxBin = resolve(SDK_ROOT, 'node_modules/.bin/cyclonedx-npm');
if (!existsSync(cyclonedxBin)) {
  console.error('[sbom:generate] ERROR: node_modules/.bin/cyclonedx-npm not found. Run bun install.');
  process.exit(1);
}

const npmCliPath = findSystemNpmCli();
const env = { ...process.env };
if (npmCliPath) {
  env.npm_execpath = npmCliPath;
  console.log(`[sbom:generate] Using npm-cli.js: ${npmCliPath}`);
} else {
  console.warn('[sbom:generate] WARN: Could not find system npm-cli.js; cyclonedx-npm may fail.');
}

console.log(`[sbom:generate] Generating SBOM → ${OUTPUT_FILE}`);

try {
  execFileSync(
    process.execPath, // node binary (not bun)
    [
      cyclonedxBin,
      '--ignore-npm-errors',
      '--output-format', 'JSON',
      '--output-file', OUTPUT_FILE,
    ],
    {
      cwd: SDK_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'buffer',
    }
  );
  console.log(`[sbom:generate] SBOM generated successfully.`);
} catch (e: unknown) {
  // cyclonedx-npm exits non-zero on --ignore-npm-errors but still writes output
  if (existsSync(OUTPUT_FILE)) {
    console.log(`[sbom:generate] SBOM generated (with npm warnings — expected in bun workspace).`);
  } else {
    console.error(`[sbom:generate] ERROR: SBOM generation failed and no output file was written.`);
    if (e != null && typeof e === 'object' && 'stderr' in e && e.stderr) process.stderr.write(e.stderr as string);
    process.exit(1);
  }
}
