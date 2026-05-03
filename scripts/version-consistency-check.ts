// version-consistency-check.ts
// Verifies all workspace package.json files share the same version as the root.
//
// Test-harness overrides (default behavior unchanged when env vars not set):
//   WORKSPACE_ROOT        — override the repo root directory (default: dirname of this script)
//   WORKSPACE_PACKAGES_JSON — JSON array of relative package paths to check
//                             (default: the canonical WORKSPACE_PACKAGES list below)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SDK_ROOT = process.env.WORKSPACE_ROOT ?? resolve(import.meta.dir, '..');

const DEFAULT_WORKSPACE_PACKAGES = [
  'packages/contracts',
  'packages/daemon-sdk',
  'packages/errors',
  'packages/operator-sdk',
  'packages/peer-sdk',
  'packages/sdk',
  'packages/transport-core',
  'packages/transport-http',
  'packages/transport-realtime',
];

const WORKSPACE_PACKAGES: string[] = process.env.WORKSPACE_PACKAGES_JSON
  ? (JSON.parse(process.env.WORKSPACE_PACKAGES_JSON) as string[])
  : DEFAULT_WORKSPACE_PACKAGES;

function readVersion(pkgPath: string): string {
  const raw = readFileSync(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: string; name?: string };
  if (!parsed.version) {
    throw new Error(`No version field found in ${pkgPath}`);
  }
  return parsed.version;
}

const rootPkgPath = resolve(SDK_ROOT, 'package.json');
const rootVersion = readVersion(rootPkgPath);

const results: Array<{ path: string; name: string; version: string; ok: boolean }> = [];

for (const pkg of WORKSPACE_PACKAGES) {
  const pkgJsonPath = resolve(SDK_ROOT, pkg, 'package.json');
  const raw = readFileSync(pkgJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: string; name?: string };
  const version = parsed.version ?? '(missing)';
  const name = parsed.name ?? pkg;
  results.push({
    path: `${pkg}/package.json`,
    name,
    version,
    ok: version === rootVersion,
  });
}

const diverged = results.filter((r) => !r.ok);
const allOk = diverged.length === 0;

console.log(`version-consistency-check — root version: ${rootVersion}`);
console.log('');

const col = (s: string, w: number) => s.padEnd(w);
const header = `  ${col('Package', 48)}${col('Version', 12)}Status`;
console.log(header);
console.log('  ' + '-'.repeat(72));

for (const r of results) {
  const status = r.ok ? 'OK' : `DIVERGED (expected ${rootVersion})`;
  console.log(`  ${col(r.name, 48)}${col(r.version, 12)}${status}`);
}

console.log('');

if (!allOk) {
  console.error(
    `version-consistency-check FAILED: ${diverged.length} package(s) diverge from root version ${rootVersion}:`,
  );
  for (const r of diverged) {
    console.error(`  ${r.name}: ${r.version} (expected ${rootVersion})`);
  }
  console.error('');
  console.error(
    'Fix: bump ALL package.json files in the workspace to the same version.\n' +
      'Root package.json is the source of truth. Run:\n' +
      '  bun run version:check\n' +
      'after bumping to confirm consistency.',
  );
  process.exit(1);
}

console.log(`version-consistency-check PASSED — all ${results.length} packages at ${rootVersion}.`);
