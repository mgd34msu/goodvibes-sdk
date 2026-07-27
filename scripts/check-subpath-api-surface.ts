/**
 * check-subpath-api-surface.ts — the published surface api:check cannot see.
 *
 * ## Why this exists
 *
 * `api:check` runs api-extractor over exactly two entry points, `index.d.ts`
 * and `embed.d.ts`. Everything reached only through a SUBPATH export —
 * `./platform/runtime/disposal`, `./platform/tools`, `./platform/utils` — is
 * invisible to it. `RuntimePollerOwners`, `PushService`, `RetryConfig`,
 * `HttpListener`, `AgentOrchestrator` and `cancelAllAgentRuns` appear in
 * neither rollup.
 *
 * That is not a documentation gap, it is a missing gate. Consumer forks
 * IMPLEMENT some of those contracts: goodvibes-tui and goodvibes-agent each
 * build their own runtime graph and hand it to `registerRuntimePollers`. Adding
 * a REQUIRED member to `RuntimePollerOwners` breaks every one of them, and this
 * repository had no check that would say so. It happened — `cancelHostedAgentRuns`
 * went in as required, and it surfaced only because somebody checked by hand.
 *
 * ## What it captures, and what it deliberately does not
 *
 * A full type rollup per subpath would mean 138 api-extractor runs, which is
 * over an hour and not a patch-sized answer. This captures the shape that
 * actually breaks a consumer:
 *
 *   - every exported name, per subpath — so a removal or rename is caught;
 *   - for every exported interface, its REQUIRED member names — so a member
 *     added without `?` is caught, which is the incident above.
 *
 * NOT captured, and worth stating plainly rather than implying coverage that is
 * not here: parameter and return types, generics, member types, optional
 * members, and anything about a symbol's internals. A required member whose
 * TYPE changes incompatibly still passes this gate. The two rollups remain the
 * authority for the root and embed entry points.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const PACKAGE_DIR = resolve(SDK_ROOT, 'packages', 'sdk');
const SNAPSHOT_PATH = resolve(SDK_ROOT, 'etc', 'subpath-api-surface.json');

interface ExportEntry {
  readonly name: string;
  readonly kind: string;
  /** Required (non-optional) member names, for interfaces a consumer implements. */
  readonly required?: readonly string[];
}

/** Every subpath export that publishes types, as `subpath -> .d.ts path`. */
function subpathTypeEntryPoints(): Map<string, string> {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
  };
  const found = new Map<string, string>();
  for (const [subpath, value] of Object.entries(manifest.exports)) {
    if (subpath === './package.json') continue;
    if (typeof value !== 'object' || value === null) continue;
    const types = (value as Record<string, unknown>)['types'];
    if (typeof types !== 'string') continue;
    found.set(subpath, resolve(PACKAGE_DIR, types));
  }
  return found;
}

function declarationKind(symbol: ts.Symbol): string {
  const flags = symbol.getFlags();
  if (flags & ts.SymbolFlags.Interface) return 'interface';
  if (flags & ts.SymbolFlags.Class) return 'class';
  if (flags & ts.SymbolFlags.TypeAlias) return 'type';
  if (flags & ts.SymbolFlags.Enum) return 'enum';
  if (flags & ts.SymbolFlags.Function) return 'function';
  if (flags & ts.SymbolFlags.Variable) return 'const';
  return 'other';
}

/**
 * The members a consumer MUST supply.
 *
 * Optional members are skipped on purpose: adding one is additive and breaks
 * nobody, which is exactly the difference this gate is trying to draw.
 */
function requiredMembers(symbol: ts.Symbol): string[] | undefined {
  const declarations = symbol.getDeclarations() ?? [];
  const names = new Set<string>();
  let sawInterface = false;
  for (const declaration of declarations) {
    if (!ts.isInterfaceDeclaration(declaration)) continue;
    sawInterface = true;
    for (const member of declaration.members) {
      const memberName = member.name && ts.isIdentifier(member.name) ? member.name.text : null;
      if (!memberName) continue;
      const optional = 'questionToken' in member && member.questionToken !== undefined;
      if (!optional) names.add(memberName);
    }
  }
  return sawInterface ? [...names].sort() : undefined;
}

function buildSnapshot(): Record<string, ExportEntry[]> {
  const entryPoints = subpathTypeEntryPoints();
  const program = ts.createProgram([...entryPoints.values()], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();

  const snapshot: Record<string, ExportEntry[]> = {};
  for (const [subpath, filePath] of [...entryPoints].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const source = program.getSourceFile(filePath);
    if (!source) {
      snapshot[subpath] = [];
      continue;
    }
    const moduleSymbol = checker.getSymbolAtLocation(source);
    const exported = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    const entries: ExportEntry[] = [];
    for (const symbol of exported) {
      const resolved = symbol.getFlags() & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const required = requiredMembers(resolved);
      entries.push({
        name: symbol.getName(),
        kind: declarationKind(resolved),
        ...(required && required.length > 0 ? { required } : {}),
      });
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    snapshot[subpath] = entries;
  }
  return snapshot;
}

function render(snapshot: Record<string, ExportEntry[]>): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

const checkOnly = process.argv.includes('--check');
const rendered = render(buildSnapshot());

if (!checkOnly) {
  writeFileSync(SNAPSHOT_PATH, rendered);
  console.log(`subpath-api-surface: wrote ${relative(SDK_ROOT, SNAPSHOT_PATH)}`);
  process.exit(0);
}

let committed: string;
try {
  committed = readFileSync(SNAPSHOT_PATH, 'utf8');
} catch {
  console.error(
    `subpath-api-surface FAILED: ${relative(SDK_ROOT, SNAPSHOT_PATH)} is missing.\n`
    + 'Fix: bun run api:subpath',
  );
  process.exit(1);
}

if (committed === rendered) {
  const count = Object.keys(JSON.parse(rendered) as Record<string, unknown>).length;
  console.log(`subpath-api-surface: OK — ${count} subpath export(s) match the committed surface.`);
  process.exit(0);
}

const before = JSON.parse(committed) as Record<string, ExportEntry[]>;
const after = JSON.parse(rendered) as Record<string, ExportEntry[]>;
const lines: string[] = ['subpath-api-surface FAILED: the published subpath surface changed.', ''];
for (const subpath of new Set([...Object.keys(before), ...Object.keys(after)])) {
  const previous = new Map((before[subpath] ?? []).map((entry) => [entry.name, entry]));
  const current = new Map((after[subpath] ?? []).map((entry) => [entry.name, entry]));
  for (const [name, entry] of current) {
    const was = previous.get(name);
    if (!was) {
      lines.push(`  + ${subpath} exports ${entry.kind} ${name}`);
      continue;
    }
    const added = (entry.required ?? []).filter((member) => !(was.required ?? []).includes(member));
    if (added.length > 0) {
      lines.push(
        `  ! ${subpath} ${name} gained REQUIRED member(s): ${added.join(', ')}`
        + ' — this breaks every consumer that implements it.',
      );
    }
  }
  for (const name of previous.keys()) {
    if (!current.has(name)) lines.push(`  - ${subpath} no longer exports ${name}`);
  }
}
lines.push('', 'If the change is intended, re-record it: bun run api:subpath');
console.error(lines.join('\n'));
process.exit(1);
