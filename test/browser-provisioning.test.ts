import { describe, expect, test } from 'bun:test';
import { ensureBrowserBinary } from '../packages/sdk/src/platform/browser/browser-provisioning.js';
import type { BrowserProvisionIo, CommandOutcome } from '../packages/sdk/src/platform/browser/browser-types.js';

const BROWSERS_PATH = '/cache/ms-playwright';
const EXECUTABLE = `${BROWSERS_PATH}/chromium-1234/chrome-linux64/chrome`;

interface FakeState {
  readonly existing: Set<string>;
  readonly executable: Set<string>;
  readonly removed: string[];
  readonly commands: { command: string; args: readonly string[] }[];
  writable: boolean;
  systemBrowsers: readonly string[];
  driverAvailable: boolean;
  versionProbe: CommandOutcome;
  install: CommandOutcome;
  /** Files the install creates when it succeeds. */
  installCreates: readonly string[];
}

function outcome(overrides: Partial<CommandOutcome> = {}): CommandOutcome {
  return { code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null, ...overrides };
}

function createFakeIo(overrides: Partial<FakeState> = {}): { io: BrowserProvisionIo; state: FakeState } {
  const state: FakeState = {
    existing: new Set<string>(),
    executable: new Set<string>(),
    removed: [],
    commands: [],
    writable: true,
    systemBrowsers: [],
    driverAvailable: true,
    versionProbe: outcome({ stdout: 'Chromium 151.0' }),
    install: outcome({ stdout: 'downloaded chromium' }),
    installCreates: [EXECUTABLE],
    ...overrides,
  };
  const io: BrowserProvisionIo = {
    resolveDriver: () => state.driverAvailable
      ? { available: true, packageDirectory: '/pkg', cliPath: '/pkg/cli.js', version: '1.62.0', error: null }
      : { available: false, packageDirectory: null, cliPath: null, version: null, error: 'not installed' },
    expectedExecutablePath: () => EXECUTABLE,
    browsersPath: () => BROWSERS_PATH,
    pathExists: (path) => state.existing.has(path),
    isExecutableFile: (path) => state.executable.has(path),
    directoryWritable: () => state.writable,
    removePath: (path) => {
      state.removed.push(path);
      for (const entry of [...state.existing]) {
        if (entry.startsWith(path)) state.existing.delete(entry);
      }
    },
    runCommand: async (command, args) => {
      state.commands.push({ command, args });
      if (args.includes('install')) {
        if (state.install.code === 0) {
          for (const created of state.installCreates) {
            state.existing.add(created);
            state.executable.add(created);
          }
        }
        return state.install;
      }
      return state.versionProbe;
    },
    systemBrowserCandidates: () => state.systemBrowsers,
    now: () => 0,
  };
  return { io, state };
}

describe('browser provisioning', () => {
  test('uses the cached browser without downloading anything', async () => {
    const { io, state } = createFakeIo();
    state.existing.add(EXECUTABLE);
    state.executable.add(EXECUTABLE);

    const report = await ensureBrowserBinary(io);

    expect(report.ok).toBe(true);
    expect(report.source).toBe('managed-cache');
    expect(report.executablePath).toBe(EXECUTABLE);
    expect(state.commands.some((entry) => entry.args.includes('install'))).toBe(false);
  });

  test('installs the browser on a machine that has none, then verifies it', async () => {
    const { io, state } = createFakeIo();

    const report = await ensureBrowserBinary(io);

    expect(report.ok).toBe(true);
    expect(report.source).toBe('managed-download');
    expect(state.commands.some((entry) => entry.args.includes('install'))).toBe(true);
    // The install is not trusted on its own: the binary is run before use.
    expect(report.steps.map((step) => step.step)).toContain('verify-install');
  });

  test('deletes a partial download and reinstalls instead of failing forever', async () => {
    const { io, state } = createFakeIo();
    // A build directory exists but the executable inside it does not: the
    // shape a cancelled or truncated download leaves behind.
    state.existing.add(`${BROWSERS_PATH}/chromium-1234`);

    const report = await ensureBrowserBinary(io);

    expect(report.ok).toBe(true);
    expect(state.removed).toEqual([`${BROWSERS_PATH}/chromium-1234`]);
    expect(state.commands.some((entry) => entry.args.includes('--force'))).toBe(true);
    expect(report.steps.some((step) => step.step === 'self-heal')).toBe(true);
  });

  test('falls back to a browser already on the machine when the download fails', async () => {
    const { io, state } = createFakeIo();
    state.install = outcome({ code: 1, stderr: 'getaddrinfo ENOTFOUND cdn.playwright.dev' });
    state.installCreates = [];
    state.systemBrowsers = ['/usr/bin/chromium'];
    state.existing.add('/usr/bin/chromium');
    state.executable.add('/usr/bin/chromium');

    const report = await ensureBrowserBinary(io);

    expect(report.ok).toBe(true);
    expect(report.source).toBe('system-browser');
    expect(report.executablePath).toBe('/usr/bin/chromium');
  });

  test('names the network as the blocker when nothing can be downloaded or found', async () => {
    const { io, state } = createFakeIo();
    state.install = outcome({ code: 1, stderr: 'getaddrinfo ENOTFOUND cdn.playwright.dev' });
    state.installCreates = [];

    const report = await ensureBrowserBinary(io);

    expect(report.ok).toBe(false);
    expect(report.failure).toBe('download-blocked-offline');
    expect(report.problem).toContain('could not reach');
    expect(report.fix).toContain('package manager');
  });

  test('names the missing system library rather than reporting a generic failure', async () => {
    const { io, state } = createFakeIo();
    state.existing.add(EXECUTABLE);
    state.executable.add(EXECUTABLE);
    state.versionProbe = outcome({
      code: 127,
      stderr: 'chrome: error while loading shared libraries: libnss3.so: cannot open shared object file',
    });

    const report = await ensureBrowserBinary(io);

    expect(report.ok).toBe(false);
    expect(report.failure).toBe('missing-system-libraries');
    expect(report.problem).toContain('libnss3.so');
    expect(report.fix).toContain('libnss3');
  });

  test('uses an installed browser when the managed cache is not writable', async () => {
    const { io, state } = createFakeIo();
    state.writable = false;
    state.systemBrowsers = ['/usr/bin/google-chrome'];
    state.existing.add('/usr/bin/google-chrome');
    state.executable.add('/usr/bin/google-chrome');

    const report = await ensureBrowserBinary(io);

    expect(report.ok).toBe(true);
    expect(report.source).toBe('system-browser');
  });

  test('reports the unwritable cache with its fix when there is no other browser', async () => {
    const { io, state } = createFakeIo();
    state.writable = false;

    const report = await ensureBrowserBinary(io);

    expect(report.ok).toBe(false);
    expect(report.failure).toBe('cache-directory-unwritable');
    expect(report.fix).toContain('PLAYWRIGHT_BROWSERS_PATH');
  });

  test('reports a missing driver as a driver problem, with the fix its host supplied', async () => {
    // The remediation is injected rather than hardcoded, because the right
    // answer depends on how the agent was installed: telling someone who
    // downloaded a release binary to install the npm package silently switches
    // their install method. The policy surfaces whatever its host supplies.
    const { io, state } = createFakeIo();
    state.driverAvailable = false;
    const hostFix = 'Re-run the installer, or extract browser-driver.tar.gz beside the binary.';

    const report = await ensureBrowserBinary({ ...io, driverFix: () => hostFix });

    expect(report.ok).toBe(false);
    expect(report.failure).toBe('driver-missing');
    expect(report.fix).toBe(hostFix);
    // And it is stated as a driver problem, not as the browser being broken.
    expect(report.problem).toContain('browser driver');
  });

  test('every failure carries both a plain-language problem and a named fix', async () => {
    const cases: Partial<FakeState>[] = [
      { driverAvailable: false },
      { writable: false },
      { install: outcome({ code: 1, stderr: 'boom' }), installCreates: [] },
    ];
    for (const overrides of cases) {
      const { io } = createFakeIo(overrides);
      const report = await ensureBrowserBinary(io);
      expect(report.ok).toBe(false);
      expect(report.problem?.length ?? 0).toBeGreaterThan(10);
      expect(report.fix?.length ?? 0).toBeGreaterThan(10);
    }
  });

  test('reports what is present without downloading when downloads are not allowed', async () => {
    const { io, state } = createFakeIo();

    const report = await ensureBrowserBinary(io, { allowDownload: false });

    expect(state.commands.some((entry) => entry.args.includes('install'))).toBe(false);
    expect(report.ok).toBe(false);
  });
});
