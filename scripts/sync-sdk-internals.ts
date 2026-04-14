import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const TARGET_ROOT = resolve(SDK_ROOT, 'packages/sdk/src/_internal');
const CHECK_ONLY = process.argv.includes('--check');

const PACKAGE_SPECS = [
  {
    sourceDir: resolve(SDK_ROOT, 'packages/contracts/src'),
    targetDir: resolve(TARGET_ROOT, 'contracts'),
    artifactsDir: resolve(SDK_ROOT, 'packages/contracts/artifacts'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/errors/src'),
    targetDir: resolve(TARGET_ROOT, 'errors'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/daemon-sdk/src'),
    targetDir: resolve(TARGET_ROOT, 'daemon'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/transport-core/src'),
    targetDir: resolve(TARGET_ROOT, 'transport-core'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/transport-direct/src'),
    targetDir: resolve(TARGET_ROOT, 'transport-direct'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/transport-http/src'),
    targetDir: resolve(TARGET_ROOT, 'transport-http'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/transport-realtime/src'),
    targetDir: resolve(TARGET_ROOT, 'transport-realtime'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/operator-sdk/src'),
    targetDir: resolve(TARGET_ROOT, 'operator'),
  },
  {
    sourceDir: resolve(SDK_ROOT, 'packages/peer-sdk/src'),
    targetDir: resolve(TARGET_ROOT, 'peer'),
  },
];

const SPECIFIER_TARGETS = new Map([
  ['@pellux/goodvibes-contracts/node', resolve(TARGET_ROOT, 'contracts/node.ts')],
  ['@pellux/goodvibes-contracts', resolve(TARGET_ROOT, 'contracts/index.ts')],
  ['@pellux/goodvibes-errors', resolve(TARGET_ROOT, 'errors/index.ts')],
  ['@pellux/goodvibes-daemon-sdk', resolve(TARGET_ROOT, 'daemon/index.ts')],
  ['@pellux/goodvibes-transport-core', resolve(TARGET_ROOT, 'transport-core/index.ts')],
  ['@pellux/goodvibes-transport-direct', resolve(TARGET_ROOT, 'transport-direct/index.ts')],
  ['@pellux/goodvibes-transport-http', resolve(TARGET_ROOT, 'transport-http/index.ts')],
  ['@pellux/goodvibes-transport-realtime', resolve(TARGET_ROOT, 'transport-realtime/index.ts')],
  ['@pellux/goodvibes-operator-sdk', resolve(TARGET_ROOT, 'operator/index.ts')],
  ['@pellux/goodvibes-peer-sdk', resolve(TARGET_ROOT, 'peer/index.ts')],
]);

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function toImportPath(fromFile, toFile) {
  const raw = relative(dirname(fromFile), toFile).replaceAll('\\', '/');
  return raw.startsWith('.') ? raw : `./${raw}`;
}

function rewriteRelativeTsSpecifiers(content) {
  return content.replaceAll(
    /((?:from|import)\s*['"](?:\.\.?\/[^'"]+))\.ts(['"])/g,
    '$1.js$2',
  ).replaceAll(
    /(['"])(\.\.?\/[^'"]+)\.ts\1/g,
    '$1$2.js$1',
  );
}

function rewritePackageSpecifiers(content, targetPath) {
  let next = content;
  for (const [specifier, targetSourcePath] of SPECIFIER_TARGETS.entries()) {
    const importPath = toImportPath(targetPath, targetSourcePath).replace(/\.ts$/, '.js');
    next = next.replaceAll(`'${specifier}'`, `'${importPath}'`);
    next = next.replaceAll(`"${specifier}"`, `"${importPath}"`);
  }
  if (targetPath.endsWith('/contracts/node.ts')) {
    next = next.replaceAll('../artifacts/', './artifacts/');
  }
  return next;
}

function withHeader(content, sourceLabel) {
  if (content.startsWith('#!')) {
    const newlineIndex = content.indexOf('\n');
    const shebang = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
    const rest = newlineIndex === -1 ? '' : content.slice(newlineIndex + 1);
    return `${shebang}\n// Synced from ${sourceLabel}\n${rest}`;
  }
  return `// Synced from ${sourceLabel}\n${content}`;
}

function syncTsFile(sourcePath, sourceDir, targetDir) {
  const rel = relative(sourceDir, sourcePath).replaceAll('\\', '/');
  const targetPath = resolve(targetDir, rel);
  const raw = readFileSync(sourcePath, 'utf8');
  const rewritten = withHeader(
    rewritePackageSpecifiers(rewriteRelativeTsSpecifiers(raw), targetPath),
    relative(SDK_ROOT, sourcePath).replaceAll('\\', '/'),
  );

  let current = null;
  try {
    current = readFileSync(targetPath, 'utf8');
  } catch {
    current = null;
  }

  if (current === rewritten) return false;
  if (CHECK_ONLY) {
    throw new Error(`sdk internal source is out of sync: ${targetPath}`);
  }
  ensureParent(targetPath);
  writeFileSync(targetPath, rewritten);
  return true;
}

function syncArtifactFile(sourcePath, targetDir, artifactsDir) {
  const rel = relative(artifactsDir, sourcePath).replaceAll('\\', '/');
  const targetPath = resolve(targetDir, 'artifacts', rel);
  const source = readFileSync(sourcePath);
  const current = statSafe(targetPath);

  if (current?.isFile()) {
    const existing = readFileSync(targetPath);
    if (Buffer.compare(existing, source) === 0) return false;
  }

  if (CHECK_ONLY) {
    throw new Error(`sdk internal artifact is out of sync: ${targetPath}`);
  }

  ensureParent(targetPath);
  copyFileSync(sourcePath, targetPath);
  return true;
}

function removeStaleFiles(validTargetPaths) {
  const stale = [];
  if (!statSafe(TARGET_ROOT)?.isDirectory()) return stale;

  for (const filePath of walk(TARGET_ROOT)) {
    if (!validTargetPaths.has(filePath)) {
      stale.push(filePath);
    }
  }

  if (CHECK_ONLY && stale.length > 0) {
    throw new Error(`sdk internal source has stale files:\n${stale.join('\n')}`);
  }

  for (const filePath of stale) {
    rmSync(filePath, { force: true });
  }

  return stale;
}

const sourceFiles = [];
const artifactFiles = [];

for (const spec of PACKAGE_SPECS) {
  for (const filePath of walk(spec.sourceDir)) {
    if (filePath.endsWith('.ts')) {
      sourceFiles.push({ filePath, sourceDir: spec.sourceDir, targetDir: spec.targetDir });
    }
  }

  if (spec.artifactsDir) {
    for (const filePath of walk(spec.artifactsDir)) {
      artifactFiles.push({ filePath, targetDir: spec.targetDir, artifactsDir: spec.artifactsDir });
    }
  }
}

const validTargetPaths = new Set([
  ...sourceFiles.map(({ filePath, sourceDir, targetDir }) => resolve(targetDir, relative(sourceDir, filePath))),
  ...artifactFiles.map(({ filePath, targetDir, artifactsDir }) => resolve(targetDir, 'artifacts', relative(artifactsDir, filePath))),
]);

let changed = false;
if (!CHECK_ONLY) {
  mkdirSync(TARGET_ROOT, { recursive: true });
}

for (const source of sourceFiles) {
  changed = syncTsFile(source.filePath, source.sourceDir, source.targetDir) || changed;
}

for (const artifact of artifactFiles) {
  changed = syncArtifactFile(artifact.filePath, artifact.targetDir, artifact.artifactsDir) || changed;
}

const stale = removeStaleFiles(validTargetPaths);
if (stale.length > 0) {
  changed = true;
}

if (CHECK_ONLY) {
  console.log('sdk internal source is in sync');
} else if (changed) {
  console.log('sdk internal source synced');
} else {
  console.log('sdk internal source already up to date');
}
