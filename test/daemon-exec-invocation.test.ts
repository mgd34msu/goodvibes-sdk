/**
 * daemon-exec-invocation.test.ts
 *
 * The supervised-service ExecStart must be derived from how the daemon process
 * was actually started: a compiled single-file binary launches itself with its
 * real argv (never a reconstructed `run <workingDir>/src/daemon/cli.ts` dev
 * command line), and a source/dev run is recognized as such so it is never
 * promoted into a unit that would fail on the next boot.
 */
import { describe, expect, test } from 'bun:test';
import {
  isCompiledBinaryInvocation,
  resolveDaemonExecInvocation,
} from '../packages/sdk/src/platform/daemon/daemon-exec-invocation.ts';

describe('isCompiledBinaryInvocation', () => {
  test('a source/dev run (bun run <cli.ts>) is NOT a compiled binary', () => {
    expect(isCompiledBinaryInvocation({ execPath: '/usr/local/bin/bun', argv: ['/usr/local/bin/bun', '/home/u/proj/src/daemon/cli.ts', 'daemon'] })).toBe(false);
    expect(isCompiledBinaryInvocation({ execPath: '/usr/bin/node', argv: ['/usr/bin/node', '/home/u/proj/dist/cli.js'] })).toBe(false);
  });

  test('a compiled binary is recognized: bare launch, subcommand argv, or an embedded entry', () => {
    // Launched as a bare binary (no entry).
    expect(isCompiledBinaryInvocation({ execPath: '/opt/app/goodvibes', argv: ['/opt/app/goodvibes'] })).toBe(true);
    // Binary with a subcommand (argv[1] is not a source file).
    expect(isCompiledBinaryInvocation({ execPath: '/opt/app/goodvibes', argv: ['/opt/app/goodvibes', 'daemon', '--port', '3421'] })).toBe(true);
    // Bun single-file executable: the embedded entry lives in a virtual FS.
    expect(isCompiledBinaryInvocation({ execPath: '/opt/app/goodvibes', argv: ['/opt/app/goodvibes', '/$bunfs/root/cli.ts'] })).toBe(true);
  });
});

describe('resolveDaemonExecInvocation', () => {
  test('a compiled binary launches ITSELF with its real args — no source-file path', () => {
    const inv = resolveDaemonExecInvocation(
      { execPath: '/opt/app/goodvibes', argv: ['/opt/app/goodvibes', 'daemon', '--port', '3421'] },
      '/home/u/proj',
    );
    expect(inv.fromCompiledBinary).toBe(true);
    expect(inv.command).toBe('/opt/app/goodvibes');
    expect(inv.args).toEqual(['daemon', '--port', '3421']);
    // The whole ExecStart line carries no reconstructed source path.
    const execStart = [inv.command, ...inv.args].join(' ');
    expect(execStart).not.toContain('src/daemon/cli.ts');
    expect(execStart).not.toContain('.ts');
    expect(execStart).not.toContain('run ');
  });

  test('a bare compiled binary launch yields the binary alone', () => {
    const inv = resolveDaemonExecInvocation({ execPath: '/opt/app/goodvibes', argv: ['/opt/app/goodvibes'] }, '/home/u/proj');
    expect(inv.fromCompiledBinary).toBe(true);
    expect([inv.command, ...inv.args].join(' ')).toBe('/opt/app/goodvibes');
  });

  test('a source/dev run yields the run <cli.ts> shape and is flagged not-compiled', () => {
    const inv = resolveDaemonExecInvocation(
      { execPath: '/usr/local/bin/bun', argv: ['/usr/local/bin/bun', '/home/u/proj/src/daemon/cli.ts'] },
      '/home/u/proj',
    );
    expect(inv.fromCompiledBinary).toBe(false);
    expect(inv.command).toBe('/usr/local/bin/bun');
    expect(inv.args).toEqual(['run', '/home/u/proj/src/daemon/cli.ts']);
  });
});
