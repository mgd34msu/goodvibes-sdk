import { CodeIntelligence, uriToPath } from '../../intelligence/index.js';
import { summarizeError } from '../../utils/error-display.js';
import type { ReferencesQuery, OutputOptions } from './shared.js';
import {
  addFindWarning,
  collectTextFiles,
  createFindDiagnostics,
  makeCountResult,
  makeFilesResult,
  makeLocationsResult,
  readTextFile,
  withFindWarnings,
} from './shared.js';

function withFallbackReason<T extends Record<string, unknown>>(result: T, reason: string): T & { fallback_reason: string } {
  return { ...result, fallback_reason: reason };
}

export async function executeReferencesQuery(
  query: ReferencesQuery,
  output: OutputOptions,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const maxResults = output.max_results ?? 100;

  interface ReferenceLocation { file: string; line: number; }
  let locations: ReferenceLocation[] = [];
  let lspFallbackReason = 'lsp returned no reference locations';
  let skippedInvalidLspUris = 0;
  const diagnostics = createFindDiagnostics();

  const ci = new CodeIntelligence({});
  try {
    const lspLocations = await ci.getReferences(query.file, query.line, query.column);
    if (lspLocations.length > 0) {
      for (const loc of lspLocations) {
        if (locations.length >= maxResults) break;
        try {
          const filePath = uriToPath(loc.uri);
          locations.push({ file: filePath, line: loc.range.start.line + 1 });
        } catch (err) {
          skippedInvalidLspUris++;
          addFindWarning(diagnostics, `Skipped invalid LSP reference URI '${loc.uri}': ${summarizeError(err)}`);
        }
      }

      const source = skippedInvalidLspUris > 0 ? 'lsp_with_invalid_uri_skips' : undefined;
      if (output.format === 'count_only') {
        return withFindWarnings(skippedInvalidLspUris > 0
          ? { ...makeCountResult(locations.length, source), invalid_lsp_uri_count: skippedInvalidLspUris }
          : makeCountResult(locations.length), diagnostics.warnings);
      }
      if (output.format === 'files_only') {
        const uniqueFiles = [...new Set(locations.map((l) => l.file))];
        return withFindWarnings(skippedInvalidLspUris > 0
          ? { ...makeFilesResult(uniqueFiles, locations.length, source), invalid_lsp_uri_count: skippedInvalidLspUris }
          : makeFilesResult(uniqueFiles, locations.length), diagnostics.warnings);
      }
      return withFindWarnings(skippedInvalidLspUris > 0
        ? { ...makeLocationsResult(locations, locations.length, source), invalid_lsp_uri_count: skippedInvalidLspUris }
        : makeLocationsResult(locations, locations.length), diagnostics.warnings);
    }
  } catch (err) {
    lspFallbackReason = `lsp unavailable: ${summarizeError(err)}`;
  }

  if (!query.symbol) {
    return withFindWarnings(
      withFallbackReason(makeLocationsResult([], 0, 'grep_fallback'), `${lspFallbackReason}; no symbol supplied for grep fallback`),
      diagnostics.warnings,
    );
  }

  let regex: RegExp;
  try {
    regex = new RegExp(`\\b${query.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  } catch {
    return { error: `Invalid symbol name: ${query.symbol}` };
  }

  const files = await collectTextFiles(projectRoot, diagnostics);
  for (const file of files) {
    if (locations.length >= maxResults) break;
    const content = await readTextFile(file, diagnostics);
    if (content === null) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (locations.length >= maxResults) break;
      regex.lastIndex = 0;
      if (regex.test(lines[i]!)) {
        locations.push({ file, line: i + 1 });
      }
    }
  }

  if (output.format === 'count_only') {
    return withFindWarnings(withFallbackReason(makeCountResult(locations.length, 'grep_fallback'), lspFallbackReason), diagnostics.warnings);
  }
  if (output.format === 'files_only') {
    const uniqueFiles = [...new Set(locations.map((l) => l.file))];
    return withFindWarnings(withFallbackReason(makeFilesResult(uniqueFiles, locations.length, 'grep_fallback'), lspFallbackReason), diagnostics.warnings);
  }
  return withFindWarnings(withFallbackReason(makeLocationsResult(locations, locations.length, 'grep_fallback'), lspFallbackReason), diagnostics.warnings);
}
