import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTuiRoot } from './source-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const TUI_ROOT = resolveTuiRoot({ required: true });
const CHECK_ONLY = process.argv.includes('--check');

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function syncFile(target, content) {
  let current = null;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  if (CHECK_ONLY) {
    throw new Error(`error seam is out of sync: ${target}`);
  }
  ensureDir(target);
  writeFileSync(target, content);
  return true;
}

function loadSource(path) {
  return readFileSync(resolve(TUI_ROOT, path), 'utf8');
}

function withHeader(content, sourcePath) {
  return `// Synced from goodvibes-tui/${sourcePath}\n${content}`;
}

const specs = [
  {
    source: 'src/types/daemon-error-contract.ts',
    target: 'packages/errors/src/daemon-error-contract.ts',
    transform: (content) => content,
  },
];

let changed = false;
for (const spec of specs) {
  const content = withHeader(spec.transform(loadSource(spec.source)), spec.source);
  changed = syncFile(resolve(SDK_ROOT, spec.target), content) || changed;
}

if (CHECK_ONLY) {
  console.log('error seams are in sync');
} else if (changed) {
  console.log('error seams synced from goodvibes-tui');
} else {
  console.log('error seams already up to date');
}
