/**
 * validate, the release-time source checks.
 *
 * Runs in .github/workflows/release-gates.yml (nightly and before every
 * release), not on every push. Per-push CI is build + typecheck + tests +
 * secret scan + the packaged-daemon smoke; see docs/testing-and-validation.md.
 *
 * Nothing here checks a GENERATED file against source: api docs, contract
 * artifacts, the webui facade, the Home Assistant client, api-extractor
 * reports, bundle budgets, the eval baseline and version strings are rewritten
 * by `bun run release:prepare` at the version bump instead.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

function run(command: string, args: readonly string[], label: string): void {
  console.log(`[validate] ${label} ...`);
  execFileSync(command, args, { cwd: SDK_ROOT, stdio: 'inherit' });
}

run('bun', ['run', 'build'], 'build');
// A credential the platform stores must be classified, or no surface can route it.
run('bun', ['run', 'credential-scope:check'], 'credential-scope:check');
// Every platform module with a public face is reachable from a published package.
run('bun', ['run', 'exports:check'], 'exports:check');
// The examples compile against the built packages the way a consumer would.
run('bun', ['run', '--cwd', 'examples', 'typecheck'], 'examples:typecheck');
// Companion-safe entry points import nothing a browser cannot load.
run('bun', ['scripts/browser-compat-check.ts'], 'browser-compat:check');
run('bun', ['scripts/package-metadata-check.ts'], 'package-metadata:check');
