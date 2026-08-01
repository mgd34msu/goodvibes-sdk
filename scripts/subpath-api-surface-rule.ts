/**
 * subpath-api-surface-rule.ts — the decision logic behind the subpath API gate.
 *
 * Split out of `check-subpath-api-surface.ts` so every branch of it can be
 * exercised directly by `test/subpath-api-surface-gate.test.ts`, including the
 * branches that must be able to answer NO. A gate whose failure path has never
 * been executed is not a gate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

/** The subset of a package manifest this rule reads. */
export interface ExportManifest {
  readonly exports: Record<string, unknown>;
}

export interface ExportEntry {
  readonly name: string;
  readonly kind: string;
  /** Required (non-optional) member names, for interfaces a consumer implements. */
  readonly required?: readonly string[];
  /**
   * PUBLIC member names of an exported class.
   *
   * A class member is as public as a top-level export once the class is
   * exported, and nothing tracked them: two new public methods were added to a
   * subpath-exported class and no gate said anything, because both this report
   * and the api-extractor rollups recorded exported SYMBOLS, not what those
   * symbols expose. `text` catches the same change, but only as an opaque
   * declaration diff; this is what lets the failure message name the method.
   */
  readonly publicMembers?: readonly string[];
  /**
   * The declaration text as emitted into the `.d.ts`, comments stripped and
   * whitespace collapsed. This is what makes a member's TYPE change visible;
   * `name` + `required` alone report `subject: string` and `subject: number`
   * as the same surface.
   */
  readonly text: string;
}

export type Snapshot = Record<string, ExportEntry[]>;

export interface EntryPointResolution {
  /** subpath -> absolute path of the `.d.ts` that subpath publishes. */
  readonly entryPoints: ReadonlyMap<string, string>;
  /**
   * Subpaths that could not be resolved to a readable `.d.ts`.
   *
   * These are the silent hole this rule was rewritten to close. The previous
   * implementation dropped a subpath with no `types` condition on the floor and
   * recorded `[]` for a `types` path that did not exist, so a module whose
   * declarations failed to resolve was reported as "no exports" and the gate
   * stayed green over it forever.
   */
  readonly problems: readonly string[];
}

/**
 * Non-type assets in the export map.
 *
 * `./package.json` and the three `./contracts/*.json` artifacts are published
 * data files, not type entry points; they are string-valued in the manifest and
 * carry no declarations. Everything else is expected to publish types.
 */
function isAssetExport(subpath: string, value: unknown): boolean {
  return typeof value === 'string' && (subpath === './package.json' || subpath.endsWith('.json'));
}

/** Resolve every subpath that is expected to publish types, and flag the ones that do not. */
export function resolveSubpathEntryPoints(
  manifest: ExportManifest,
  packageDir: string,
  fileExists: (path: string) => boolean = existsSync,
): EntryPointResolution {
  const entryPoints = new Map<string, string>();
  const problems: string[] = [];
  for (const [subpath, value] of Object.entries(manifest.exports)) {
    if (isAssetExport(subpath, value)) continue;
    if (typeof value !== 'object' || value === null) {
      problems.push(`${subpath}: export map entry is not a conditions object and is not a published .json asset`);
      continue;
    }
    const types = (value as Record<string, unknown>)['types'];
    if (typeof types !== 'string') {
      problems.push(`${subpath}: export map entry declares no "types" condition, so its public surface is unreportable`);
      continue;
    }
    const absolute = resolve(packageDir, types);
    if (!fileExists(absolute)) {
      problems.push(`${subpath}: "types" points at ${types}, which does not exist`);
      continue;
    }
    entryPoints.set(subpath, absolute);
  }
  return { entryPoints, problems };
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
 * nobody, which is exactly the difference this gate is trying to draw. A change
 * to an optional member's type is still caught, via `text`.
 */
export function requiredMembers(symbol: ts.Symbol): string[] | undefined {
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

/**
 * The public members an exported class exposes.
 *
 * `private`/`protected` members and `#name` private fields are excluded — they
 * are not surface. The constructor is included as `constructor`, because its
 * parameter list is what a consumer calls.
 */
export function publicClassMembers(symbol: ts.Symbol): string[] | undefined {
  const declarations = symbol.getDeclarations() ?? [];
  const names = new Set<string>();
  let sawClass = false;
  for (const declaration of declarations) {
    if (!ts.isClassDeclaration(declaration)) continue;
    sawClass = true;
    for (const member of declaration.members) {
      const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) ?? [] : [];
      const hidden = modifiers.some(
        (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
      );
      if (hidden) continue;
      if (ts.isConstructorDeclaration(member)) {
        names.add('constructor');
        continue;
      }
      const memberName = member.name;
      if (!memberName) continue;
      if (ts.isPrivateIdentifier(memberName)) continue;
      if (ts.isIdentifier(memberName) || ts.isStringLiteral(memberName)) {
        names.add(memberName.text);
        continue;
      }
      if (ts.isComputedPropertyName(memberName)) names.add(memberName.getText());
    }
  }
  return sawClass ? [...names].sort() : undefined;
}

/**
 * Collapse a declaration to a comparable one-liner.
 *
 * Block comments go first so a doc-only edit does not churn the report; `.d.ts`
 * emit keeps JSDoc on interface members, which sits INSIDE the declaration text
 * and would otherwise dominate the diff. Line comments are left alone on
 * purpose — `//` occurs inside string literal types (`'https://…'`) and
 * stripping it would corrupt the recorded surface.
 */
export function normalizeDeclarationText(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Definitions of types an export REFERENCES but that are not themselves
 * exported from that subpath, one level deep.
 *
 * The gap this closes, twice observed rather than imagined:
 * `PermissionConfigReader.getSnapshot(): PermissionConfigSnapshot` and
 * `automationManager.listRuns(): AutomationRunLike[]` both changed materially
 * — one narrowed from the whole GoodVibesConfig to a single key, the other had
 * silently lost a field — while the recorded declaration text stayed
 * byte-identical, because only the alias's definition moved and the alias name
 * did not.
 *
 * ONE level, not the transitive closure. Measured on this package, following
 * references all the way produces a 12.1 MB report against 3.5 MB; one level
 * catches the alias-beside-the-interface case that actually occurs and stops.
 * A change confined to a type referenced by a referenced type still passes, and
 * that is the remaining limit.
 */
function referencedLocalDefinitions(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  exportedNames: ReadonlySet<string>,
): string[] {
  const seen = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const referenced = checker.getSymbolAtLocation(node.typeName);
      if (referenced) {
        const resolved = referenced.getFlags() & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(referenced)
          : referenced;
        const name = resolved.getName();
        if (!exportedNames.has(name) && !seen.has(name)) {
          for (const declaration of resolved.getDeclarations() ?? []) {
            // Type aliases and interfaces only: pulling in classes or functions
            // here would drag the implementation surface into the report.
            if (!ts.isTypeAliasDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration)) continue;
            if (declaration.getSourceFile().isDeclarationFile === false) continue;
            seen.set(name, `${name} = ${normalizeDeclarationText(declaration.getText())}`);
            break;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const declaration of symbol.getDeclarations() ?? []) ts.forEachChild(declaration, visit);
  return [...seen.values()].sort();
}

/** Build the recorded surface for one already-created program. */
export function buildSnapshot(program: ts.Program, entryPoints: ReadonlyMap<string, string>): Snapshot {
  const checker = program.getTypeChecker();
  const snapshot: Snapshot = {};
  for (const [subpath, filePath] of [...entryPoints].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const source = program.getSourceFile(filePath);
    if (!source) {
      // Not silently empty: an entry point the program could not load is a
      // blind spot, and `coverageProblems` turns this into a failure.
      snapshot[subpath] = [];
      continue;
    }
    const moduleSymbol = checker.getSymbolAtLocation(source);
    const exported = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    const entries: ExportEntry[] = [];
    const exportedNames = new Set(exported.map((symbol) => symbol.getName()));
    for (const symbol of exported) {
      const resolved = symbol.getFlags() & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const required = requiredMembers(resolved);
      const publicMembers = publicClassMembers(resolved);
      const declarations = resolved.getDeclarations() ?? [];
      const ownText = declarations.map((declaration) => normalizeDeclarationText(declaration.getText())).join(' ;; ');
      const referenced = referencedLocalDefinitions(checker, resolved, exportedNames);
      const text = referenced.length > 0 ? `${ownText} ;; via ${referenced.join(' ;; ')}` : ownText;
      entries.push({
        name: symbol.getName(),
        kind: declarationKind(resolved),
        ...(required && required.length > 0 ? { required } : {}),
        ...(publicMembers && publicMembers.length > 0 ? { publicMembers } : {}),
        text,
      });
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    snapshot[subpath] = entries;
  }
  return snapshot;
}

/**
 * Subpaths that publish types but whose recorded surface is empty.
 *
 * Nearly every subpath in this package exports at least one symbol, so a
 * zero-export subpath normally means the entry point failed to resolve — which
 * is precisely the case that used to pass silently. A genuinely empty entry
 * point goes here WITH a reason rather than weakening the check.
 */
export const EMPTY_SUBPATH_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    './sql-js',
    'Ambient module declaration for the untyped `sql.js` package. Its whole '
      + 'content is a `declare module` block, which contributes no exported '
      + 'symbol to this package — a consumer picks it up with '
      + '`/// <reference types="@pellux/goodvibes-sdk/sql-js" />`, not by '
      + 'importing from it. An empty recorded surface is correct here, not a '
      + 'resolution failure.',
  ],
]);

export function coverageProblems(
  snapshot: Snapshot,
  allowlist: ReadonlyMap<string, string> = EMPTY_SUBPATH_ALLOWLIST,
): string[] {
  const problems: string[] = [];
  for (const [subpath, entries] of Object.entries(snapshot)) {
    if (entries.length > 0) continue;
    if (allowlist.has(subpath)) continue;
    problems.push(
      `${subpath}: resolved to a type entry point that exports nothing — its public surface is absent from the report`,
    );
  }
  return problems;
}

/** Subpaths present in the manifest but missing from a committed report. */
export function missingFromReport(
  entryPoints: ReadonlyMap<string, string>,
  committed: Snapshot,
): string[] {
  const missing: string[] = [];
  for (const subpath of entryPoints.keys()) {
    if (!Object.prototype.hasOwnProperty.call(committed, subpath)) {
      missing.push(`${subpath}: publishes types but has no section in the committed report`);
    }
  }
  return missing;
}

/** Human-readable description of every difference between two recorded surfaces. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const lines: string[] = [];
  for (const subpath of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
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
      const removedRequired = (was.required ?? []).filter((member) => !(entry.required ?? []).includes(member));
      if (removedRequired.length > 0) {
        lines.push(`  ! ${subpath} ${name} no longer requires member(s): ${removedRequired.join(', ')}`);
      }
      const addedPublic = (entry.publicMembers ?? []).filter((member) => !(was.publicMembers ?? []).includes(member));
      if (addedPublic.length > 0) {
        lines.push(
          `  + ${subpath} class ${name} gained PUBLIC member(s): ${addedPublic.join(', ')}`
          + ' — a class member is as public as a top-level export.',
        );
      }
      const removedPublic = (was.publicMembers ?? []).filter((member) => !(entry.publicMembers ?? []).includes(member));
      if (removedPublic.length > 0) {
        lines.push(`  - ${subpath} class ${name} no longer exposes PUBLIC member(s): ${removedPublic.join(', ')}`);
      }
      if (was.text !== entry.text) {
        lines.push(`  ~ ${subpath} ${name} declaration changed:`);
        lines.push(`      was: ${was.text}`);
        lines.push(`      now: ${entry.text}`);
      }
    }
    for (const name of previous.keys()) {
      if (!current.has(name)) lines.push(`  - ${subpath} no longer exports ${name}`);
    }
  }
  return lines;
}

/** Load a manifest from disk. */
export function readManifest(path: string): ExportManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as ExportManifest;
}

export function render(snapshot: Snapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
