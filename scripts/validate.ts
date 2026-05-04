import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

function run(command: string, args: readonly string[], label?: string): void {
  if (label) console.log(`[validate] ${label} ...`);
  execFileSync(command, args, {
    cwd: SDK_ROOT,
    stdio: 'inherit',
  });
}

run('bun', ['scripts/generate-api-docs.ts', '--check'], 'api-docs:check');
run('bun', ['scripts/docs-completeness-check.ts'], 'docs:completeness');
run('bun', ['run', 'error:check'], 'error:check');
run('bun', ['run', 'changelog:check'], 'changelog:check');
run('bun', ['run', 'version:check'], 'version:check');
run('bun', ['run', 'todo:check'], 'todo:check');
run('bun', ['run', 'test-skip:check'], 'test-skip:check');
run('bun', ['run', 'platform-console:check'], 'platform-console:check');
run('bun', ['run', 'build'], 'build');
run('bun', ['run', 'types:check'], 'types:check');
run('bun', ['run', 'api:check'], 'api:check');
// examples typecheck also runs locally so `bun run validate` catches type
// errors without a separate CI step.
run('bun', ['run', '--cwd', 'examples', 'typecheck'], 'examples:typecheck');
run('bun', ['scripts/browser-compat-check.ts'], 'browser-compat:check');
run('bun', ['scripts/package-metadata-check.ts'], 'package-metadata:check');
run('bun', ['run', 'any:check'], 'any:check');
// Test execution is owned by the CI platform-matrix (bun) job; removing it
// from validate eliminates the duplicate test run that used to execute on
// every push. Local callers can still run `bun run test` explicitly.
run('bun', ['run', 'pack:check'], 'pack:check');
run('bun', ['run', 'publint:check'], 'publint:check');
run('bun', ['run', 'install:smoke'], 'install:smoke');
run('bun', ['run', 'contracts:check'], 'contracts:check');
run('bun', ['run', 'bundle:check'], 'bundle:check');
