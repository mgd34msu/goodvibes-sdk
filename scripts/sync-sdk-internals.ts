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
import {
  rewritePackageSpecifiers,
  rewriteRelativeTsSpecifiers,
} from './_internal/normalize.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const TARGET_ROOT = resolve(SDK_ROOT, 'packages/sdk/src/_internal');
const CHECK_ONLY = process.argv.includes('--check');
const SCOPE_RAW = process.argv.find((a) => a.startsWith('--scope='))?.slice('--scope='.length) ?? null;

// Safety gate: refuse to run without --scope unless --scope=all is explicitly provided
if (!CHECK_ONLY && SCOPE_RAW === null) {
  console.error(
    'sync: refusing to run without --scope.\n' +
    'Example: bun run sync --scope=transport-core\n' +
    'Use --scope=all only if you absolutely mean it (nukes the entire mirror tree).',
  );
  process.exit(1);
}

const SCOPE_ALL = SCOPE_RAW === 'all';
if (!CHECK_ONLY && SCOPE_ALL) {
  console.warn('sync: WARNING — --scope=all will delete and regenerate the entire mirror tree. Proceeding.');
}

// Support comma-separated scopes: --scope=daemon,errors,operator
const SCOPE_LIST: string[] | null = SCOPE_ALL || SCOPE_RAW === null
  ? null
  : SCOPE_RAW.split(',').map((s) => s.trim()).filter(Boolean);

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

function removeStaleFiles(validTargetPaths, scopeDir = null) {
  const stale = [];
  const walkRoot = scopeDir ?? TARGET_ROOT;
  if (!statSafe(walkRoot)?.isDirectory()) return stale;

  for (const filePath of walk(walkRoot)) {
    // Never delete barrel .ts files at the _internal/ root level — they are not
    // managed by the sync script and are maintained manually.
    if (scopeDir === null && filePath.endsWith('.ts') && resolve(filePath, '..') === TARGET_ROOT) {
      continue;
    }
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

// Valid scope names (derived from targetDir basenames)
const VALID_SCOPES = ['contracts', 'errors', 'daemon', 'transport-core', 'transport-direct', 'transport-http', 'transport-realtime', 'operator', 'peer'];

let activeSpecs = PACKAGE_SPECS;
if (SCOPE_LIST !== null) {
  // Validate all requested scopes before running any
  const unknownScopes = SCOPE_LIST.filter((s) => !VALID_SCOPES.includes(s));
  if (unknownScopes.length > 0) {
    console.error(`sync: unknown scope(s): ${unknownScopes.join(', ')}`);
    console.error(`Valid scopes: ${VALID_SCOPES.join(', ')}`);
    console.error('Use --scope=all to sync everything.');
    process.exit(1);
  }
  activeSpecs = PACKAGE_SPECS.filter((s) => SCOPE_LIST.some((sc) => s.targetDir.endsWith(`/${sc}`)));
}

const sourceFiles = [];
const artifactFiles = [];

for (const spec of activeSpecs) {
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

// For multi-scope, remove stale files from each scoped targetDir independently
const stale: string[] = [];
if (SCOPE_LIST !== null && !SCOPE_ALL) {
  for (const spec of activeSpecs) {
    stale.push(...removeStaleFiles(validTargetPaths, spec.targetDir));
  }
} else {
  stale.push(...removeStaleFiles(validTargetPaths, null));
}
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
