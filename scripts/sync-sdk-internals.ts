import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const SOURCE_ARTIFACTS = resolve(SDK_ROOT, 'packages/contracts/artifacts');
const TARGET_ARTIFACTS = resolve(SDK_ROOT, 'packages/sdk/src/_internal/contracts/artifacts');
const CHECK_ONLY = process.argv.includes('--check');
const SCOPE_RAW = process.argv.find((a) => a.startsWith('--scope='))?.slice('--scope='.length) ?? null;

if (SCOPE_RAW !== null && SCOPE_RAW !== 'contracts' && SCOPE_RAW !== 'all') {
  console.error('sync: source mirrors were removed; only --scope=contracts is supported for contract artifacts.');
  process.exit(1);
}

function statSafe(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function artifactFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

let changed = false;
const sourceFiles = artifactFiles(SOURCE_ARTIFACTS);
const targetFiles = statSafe(TARGET_ARTIFACTS)?.isDirectory()
  ? artifactFiles(TARGET_ARTIFACTS)
  : [];

const sourceSet = new Set(sourceFiles);
for (const targetFile of targetFiles) {
  if (sourceSet.has(targetFile)) continue;
  changed = true;
  if (CHECK_ONLY) {
    throw new Error(`stale SDK contract artifact: ${resolve(TARGET_ARTIFACTS, targetFile)}`);
  }
}

for (const sourceFile of sourceFiles) {
  const sourcePath = resolve(SOURCE_ARTIFACTS, sourceFile);
  const targetPath = resolve(TARGET_ARTIFACTS, sourceFile);
  const source = Bun.file(sourcePath);
  const target = statSafe(targetPath)?.isFile() ? Bun.file(targetPath) : null;
  const same = target !== null && Buffer.compare(
    Buffer.from(await source.arrayBuffer()),
    Buffer.from(await target.arrayBuffer()),
  ) === 0;
  if (same) continue;
  changed = true;
  if (CHECK_ONLY) {
    throw new Error(`SDK contract artifact is out of sync: ${targetPath}`);
  }
}

if (!CHECK_ONLY && changed) {
  rmSync(TARGET_ARTIFACTS, { recursive: true, force: true });
  mkdirSync(TARGET_ARTIFACTS, { recursive: true });
  for (const sourceFile of sourceFiles) {
    copyFileSync(resolve(SOURCE_ARTIFACTS, sourceFile), resolve(TARGET_ARTIFACTS, sourceFile));
  }
}

if (CHECK_ONLY) {
  console.log('sdk contract artifacts are in sync');
} else if (changed) {
  console.log('sdk contract artifacts synced');
} else {
  console.log('sdk contract artifacts already up to date');
}
