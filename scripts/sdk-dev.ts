#!/usr/bin/env bun
/**
 * sdk-dev — the canonical local-SDK overlay tool (see CHANGELOG 1.0.0).
 *
 * Consolidates what were three independently-drifted copies (TUI 154 lines,
 * agent 172 lines, webui 114 lines) into ONE tool that ships FROM the SDK.
 * Each consumer's own scripts/sdk-dev.ts is now a one-line alias that locates
 * this file (via GOODVIBES_SDK_PATH, default ~/Projects/goodvibes-sdk) and
 * forwards to it with the consumer repo as cwd — see the alias template this
 * brief installs in TUI/agent/webui.
 *
 * `link`    Build the local SDK checkout and overlay dist + package.json for
 *           EVERY public workspace package (enumerated from packages/*, not
 *           hardcoded — a 10th @pellux package needs no consumer edit) into
 *           the caller's node_modules/@pellux/<pkg>, so SDK changes are
 *           testable immediately — no npm release round-trip.
 * `status`  Report whether the overlay is active and what it was built from.
 * `restore` Remove the overlay and reinstall the pinned npm version byte-exact.
 *
 * Discipline preserved from the TUI's copy (the most-correct of the three):
 *  - unlink-before-copy: bun hardlinks node_modules package files to
 *    its global install cache (~/.bun/install/cache/...). Overwriting a file
 *    IN PLACE (cpSync onto an existing file) writes through that hardlink and
 *    silently corrupts the shared cache entry for the pinned npm version —
 *    poisoning every other project on the machine that resolves it. Always
 *    rm the destination first so cpSync creates a fresh inode.
 *  - all-siblings overlay: refreshing only goodvibes-sdk leaves sibling
 *    packages (contracts, transport-*, operator-sdk, ...) at their stale
 *    published build, so a consumer's real-HTTP-client test can validate the
 *    local SDK's records against an OLD wire schema (a transport-parity test
 *    rejected a new field because only goodvibes-sdk was overlaid). This was
 *    already true in the TUI's copy but NEVER true in agent/webui's copies —
 *    the live re-sync gap this brief closes.
 *  - precise restore: the marker records exactly which packages were
 *    overlaid, so `restore` removes exactly those and nothing else.
 *
 * The overlay writes a marker file (.local-sdk-overlay.json) inside the main
 * package directory (node_modules/@pellux/goodvibes-sdk). Every consumer's
 * release gate (TUI publish-check.ts, agent sdk-release-gates.ts, webui
 * release-gate.ts) reads that marker path directly and hard-fails while it
 * exists, or while the pin is anything but an exact semver — so the fast path
 * can never leak into a release. Those gates are untouched by this
 * consolidation: the marker's location and shape are unchanged, so nothing
 * downstream needed to move.
 *
 * NOT shipped as a published SDK `bin`: this tool's entire job is to overlay
 * the LOCAL checkout, so it must exec the checkout's own script, never a
 * stale installed package. A consumer's alias resolves the checkout path and
 * runs THIS file directly out of it.
 *
 * Divergence note (both "legit consumer differences" the brief flagged
 * collapsed rather than needing a config knob):
 *  - agent's SDK pin lives in devDependencies (bundled into the compiled
 *    binary, not a runtime dependency). readSdkPin() below checks
 *    devDependencies before dependencies UNCONDITIONALLY, which is a safe
 *    generalization for all three consumers: TUI/webui only have the pin in
 *    dependencies, so the devDependencies lookup is simply undefined there
 *    and falls through. No per-consumer flag needed.
 *  - webui's build-time overlay guard (GOODVIBES_ALLOW_OVERLAY_BUILD escape)
 *    lives entirely in webui's vite.config.ts, which reads the marker file
 *    path directly and does not import anything from sdk-dev.ts. It needs no
 *    parameterization here at all — verified read-only, untouched.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * This file's own SDK checkout root. Honors GOODVIBES_SDK_PATH so tests (and
 * a consumer's alias, which sets the same env var to locate this file in the
 * first place) can override it, but defaults to self-location — this copy
 * lives INSIDE the checkout, unlike the three consumer copies it replaces,
 * so it never needs to guess a homedir path for itself.
 */
export const SDK_ROOT: string = process.env.GOODVIBES_SDK_PATH
  ? resolve(process.env.GOODVIBES_SDK_PATH)
  : resolve(__dirname, '..');

export interface WorkspacePackage {
  /** node_modules basename under @pellux, e.g. "goodvibes-sdk". */
  readonly nm: string;
  /** packages/<dir> in the SDK checkout. */
  readonly dir: string;
}

/**
 * Enumerate every PUBLIC workspace package under packages/* — replacing the
 * hardcoded 9-package array the TUI's copy carried. A 10th @pellux package
 * is picked up automatically the moment it exists on disk with
 * publishConfig.access:"public"; no consumer script needs an edit. Private/
 * internal packages are excluded by construction.
 */
export function enumerateWorkspacePackages(sdkRoot: string): WorkspacePackage[] {
  const packagesDir = join(sdkRoot, 'packages');
  const out: WorkspacePackage[] = [];
  if (!existsSync(packagesDir)) return out;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    let pkg: { name?: string; private?: boolean; publishConfig?: { access?: string } };
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.name || pkg.private || pkg.publishConfig?.access !== 'public') continue;
    const nm = pkg.name.startsWith('@pellux/') ? pkg.name.slice('@pellux/'.length) : pkg.name;
    out.push({ nm, dir: entry.name });
  }
  // Deterministic order: goodvibes-sdk first (the package the marker/fail
  // checks key off of), then the rest alphabetically.
  out.sort((a, b) => (a.nm === 'goodvibes-sdk' ? -1 : b.nm === 'goodvibes-sdk' ? 1 : a.nm.localeCompare(b.nm)));
  return out;
}

/** Read the SDK pin: devDependencies first (agent bundles the SDK there), then dependencies. */
export function readSdkPin(consumerRoot: string): string | undefined {
  const pkg = JSON.parse(readFileSync(join(consumerRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return pkg.devDependencies?.['@pellux/goodvibes-sdk'] ?? pkg.dependencies?.['@pellux/goodvibes-sdk'];
}

export interface OverlayStatus {
  readonly active: boolean;
  readonly line: string;
  readonly exitCode: number;
}

/**
 * Decide the `status` output purely from inputs: the marker file contents
 * (null when absent) and the installed package version. Overlay active →
 * exit 2; clean npm state → exit 0. Extracted so the three lifecycle states
 * are testable without a real SDK build or node_modules mutation.
 */
export function overlayStatus(markerRaw: string | null, installedVersion: string | undefined): OverlayStatus {
  if (markerRaw !== null) {
    const m = JSON.parse(markerRaw) as { sdkGit?: string; overlaidAt?: string; sourcePath?: string };
    return {
      active: true,
      line: `sdk-dev: OVERLAY ACTIVE — ${m.sdkGit}, overlaid ${m.overlaidAt} from ${m.sourcePath}`,
      exitCode: 2,
    };
  }
  return {
    active: false,
    line: `sdk-dev: clean — npm @pellux/goodvibes-sdk@${installedVersion} installed.`,
    exitCode: 0,
  };
}

/** After a restore reinstall, the reinstalled version must equal the pin. Returns an issue string or null. */
export function restoreVersionIssue(restoredVersion: string | undefined, pinned: string | undefined): string | null {
  return restoredVersion !== pinned
    ? `restored version ${String(restoredVersion)} does not match pinned ${String(pinned)}`
    : null;
}

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function fail(msg: string): never {
  console.error(`sdk-dev: ${msg}`);
  process.exit(1);
}

/**
 * Overlay one monorepo package's dist + package.json into a consumer's
 * node_modules. MUST unlink package.json (and the dist dir) before copying —
 * see the cache-safety note in the file header. Returns false when the
 * package is not installed in this consumer / not built in the SDK (skip;
 * not every consumer depends on every sibling package).
 */
export function overlayPackage(consumerRoot: string, sdkRoot: string, pkg: WorkspacePackage): boolean {
  const installed = join(consumerRoot, 'node_modules/@pellux', pkg.nm);
  const dist = join(sdkRoot, 'packages', pkg.dir, 'dist');
  const pkgJson = join(sdkRoot, 'packages', pkg.dir, 'package.json');
  if (!existsSync(installed) || !existsSync(dist)) return false;
  rmSync(join(installed, 'dist'), { recursive: true, force: true });
  cpSync(dist, join(installed, 'dist'), { recursive: true });
  rmSync(join(installed, 'package.json'), { force: true });
  cpSync(pkgJson, join(installed, 'package.json'));
  return true;
}

export function markerPath(consumerRoot: string): string {
  return join(consumerRoot, 'node_modules/@pellux/goodvibes-sdk/.local-sdk-overlay.json');
}

async function link(consumerRoot: string, sdkRoot: string): Promise<void> {
  if (!existsSync(sdkRoot)) fail(`local SDK checkout not found at ${sdkRoot} (set GOODVIBES_SDK_PATH to override)`);
  const installedSdkPkg = join(consumerRoot, 'node_modules/@pellux/goodvibes-sdk');
  if (!existsSync(installedSdkPkg)) fail('node_modules/@pellux/goodvibes-sdk missing — run bun install first');

  const sha = sh('git rev-parse --short HEAD', sdkRoot);
  const branch = sh('git rev-parse --abbrev-ref HEAD', sdkRoot);
  const dirty = sh('git status --porcelain', sdkRoot) ? 'dirty' : 'clean';

  console.log(`sdk-dev: building local SDK (${branch}@${sha}, ${dirty} tree)...`);
  // NOT wrapped in an extra workspace lock here: scripts/build.ts already
  // acquires the SDK's own build lock internally (withWorkspaceLock('build',
  // ...)). Locking again around this execSync call would be a SEPARATE
  // acquisition in the parent process racing the child's own acquisition of
  // the SAME lock directory — a deadlock, not extra safety. Two consumers
  // linking concurrently still serialize correctly through build.ts's lock.
  execSync('bun run build && bun run prepare:sdk', { cwd: sdkRoot, stdio: 'inherit' });
  if (!existsSync(join(sdkRoot, 'packages/sdk/dist'))) fail('SDK build produced no dist at packages/sdk/dist');

  const packages = enumerateWorkspacePackages(sdkRoot);
  const overlaid: string[] = [];
  for (const pkg of packages) {
    if (overlayPackage(consumerRoot, sdkRoot, pkg)) overlaid.push(pkg.nm);
  }
  if (!overlaid.includes('goodvibes-sdk')) fail('goodvibes-sdk overlay failed — is node_modules populated?');
  console.log(`sdk-dev: overlaid ${overlaid.length} package(s): ${overlaid.join(', ')}`);

  writeFileSync(markerPath(consumerRoot), JSON.stringify({
    sourcePath: sdkRoot,
    sdkGit: `${branch}@${sha} (${dirty})`,
    overlaidAt: new Date().toISOString(),
    overlaidPackages: overlaid,
    note: 'Local SDK overlay active. Run `bun scripts/sdk-dev.ts restore` before releasing; release gates fail while this file exists.',
  }, null, 2));

  console.log(`sdk-dev: LINKED — ${branch}@${sha} (${dirty}) now overlaid into this repo.`);
  console.log('sdk-dev: run `bun scripts/sdk-dev.ts restore` to return to the pinned npm version.');
}

function status(consumerRoot: string): number {
  const marker = markerPath(consumerRoot);
  const markerRaw = existsSync(marker) ? readFileSync(marker, 'utf8') : null;
  const installedPkgJson = join(consumerRoot, 'node_modules/@pellux/goodvibes-sdk/package.json');
  const installedVersion = existsSync(installedPkgJson)
    ? (JSON.parse(readFileSync(installedPkgJson, 'utf8')) as { version?: string }).version
    : undefined;
  const result = overlayStatus(markerRaw, installedVersion);
  console.log(result.line);
  return result.exitCode;
}

async function restore(consumerRoot: string): Promise<void> {
  const marker = markerPath(consumerRoot);
  if (!existsSync(marker)) {
    console.log('sdk-dev: no overlay active; nothing to restore.');
    return;
  }
  console.log('sdk-dev: removing overlay and reinstalling from lockfile...');
  // Remove every package the overlay may have touched (the marker records
  // what was overlaid; fall back to the full enumerated set for markers
  // written before this field existed, or if the SDK checkout used at
  // restore time differs from the one used at link time) so no sibling is
  // left at the local build after restore.
  let overlaidPackages: string[];
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { overlaidPackages?: unknown };
    overlaidPackages = Array.isArray(parsed.overlaidPackages)
      ? parsed.overlaidPackages.filter((v): v is string => typeof v === 'string')
      : enumerateWorkspacePackages(SDK_ROOT).map((p) => p.nm);
  } catch {
    overlaidPackages = enumerateWorkspacePackages(SDK_ROOT).map((p) => p.nm);
  }
  for (const nm of overlaidPackages) {
    rmSync(join(consumerRoot, 'node_modules/@pellux', nm), { recursive: true, force: true });
  }
  execSync('bun install', { cwd: consumerRoot, stdio: 'inherit' });
  if (existsSync(marker)) fail('marker still present after reinstall — restore failed');
  const installedPkgJson = join(consumerRoot, 'node_modules/@pellux/goodvibes-sdk/package.json');
  const installedVersion = existsSync(installedPkgJson)
    ? (JSON.parse(readFileSync(installedPkgJson, 'utf8')) as { version?: string }).version
    : undefined;
  const pinned = readSdkPin(consumerRoot);
  const issue = restoreVersionIssue(installedVersion, pinned);
  if (issue) fail(issue);
  console.log(`sdk-dev: RESTORED — npm @pellux/goodvibes-sdk@${installedVersion}.`);
}

/**
 * Entry point a consumer's alias calls directly (in-process; this file is
 * dynamically resolved and its CLI dispatch driven from here rather than
 * relying on import.meta.main, which would be false when imported). Also
 * used by this file's own `if (import.meta.main)` block below when the SDK
 * repo invokes it directly. Returns the process exit code; callers decide
 * whether to actually exit (this file's own CLI block does).
 */
export async function runSdkDev(argv: readonly string[], consumerRoot: string): Promise<number> {
  const cmd = argv[0];
  if (cmd === 'link') {
    await link(consumerRoot, SDK_ROOT);
    return 0;
  }
  if (cmd === 'status') {
    return status(consumerRoot);
  }
  if (cmd === 'restore') {
    await restore(consumerRoot);
    return 0;
  }
  console.log('usage: bun scripts/sdk-dev.ts <link|status|restore>');
  return cmd ? 1 : 0;
}

if (import.meta.main) {
  const code = await runSdkDev(process.argv.slice(2), process.cwd());
  process.exit(code);
}
