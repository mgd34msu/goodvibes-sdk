import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const SDK_DIST = resolve(SDK_ROOT, 'packages/sdk/dist');
const INTERNAL_DIST_ROOT = resolve(SDK_DIST, '_internal');

const internalPackages = [
  {
    sourceDir: resolve(SDK_ROOT, 'packages/contracts/dist'),
    targetDir: resolve(INTERNAL_DIST_ROOT, 'contracts'),
    artifactsDir: resolve(SDK_ROOT, 'packages/contracts/artifacts'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/errors/dist'),
    targetDir: resolve(INTERNAL_DIST_ROOT, 'errors'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/daemon-sdk/dist'),
    targetDir: resolve(INTERNAL_DIST_ROOT, 'daemon'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/transport-core/dist'),
    targetDir: resolve(INTERNAL_DIST_ROOT, 'transport-core'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/transport-direct/dist'),
    targetDir: resolve(INTERNAL_DIST_ROOT, 'transport-direct'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/transport-http/dist'),
    targetDir: resolve(INTERNAL_DIST_ROOT, 'transport-http'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/transport-realtime/dist'),
    targetDir: resolve(INTERNAL_DIST_ROOT, 'transport-realtime'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/operator-sdk/dist'),
    targetDir: resolve(INTERNAL_DIST_ROOT, 'operator'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/peer-sdk/dist'),
    targetDir: resolve(INTERNAL_DIST_ROOT, 'peer'),
  },
];

const specifierTargets = new Map([
  ['@pellux/goodvibes-contracts', resolve(INTERNAL_DIST_ROOT, 'contracts/index.js')],
  ['@pellux/goodvibes-contracts/node', resolve(INTERNAL_DIST_ROOT, 'contracts/node.js')],
  ['@pellux/goodvibes-errors', resolve(INTERNAL_DIST_ROOT, 'errors/index.js')],
  ['@pellux/goodvibes-daemon-sdk', resolve(INTERNAL_DIST_ROOT, 'daemon/index.js')],
  ['@pellux/goodvibes-transport-core', resolve(INTERNAL_DIST_ROOT, 'transport-core/index.js')],
  ['@pellux/goodvibes-transport-direct', resolve(INTERNAL_DIST_ROOT, 'transport-direct/index.js')],
  ['@pellux/goodvibes-transport-http', resolve(INTERNAL_DIST_ROOT, 'transport-http/index.js')],
  ['@pellux/goodvibes-transport-realtime', resolve(INTERNAL_DIST_ROOT, 'transport-realtime/index.js')],
  ['@pellux/goodvibes-operator-sdk', resolve(INTERNAL_DIST_ROOT, 'operator/index.js')],
  ['@pellux/goodvibes-peer-sdk', resolve(INTERNAL_DIST_ROOT, 'peer/index.js')],
]);

function ensureDistExists(path) {
  if (!existsSync(path)) {
    throw new Error(`Expected build output at ${path}. Run the TypeScript build first.`);
  }
}

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function toImportPath(fromFile, toFile) {
  const raw = relative(dirname(fromFile), toFile).replaceAll('\\', '/');
  return raw.startsWith('.') ? raw : `./${raw}`;
}

function rewriteModuleSpecifiers(filePath) {
  let content = readFileSync(filePath, 'utf8');
  for (const [specifier, target] of specifierTargets.entries()) {
    const localPath = toImportPath(filePath, target);
    content = content.replaceAll(`'${specifier}'`, `'${localPath}'`);
    content = content.replaceAll(`"${specifier}"`, `"${localPath}"`);
  }
  if (filePath.endsWith('/_internal/contracts/node.js')) {
    content = content.replaceAll('../artifacts/', './artifacts/');
  }
  writeFileSync(filePath, content);
}

ensureDistExists(SDK_DIST);
for (const pkg of internalPackages) {
  ensureDistExists(pkg.sourceDir);
}

rmSync(INTERNAL_DIST_ROOT, { recursive: true, force: true });
mkdirSync(INTERNAL_DIST_ROOT, { recursive: true });

for (const pkg of internalPackages) {
  cpSync(pkg.sourceDir, pkg.targetDir, { recursive: true });
  if (pkg.artifactsDir) {
    cpSync(pkg.artifactsDir, resolve(pkg.targetDir, 'artifacts'), { recursive: true });
  }
}

const filesToRewrite = walkFiles(SDK_DIST).filter((filePath) => {
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return false;
  }
  return filePath.endsWith('.js') || filePath.endsWith('.d.ts');
});

for (const filePath of filesToRewrite) {
  rewriteModuleSpecifiers(filePath);
}

console.log('prepared flattened sdk package');
