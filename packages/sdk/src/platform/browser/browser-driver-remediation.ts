/**
 * What to tell someone whose browser driver is not there, matched to how they
 * actually installed the product they are running.
 *
 * This exists because every driver-missing message once named a single package
 * manager command. That command does work for one install method — but telling
 * someone who downloaded a release binary to install an npm package silently
 * changes their install method, and it is not the fix for their situation. The
 * fix has to name the thing they did.
 *
 * Which install method that is, and what the release calls its assets, are
 * facts about a PRODUCT, not about browsing — the SDK ships no release assets
 * and has no installer. So the shape of the answer lives here and the product
 * supplies the particulars, including the same install-kind detector its own
 * update path uses, so a message here can never disagree with what applying an
 * update would do on the same machine.
 */

/** How a build got onto the machine, as the product's own detector reports it. */
export type BrowserDriverInstallKind = 'binary' | 'global-package' | 'source';

/** The product-specific facts a driver-missing message has to name. */
export interface BrowserDriverInstallProfile {
  /**
   * The product's install-kind detector — the same one its update path uses,
   * so remediation and `update apply` can never describe different machines.
   */
  readonly detectInstallKind: (execPath: string) => BrowserDriverInstallKind;
  /** Release asset carrying the driver, e.g. `browser-driver.tar.gz`. */
  readonly archiveName: string;
  /** Directory the driver is extracted into beside the executable, e.g. `playwright-core`. */
  readonly directoryName: string;
  /** Where that asset is published, e.g. a releases/latest page. */
  readonly releasesUrl: string;
  /** The one-line installer command, e.g. `curl -fsSL https://example/install.sh | sh`. */
  readonly installerCommand: string;
  /** How to reinstall the published package, e.g. `bun add -g @scope/product`. */
  readonly globalPackageCommand: string;
  /** How to install a source checkout's dependencies, e.g. `bun install`. */
  readonly sourceInstallCommand: string;
}

export interface DriverRemediationOptions {
  /** Path of the running executable. Defaults to this process's. */
  readonly execPath?: string;
  /** Directory the driver would be extracted into. Defaults to the executable's. */
  readonly executableDirectory?: string;
}

function executableDirectoryOf(execPath: string): string {
  const separator = execPath.includes('\\') && !execPath.includes('/') ? '\\' : '/';
  const cut = execPath.lastIndexOf(separator);
  return cut <= 0 ? '.' : execPath.slice(0, cut);
}

/**
 * The one sentence to print when the driver could not be found AND could not be
 * provisioned. Provisioning is tried first everywhere this is used, so reaching
 * this text means the automatic path is genuinely unavailable (no network, no
 * package manager, nowhere writable) and the person has to do something.
 */
export function driverRemediation(
  profile: BrowserDriverInstallProfile,
  options: DriverRemediationOptions = {},
): string {
  const execPath = options.execPath ?? process.execPath;
  const directory = options.executableDirectory ?? executableDirectoryOf(execPath);
  switch (profile.detectInstallKind(execPath)) {
    case 'binary':
      return [
        `The driver ships with the release. Re-run the installer (${profile.installerCommand}),`,
        `or download ${profile.archiveName} from ${profile.releasesUrl} and extract it beside the binary`,
        `so that ${directory}/${profile.directoryName}/cli.js exists.`,
        'Installing bun or npm also works: the driver is then installed automatically on the next browser call.',
      ].join(' ');
    case 'global-package':
      return `Reinstall the package so its dependencies are present: ${profile.globalPackageCommand}`;
    case 'source':
      return `Install this checkout's dependencies: ${profile.sourceInstallCommand}`;
  }
}

/**
 * Where the driver would go if the person followed the advice above, for
 * messages that want to name the exact path rather than the whole recipe.
 */
export function shippedDriverPath(
  profile: Pick<BrowserDriverInstallProfile, 'directoryName'>,
  options: DriverRemediationOptions = {},
): string {
  const execPath = options.execPath ?? process.execPath;
  const directory = options.executableDirectory ?? executableDirectoryOf(execPath);
  return `${directory}/${profile.directoryName}`;
}
