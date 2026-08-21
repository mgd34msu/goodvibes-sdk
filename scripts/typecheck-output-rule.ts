/**
 * typecheck-output-rule.ts, treat a compiler's OUTPUT as evidence, not its exit code.
 *
 * ## Why this exists
 *
 * "tsc is clean" was cited as proof five separate times in one night, and it
 * was wrong in two independent ways. The first is that the root config is
 * references-only with `files: []`, so `tsc -b` never compiled `test/` at all
 * (see tsconfig.tests.json). The second is this one: a `tsc --build` was
 * observed printing more than twenty `TS2307` diagnostics and still exiting 0.
 *
 * I could not reproduce that exit code from a minimal composite project, from a
 * solution whose `node_modules` was deleted after a successful build, or
 * through `bunx`, every one of those exited non-zero. So rather than claim a
 * root cause I have not seen, this gate stops depending on the exit code being
 * right. It fails on either signal:
 *
 *   - a non-zero exit code, or
 *   - a diagnostic line in the output, whatever the exit code said.
 *
 * A pipeline is the other way this goes wrong and it is worth naming, because
 * it is easy to do by accident: `tsc -b 2>&1 | head` reports `head`'s exit
 * status, which is 0 no matter what the compiler found. The runner in
 * typecheck.ts captures output instead of piping it.
 */

/** A tsc diagnostic line: `file(1,2): error TS1234: message`, or a bare `error TS1234:`. */
const DIAGNOSTIC_RE = /(?:^|\s)error TS\d+\b/;

/** tsc's own tally line. `Found 0 errors` is the passing form. */
const TALLY_RE = /\bFound (\d+) errors?\b/;

export interface OutputVerdict {
  /** Diagnostic lines found in the output, verbatim. */
  readonly diagnostics: readonly string[];
  /** The count from tsc's `Found N errors` line, when it printed one. */
  readonly reportedErrorCount: number | null;
}

/**
 * Read a compiler's output for evidence that it found something.
 *
 * Deliberately narrow: `error TS<digits>` and a non-zero `Found N errors`
 * tally. Matching anything looser, say, any line containing `TS` or `error`,
 * would fire on ordinary log lines and on this file's own prose, and a gate
 * that always fails gets switched off, which is the same outcome as a gate that
 * never fails.
 */
export function readCompilerOutput(output: string): OutputVerdict {
  const diagnostics: string[] = [];
  let reportedErrorCount: number | null = null;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    const tally = TALLY_RE.exec(line);
    if (tally) {
      const parsed = Number(tally[1]);
      if (Number.isFinite(parsed)) reportedErrorCount = parsed;
      continue;
    }
    if (DIAGNOSTIC_RE.test(line)) diagnostics.push(line.trim());
  }
  return { diagnostics, reportedErrorCount };
}

export interface CommandResult {
  readonly label: string;
  readonly exitCode: number | null;
  readonly output: string;
}

/**
 * Every reason a typecheck run should be treated as failed.
 *
 * Returns an empty array when the run is genuinely clean, that is the case the
 * accompanying test drives alongside each rejection, so this cannot quietly
 * become a function that only ever says yes.
 */
export function typecheckFailures(result: CommandResult): string[] {
  const failures: string[] = [];
  const { diagnostics, reportedErrorCount } = readCompilerOutput(result.output);
  if (result.exitCode !== 0) {
    failures.push(`${result.label}: exited ${result.exitCode ?? 'by signal'}`);
  }
  if (diagnostics.length > 0) {
    failures.push(
      `${result.label}: printed ${diagnostics.length} diagnostic line(s)`
      + (result.exitCode === 0 ? ' while exiting 0, the exit code was not evidence' : ''),
    );
  }
  if (reportedErrorCount !== null && reportedErrorCount > 0 && diagnostics.length === 0) {
    failures.push(`${result.label}: reported "Found ${reportedErrorCount} errors" with no diagnostic lines`);
  }
  return failures;
}
