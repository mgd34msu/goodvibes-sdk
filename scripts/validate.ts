import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

function run(command: string, args: readonly string[]): void {
  execFileSync(command, args, {
    cwd: SDK_ROOT,
    stdio: 'inherit',
  });
}

run('bun', ['scripts/generate-api-docs.ts', '--check']);
run('bun', ['scripts/docs-completeness-check.ts']);
run('bun', ['run', 'error:check']);
run('bun', ['run', 'changelog:check']);
run('bun', ['run', 'version:check']);
run('bun', ['run', 'todo:check']);
run('bun', ['run', 'test-skip:check']);
run('bun', ['run', 'build']);
run('bun', ['run', 'types:check']);
run('bun', ['run', '--cwd', 'examples', 'typecheck']);
run('bun', ['scripts/browser-compat-check.ts']);
run('bun', ['scripts/package-metadata-check.ts']);
run('bun', ['run', 'any:check']);
// Test execution is owned by the CI platform-matrix (bun) job; removing it
// from validate eliminates the duplicate test run that used to execute on
// every push. Local callers can still run `bun run test` explicitly.
run('bun', ['run', 'pack:check']);
run('bun', ['run', 'install:smoke']);
