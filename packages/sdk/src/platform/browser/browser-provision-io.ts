import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSurfaceDirectory } from '../runtime/surface-root.js';
import { extractTarGzTree } from './browser-driver-archive.js';
import type { BrowserDriverResolution, BrowserProvisionIo, CommandOutcome } from './browser-types.js';

/**
 * The concrete node-side half of provisioning.
 *
 * Everything the provisioning POLICY does is injected through
 * `BrowserProvisionIo`, so the policy is testable with no machine. This file is
 * the factory that fills that record with real process, filesystem and network
 * work, the one place in this module allowed to touch any of them.
 *
 * The Playwright driver is resolved at RUNTIME through a specifier a bundler
 * cannot see. A `bun build --compile` step inlines every statically-named
 * import into one file, and playwright-core cannot survive that: it reads
 * browsers.json and its own driver files relative to its package directory, so
 * a bundled copy would look for files that no longer exist. Splitting the
 * specifier keeps playwright-core an ordinary installed dependency that is
 * required from node_modules exactly the way its own code expects.
 */
const DRIVER_PACKAGE = ['playwright', 'core'].join('-');

/**
 * The driver version this build expects. Kept in step with the dependency in
 * package.json by a test, because a compiled binary has no package.json to read
 * and would otherwise install whatever npm happened to consider latest.
 */
export const DRIVER_VERSION = '1.62.0';

const requireFromEngine = createRequire(import.meta.url);

interface DriverModule {
  readonly chromium: { readonly executablePath: () => string };
}

/** Which surface's storage a driver search or install belongs to. */
export interface BrowserDriverLocation {
  /**
   * The product's storage root segment under `~/.goodvibes/`, the formalized
   * surface-scoped mechanism, so no product's driver lands in another's
   * directory and this module never has to know any product's name.
   */
  readonly surfaceRoot: string;
  /** Home directory owning that storage. Defaults to this process's HOME. */
  readonly homeDirectory?: string | undefined;
}

/**
 * Where the driver lives when this build is a compiled binary.
 *
 * A single-file executable has no node_modules, so `require('playwright-core')`
 * finds nothing and browser control would silently not exist in the shipped
 * artifact. These are the places a driver can be instead: shipped beside the
 * executable, provisioned into the surface's own storage, or pointed at
 * explicitly. Resolution tries the ordinary module path first, so an npm
 * install behaves exactly as before.
 */
export function driverSearchDirectories(location?: BrowserDriverLocation): readonly string[] {
  const executableDirectory = dirname(process.execPath);
  const override = process.env.GOODVIBES_PLAYWRIGHT_CORE?.trim();
  const home = location?.homeDirectory ?? process.env.HOME ?? '';
  const surfaceRoot = location?.surfaceRoot;
  return [
    ...(override ? [override] : []),
    join(executableDirectory, DRIVER_PACKAGE),
    join(executableDirectory, 'vendor', DRIVER_PACKAGE),
    join(executableDirectory, 'node_modules', DRIVER_PACKAGE),
    // Only this last candidate needs to know whose storage it is looking in.
    // The three above are properties of the executable, so a caller that has
    // no surface still gets the driver staged beside the binary, losing that
    // would make browser control silently absent in exactly the shipped
    // artifact this search exists for.
    ...(home && surfaceRoot ? [join(managedDriverRoot(home, surfaceRoot), 'node_modules', DRIVER_PACKAGE)] : []),
  ];
}

/** Where a driver is installed for this surface when nothing ships one. */
export function managedDriverRoot(homeDirectory: string, surfaceRoot: string): string {
  return resolveSurfaceDirectory(homeDirectory, surfaceRoot, 'browser', 'driver');
}

/**
 * A candidate directory counts as a driver only if it holds everything the
 * driver is used for: the manifest, the module entry, AND the CLI the browser
 * install step executes.
 *
 * Requiring cli.js here is load-bearing. The search stops at the first match,
 * so a directory that satisfied a weaker test, a partial extraction, or an
 * older release's incomplete driver, used to shadow a perfectly good driver
 * further down the list and could not be recovered from: resolveDriver would
 * reject it for the missing cli.js, provisioning would install a working copy
 * into the managed directory, and the search would hand back the broken one
 * again on the very next call. Skipping an unusable candidate lets the next one
 * win, and lets self-provisioning actually take effect.
 */
export const DRIVER_REQUIRED_FILES: readonly string[] = ['package.json', 'index.js', 'cli.js'];

function driverDirectoryFrom(candidate: string): string | null {
  const complete = DRIVER_REQUIRED_FILES.every((file) => existsSync(join(candidate, file)));
  return complete ? candidate : null;
}

/** The driver package directory, wherever it turns out to be. */
export function findDriverDirectory(
  location: BrowserDriverLocation | undefined,
  searchDirectories?: readonly string[],
): string | null {
  if (!searchDirectories) {
    try {
      const manifestPath = requireFromEngine.resolve(`${DRIVER_PACKAGE}/package.json`);
      return manifestPath.slice(0, manifestPath.length - '/package.json'.length);
    } catch {
      // Not resolvable as a module, expected inside a compiled binary.
    }
  }
  const candidates = searchDirectories ?? driverSearchDirectories(location);
  for (const candidate of candidates) {
    const found = driverDirectoryFrom(candidate);
    if (found) return found;
  }
  return null;
}

export function loadDriverModule(location: BrowserDriverLocation): DriverModule | null {
  try {
    return requireFromEngine(DRIVER_PACKAGE) as DriverModule;
  } catch {
    // Fall through to the on-disk locations.
  }
  const directory = findDriverDirectory(location);
  if (!directory) return null;
  try {
    const requireFromDriver = createRequire(pathToFileURL(join(directory, 'package.json')).href);
    return requireFromDriver(directory) as DriverModule;
  } catch {
    return null;
  }
}

export function resolveDriver(location: BrowserDriverLocation): BrowserDriverResolution {
  const packageDirectory = findDriverDirectory(location);
  if (!packageDirectory) {
    return {
      available: false,
      packageDirectory: null,
      cliPath: null,
      version: null,
      error: `${DRIVER_PACKAGE} was not found next to the executable, in this surface's driver directory, or as an installed module`,
    };
  }
  try {
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as { readonly version?: unknown };
    const cliPath = join(packageDirectory, 'cli.js');
    return {
      available: existsSync(cliPath),
      packageDirectory,
      cliPath: existsSync(cliPath) ? cliPath : null,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      error: existsSync(cliPath) ? null : `${DRIVER_PACKAGE} is present but its cli.js is missing`,
    };
  } catch (error) {
    return {
      available: false,
      packageDirectory,
      cliPath: null,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Playwright's own browser cache location, honoring the standard override.
 * The home directory is passed in rather than discovered, so the cache a build
 * uses is always something its composition root chose.
 */
export function defaultBrowsersPath(homeDirectory: string): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override.trim() && override.trim() !== '0') return override.trim();
  if (platform() === 'darwin') return join(homeDirectory, 'Library', 'Caches', 'ms-playwright');
  if (platform() === 'win32') return join(homeDirectory, 'AppData', 'Local', 'ms-playwright');
  return join(homeDirectory, '.cache', 'ms-playwright');
}

function expectedExecutablePath(location: BrowserDriverLocation): string | null {
  const driver = loadDriverModule(location);
  if (!driver) return null;
  try {
    return driver.chromium.executablePath();
  } catch {
    return null;
  }
}

/**
 * Browsers already installed on the machine, used when a managed download is
 * impossible (offline, blocked registry). Order is deliberate: Chromium and
 * Chrome first because the automation surface targets Chromium's CDP.
 */
const SYSTEM_BROWSER_PATHS: readonly string[] = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/brave-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function directoryWritable(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one command and waits for it.
 *
 * The timeout signals THIS child and nothing else: no process-group signal, no
 * name matching, no sweep of other processes. A provisioning timeout can never
 * reach a browser, the failure mode that killed a live logged-in browser
 * session before this capability existed.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly env?: Readonly<Record<string, string>>; readonly cwd?: string },
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(command, [...args], {
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);
    const settle = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      settle({ code: null, stdout, stderr, timedOut, spawnError: error.message });
    });
    child.on('close', (code) => {
      settle({ code, stdout, stderr, timedOut, spawnError: null });
    });
  });
}

export interface BrowserProvisionIoOptions {
  /** Home directory owning the managed browser cache. */
  readonly homeDirectory: string;
  /**
   * The product's storage root segment under `~/.goodvibes/`. Required, because
   * a self-installed driver has to land somewhere a specific product owns.
   */
  readonly surfaceRoot: string;
  /**
   * What to tell someone whose driver is neither present nor installable,
   * phrased for how THIS build was installed. Optional: without one the
   * provisioning policy falls back to a generic sentence.
   */
  readonly driverFix?: (() => string) | undefined;
}

/** Where the driver package is published. Pinned to the version this build expects. */
export function driverTarballUrl(version: string = DRIVER_VERSION): string {
  return `https://registry.npmjs.org/${DRIVER_PACKAGE}/-/${DRIVER_PACKAGE}-${version}.tgz`;
}

const DRIVER_DOWNLOAD_TIMEOUT_MS = 180_000;

/**
 * Downloads the driver package straight from the registry and writes it into
 * place, with no package manager involved.
 *
 * This is the route that makes provisioning work on a machine that has only the
 * downloaded binary, no bun, no npm, no node_modules anywhere. The tarball is
 * extracted into a scratch directory beside the target and moved into place
 * only after the files that matter are confirmed present, so a download that
 * dies halfway can never leave a directory that resolves as a driver but fails
 * on first use.
 */
async function downloadDriverPackage(targetRoot: string): Promise<CommandOutcome> {
  const finalDirectory = join(targetRoot, 'node_modules', DRIVER_PACKAGE);
  const staging = join(targetRoot, `.${DRIVER_PACKAGE}-incoming`);
  const url = driverTarballUrl();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(DRIVER_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
      return { code: 1, stdout: '', stderr: `download failed (${response.status}) for ${url}`, timedOut: false, spawnError: null };
    }
    const archive = Buffer.from(await response.arrayBuffer());
    rmSync(staging, { recursive: true, force: true });
    // npm tarballs put everything under `package/`; dropping that component
    // lands the driver's own files directly in the directory that gets moved.
    const extracted = extractTarGzTree(archive, staging, { stripComponents: 1 });
    for (const required of ['package.json', 'index.js', 'cli.js']) {
      if (!existsSync(join(staging, required))) {
        rmSync(staging, { recursive: true, force: true });
        return {
          code: 1,
          stdout: '',
          stderr: `the downloaded driver package is missing ${required}`,
          timedOut: false,
          spawnError: null,
        };
      }
    }
    mkdirSync(dirname(finalDirectory), { recursive: true });
    rmSync(finalDirectory, { recursive: true, force: true });
    renameSync(staging, finalDirectory);
    return {
      code: 0,
      stdout: `downloaded ${DRIVER_PACKAGE}@${DRIVER_VERSION} from the npm registry (${extracted.files} files) into ${finalDirectory}`,
      stderr: '',
      timedOut: false,
      spawnError: null,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, stdout: '', stderr: `${url}: ${message}`, timedOut: false, spawnError: null };
  }
}

/**
 * Installs the driver into a directory this surface owns.
 *
 * Used when nothing shipped one. Three routes are tried in order, and the first
 * that works wins:
 *
 *   1. a direct registry download, which needs nothing installed on the machine;
 *   2. `bun add`, when bun is present;
 *   3. `npm install`, when npm is present.
 *
 * The direct download goes first deliberately: it is the only route that works
 * on a machine holding nothing but the downloaded binary, and it writes only
 * inside the surface's own directory rather than through a package manager's
 * global state. The package managers stay as fallbacks for a machine where the
 * registry is reachable only through their configuration (a private mirror, an
 * authenticated proxy).
 *
 * The failure returned is the LAST route's, with every route's reason in stderr,
 * so a caller reports what actually stopped it rather than "no package manager".
 */
async function installDriverPackage(targetRoot: string): Promise<CommandOutcome> {
  mkdirSync(targetRoot, { recursive: true });
  const specifier = `${DRIVER_PACKAGE}@${DRIVER_VERSION}`;
  const download = await downloadDriverPackage(targetRoot);
  if (download.code === 0) return download;
  const reasons: string[] = [`registry download: ${download.stderr.trim() || 'failed'}`];
  const attempts: readonly (readonly [string, readonly string[]])[] = [
    ['bun', ['add', '--no-save', specifier]],
    ['npm', ['install', '--no-save', '--prefix', targetRoot, specifier]],
  ];
  for (const [command, args] of attempts) {
    const outcome = await runCommand(command, args, { timeoutMs: 300_000, cwd: targetRoot });
    if (outcome.code === 0) {
      return { ...outcome, stdout: outcome.stdout || `installed ${specifier} with ${command}` };
    }
    // Bun reports a missing program as `Executable not found in $PATH: "npm"`,
    // not as ENOENT, so matching ENOENT alone handed back that raw string
    // instead of the plain "not installed on this machine" this is meant to say.
    const missing = outcome.spawnError !== null
      && (/ENOENT/i.test(outcome.spawnError) || /not found in \$PATH/i.test(outcome.spawnError));
    reasons.push(missing
      ? `${command}: not installed on this machine`
      : `${command}: ${(outcome.spawnError ?? (outcome.stderr.trim() || `exited with code ${String(outcome.code)}`)).split('\n')[0] ?? 'failed'}`);
  }
  return { code: 1, stdout: '', stderr: reasons.join('; '), timedOut: false, spawnError: null };
}

/**
 * Makes the chosen browser cache the one the driver actually uses.
 *
 * `defaultBrowsersPath` is derived from the home directory the composition root
 * chose, but the driver resolves its own cache independently, and the two do
 * NOT always agree: with a surface-specific home, or any home that is not the
 * one the driver computes, provisioning downloaded into one directory while
 * `chromium.executablePath()` pointed at another. That reads as "the install
 * succeeded but no browser executable is present afterwards", and it can also
 * silently drive a browser from a cache this process was not told to use.
 *
 * Publishing the path as the standard override, once, and only when nothing has
 * set it, removes the disagreement: the driver, the install step, and the report
 * all name the same directory. An explicit PLAYWRIGHT_BROWSERS_PATH from the
 * user still wins, because defaultBrowsersPath honors it first.
 */
function publishBrowsersPath(homeDirectory: string): string {
  const resolved = defaultBrowsersPath(homeDirectory);
  const existing = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (!existing || existing === '0') process.env.PLAYWRIGHT_BROWSERS_PATH = resolved;
  return resolved;
}

export function createBrowserProvisionIo(options: BrowserProvisionIoOptions): BrowserProvisionIo {
  const browsersPath = publishBrowsersPath(options.homeDirectory);
  const location: BrowserDriverLocation = {
    surfaceRoot: options.surfaceRoot,
    homeDirectory: options.homeDirectory,
  };
  return {
    installDriver: (targetRoot) => installDriverPackage(targetRoot),
    managedDriverRoot: () => managedDriverRoot(options.homeDirectory, options.surfaceRoot),
    // Injected rather than imported by the provisioning policy, so the policy
    // stays free of any surface's install layout and still reports a fix that
    // matches how THIS install got here.
    ...(options.driverFix ? { driverFix: options.driverFix } : {}),
    resolveDriver: () => resolveDriver(location),
    expectedExecutablePath: () => expectedExecutablePath(location),
    browsersPath: () => browsersPath,
    pathExists: (path) => existsSync(path),
    isExecutableFile,
    directoryWritable,
    removePath: (path) => {
      rmSync(path, { recursive: true, force: true });
    },
    runCommand,
    systemBrowserCandidates: () => SYSTEM_BROWSER_PATHS.filter(isExecutableFile),
    now: () => Date.now(),
  };
}
