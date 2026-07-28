// check-credential-scope.ts
//
// CI/pre-commit gate: a credential this platform stores must be CLASSIFIED
// before it can be stored.
//
// The defect this gate exists to stop recurring. Three times now a credential
// captured on one surface has been unreadable to the daemon that actually uses
// it — Google mail, payment card fields, the Telegram bot username. Each time
// the immediate cause was different (a wrong default, a forced scope, a bare
// key name nothing derived) and each time the underlying cause was the same:
// nothing anywhere in the codebase stated whether the daemon needed that
// credential, so no code could route it and no reviewer could check.
//
// `platform/config/credential-scope-registry.ts` is where that statement lives.
// This script fails the build when a secret-store write names a key the
// registry does not cover, so "which is it" is a question that has to be
// answered before the write can land rather than after an operator finds the
// capability silently dead.
//
// What counts as covered:
//   - a key the registry declares (exact name or declared prefix), OR
//   - a key derived from a daemon-owned config path (daemonSecretKeyFor), OR
//   - a call site that passes an explicit `scope:` — the author said where it
//     goes, on purpose, in code a reviewer can see. This is the escape hatch
//     for names only an operator can choose (a custom provider's key, a
//     `/secrets set` argument), and it is deliberately the LOUD one.
//
// Only literal key names are checked. A computed key (`secretKeyFor(name)`) is
// reported when it has no explicit scope, because that is exactly the shape
// that produced the per-subscription calendar keys nobody classified.
//
// Test-harness overrides:
//   CREDENTIAL_SCOPE_ROOT      — override the repo root directory
//   CREDENTIAL_SCOPE_DIRS_JSON — JSON array of dirs to scan, repo-relative
//
// Usage:
//   bun run credential-scope:check
//   bun scripts/check-credential-scope.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  findCredentialScopeDeclaration,
} from '../packages/sdk/src/platform/config/credential-scope-registry.ts';
import { daemonSecretKeyFor, listDaemonOwnedSecretKeys } from '../packages/sdk/src/platform/config/daemon-secret-keys.ts';

const REPO_ROOT = process.env['CREDENTIAL_SCOPE_ROOT'] ?? resolve(import.meta.dir, '..');
const DEFAULT_DIRS = ['packages/sdk/src'];
const SCAN_DIRS: readonly string[] = process.env['CREDENTIAL_SCOPE_DIRS_JSON']
  ? (JSON.parse(process.env['CREDENTIAL_SCOPE_DIRS_JSON']!) as string[])
  : DEFAULT_DIRS;

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git', 'generated', 'vendor', '__snapshots__']);

/**
 * A secret WRITE, in the two shapes the platform uses.
 *
 * `.set(` on a secrets manager or an injected secret port, and the
 * `storeSecret(` helper the Cloudflare manager wraps its writes in. Reads are
 * not scanned: reading an unclassified key is not what strands it.
 */
const WRITE_CALL = /(?:secrets?|secretsManager|secretStore|store|deps\.secrets|this\.secrets)\s*\.\s*set\s*\(|storeSecret\s*\(|setSecret\s*\(/g;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly reason: string;
}

function walk(target: string, out: string[]): void {
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(target); } catch { return; }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(target)) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      walk(join(target, entry), out);
    }
    return;
  }
  if (target.endsWith('.ts') && !target.endsWith('.d.ts')) out.push(target);
}

/**
 * The call's full argument text, from the opening paren to its match.
 *
 * Read forward across newlines because a multi-line call is the common shape:
 * `await deps.secrets.set(\n  GOOGLE_SECRET_KEYS.oauthRefreshToken,\n  value,\n)`.
 */
function callArguments(source: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < source.length && i < openParenIndex + 4_000; i += 1) {
    const char = source[i];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex + 1, i);
    }
  }
  return source.slice(openParenIndex + 1, openParenIndex + 400);
}

/**
 * Blank out comments so prose describing a write is never mistaken for one.
 *
 * Replaced with spaces rather than removed, so every byte offset — and
 * therefore every reported line number — still points at the real source.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (line, lead: string) => lead + ' '.repeat(line.length - lead.length));
}

/**
 * Every `const NAME = 'LITERAL'` in the scanned source.
 *
 * A write almost never spells its key inline — it names a constant
 * (`CLOUDFLARE_API_TOKEN_KEY`). Resolving those is the difference between a
 * gate that checks the real key set and one that shouts at every call site.
 */
function buildConstantTable(files: readonly string[]): ReadonlyMap<string, string> {
  const table = new Map<string, string>();
  // `const NAME = <expr>;` — the expression is evaluated by
  // `evaluateKeyExpression`, so `daemonSecretKeyFor('cluster.groupMaterial')`
  // resolves the same way the routing resolves it.
  // The optional type annotation must not cross a line or a statement: `[^=]`
  // alone matched newlines, so `declare const secrets: {...};` swallowed the
  // NEXT declaration's name and the real constant never entered the table.
  const declaration = /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=;\n]+?)?=\s*([^;\n]+);/g;
  // `GOOGLE_SECRET_KEYS = { appPassword: daemonSecretKeyFor('email.passwordRef') }`
  // — a member of an object literal, which is how the derived key sets are
  // written. Resolved to `OBJECT.member` entries so a call that names one is
  // checked rather than written off as computed.
  const objectLiteral = /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=]+)?=\s*\{([\s\S]*?)\n\}/g;
  const member = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([^,\n]+)/g;
  const sources = files.map((file) => withoutComments(readFileSync(file, 'utf-8')));

  // Two passes: a constant may name another declared earlier in a file this
  // walk has not reached yet, and a single pass would call it unresolvable.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const source of sources) {
      declaration.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = declaration.exec(source)) !== null) {
        const name = match[1]!;
        if (table.has(name)) continue;
        const value = evaluateKeyExpression(match[2]!.trim(), table);
        if (value !== null) table.set(name, value);
      }
      objectLiteral.lastIndex = 0;
      while ((match = objectLiteral.exec(source)) !== null) {
        const objectName = match[1]!;
        const body = match[2]!;
        member.lastIndex = 0;
        let entry: RegExpExecArray | null;
        while ((entry = member.exec(body)) !== null) {
          const key = `${objectName}.${entry[1]!}`;
          if (table.has(key)) continue;
          const resolved = evaluateKeyExpression(entry[2]!.trim(), table);
          if (resolved !== null) table.set(key, resolved);
        }
      }
    }
  }
  return table;
}

/**
 * Evaluate a key expression the way the platform actually writes them.
 *
 * Three shapes and no more: a string literal, a name already in the table, and
 * `daemonSecretKeyFor(<one of those>)` — the platform-wide derivation. Calling
 * the real function rather than reimplementing it means this gate cannot
 * disagree with the routing about what a key is called.
 */
function evaluateKeyExpression(expression: string, table: ReadonlyMap<string, string>): string | null {
  const literal = /^(['"`])([A-Za-z0-9_.:/-]+)\1$/.exec(expression);
  if (literal?.[2]) return literal[2];
  const derived = /^daemonSecretKeyFor\s*\(\s*(.+?)\s*\)$/.exec(expression);
  if (derived?.[1]) {
    const inner = evaluateKeyExpression(derived[1], table);
    return inner === null ? null : daemonSecretKeyFor(inner);
  }
  const named = /^([A-Za-z_$][A-Za-z0-9_$.]*)$/.exec(expression);
  return named?.[1] ? table.get(named[1]) ?? null : null;
}

/**
 * The key name a call names: a string literal, or a constant that resolves to
 * one. Returns null when the key is genuinely computed at runtime.
 */
function resolvedKey(args: string, constants: ReadonlyMap<string, string>): string | null {
  const quoted = /^\s*(['"`])([A-Za-z0-9_.:/-]+)\1/.exec(args);
  if (quoted?.[2]) return quoted[2];
  const identifier = /^\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*(?:,|$)/.exec(args);
  const name = identifier?.[1];
  if (name === undefined) return null;
  return evaluateKeyExpression(name, constants);
}

/**
 * True when this is the DEFINITION of a helper rather than a call to one.
 * `storeSecret(key: string, value: string)` is a signature; it stores nothing.
 */
function isDefinition(args: string): boolean {
  return /^\s*[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*(?:string|unknown)\b/.test(args);
}

/**
 * Functions that produce a daemon-owned key BY CONSTRUCTION.
 *
 * `daemonSecretKeyFor` is the platform's one derivation: it turns a config path
 * into the secret name that path owns, and `isDaemonNeededSecretKey` recognises
 * exactly what it produces. `replicatedSecretKeyFor` delegates to it. A key
 * built by either is classified whatever the argument turns out to be at
 * runtime, so a call to one is not an unclassified write.
 */
const DERIVING_FUNCTIONS = new Set(['daemonSecretKeyFor', 'replicatedSecretKeyFor']);

/**
 * Grow the deriving set with local one-line wrappers around it.
 *
 * `function tokenKey(provider) { return daemonSecretKeyFor(`calendar.${provider}.tokens`); }`
 * is the derivation with a name on it, and a module is entitled to name it.
 * Found by reading the body rather than by listing the wrapper here, so a
 * wrapper that stops deriving stops being trusted the moment it changes.
 */
function collectDerivingWrappers(sources: readonly string[]): void {
  const wrapper = /function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*:\s*string\s*\{\s*return\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  // Repeat so a wrapper around a wrapper is reached.
  for (let pass = 0; pass < 3; pass += 1) {
    for (const source of sources) {
      wrapper.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = wrapper.exec(source)) !== null) {
        if (DERIVING_FUNCTIONS.has(match[2]!)) DERIVING_FUNCTIONS.add(match[1]!);
      }
    }
  }
}

/** The function a key expression calls, if it is a call at all. */
function calledFunction(args: string): string | null {
  const call = /^\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\(/.exec(args);
  const name = call?.[1];
  if (name === undefined) return null;
  return name.split('.').pop() ?? name;
}

/**
 * True when the key is a plain identifier this walk could not resolve.
 *
 * That is a PASSTHROUGH — `storeSecret(key, value)` inside a wrapper, or a
 * local `const secretKey` two lines above. The value arrived from somewhere,
 * and the site that MINTED the name is the site that has to classify it. This
 * check sees that site too, so reporting the passthrough as well would be one
 * defect reported twice and would push authors to scatter scope arguments
 * through wrappers instead of classifying at the source.
 */
function isPassthroughIdentifier(args: string): boolean {
  return /^\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:,|$)/.test(args) && !/^\s*[A-Za-z_$][A-Za-z0-9_$.]*\s*\(/.test(args);
}

/** True when the call states a scope in code a reviewer can see. */
function statesScope(args: string): boolean {
  return /\bscope\s*:/.test(args);
}

/** Covered by the registry, or derived from a daemon-owned config path. */
function isClassified(key: string): boolean {
  if (listDaemonOwnedSecretKeys().has(key)) return true;
  return findCredentialScopeDeclaration(key) !== null;
}

function checkFile(path: string, constants: ReadonlyMap<string, string>): Finding[] {
  const source = withoutComments(readFileSync(path, 'utf-8'));
  // A `Map` called `store` also has `.set(`. The alias is kept because real
  // secret writes use it (push/vapid.ts), but only in a file that is about
  // secrets at all — otherwise every cache in the codebase is a finding.
  const aboutSecrets = /secret/i.test(source);
  const findings: Finding[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let low = 0, high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid]! <= index) low = mid; else high = mid - 1;
    }
    return low + 1;
  };

  WRITE_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WRITE_CALL.exec(source)) !== null) {
    const openParen = source.indexOf('(', match.index);
    if (openParen === -1) continue;
    if (!aboutSecrets && /^store\s*\./.test(match[0])) continue;
    const args = callArguments(source, openParen);
    if (isDefinition(args)) continue;
    if (statesScope(args)) continue;

    const key = resolvedKey(args, constants);
    const line = lineOf(match.index);
    const snippet = source.slice(match.index, Math.min(source.length, match.index + 90)).split('\n')[0]!.trim();

    if (key === null) {
      const callee = calledFunction(args);
      if (callee !== null && DERIVING_FUNCTIONS.has(callee)) continue;
      if (isPassthroughIdentifier(args)) continue;
      // A computed key with no stated scope, minted right here. This is the
      // per-subscription calendar-feed shape: nobody could classify it and
      // nobody did.
      findings.push({
        file: path, line, snippet,
        reason: 'writes a computed secret key and states no scope — declare the key family in credential-scope-registry.ts (a prefix declaration), or pass an explicit scope',
      });
      continue;
    }
    if (!isClassified(key)) {
      findings.push({
        file: path, line, snippet,
        reason: `"${key}" is not classified — add it to CREDENTIAL_SCOPE_DECLARATIONS in credential-scope-registry.ts as daemon-needed or surface-local, with the reason`,
      });
    }
  }
  return findings;
}

function main(): void {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) walk(resolve(REPO_ROOT, dir), files);

  collectDerivingWrappers(files.map((file) => withoutComments(readFileSync(file, 'utf-8'))));
  const constants = buildConstantTable(files);
  const findings = files.flatMap((file) => checkFile(file, constants));
  if (findings.length === 0) {
    console.log(`credential-scope-check: OK — every secret write in ${files.length} file(s) names a classified credential or states its scope.`);
    return;
  }

  console.error('credential-scope-check FAILED:\n');
  for (const finding of findings) {
    console.error(`- ${relative(REPO_ROOT, finding.file)}:${finding.line}`);
    console.error(`    ${finding.snippet}`);
    console.error(`    ${finding.reason}\n`);
  }
  console.error('A credential nothing classifies is a credential nothing can route. See');
  console.error('packages/sdk/src/platform/config/credential-scope-registry.ts for the rule.');
  process.exit(1);
}

main();
