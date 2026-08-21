/**
 * bun-pin-rule.ts, validation-gate rule.
 *
 * One bun version, declared in twenty-three places, held to a single number.
 *
 * The root `package.json`'s `engines.bun` is the source of truth. Every other
 * declaration of the toolchain version, `packageManager`, the `@types/bun`
 * devDependency, every workspace package's `engines.bun`, and every
 * `bun-version:` pin or default in `.github/`, must equal it exactly.
 *
 * The reason this rule exists rather than a convention: a floor with a REASON
 * behind it is worthless if one of its copies can quietly stay below the floor.
 * Bun 1.3.10 through 1.3.13 deadlock the module loader once a process has
 * closed two or more `node:fs` watch handles, the next module graph the loader
 * fetches never resolves, and the process parks with an idle event loop and no
 * output at all until something outside it runs out of patience. That cost this
 * repository two fifteen-minute CI cycles of pure silence. The floor is
 * recorded at `.github/actions/setup/action.yml`, with the reproduction; this
 * rule is what stops a single forgotten copy from reintroducing it.
 *
 * Pure, and separate from `package-metadata-check.ts` (the caller that reads
 * the filesystem), so the matching can be exercised from tests with in-memory
 * fixtures.
 */

/** A file's text, as read by the caller. */
export interface PinSource {
  /** Repo-relative path, forward-slash normalized, used in messages. */
  readonly relPath: string;
  readonly text: string;
}

/** One place a bun version is written down. */
export interface BunPin {
  readonly relPath: string;
  /** 1-based line number, so a failure message points at the exact line. */
  readonly line: number;
  /** What that line declares the version to be. */
  readonly version: string;
  /** Which declaration form matched, for the failure message. */
  readonly kind: 'bun-version' | 'bun-version-default';
}

/**
 * An exact version, never a range.
 *
 * A range is not a pin: `^1.3.10` on a caret-resolving installer is free to
 * pick the very release the floor exists to exclude. Every site this rule
 * covers writes an exact version except `examples/package.json`, whose
 * `@types/bun` is a caret range, that one is compared with its caret stripped,
 * by the caller, because the examples workspace is not published and its
 * resolution is the installer's business.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

export function isExactVersion(value: unknown): value is string {
  return typeof value === 'string' && EXACT_VERSION.test(value);
}

/**
 * Every bun version written into a GitHub Actions YAML file.
 *
 * Two shapes occur, and both are pins:
 *
 *   bun-version: "1.3.14"          # a call site pinning the action
 *   bun-version:                   # a reusable workflow input declaring
 *     required: false              # the estate default
 *     type: string
 *     default: "1.3.14"
 *
 * The second is matched by remembering that a `bun-version:` key with no value
 * on its own line opens a block, and taking the first `default:` inside it. The
 * block ends at the first line indented no deeper than the key itself, so a
 * `default:` belonging to some later input can never be misread as bun's.
 */
export function collectBunPins(source: PinSource): BunPin[] {
  const pins: BunPin[] = [];
  const lines = source.text.split('\n');
  // Indentation of an open `bun-version:` block, or null when none is open.
  let openBlockIndent: number | null = null;

  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    if (openBlockIndent !== null && indent <= openBlockIndent) {
      openBlockIndent = null;
    }

    if (openBlockIndent !== null) {
      const nested = /^\s*default:\s*["']?(\d+\.\d+\.\d+)["']?\s*$/.exec(line);
      if (nested) {
        pins.push({
          relPath: source.relPath,
          line: index + 1,
          version: nested[1] as string,
          kind: 'bun-version-default',
        });
        openBlockIndent = null;
      }
      continue;
    }

    const inline = /^\s*bun-version:\s*["']?(\d+\.\d+\.\d+)["']?\s*$/.exec(line);
    if (inline) {
      pins.push({
        relPath: source.relPath,
        line: index + 1,
        version: inline[1] as string,
        kind: 'bun-version',
      });
      continue;
    }
    if (/^\s*bun-version:\s*$/.test(line)) {
      openBlockIndent = indent;
    }
  }
  return pins;
}

/** Every pin in `sources` that disagrees with `expected`, as failure lines. */
export function checkBunPins(expected: string, sources: readonly PinSource[]): string[] {
  const violations: string[] = [];
  if (!isExactVersion(expected)) {
    violations.push(
      `root package.json engines.bun must be an exact version like 1.3.14 (found: ${JSON.stringify(expected)})`,
    );
    return violations;
  }
  for (const source of sources) {
    for (const pin of collectBunPins(source)) {
      if (pin.version !== expected) {
        violations.push(
          `${pin.relPath}:${pin.line} pins bun ${pin.version} via ${pin.kind}; `
          + `it must be ${expected} to match the root package.json engines.bun `
          + `(the floor and its reason are recorded in .github/actions/setup/action.yml)`,
        );
      }
    }
  }
  return violations;
}
