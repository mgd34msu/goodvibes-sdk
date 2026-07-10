// Post-edit diagnostics — a pluggable provider that surfaces cheap, in-process
// diagnostics on a file the model just wrote or edited, appended to the tool
// result so the model sees a broken edit immediately.
//
// The first (and only bundled) provider is tree-sitter-backed SYNTAX diagnostics
// for TypeScript/JavaScript: in-process, no process spawn, no type checking.
// It is deliberately NOT an LSP/tsc provider — those spawn a language server,
// which this layer must never do per edit. The DiagnosticsProvider interface is
// the seam a host can later implement with a full type-checking provider.
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { CodeIntelligence, SyntaxDiagnostic } from '../../intelligence/index.js';
import { CodeIntelligence as CodeIntelligenceImpl } from '../../intelligence/index.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** A single error-level diagnostic for a touched file. */
export interface PostEditDiagnostic {
  readonly severity: 'error';
  /** 1-based line. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
  readonly message: string;
}

/** A diagnostic tagged with the file it belongs to (output-level shape). */
export interface PostEditFileDiagnostic extends PostEditDiagnostic {
  readonly file: string;
}

/**
 * A source of cheap, in-process, error-level diagnostics for a single file.
 * Implementations MUST NOT spawn processes and MUST never throw — return [] on
 * any failure or when they cannot produce diagnostics (honest absence).
 */
export interface DiagnosticsProvider {
  readonly name: string;
  /** True when this provider can produce diagnostics for the file's type. */
  supports(filePath: string): boolean;
  /** Collect error-level diagnostics for one file's content. */
  collect(filePath: string, content: string): Promise<PostEditDiagnostic[]>;
}

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** True when a tsconfig.json / jsconfig.json is present at or above the file. */
function hasTsProjectContext(filePath: string): boolean {
  let dir = dirname(filePath);
  let prev = '';
  while (dir && dir !== prev) {
    if (existsSync(join(dir, 'tsconfig.json')) || existsSync(join(dir, 'jsconfig.json'))) return true;
    prev = dir;
    dir = dirname(dir);
  }
  return false;
}

/**
 * Syntax-level TypeScript/JavaScript diagnostics from the in-process tree-sitter
 * parser. Cheap and never spawns a process; surfaces parse errors (unbalanced
 * braces, broken syntax) — NOT type errors. Only runs when a TS/JS project
 * context (tsconfig.json / jsconfig.json) is detectable; otherwise returns []
 * (honest absence rather than a fabricated "no errors").
 */
export class TypeScriptSyntaxDiagnosticsProvider implements DiagnosticsProvider {
  readonly name = 'typescript-syntax';
  private readonly intel: CodeIntelligence;
  private initPromise: Promise<void> | null = null;

  constructor(intel?: CodeIntelligence) {
    this.intel = intel ?? new CodeIntelligenceImpl();
  }

  supports(filePath: string): boolean {
    return TS_EXTS.has(extname(filePath).toLowerCase());
  }

  async collect(filePath: string, content: string): Promise<PostEditDiagnostic[]> {
    if (!this.supports(filePath) || !hasTsProjectContext(filePath)) return [];
    try {
      // Lazy one-time init. On a non-Bun runtime (or if the WASM grammar is
      // unavailable) this leaves tree-sitter uninitialized and getSyntaxDiagnostics
      // returns [] — honest absence, never a fake clean bill.
      this.initPromise ??= this.intel.initialize();
      await this.initPromise;
      const diagnostics = await this.intel.getSyntaxDiagnostics(filePath, content);
      return diagnostics.map((d: SyntaxDiagnostic): PostEditDiagnostic => ({
        severity: 'error',
        line: d.line,
        column: d.column,
        message: d.message,
      }));
    } catch (err) {
      logger.warn('TypeScriptSyntaxDiagnosticsProvider.collect error', { filePath, error: summarizeError(err) });
      return [];
    }
  }
}

/**
 * Render diagnostics as a compact human-readable block for tools whose output
 * is not pure JSON (e.g. the edit tool, which already appends text suffixes).
 * Returns '' for an empty list so callers can append unconditionally.
 */
export function formatDiagnosticsBlock(diagnostics: readonly PostEditFileDiagnostic[]): string {
  if (diagnostics.length === 0) return '';
  const lines = diagnostics.map((d) => `  ${d.file}:${d.line}:${d.column} ${d.message}`);
  return `\n⚠ Syntax diagnostics (${diagnostics.length}, errors only):\n${lines.join('\n')}`;
}

/**
 * Run a provider across several just-written files, tagging each diagnostic with
 * its file and capping the total count. Returns [] when no provider is wired.
 */
export async function collectPostEditDiagnostics(
  provider: DiagnosticsProvider | undefined,
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
  cap = 20,
): Promise<PostEditFileDiagnostic[]> {
  if (!provider) return [];
  const out: PostEditFileDiagnostic[] = [];
  for (const file of files) {
    if (out.length >= cap) break;
    if (!provider.supports(file.path)) continue;
    const diagnostics = await provider.collect(file.path, file.content);
    for (const diagnostic of diagnostics) {
      if (out.length >= cap) break;
      out.push({ ...diagnostic, file: file.path });
    }
  }
  return out;
}
