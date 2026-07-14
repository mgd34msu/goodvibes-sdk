/**
 * daemon/daemon-exec-invocation.ts
 *
 * How the daemon's supervised-service ExecStart should be written depends on how
 * THIS process was actually started, not on whether a `dist/` build happens to
 * sit next to the working directory. A compiled single-file binary must launch
 * itself as the binary with its real argv; a source/dev run (`bun run …cli.ts`)
 * must NOT be turned into a service at all — a unit that reconstructs
 * `<binary> run <workingDir>/src/daemon/cli.ts` for a compiled binary is a dev
 * command line that fails on the next boot.
 *
 * These helpers derive the invocation from injectable process signals so the
 * decision is pure and testable, with no reliance on the ambient process.
 */
import { resolve } from 'node:path';

/** The slice of `process` that determines how the daemon was launched. */
export interface ProcessInvocationSignals {
  /** process.execPath — the runtime (bun/node) in a dev run, or the compiled binary itself. */
  readonly execPath: string;
  /** process.argv — [runtimeOrBinary, entry?, ...args]. */
  readonly argv: readonly string[];
}

/** The resolved service ExecStart pieces plus whether this is a compiled binary. */
export interface DaemonExecInvocation {
  readonly command: string;
  readonly args: string[];
  /** True when the running process is a compiled single-file binary (safe to promote). */
  readonly fromCompiledBinary: boolean;
}

const SOURCE_ENTRY_RE = /\.(ts|tsx|js|mjs|cjs)$/i;
// Bun's single-file executables mount their embedded entry under a virtual FS;
// its path never looks like a real on-disk source file the way a dev entry does.
const EMBEDDED_MARKERS = ['$bunfs', '/~BUN/', 'B~', 'bun-build'];

/** Live process signals — the production input to the resolvers below. */
export function currentProcessSignals(): ProcessInvocationSignals {
  return { execPath: process.execPath, argv: [...process.argv] };
}

/**
 * Whether the running process is a compiled single-file binary (rather than a
 * `bun run <source>.ts` / `node <source>.js` dev invocation).
 *
 * The discriminator is the process entry (argv[1]): a dev run always points it
 * at a real on-disk SOURCE file; a compiled binary points it at an embedded
 * virtual-FS entry, at a bare subcommand, or has no entry at all.
 */
export function isCompiledBinaryInvocation(signals: ProcessInvocationSignals): boolean {
  const entry = signals.argv[1];
  if (entry === undefined || entry.length === 0) return true; // launched as a bare binary
  if (EMBEDDED_MARKERS.some((marker) => entry.includes(marker))) return true;
  // A real source-file entry that exists on disk ⇒ a dev/source run.
  return !SOURCE_ENTRY_RE.test(entry);
}

/**
 * Derive the service ExecStart invocation from how the process was started. A
 * compiled binary launches itself with its real argv (no source paths); a
 * source/dev run yields the `run <cli.ts>` shape, but the caller MUST gate on
 * `fromCompiledBinary` before writing a unit for a self-promotion (a dev run
 * should never be promoted).
 */
export function resolveDaemonExecInvocation(
  signals: ProcessInvocationSignals,
  workingDirectory: string,
): DaemonExecInvocation {
  if (isCompiledBinaryInvocation(signals)) {
    // The binary itself, with the exact args that launched this daemon — no
    // reconstructed source-file path.
    return { command: signals.execPath, args: [...signals.argv.slice(1)], fromCompiledBinary: true };
  }
  return {
    command: signals.execPath,
    args: ['run', resolve(workingDirectory, 'src', 'daemon', 'cli.ts')],
    fromCompiledBinary: false,
  };
}
