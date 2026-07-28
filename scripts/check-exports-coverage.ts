/**
 * check-exports-coverage.ts — every platform module is either exported or
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
 * exports entry — a consumer could not import it from a published package at
 * all — and every gate stayed green through it. The `file:` overlay tarballs the
 * surfaces build against compound it, because a directory install resolves more
 * leniently than a published package does: deep paths that the exports map
 * blocks still resolve locally, so a consumer's own suite goes green on an
 * import that would fail the moment it consumed the real package.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * A directory under `src/platform/` with an `index.ts` is a module with a public
 * face. It must either appear in the `exports` map, or be named here with a
 * reason. Silence is the failure — "we forgot" and "it is deliberately internal"
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
 * plane rather than by importing it — the daemon owns the instance, and handing
 * out the class would invite a second one.
 */
const INTENTIONALLY_INTERNAL: Readonly<Record<string, string>> = {
  'channel-profiles': 'daemon-owned registry; consumers reach it through the channel-profiles.* verbs',
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
  return readdirSync(PLATFORM_DIR).filter((entry) => {
    const full = join(PLATFORM_DIR, entry);
    return statSync(full).isDirectory() && existsSync(join(full, 'index.ts'));
  });
}

function main(): void {
  const declared = declaredPlatformSubpaths();
  const undeclared: string[] = [];
  const staleAllowlist: string[] = [];

  for (const name of moduleDirectories()) {
    if (declared.has(name)) {
      if (name in INTENTIONALLY_INTERNAL) staleAllowlist.push(name);
      continue;
    }
    if (name in INTENTIONALLY_INTERNAL) continue;
    undeclared.push(name);
  }

  const problems: string[] = [];

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
      'allowlist entry is now misleading — remove it:',
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
    `exports-coverage: OK — ${declared.size} platform module(s) exported, ${internal} declared internal.`,
  );
}

main();
