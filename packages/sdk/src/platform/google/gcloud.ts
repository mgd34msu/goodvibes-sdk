/**
 * gcloud.ts — the gcloud driver for the OAuth (Path B) setup flow.
 *
 * Every subprocess call goes through the injected `GoogleCommandPort` (see
 * `types.ts`) so this module is fully testable without a real gcloud install,
 * a real Google account, or a real Cloud project. The one real
 * implementation, `createProcessCommandPort()`, lives in this module's `node`
 * entry and is the only place that touches `Bun.spawn`.
 *
 * Every exported function returns a typed discriminated result and never
 * throws for an expected failure (gcloud missing, malformed JSON, an empty
 * project list, and so on). The functions that create or enable things are
 * idempotent: re-running the flow after a partial success does not create a
 * second Cloud project or re-enable an already-enabled service.
 */

export interface GcloudDetected {
  readonly ok: true;
  readonly path: string;
  readonly version: string;
}
export interface GcloudNotFound {
  readonly ok: false;
  readonly problem: string;
  readonly fix: string;
}
export type GcloudDetection = GcloudDetected | GcloudNotFound;

/** Subset of the command port surface this module depends on. */
import type { GoogleCommandPort, GoogleCommandResult } from './types.js';

/**
 * Where the no-root tarball install pulls the Google Cloud CLI from.
 * Exported so the node adapter and the runbook name the same URL.
 */
export const GCLOUD_DEFAULT_DOWNLOAD_URL =
  'https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz';

/** Default per-command wall clock for the gcloud driver. */
export const GCLOUD_DEFAULT_TIMEOUT_MS = 60_000;

/** Is `gcloud` reachable on PATH, or at the `$HOME/google-cloud-sdk/bin/gcloud` fallback? */
export async function detectGcloud(
  port: GoogleCommandPort,
  homeDirectory: string,
): Promise<GcloudDetection> {
  const onPath = await tryVersion(port, 'gcloud');
  if (onPath) return onPath;
  const fallbackPath = `${homeDirectory}/google-cloud-sdk/bin/gcloud`;
  const atFallback = await tryVersion(port, fallbackPath);
  if (atFallback) return atFallback;
  return {
    ok: false,
    problem: 'gcloud is not on PATH and is not installed at the home-directory fallback location.',
    fix: 'Install the Google Cloud CLI (this flow can do it into your home directory with no root access) or add it to PATH if already installed elsewhere.',
  };
}

async function tryVersion(port: GoogleCommandPort, executable: string): Promise<GcloudDetected | null> {
  const result = await port.run(executable, ['--version']);
  if (result.spawnError || result.timedOut || result.code !== 0) return null;
  const versionLine = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return { ok: true, path: executable, version: versionLine ?? 'unknown version' };
}

export interface InstallOptions {
  readonly homeDirectory: string;
  readonly downloadUrl?: string;
}
export interface InstallAlreadyInstalled {
  readonly ok: true;
  readonly outcome: 'already-installed';
  readonly path: string;
}
export interface InstallInstalled {
  readonly ok: true;
  readonly outcome: 'installed';
  readonly path: string;
}
export interface InstallFailed {
  readonly ok: false;
  readonly problem: string;
  readonly fix: string;
}
export type InstallResult = InstallAlreadyInstalled | InstallInstalled | InstallFailed;

/**
 * No-root tarball install into the home directory. Idempotent: if the binary
 * already exists at the fallback path, this returns `already-installed`
 * without downloading anything again.
 */
export async function installGcloud(port: GoogleCommandPort, options: InstallOptions): Promise<InstallResult> {
  const { homeDirectory } = options;
  const downloadUrl = options.downloadUrl ?? GCLOUD_DEFAULT_DOWNLOAD_URL;
  const binaryPath = `${homeDirectory}/google-cloud-sdk/bin/gcloud`;

  const already = await tryVersion(port, binaryPath);
  if (already) {
    return { ok: true, outcome: 'already-installed', path: binaryPath };
  }

  const tarballPath = `${homeDirectory}/google-cloud-cli-linux-x86_64.tar.gz`;
  const download = await port.run('curl', ['-sSL', '-o', tarballPath, downloadUrl], { timeoutMs: 300_000 });
  const downloadProblem = commandProblem(download, 'Downloading the Google Cloud CLI archive');
  if (downloadProblem) {
    return {
      ok: false,
      problem: downloadProblem,
      fix: 'Check network access to dl.google.com, or download the archive manually and extract it into your home directory.',
    };
  }

  const extract = await port.run('tar', ['-xzf', tarballPath, '-C', homeDirectory], { timeoutMs: 300_000 });
  const extractProblem = commandProblem(extract, 'Extracting the Google Cloud CLI archive');
  if (extractProblem) {
    return {
      ok: false,
      problem: extractProblem,
      fix: 'Make sure the downloaded archive is a valid gzip tarball and that the home directory is writable.',
    };
  }

  const installScript = `${homeDirectory}/google-cloud-sdk/install.sh`;
  const install = await port.run(installScript, ['--quiet'], { timeoutMs: 300_000 });
  const installProblem = commandProblem(install, 'Running the Google Cloud CLI installer');
  if (installProblem) {
    return {
      ok: false,
      problem: installProblem,
      fix: 'Re-run the installer directly to see its full output: install.sh --quiet',
    };
  }

  const installed = await tryVersion(port, binaryPath);
  if (!installed) {
    return {
      ok: false,
      problem: 'The installer ran without error, but no working gcloud binary was found afterward.',
      fix: `Check ${binaryPath} exists and is executable.`,
    };
  }
  return { ok: true, outcome: 'installed', path: binaryPath };
}

function commandProblem(result: GoogleCommandResult, action: string): string | null {
  if (result.spawnError) return `${action} failed to start: ${result.spawnError}`;
  if (result.timedOut) return `${action} timed out.`;
  if (result.code !== 0) {
    const tail = result.stderr.trim().split('\n').slice(-5).join('\n');
    return `${action} exited with code ${result.code}.${tail ? ` ${tail}` : ''}`;
  }
  return null;
}

/** Parse `--format=json` output defensively: tolerate stderr noise mixed onto stdout. */
function parseGcloudJson(stdout: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // gcloud occasionally interleaves a warning line before or after the JSON body.
    // Take the widest slice between the first '[' or '{' and the last matching close.
    const firstArray = trimmed.indexOf('[');
    const firstObject = trimmed.indexOf('{');
    const candidates = [firstArray, firstObject].filter((i) => i >= 0);
    if (candidates.length === 0) return { ok: false };
    const start = Math.min(...candidates);
    const closeChar = trimmed[start] === '[' ? ']' : '}';
    const end = trimmed.lastIndexOf(closeChar);
    if (end < start) return { ok: false };
    const slice = trimmed.slice(start, end + 1);
    try {
      return { ok: true, value: JSON.parse(slice) };
    } catch {
      return { ok: false };
    }
  }
}

export interface AuthAccount {
  readonly ok: true;
  readonly account: string;
}
export interface AuthNoActiveAccount {
  readonly ok: false;
  readonly problem: string;
  readonly fix: string;
}
export type AuthCheckResult = AuthAccount | AuthNoActiveAccount;

interface GcloudAuthEntry {
  readonly account?: unknown;
  readonly status?: unknown;
}

/** `gcloud auth list --format=json`, parsed. Never logs the account it finds. */
export async function checkAuthenticated(port: GoogleCommandPort, gcloudPath: string): Promise<AuthCheckResult> {
  const result = await port.run(gcloudPath, ['auth', 'list', '--format=json']);
  const problem = commandProblem(result, 'Listing gcloud accounts');
  if (problem) {
    return { ok: false, problem, fix: 'Run gcloud auth login to sign gcloud in, then try again.' };
  }
  const parsed = parseGcloudJson(result.stdout);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    return {
      ok: false,
      problem: 'Could not parse the output of gcloud auth list as JSON.',
      fix: 'Run gcloud auth list --format=json directly and check its output.',
    };
  }
  const entries = parsed.value as readonly GcloudAuthEntry[];
  const active = entries.find((entry) => entry.status === 'ACTIVE' && typeof entry.account === 'string');
  if (!active || typeof active.account !== 'string') {
    return {
      ok: false,
      problem: 'gcloud has no active account.',
      fix: 'Run gcloud auth login, choose the Google account to use, then try again.',
    };
  }
  return { ok: true, account: active.account };
}

export interface GcloudProject {
  readonly projectId: string;
  readonly name?: string;
}
export interface ListProjectsOk {
  readonly ok: true;
  readonly projects: readonly GcloudProject[];
}
export interface ListProjectsFailed {
  readonly ok: false;
  readonly problem: string;
  readonly fix: string;
}
export type ListProjectsResult = ListProjectsOk | ListProjectsFailed;

interface GcloudProjectEntry {
  readonly projectId?: unknown;
  readonly name?: unknown;
}

/** `gcloud projects list --format=json`, parsed. */
export async function listProjects(port: GoogleCommandPort, gcloudPath: string): Promise<ListProjectsResult> {
  const result = await port.run(gcloudPath, ['projects', 'list', '--format=json']);
  const problem = commandProblem(result, 'Listing Cloud projects');
  if (problem) {
    return { ok: false, problem, fix: 'Make sure gcloud is authenticated (gcloud auth list), then try again.' };
  }
  const parsed = parseGcloudJson(result.stdout);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    return {
      ok: false,
      problem: 'Could not parse the output of gcloud projects list as JSON.',
      fix: 'Run gcloud projects list --format=json directly and check its output.',
    };
  }
  const entries = parsed.value as readonly GcloudProjectEntry[];
  const projects: GcloudProject[] = [];
  for (const entry of entries) {
    if (typeof entry.projectId !== 'string') continue;
    projects.push({
      projectId: entry.projectId,
      ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
    });
  }
  return { ok: true, projects };
}

export interface SelectOrCreateOptions {
  readonly preferredPrefix: string;
}
export interface ProjectReused {
  readonly ok: true;
  readonly outcome: 'reused';
  readonly projectId: string;
}
export interface ProjectCreated {
  readonly ok: true;
  readonly outcome: 'created';
  readonly projectId: string;
}
export interface ProjectSelectFailed {
  readonly ok: false;
  readonly problem: string;
  readonly fix: string;
}
export type SelectOrCreateResult = ProjectReused | ProjectCreated | ProjectSelectFailed;

/**
 * Idempotent project selection: reuse an existing project whose id starts
 * with `preferredPrefix`, or create one with a random suffix. Re-running
 * this after a project already exists never creates a second one.
 */
export async function selectOrCreateProject(
  port: GoogleCommandPort,
  gcloudPath: string,
  options: SelectOrCreateOptions,
): Promise<SelectOrCreateResult> {
  const existing = await listProjects(port, gcloudPath);
  if (!existing.ok) return existing;
  const match = existing.projects.find((project) => project.projectId.startsWith(options.preferredPrefix));
  if (match) {
    return { ok: true, outcome: 'reused', projectId: match.projectId };
  }

  const suffix = randomSuffix();
  const projectId = `${options.preferredPrefix}-${suffix}`;
  const result = await port.run(gcloudPath, [
    'projects',
    'create',
    projectId,
    '--name=goodvibes agent',
    '--format=json',
  ]);
  const problem = commandProblem(result, 'Creating a Cloud project');
  if (problem) {
    return {
      ok: false,
      problem,
      fix: 'Check that Cloud Resource Manager quota/billing is not blocking project creation, then try again.',
    };
  }
  return { ok: true, outcome: 'created', projectId };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export interface EnabledServicesOk {
  readonly ok: true;
  readonly services: readonly string[];
}
export interface EnabledServicesFailed {
  readonly ok: false;
  readonly problem: string;
  readonly fix: string;
}
export type EnabledServicesResult = EnabledServicesOk | EnabledServicesFailed;

interface GcloudServiceEntry {
  readonly config?: { readonly name?: unknown };
  readonly name?: unknown;
}

/** `gcloud services list --enabled --format=json`, parsed. */
export async function enabledServices(
  port: GoogleCommandPort,
  gcloudPath: string,
  projectId: string,
): Promise<EnabledServicesResult> {
  const result = await port.run(gcloudPath, [
    'services',
    'list',
    '--enabled',
    `--project=${projectId}`,
    '--format=json',
  ]);
  const problem = commandProblem(result, 'Listing enabled services');
  if (problem) {
    return { ok: false, problem, fix: 'Check the project id is correct and gcloud has access to it.' };
  }
  const parsed = parseGcloudJson(result.stdout);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    return {
      ok: false,
      problem: 'Could not parse the output of gcloud services list as JSON.',
      fix: 'Run gcloud services list --enabled --format=json directly and check its output.',
    };
  }
  const entries = parsed.value as readonly GcloudServiceEntry[];
  const services: string[] = [];
  for (const entry of entries) {
    const name = entry.config?.name ?? entry.name;
    if (typeof name === 'string') services.push(name);
  }
  return { ok: true, services };
}

export interface EnableServicesOk {
  readonly ok: true;
  readonly enabled: readonly string[];
  readonly alreadyEnabled: readonly string[];
}
export interface EnableServicesFailed {
  readonly ok: false;
  readonly problem: string;
  readonly fix: string;
}
export type EnableServicesResult = EnableServicesOk | EnableServicesFailed;

/**
 * Idempotent service enablement: diffs against `enabledServices` first and
 * only enables what is missing, reporting which services were already on.
 */
export async function enableServices(
  port: GoogleCommandPort,
  gcloudPath: string,
  projectId: string,
  services: readonly string[],
): Promise<EnableServicesResult> {
  const current = await enabledServices(port, gcloudPath, projectId);
  if (!current.ok) return current;
  const currentSet = new Set(current.services);
  const missing = services.filter((service) => !currentSet.has(service));
  const alreadyEnabled = services.filter((service) => currentSet.has(service));

  if (missing.length === 0) {
    return { ok: true, enabled: [], alreadyEnabled };
  }

  const result = await port.run(
    gcloudPath,
    ['services', 'enable', ...missing, `--project=${projectId}`, '--format=json'],
    { timeoutMs: 120_000 },
  );
  const problem = commandProblem(result, 'Enabling services');
  if (problem) {
    return {
      ok: false,
      problem,
      fix: 'Check that the project has billing enabled and the account has the serviceusage.services.enable permission.',
    };
  }
  return { ok: true, enabled: missing, alreadyEnabled };
}
