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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SDK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_FILE = join(SDK_ROOT, 'sbom.cdx.json');
const TEMP_ROOT = join(SDK_ROOT, '.tmp');

rmSync(OUTPUT_FILE, { force: true });

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
  console.error('[sbom:generate] ERROR: node_modules/.bin/cyclonedx-npm not found. Run `bun install` from the repo root first. If you already ran `bun install`, the install was incomplete — try `rm -rf node_modules && bun install`.');
  process.exit(1);
}

const npmCliPath = findSystemNpmCli();
const env = { ...process.env };
env.npm_execpath = npmCliPath;
console.log(`[sbom:generate] Using npm-cli.js: ${npmCliPath}`);

function sortObjectKeys(value: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize(value[key], key);
  }
  return sorted;
}

function canonicalizeArray(values: readonly unknown[], key: string | undefined): unknown[] {
  const next = values.map((value) => canonicalize(value));
  if (key === 'components') {
    return next.sort((a, b) => componentSortKey(a).localeCompare(componentSortKey(b)));
  }
  if (key === 'dependencies') {
    return next.sort((a, b) => dependencySortKey(a).localeCompare(dependencySortKey(b)));
  }
  return next.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function canonicalize(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return canonicalizeArray(value, key);
  if (!value || typeof value !== 'object') return value;
  return sortObjectKeys(value as Record<string, unknown>);
}

function componentSortKey(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return [
    record['bom-ref'],
    record.name,
    record.version,
    record.purl,
  ].map((part) => typeof part === 'string' ? part : '').join('\0');
}

function dependencySortKey(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const ref = (value as Record<string, unknown>).ref;
  return typeof ref === 'string' ? ref : JSON.stringify(value);
}

function normalizeSbomFile(path: string): void {
  const sbom = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  delete sbom.serialNumber;
  if (sbom.metadata && typeof sbom.metadata === 'object' && !Array.isArray(sbom.metadata)) {
    delete (sbom.metadata as Record<string, unknown>).timestamp;
  }
  writeFileSync(path, `${JSON.stringify(canonicalize(sbom), null, 2)}\n`);
}

mkdirSync(TEMP_ROOT, { recursive: true });
const tempDir = mkdtempSync(join(TEMP_ROOT, 'sbom-'));
const tempOutputFile = join(tempDir, 'sbom.cdx.json');

console.log(`[sbom:generate] Generating SBOM → ${OUTPUT_FILE}`);

try {
  execFileSync(
    'node',
    [
      cyclonedxBin,
      '--ignore-npm-errors',
      '--output-format', 'JSON',
      '--output-file', tempOutputFile,
    ],
    {
      cwd: SDK_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'buffer',
    }
  );
  normalizeSbomFile(tempOutputFile);
  renameSync(tempOutputFile, OUTPUT_FILE);
  console.log(`[sbom:generate] SBOM generated successfully.`);
} catch (e: unknown) {
  // cyclonedx-npm exits non-zero on --ignore-npm-errors but still writes output
  if (existsSync(tempOutputFile)) {
    normalizeSbomFile(tempOutputFile);
    renameSync(tempOutputFile, OUTPUT_FILE);
    console.log(`[sbom:generate] SBOM generated (with npm warnings — expected in bun workspace).`);
  } else {
    console.error(`[sbom:generate] ERROR: SBOM generation failed and no output file was written.`);
    const stderr = e != null && typeof e === 'object' && 'stderr' in e
      ? (e as { readonly stderr?: Buffer | string }).stderr
      : undefined;
    if (stderr) process.stderr.write(stderr);
    process.exit(1);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
