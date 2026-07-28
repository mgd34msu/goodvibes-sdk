/**
 * check-subpath-declared.ts — a capability that exists but cannot be imported.
 *
 * ## The gap this closes
 *
 * `check-subpath-api-surface.ts` enumerates its entry points by iterating
 * `package.json`'s `exports` map. That makes it a DRIFT detector over the
 * declared surface: it catches a removed export, a rename, and an interface
 * that gained a required member. It is the right tool for those.
 *
 * What it structurally cannot see is a module that should be declared and is
 * not. A capability with no `exports` entry has no entry point to enumerate, so
 * it is absent from the snapshot, absent from the diff, and absent from every
 * green run — while `import '@pellux/goodvibes-sdk/platform/<thing>'` fails
 * resolution for every consumer of the published package.
 *
 * That gap is invisible in local development for a specific reason worth
 * naming: consumers build against overlay tarballs and workspace links, which
 * resolve through paths a published install does not have. Source-tree
 * resolution proves nothing about the published artifact.
 *
 * ## Why the rule is TOP-LEVEL only
 *
 * The obvious rule — "every directory with an index.ts must be declared" —
 * fires on 97 modules in this repository, and nearly all of them are correct as
 * they are. `./platform/tools/read` is reached through `./platform/tools`;
 * `./platform/adapters/slack` through `./platform/adapters`. An internal
 * submodule having its own barrel file is ordinary structure, not a defect, and
 * a check that flagged all of them would be turned off within a day.
 *
 * The rule that holds: a TOP-LEVEL `src/platform/*` directory with an index.ts
 * is a capability, and a capability nobody can import is a capability that does
 * not ship. That fires on five modules here, all of them genuine.
 *
 * ## Why there is a known-gap list rather than a hard failure
 *
 * The five predate this check and belong to other work streams. Failing the
 * build for them would block every lane on a defect none of them introduced,
 * which is how a gate gets bypassed instead of fixed. So they are listed
 * explicitly — visible, attributable, and shrinking — and the check fails on
 * anything NEW. Same shape as `KNOWN_PRE_EXISTING_ROUTE_DEBT` in
 * capability-route-reconcile and the line-cap grandfather list.
 *
 * Shrink this list. Do not grow it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const PACKAGE_DIR = resolve(SDK_ROOT, 'packages', 'sdk');
const PLATFORM_DIR = resolve(PACKAGE_DIR, 'src', 'platform');

/**
 * Top-level capabilities that exist in source and are not importable from the
 * published package.
 *
 * Each one is unreachable from every consumer of a published SDK. They are
 * recorded rather than fixed here because they belong to other work streams;
 * whoever owns one should add its `exports` entry and delete its line.
 */
const KNOWN_UNDECLARED: readonly string[] = [
  './platform/channel-profiles',
  './platform/checkin',
  './platform/ci-watch',
  './platform/principals',
  './platform/push',
];

function declaredSubpaths(): ReadonlySet<string> {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  return new Set(Object.keys(manifest.exports ?? {}));
}

/** Top-level platform directories carrying a barrel file. */
function topLevelCapabilities(): readonly string[] {
  return readdirSync(PLATFORM_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(PLATFORM_DIR, entry.name, 'index.ts')))
    .map((entry) => `./platform/${entry.name}`)
    .sort();
}

export function findUndeclaredCapabilities(): readonly string[] {
  const declared = declaredSubpaths();
  return topLevelCapabilities().filter((subpath) => !declared.has(subpath));
}

function main(): void {
  const undeclared = findUndeclaredCapabilities();
  const known = new Set(KNOWN_UNDECLARED);
  const added = undeclared.filter((subpath) => !known.has(subpath));
  const fixed = KNOWN_UNDECLARED.filter((subpath) => !undeclared.includes(subpath));

  if (added.length === 0 && fixed.length === 0) {
    console.log(
      `subpath-declared: OK — ${String(topLevelCapabilities().length)} top-level capabilities, `
      + `${String(undeclared.length)} known-undeclared, no new ones.`,
    );
    return;
  }

  const lines: string[] = [];
  if (added.length > 0) {
    lines.push(
      'subpath-declared FAILED: a capability exists in source and cannot be imported',
      'from the published package. Consumers resolving the real tarball get ERR_PACKAGE_PATH_NOT_EXPORTED.',
      '',
      ...added.map((subpath) => `  + ${subpath}`),
      '',
      'Fix: add an exports entry in packages/sdk/package.json pointing at its dist index,',
      'then verify against a PACKED TARBALL — source-tree resolution does not prove this.',
    );
  }
  if (fixed.length > 0) {
    lines.push(
      '',
      'These are now declared. Remove them from KNOWN_UNDECLARED:',
      ...fixed.map((subpath) => `  - ${subpath}`),
    );
  }
  console.error(lines.join('\n'));
  process.exitCode = 1;
}

main();
