/**
 * sbom-generate.ts
 *
 * Generates a CycloneDX 1.x JSON SBOM for the SDK workspace.
 * Wraps @cyclonedx/cyclonedx-npm to ensure it uses the system npm binary
 * rather than Bun's npm adapter (which reports version 1.x, below cyclonedx-npm's floor).
 *
 * Output: sbom.cdx.json in the workspace root.
 */

import { execFileSync } from 'node:child_process';
import { dirname, delimiter, join, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SDK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_FILE = join(SDK_ROOT, 'sbom.cdx.json');

function normalizeExistingFile(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return realpathSync.native?.(path) ?? realpathSync(path);
}

function resolveNpmCliFromPackage(): string | undefined {
  try {
    return normalizeExistingFile(fileURLToPath(import.meta.resolve('npm/bin/npm-cli.js')));
  } catch {
    return undefined;
  }
}

function resolveNpmCliFromEnv(): string | undefined {
  const resolved = normalizeExistingFile(process.env.npm_execpath);
  if (resolved?.endsWith('npm-cli.js')) return resolved;
  return undefined;
}

function candidateNpmCliPaths(npmBin: string): string[] {
  const resolvedBin = normalizeExistingFile(npmBin);
  const candidates = new Set<string>();
  if (resolvedBin) {
    candidates.add(resolvedBin);
    candidates.add(join(dirname(resolvedBin), 'npm-cli.js'));
    candidates.add(join(dirname(resolvedBin), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  candidates.add(join(dirname(npmBin), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  return [...candidates];
}

// Locate system npm-cli.js without assuming POSIX PATH separators or readlink(1).
function findSystemNpmCli(): string {
  const direct = resolveNpmCliFromPackage() ?? resolveNpmCliFromEnv();
  if (direct) return direct;

  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const executableNames = process.platform === 'win32'
    ? ['npm.cmd', 'npm.exe', 'npm.ps1', 'npm']
    : ['npm'];
  for (const dir of pathDirs) {
    for (const executable of executableNames) {
      const npmBin = join(dir, executable);
      if (!existsSync(npmBin)) continue;
      for (const candidate of candidateNpmCliPaths(npmBin)) {
        const resolved = normalizeExistingFile(candidate);
        if (resolved?.endsWith('npm-cli.js')) return resolved;
      }
    }
  }
  throw new Error(
    '[sbom:generate] Could not locate npm/bin/npm-cli.js. Install Node.js npm, add it to PATH, or run with npm_execpath pointing at npm-cli.js.',
  );
}

const cyclonedxBin = resolve(SDK_ROOT, 'node_modules/.bin/cyclonedx-npm');
if (!existsSync(cyclonedxBin)) {
  console.error('[sbom:generate] ERROR: node_modules/.bin/cyclonedx-npm not found. Run bun install.');
  process.exit(1);
}

const npmCliPath = findSystemNpmCli();
const env = { ...process.env };
env.npm_execpath = npmCliPath;
console.log(`[sbom:generate] Using npm-cli.js: ${npmCliPath}`);

console.log(`[sbom:generate] Generating SBOM → ${OUTPUT_FILE}`);

try {
  execFileSync(
    'node',
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
    const stderr = e != null && typeof e === 'object' && 'stderr' in e
      ? (e as { readonly stderr?: Buffer | string }).stderr
      : undefined;
    if (stderr) process.stderr.write(stderr);
    process.exit(1);
  }
}
