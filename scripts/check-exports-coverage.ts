/**
 * check-exports-coverage.ts, every platform module is either exported or
 * declared internal, on purpose.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * `check-subpath-api-surface.ts` reads `packages/sdk/package.json`'s `exports`
 * map and iterates FROM it: for each declared subpath, it records and compares
 * the symbols that subpath exposes. That is the right check for "did a declared
 * subpath's API change", and it is structurally incapable of answering "is a
 * module missing from the map", because a subpath absent from `exports` is
 * never examined.
 *
 * That blind spot is not theoretical. `platform/owner-profile` shipped with no
 * exports entry, a consumer could not import it from a published package at
 * all, and every gate stayed green through it. The `file:` overlay tarballs the
 * surfaces build against compound it, because a directory install resolves more
 * leniently than a published package does: deep paths that the exports map
 * blocks still resolve locally, so a consumer's own suite goes green on an
 * import that would fail the moment it consumed the real package.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * A directory under `src/platform/` with an `index.ts` is a module with a public
 * face. It must either appear in the `exports` map, or be named here with a
 * reason. Silence is the failure, "we forgot" and "it is deliberately internal"
 * look identical from outside, and this makes them different.
 *
 * Adding a module and forgetting the export is the common case, so the default
 * outcome for a new directory is a failure, not a pass.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = join(ROOT, 'packages/sdk/package.json');
const PLATFORM_DIR = join(ROOT, 'packages/sdk/src/platform');

/**
 * Modules with an `index.ts` that are deliberately NOT part of the published
 * surface, each with the reason it is unreachable by design.
 *
 * A module belongs here when consumers reach its behaviour through the control
 * plane rather than by importing it, the daemon owns the instance, and handing
 * out the class would invite a second one.
 */
const INTENTIONALLY_INTERNAL: Readonly<Record<string, string>> = {
  'channel-profiles': 'daemon-owned registry; consumers reach it through the channel-profiles.* verbs',
  'channel-sync': 'daemon-owned routing table and draft mirror; consumers reach it through the channels.routing.* and channels.drafts.* verbs',
  checkin: 'daemon-owned scheduler; consumers configure it through checkin.* config keys and verbs',
  'ci-watch': 'daemon-owned watcher; consumers reach it through the ci.* verbs',
  principals: 'daemon-owned registry; consumers reach it through the principals.* verbs',
  push: 'daemon-owned subscription store; consumers reach it through the push.* verbs',
};

function declaredPlatformSubpaths(): ReadonlySet<string> {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { exports: Record<string, unknown> };
  const out = new Set<string>();
  for (const key of Object.keys(manifest.exports)) {
    if (!key.startsWith('./platform/')) continue;
    // Only the module root counts: './platform/email' covers the module,
    // './platform/email/node' is a further entry point within it.
    const rest = key.slice('./platform/'.length);
    const [head] = rest.split('/');
    if (head !== undefined && head.length > 0) out.add(head);
  }
  return out;
}

function moduleDirectories(): readonly string[] {
  // A missing directory returns empty rather than throwing, so the count
  // tripwire below reports "this check is looking in the wrong place" instead
  // of a stack trace. Both fail; only one tells the reader what to fix.
  if (!existsSync(PLATFORM_DIR)) return [];
  return readdirSync(PLATFORM_DIR).filter((entry) => {
    const full = join(PLATFORM_DIR, entry);
    return statSync(full).isDirectory() && existsSync(join(full, 'index.ts'));
  });
}

function main(): void {
  const declared = declaredPlatformSubpaths();
  const modules = moduleDirectories();
  const undeclared: string[] = [];
  const staleAllowlist: string[] = [];

  for (const name of modules) {
    if (declared.has(name)) {
      if (name in INTENTIONALLY_INTERNAL) staleAllowlist.push(name);
      continue;
    }
    if (name in INTENTIONALLY_INTERNAL) continue;
    undeclared.push(name);
  }

  const problems: string[] = [];

  // A scan that finds nothing must fail, not pass. Both consumer-side audits in
  // this round produced confident wrong answers from a drifted matcher, and a
  // check whose only failure mode is "found no problems" cannot tell "clean"
  // from "looked in the wrong place". The floor is deliberately far below the
  // real count, it is a tripwire for a broken scan, not a ratchet on module
  // count.
  const MIN_PLAUSIBLE_MODULES = 20;
  if (modules.length < MIN_PLAUSIBLE_MODULES || declared.size < MIN_PLAUSIBLE_MODULES) {
    problems.push(
      `The scan found ${modules.length} module director(ies) and ${declared.size} declared`,
      `subpath(s), both of which should be well above ${MIN_PLAUSIBLE_MODULES}. That means this`,
      'check is looking in the wrong place or its matcher has drifted, not that the',
      'surface is clean. Fix the scan before trusting a pass.',
    );
  }

  // The opposite failure: an entry that names a file the package does not ship.
  // It resolves in the map and then fails at import time, which is a worse
  // symptom than a missing entry because the map itself looks correct. Only
  // checkable once dist exists, so it is skipped rather than guessed before a
  // build.
  const SDK_DIR = join(ROOT, 'packages/sdk');
  if (existsSync(join(SDK_DIR, 'dist'))) {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      exports: Record<string, { import?: string; types?: string } | string>;
    };
    const missingTargets: string[] = [];
    for (const [subpath, value] of Object.entries(manifest.exports)) {
      if (subpath === './package.json' || typeof value === 'string') continue;
      for (const target of [value.import, value.types]) {
        if (target === undefined) continue;
        if (!existsSync(join(SDK_DIR, target))) missingTargets.push(`${subpath} -> ${target}`);
      }
    }
    if (missingTargets.length > 0) {
      problems.push(
        'These exports entries name a file the package does not ship. They resolve in',
        'the map and then fail at import time, which is harder to spot than a missing',
        'entry because the map itself looks right:',
        ...missingTargets.map((entry) => `  - ${entry}`),
      );
    }
  }

  if (undeclared.length > 0) {
    problems.push(
      'These platform modules have an index.ts but no entry in the exports map, so no',
      'consumer can import them from a published package:',
      ...undeclared.map((name) => `  - platform/${name}`),
      '',
      'Add an entry to packages/sdk/package.json:',
      '',
      '    "./platform/<name>": {',
      '      "types": "./dist/platform/<name>/index.d.ts",',
      '      "import": "./dist/platform/<name>/index.js"',
      '    }',
      '',
      'or, if it is genuinely internal, name it in INTENTIONALLY_INTERNAL in this',
      'script with the reason consumers do not need it.',
    );
  }

  if (staleAllowlist.length > 0) {
    problems.push(
      'These modules are listed as intentionally internal but ARE exported, so the',
      'allowlist entry is now misleading, remove it:',
      ...staleAllowlist.map((name) => `  - platform/${name}`),
    );
  }

  if (problems.length > 0) {
    console.error('exports-coverage FAILED:\n');
    console.error(problems.join('\n'));
    process.exit(1);
  }

  const internal = Object.keys(INTENTIONALLY_INTERNAL).length;
  console.log(
    `exports-coverage: OK, ${declared.size} platform module(s) exported, ${internal} declared internal.`,
  );
}

main();
