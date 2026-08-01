/**
 * check-subpath-api-surface.ts — the published surface api:check cannot see.
 *
 * ## Why this exists
 *
 * `api:check` runs api-extractor over exactly two entry points, `index.d.ts`
 * and `embed.d.ts`. Everything reached only through a SUBPATH export is
 * invisible to it. That is not a small remainder. Measured on this package:
 *
 *   - 140 subpaths publish types, exporting 6 361 symbols between them;
 *   - 806 of those symbols (12.7%) appear anywhere in the two api-extractor
 *     rollups;
 *   - 78 of the 140 subpaths have ZERO symbols in either rollup — among them
 *     `./platform/email`, `./platform/google`, `./platform/config`,
 *     `./platform/cluster`, `./platform/devices` and `./platform/channels`.
 *
 * `etc/goodvibes-sdk.api.md` contains no occurrence of `EmailInboxListResult`,
 * `EmailSummary` or `ImapMessageDetail`, because `packages/sdk/src/index.ts`
 * is the CLIENT surface and re-exports none of `platform/**`. Running the
 * extractor after changing the email module produces no diff at all.
 *
 * That is a missing gate, not a documentation gap. Consumer forks IMPLEMENT
 * some of these contracts: goodvibes-tui and goodvibes-agent each build their
 * own runtime graph and hand it to `registerRuntimePollers`. Adding a REQUIRED
 * member to `RuntimePollerOwners` breaks every one of them, and it happened —
 * `cancelHostedAgentRuns` went in as required and surfaced only because
 * somebody checked by hand.
 *
 * ## What it captures
 *
 * One TypeScript program over all 140 entry points, ~1.5 s, recording per
 * subpath:
 *
 *   - every exported name and kind — a removal or rename is caught;
 *   - for every exported interface, its REQUIRED member names — a member added
 *     without `?` is caught, which is the incident above;
 *   - the emitted DECLARATION TEXT of every export, comments stripped — so a
 *     member whose type changes, a parameter added, a return type narrowed or a
 *     type alias rewritten is caught. This is the part the previous version did
 *     not have, and stated it did not have: it recorded names only, so
 *     `subject: string` becoming `subject: number` passed.
 *
 * ## What it deliberately does not capture
 *
 * Types that are REFERENCED by an export but not themselves exported from that
 * subpath are recorded by name, not inlined. api-extractor inlines them; doing
 * the same here means a 12.1 MB report instead of a 3.3 MB one (measured), for
 * a second-order case. A change confined to a non-exported referenced type
 * still passes this gate. The two rollups remain the authority for the root and
 * embed entry points.
 *
 * ## Failure modes it now refuses to be silent about
 *
 * A subpath whose `types` condition is missing, or points at a file that does
 * not exist, or resolves to an entry point exporting nothing, is a FAILURE.
 * The previous version skipped the first case and recorded `[]` for the other
 * two, so a module whose declarations failed to resolve looked identical to a
 * module with no public surface and stayed green forever. That is how the next
 * module added would have landed outside the report unnoticed.
 *
 * ## Which packages it covers
 *
 * Every package in TRACKED_PACKAGES below, each with its own committed snapshot
 * under `etc/`. `packages/sdk` is the reason the gate exists, and
 * `packages/terminal-shell` is here because it is the other package consumers
 * import directly: it publishes three entry points (`.`, `./conformance`,
 * `./terminal-output-guard`) and had nothing watching them, so a change to its
 * public surface could reach a consumer with no review step in between. A
 * package joins by appending one entry — the mechanism is identical for all.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  buildSnapshot,
  coverageProblems,
  diffSnapshots,
  missingFromReport,
  readManifest,
  render,
  resolveSubpathEntryPoints,
  type Snapshot,
} from './subpath-api-surface-rule.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

/**
 * A package whose published subpath surface is recorded and gated.
 *
 * Each package keeps its OWN committed baseline rather than sharing one report,
 * so a change in one package produces a diff naming only that package, and
 * adding a package cannot rewrite another's baseline.
 */
interface TrackedPackage {
  readonly name: string;
  readonly dir: string;
  readonly snapshot: string;
}

const TRACKED_PACKAGES: readonly TrackedPackage[] = [
  {
    name: '@pellux/goodvibes-sdk',
    dir: resolve(SDK_ROOT, 'packages', 'sdk'),
    snapshot: resolve(SDK_ROOT, 'etc', 'subpath-api-surface.json'),
  },
  {
    name: '@pellux/goodvibes-terminal-shell',
    dir: resolve(SDK_ROOT, 'packages', 'terminal-shell'),
    snapshot: resolve(SDK_ROOT, 'etc', 'subpath-api-surface-terminal-shell.json'),
  },
];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The entry points a package publishes, refusing an export map that hides types. */
function entryPointsFor(pkg: TrackedPackage): ReadonlyMap<string, string> {
  const manifest = readManifest(join(pkg.dir, 'package.json'));
  const { entryPoints, problems } = resolveSubpathEntryPoints(manifest, pkg.dir);
  if (problems.length > 0) {
    fail(
      [
        `subpath-api-surface FAILED (${pkg.name}): an export map entry publishes no reportable types.`,
        '',
        ...problems.map((p) => `  ${p}`),
      ].join('\n'),
    );
  }
  return entryPoints;
}

/** Build the current snapshot for one package's entry points. */
function snapshotFor(pkg: TrackedPackage, entryPoints: ReadonlyMap<string, string>): Snapshot {
  const program = ts.createProgram([...entryPoints.values()], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  });

  const snapshot = buildSnapshot(program, entryPoints);

  const empty = coverageProblems(snapshot);
  if (empty.length > 0) {
    fail(
      [
        `subpath-api-surface FAILED (${pkg.name}): a published subpath contributes nothing to the report.`,
        '',
        ...empty.map((p) => `  ${p}`),
        '',
        'A subpath that exports nothing is almost always an entry point that failed to resolve.',
        'Rebuild (`bun run build`) and re-run. If the entry point is genuinely empty, add it to',
        'EMPTY_SUBPATH_ALLOWLIST in scripts/subpath-api-surface-rule.ts with a reason.',
      ].join('\n'),
    );
  }

  return snapshot;
}

/** Record one package's baseline. */
function record(pkg: TrackedPackage): void {
  const entryPoints = entryPointsFor(pkg);
  const snapshot = snapshotFor(pkg, entryPoints);
  writeFileSync(pkg.snapshot, render(snapshot));
  console.log(
    `subpath-api-surface: wrote ${relative(SDK_ROOT, pkg.snapshot)}`
    + ` — ${pkg.name}, ${entryPoints.size} subpaths,`
    + ` ${Object.values(snapshot).reduce((n, e) => n + e.length, 0)} exports.`,
  );
}

/** Verify one package against its committed baseline. */
function check(pkg: TrackedPackage): void {
  const entryPoints = entryPointsFor(pkg);
  const rendered = render(snapshotFor(pkg, entryPoints));

  let committedText: string;
  try {
    committedText = readFileSync(pkg.snapshot, 'utf8');
  } catch {
    fail(
      `subpath-api-surface FAILED (${pkg.name}): ${relative(SDK_ROOT, pkg.snapshot)} is missing.\n`
      + 'Fix: bun run api:subpath',
    );
  }

  const committed = JSON.parse(committedText) as Snapshot;

  const missing = missingFromReport(entryPoints, committed);
  if (missing.length > 0) {
    fail(
      [
        `subpath-api-surface FAILED (${pkg.name}): a published subpath is absent from the committed report.`,
        '',
        ...missing.map((p) => `  ${p}`),
        '',
        'Record it: bun run api:subpath',
      ].join('\n'),
    );
  }

  if (committedText === rendered) {
    const exports = Object.values(committed).reduce((n, e) => n + e.length, 0);
    console.log(
      `subpath-api-surface: OK — ${pkg.name}, ${Object.keys(committed).length} subpaths,`
      + ` ${exports} exports match the committed surface.`,
    );
    return;
  }

  fail(
    [
      `subpath-api-surface FAILED (${pkg.name}): the published subpath surface changed.`,
      '',
      ...diffSnapshots(committed, JSON.parse(rendered) as Snapshot),
      '',
      'If the change is intended, re-record it: bun run api:subpath',
    ].join('\n'),
  );
}

const checkOnly = process.argv.includes('--check');
for (const pkg of TRACKED_PACKAGES) {
  if (checkOnly) check(pkg);
  else record(pkg);
}
