import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sbomPath = resolve(root, 'sbom.cdx.json');

function run(command: string, args: readonly string[]): void {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

run('bun', ['run', 'sbom:generate']);

const size = statSync(sbomPath).size;
if (size < 100) {
  throw new Error(`sbom.cdx.json is suspiciously small (${size} bytes).`);
}

run('bun', ['scripts/sbom-validate.ts', sbomPath]);
run('bun', ['scripts/sbom-license-policy.ts', sbomPath]);
console.log(`sbom check passed (${size} bytes)`);
