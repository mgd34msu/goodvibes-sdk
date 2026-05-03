import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { VERSION } from '../../version.js';

export type EcosystemEntryKind = 'plugin' | 'skill' | 'hook-pack' | 'policy-pack';
export interface EcosystemCatalogPathOptions {
  readonly cwd: string;
  readonly homeDir: string;
  readonly projectCatalogRoot?: string;
  readonly userCatalogRoot?: string;
  readonly projectInstallRoot?: string;
  readonly userInstallRoot?: string;
}

export interface EcosystemCatalogEntry {
  readonly id: string;
  readonly kind: EcosystemEntryKind;
  readonly name: string;
  readonly summary: string;
  readonly version?: string;
  readonly author?: string;
  readonly source: string;
  readonly tags: readonly string[];
  readonly trustNotes?: string;
  readonly installHint?: string;
  readonly provenance?: string;
  readonly signature?: string;
  readonly updateHint?: string;
  readonly runtimeFit?: {
    readonly minAppVersion?: string;
    readonly maxAppVersion?: string;
    readonly platforms?: readonly string[];
    readonly requiresSandbox?: boolean;
  };
}

export interface EcosystemCatalogFile {
  readonly version: 1;
  readonly entries: EcosystemCatalogEntry[];
}

export interface EcosystemInstallReceipt {
  readonly version: 1;
  readonly id: string;
  readonly kind: EcosystemEntryKind;
  readonly installedAt: number;
  readonly scope: 'project' | 'user';
  readonly entry: EcosystemCatalogEntry;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly fingerprint: string;
  readonly provenanceSummary: string;
  readonly runtimeFit: {
    readonly appVersion: string;
    readonly status: 'supported' | 'warning';
    readonly reasons: readonly string[];
  };
}

export interface EcosystemCatalogBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly scope: 'project' | 'user';
  readonly entries: readonly EcosystemCatalogEntry[];
}

export interface EcosystemCatalogBundleSummary {
  readonly exportedAt: number;
  readonly scope: 'project' | 'user';
  readonly counts: Readonly<Record<EcosystemEntryKind, number>>;
}

export interface EcosystemInstallBackup {
  readonly version: 1;
  readonly id: string;
  readonly kind: EcosystemEntryKind;
  readonly createdAt: number;
  readonly scope: 'project' | 'user';
  readonly archivedTargetPath: string;
  readonly targetPath: string;
  readonly receipt: EcosystemInstallReceipt;
  readonly reason: 'update' | 'uninstall' | 'replace';
}

function resolveCatalogRoot(
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  if (scope === 'project') {
    return options.projectCatalogRoot ?? join(options.cwd, '.goodvibes', 'ecosystem');
  }
  return options.userCatalogRoot ?? join(options.homeDir, '.goodvibes', 'ecosystem');
}

function catalogPath(
  kind: EcosystemEntryKind,
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  return join(resolveCatalogRoot(options, scope), `${kind}s.json`);
}

function catalogPaths(kind: EcosystemEntryKind, options: EcosystemCatalogPathOptions): string[] {
  return [
    catalogPath(kind, options, 'project'),
    catalogPath(kind, options, 'user'),
  ];
}

function resolveInstallRoot(
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  if (scope === 'project') {
    return options.projectInstallRoot ?? join(options.cwd, '.goodvibes');
  }
  return options.userInstallRoot ?? join(options.homeDir, '.goodvibes');
}

function installedRoot(
  kind: EcosystemEntryKind,
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  const base = resolveInstallRoot(options, scope);
  switch (kind) {
    case 'plugin':
      return join(base, 'plugins');
    case 'skill':
      return join(base, 'skills');
    case 'hook-pack':
      return join(base, 'hooks', 'packs');
    case 'policy-pack':
      return join(base, 'policies', 'packs');
  }
}

function installedReceiptsRoot(
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  return join(resolveCatalogRoot(options, scope), 'installed');
}

function receiptPath(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  const base = installedReceiptsRoot(options, scope);
  return join(base, `${kind}-${entryId}.json`);
}

function backupRoot(
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  return join(installedReceiptsRoot(options, scope), 'backups');
}

function backupPrefix(kind: EcosystemEntryKind, entryId: string): string {
  return `${kind}-${entryId}`;
}

function backupMetaPath(
  kind: EcosystemEntryKind,
  entryId: string,
  createdAt: number,
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  return join(backupRoot(options, scope), `${backupPrefix(kind, entryId)}-${createdAt}.json`);
}

function backupArchivePath(
  kind: EcosystemEntryKind,
  entryId: string,
  createdAt: number,
  options: EcosystemCatalogPathOptions,
  scope: 'project' | 'user',
): string {
  return join(backupRoot(options, scope), `${backupPrefix(kind, entryId)}-${createdAt}`);
}

function loadReceipt(path: string): EcosystemInstallReceipt | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as EcosystemInstallReceipt;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function loadBackup(path: string): EcosystemInstallBackup | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as EcosystemInstallBackup;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function createBackupFromReceipt(
  receipt: EcosystemInstallReceipt,
  reason: EcosystemInstallBackup['reason'],
  options: EcosystemCatalogPathOptions,
): EcosystemInstallBackup {
  const createdAt = Date.now();
  const archivedTargetPath = backupArchivePath(receipt.kind, receipt.entry.id, createdAt, options, receipt.scope);
  mkdirSync(dirname(archivedTargetPath), { recursive: true });
  rmSync(archivedTargetPath, { recursive: true, force: true });
  if (existsSync(receipt.targetPath)) {
    cpSync(receipt.targetPath, archivedTargetPath, { recursive: true });
  } else {
    mkdirSync(archivedTargetPath, { recursive: true });
  }
  const backup: EcosystemInstallBackup = {
    version: 1,
    id: `${receipt.kind}:${receipt.entry.id}:${createdAt}`,
    kind: receipt.kind,
    createdAt,
    scope: receipt.scope,
    archivedTargetPath,
    targetPath: receipt.targetPath,
    receipt,
    reason,
  };
  const metaPath = backupMetaPath(receipt.kind, receipt.entry.id, createdAt, options, receipt.scope);
  writeFileSync(metaPath, `${JSON.stringify(backup, null, 2)}\n`, 'utf-8');
  return backup;
}

function parseVersionParts(value: string): number[] {
  return value
    .split('.')
    .map((part) => parseInt(part.replace(/[^0-9].*$/, ''), 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function compareVersions(a: string, b: string): number {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

function hashPath(path: string): string {
  const hash = createHash('sha256');
  if (!existsSync(path)) {
    hash.update(`missing:${path}`);
    return hash.digest('hex');
  }
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const names = readdirSync(path).sort((a, b) => a.localeCompare(b));
    hash.update(`dir:${path}`);
    for (const name of names) {
      hash.update(name);
      hash.update(hashPath(join(path, name)));
    }
    return hash.digest('hex');
  }
  hash.update(`file:${path}`);
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function readCatalogFile(path: string): EcosystemCatalogEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as EcosystemCatalogFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string' && entry.kind !== undefined);
  } catch {
    return [];
  }
}

function readCatalogDocument(path: string): EcosystemCatalogFile {
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as EcosystemCatalogFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    return {
      version: 1,
      entries: parsed.entries.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string' && entry.kind !== undefined),
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function loadEcosystemCatalog(
  kind: EcosystemEntryKind,
  options: EcosystemCatalogPathOptions,
): EcosystemCatalogEntry[] {
  const seen = new Set<string>();
  const entries: EcosystemCatalogEntry[] = [];

  for (const path of catalogPaths(kind, options)) {
    for (const entry of readCatalogFile(path)) {
      if (entry.kind !== kind) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function searchEcosystemCatalog(
  kind: EcosystemEntryKind,
  query: string,
  options: EcosystemCatalogPathOptions,
): EcosystemCatalogEntry[] {
  const normalized = query.trim().toLowerCase();
  const entries = loadEcosystemCatalog(kind, options);
  if (!normalized) return entries;
  return entries.filter((entry) => {
    const haystack = [
      entry.id,
      entry.name,
      entry.summary,
      entry.source,
      entry.trustNotes ?? '',
      entry.installHint ?? '',
      ...entry.tags,
    ].join(' ').toLowerCase();
    return haystack.includes(normalized);
  });
}

export function reviewEcosystemCatalogEntry(
  entry: EcosystemCatalogEntry,
  options: EcosystemCatalogPathOptions,
): {
  entry: EcosystemCatalogEntry;
  sourcePath: string;
  sourceExists: boolean;
  sourceKind: 'local-path' | 'remote' | 'unknown';
  riskLevel: 'low' | 'medium';
  recommendedScope: 'project' | 'user';
  runtimeFit: {
    status: 'supported' | 'warning';
    reasons: readonly string[];
  };
} {
  const { cwd, homeDir } = options;
  const sourcePath = entry.source.startsWith('/') || entry.source.startsWith('.')
    ? resolve(cwd, entry.source)
    : resolve(homeDir, entry.source);
  const sourceExists = existsSync(sourcePath);
  const sourceKind = entry.source.startsWith('/') || entry.source.startsWith('.')
    ? 'local-path'
    : entry.source.includes('://') || entry.source.startsWith('git+') || entry.source.startsWith('repo:')
      ? 'remote'
      : 'unknown';
  const reasons: string[] = [];
  if (entry.runtimeFit?.minAppVersion && compareVersions(VERSION, entry.runtimeFit.minAppVersion) < 0) {
    reasons.push(`requires GoodVibes >= ${entry.runtimeFit.minAppVersion}`);
  }
  if (entry.runtimeFit?.maxAppVersion && compareVersions(VERSION, entry.runtimeFit.maxAppVersion) > 0) {
    reasons.push(`targets GoodVibes <= ${entry.runtimeFit.maxAppVersion}`);
  }
  if (entry.runtimeFit?.platforms && entry.runtimeFit.platforms.length > 0 && !entry.runtimeFit.platforms.includes(process.platform)) {
    reasons.push(`targets platforms: ${entry.runtimeFit.platforms.join(', ')}`);
  }
  if (entry.runtimeFit?.requiresSandbox) {
    reasons.push('requires sandbox-backed execution support');
  }

  return {
    entry,
    sourcePath,
    sourceExists,
    sourceKind,
    riskLevel: entry.trustNotes || sourceKind === 'remote' ? 'medium' : 'low',
    recommendedScope: entry.kind === 'plugin' ? 'project' : 'user',
    runtimeFit: {
      status: reasons.length > 0 ? 'warning' : 'supported',
      reasons,
    },
  };
}

export function installEcosystemCatalogEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user'; skipBackup?: boolean },
): { ok: true; receipt: EcosystemInstallReceipt } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  const entry = loadEcosystemCatalog(kind, options).find((candidate) => candidate.id === entryId);
  if (!entry) return { ok: false, error: `Unknown curated ${kind} entry: ${entryId}` };
  const review = reviewEcosystemCatalogEntry(entry, options);
  if (review.sourceKind !== 'local-path') {
    return { ok: false, error: `Curated ${kind} entry ${entryId} is not a local path source and cannot be installed directly.` };
  }
  if (!review.sourceExists) {
    return { ok: false, error: `Curated ${kind} source path does not exist: ${review.sourcePath}` };
  }

  const targetPath = join(installedRoot(kind, options, scope), entry.id);
  const previousReceipt = loadReceipt(receiptPath(kind, entry.id, options, scope));
  if (previousReceipt && !options.skipBackup) {
    createBackupFromReceipt(previousReceipt, 'replace', options);
  }
  mkdirSync(installedRoot(kind, options, scope), { recursive: true });
  rmSync(targetPath, { recursive: true, force: true });
  cpSync(review.sourcePath, targetPath, { recursive: true });

  const receipt: EcosystemInstallReceipt = {
    version: 1,
    id: `${kind}:${entry.id}`,
    kind,
    installedAt: Date.now(),
    scope,
    entry,
    sourcePath: review.sourcePath,
    targetPath,
    fingerprint: hashPath(targetPath),
    provenanceSummary: entry.provenance ?? entry.source,
    runtimeFit: {
      appVersion: VERSION,
      status: review.runtimeFit.status,
      reasons: review.runtimeFit.reasons,
    },
  };
  const path = receiptPath(kind, entry.id, options, scope);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8');
  return { ok: true, receipt };
}

export function inspectInstalledEcosystemEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): { ok: true; receipt: EcosystemInstallReceipt } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  const receipt = loadReceipt(receiptPath(kind, entryId, options, scope));
  if (!receipt) {
    return { ok: false, error: `No installed ${kind} receipt found for ${entryId} in ${scope} scope.` };
  }
  return { ok: true, receipt };
}

export function uninstallEcosystemCatalogEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): { ok: true; removedPath: string } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  const receipt = loadReceipt(receiptPath(kind, entryId, options, scope));
  if (!receipt) return { ok: false, error: `No installed ${kind} receipt found for ${entryId} in ${scope} scope.` };
  createBackupFromReceipt(receipt, 'uninstall', options);
  rmSync(receipt.targetPath, { recursive: true, force: true });
  rmSync(receiptPath(kind, entryId, options, scope), { force: true });
  return { ok: true, removedPath: receipt.targetPath };
}

export function updateInstalledEcosystemEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): { ok: true; receipt: EcosystemInstallReceipt; previousReceipt: EcosystemInstallReceipt } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  const previousReceipt = loadReceipt(receiptPath(kind, entryId, options, scope));
  if (!previousReceipt) {
    return { ok: false, error: `No installed ${kind} receipt found for ${entryId} in ${scope} scope.` };
  }
  createBackupFromReceipt(previousReceipt, 'update', options);

  const installed = installEcosystemCatalogEntry(kind, entryId, { ...options, scope, skipBackup: true });
  if (!installed.ok) return installed;
  return { ok: true, receipt: installed.receipt, previousReceipt };
}

export function listEcosystemInstallBackups(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): EcosystemInstallBackup[] {
  const scope = options.scope ?? 'project';
  const dir = backupRoot(options, scope);
  if (!existsSync(dir)) return [];
  const prefix = `${backupPrefix(kind, entryId)}-`;
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => loadBackup(join(dir, name)))
    .filter((backup): backup is EcosystemInstallBackup => backup !== null && backup.kind === kind && backup.receipt.entry.id === entryId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function rollbackInstalledEcosystemEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user'; backupId?: string },
): { ok: true; receipt: EcosystemInstallReceipt; restoredFrom: EcosystemInstallBackup } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  const backups = listEcosystemInstallBackups(kind, entryId, { ...options, scope });
  const backup = options.backupId
    ? backups.find((candidate) => candidate.id === options.backupId)
    : backups[0];
  if (!backup) {
    return { ok: false, error: `No rollback backup found for ${kind} ${entryId} in ${scope} scope.` };
  }
  mkdirSync(dirname(backup.targetPath), { recursive: true });
  rmSync(backup.targetPath, { recursive: true, force: true });
  cpSync(backup.archivedTargetPath, backup.targetPath, { recursive: true });
  writeFileSync(
    receiptPath(kind, entryId, options, scope),
    `${JSON.stringify(backup.receipt, null, 2)}\n`,
    'utf-8',
  );
  return { ok: true, receipt: backup.receipt, restoredFrom: backup };
}

export function listInstalledEcosystemEntries(
  kind: EcosystemEntryKind,
  options: EcosystemCatalogPathOptions,
): EcosystemInstallReceipt[] {
  const receipts = [
    installedReceiptsRoot(options, 'project'),
    installedReceiptsRoot(options, 'user'),
  ];
  const found: EcosystemInstallReceipt[] = [];
  for (const dir of receipts) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${kind}-`) || !name.endsWith('.json')) continue;
      const receipt = loadReceipt(join(dir, name));
      if (receipt && receipt.kind === kind) found.push(receipt);
    }
  }
  return found.sort((a, b) => b.installedAt - a.installedAt);
}

export function exportEcosystemCatalogBundle(
  scope: 'project' | 'user',
  options: EcosystemCatalogPathOptions,
): EcosystemCatalogBundle {
  const paths = {
    plugin: catalogPath('plugin', options, scope),
    skill: catalogPath('skill', options, scope),
    'hook-pack': catalogPath('hook-pack', options, scope),
    'policy-pack': catalogPath('policy-pack', options, scope),
  } as const;
  return {
    version: 1,
    exportedAt: Date.now(),
    scope,
    entries: [
      ...readCatalogFile(paths.plugin).filter((entry) => entry.kind === 'plugin'),
      ...readCatalogFile(paths.skill).filter((entry) => entry.kind === 'skill'),
      ...readCatalogFile(paths['hook-pack']).filter((entry) => entry.kind === 'hook-pack'),
      ...readCatalogFile(paths['policy-pack']).filter((entry) => entry.kind === 'policy-pack'),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function inspectEcosystemCatalogBundle(bundle: EcosystemCatalogBundle): EcosystemCatalogBundleSummary {
  const counts: Record<EcosystemEntryKind, number> = { plugin: 0, skill: 0, 'hook-pack': 0, 'policy-pack': 0 };
  for (const entry of bundle.entries) {
    counts[entry.kind] += 1;
  }
  return {
    exportedAt: bundle.exportedAt,
    scope: bundle.scope,
    counts,
  };
}

export function importEcosystemCatalogBundle(
  bundle: EcosystemCatalogBundle,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): { imported: number; pathByKind: Partial<Record<EcosystemEntryKind, string>> } {
  const scope = options.scope ?? bundle.scope;
  const byKind: Record<EcosystemEntryKind, EcosystemCatalogEntry[]> = {
    plugin: [],
    skill: [],
    'hook-pack': [],
    'policy-pack': [],
  };
  for (const entry of bundle.entries) {
    byKind[entry.kind].push(entry);
  }
  const pathByKind: Partial<Record<EcosystemEntryKind, string>> = {};
  let imported = 0;
  for (const kind of ['plugin', 'skill', 'hook-pack', 'policy-pack'] as const) {
    if (byKind[kind].length === 0) continue;
    const path = catalogPath(kind, options, scope);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, entries: byKind[kind].sort((a, b) => a.name.localeCompare(b.name)) }, null, 2)}\n`, 'utf-8');
    pathByKind[kind] = path;
    imported += byKind[kind].length;
  }
  return { imported, pathByKind };
}

export function upsertEcosystemCatalogEntry(
  entry: EcosystemCatalogEntry,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): { ok: true; path: string; entry: EcosystemCatalogEntry } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  const path = catalogPath(entry.kind, options, scope);
  const document = readCatalogDocument(path);
  const nextEntries = document.entries.filter((candidate) => candidate.id !== entry.id || candidate.kind !== entry.kind);
  nextEntries.push(entry);
  nextEntries.sort((a, b) => a.name.localeCompare(b.name));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, entries: nextEntries }, null, 2)}\n`, 'utf-8');
  return { ok: true, path, entry };
}

export function removeEcosystemCatalogEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: EcosystemCatalogPathOptions & { scope?: 'project' | 'user' },
): { ok: true; path: string } | { ok: false; error: string } {
  const scope = options.scope ?? 'project';
  const path = catalogPath(kind, options, scope);
  const document = readCatalogDocument(path);
  const nextEntries = document.entries.filter((candidate) => candidate.id !== entryId || candidate.kind !== kind);
  if (nextEntries.length === document.entries.length) {
    return { ok: false, error: `Curated ${kind} catalog entry not found: ${entryId}` };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, entries: nextEntries }, null, 2)}\n`, 'utf-8');
  return { ok: true, path };
}
